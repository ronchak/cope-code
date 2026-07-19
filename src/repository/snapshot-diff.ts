import { AgentError } from "../shared/errors.js";
import { sha256 } from "../shared/crypto.js";
import type { RepositoryBoundary } from "./boundary.js";
import { normalizeRepositoryPath } from "./boundary.js";
import type {
  CheckpointFileSnapshot,
  CheckpointSnapshot,
  CheckpointStore,
} from "./checkpoint.js";
import { looksBinary, readRegularFile } from "./text-file.js";

export const SNAPSHOT_DIFF_VERSION = "snapshot-diff.v1" as const;

export interface SessionMutationDiffRecord {
  readonly checkpointId: string;
  readonly changedPaths: readonly string[];
}

export interface SnapshotDiffRequest {
  readonly paths?: readonly string[];
  readonly maxBytes?: number;
}

export interface SnapshotDiffResult {
  readonly contractVersion: typeof SNAPSHOT_DIFF_VERSION;
  readonly scope: "checkpoint" | "session";
  /** Checkpoint ID for checkpoint scope; deterministic label for session scope. */
  readonly baseline: string;
  readonly diff: string;
  readonly truncated: boolean;
  readonly outputBytes: number;
  readonly sha256: string;
  readonly excludedCount: number;
  readonly comparedFileCount: number;
  readonly changedFileCount: number;
  /** Effective post-clamp output ceiling, used for a second disclosure bound. */
  readonly limitBytes: number;
}

export interface SnapshotDiffInspectorOptions {
  readonly maxDiffBytes?: number;
  readonly maxFileBytes?: number;
  readonly maxFiles?: number;
  readonly maxInputBytes?: number;
  readonly isPathAllowed?: (repositoryRelativePath: string) => boolean;
}

interface BaselineCandidate {
  readonly path: string;
  readonly checkpointId: string;
  readonly entry: CheckpointFileSnapshot;
}

/**
 * Compares integrity-verified checkpoint before-images with current worktree
 * bytes. It contains no session, protocol, model, or browser knowledge.
 */
export class SnapshotDiffInspector {
  private readonly maxDiffBytes: number;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly maxInputBytes: number;
  private readonly isPathAllowed: (repositoryRelativePath: string) => boolean;

  public constructor(
    private readonly boundary: RepositoryBoundary,
    private readonly checkpoints: CheckpointStore,
    options: SnapshotDiffInspectorOptions = {},
  ) {
    this.maxDiffBytes = positive(options.maxDiffBytes ?? 512 * 1024, "maxDiffBytes");
    this.maxFileBytes = positive(options.maxFileBytes ?? 1024 * 1024, "maxFileBytes");
    this.maxFiles = positive(options.maxFiles ?? 200, "maxFiles");
    this.maxInputBytes = positive(
      options.maxInputBytes ?? this.maxFileBytes * Math.min(this.maxFiles, 64) * 2,
      "maxInputBytes",
    );
    this.isPathAllowed = options.isPathAllowed ?? (() => true);
  }

  public async diffCheckpoint(
    checkpointId: string,
    request: SnapshotDiffRequest = {},
    signal?: AbortSignal,
  ): Promise<SnapshotDiffResult> {
    throwIfAborted(signal);
    const requested = await this.resolveRequestedPaths(request.paths ?? []);
    const snapshot = await this.loadCheckpoint(checkpointId);
    const selected: BaselineCandidate[] = [];
    let excludedCount = 0;
    for (const entry of snapshot.entries) {
      if (!matchesRequestedPath(entry.path, requested, this.boundary)) continue;
      if (!this.isPathAllowed(entry.path)) {
        excludedCount += 1;
        continue;
      }
      selected.push({ path: entry.path, checkpointId, entry });
    }
    return this.render("checkpoint", checkpointId, selected, excludedCount, request.maxBytes, signal);
  }

  public async diffSession(
    mutations: readonly SessionMutationDiffRecord[],
    request: SnapshotDiffRequest = {},
    signal?: AbortSignal,
  ): Promise<SnapshotDiffResult> {
    throwIfAborted(signal);
    const requested = await this.resolveRequestedPaths(request.paths ?? []);
    const earliest = new Map<string, { readonly path: string; readonly checkpointId: string }>();
    for (const mutation of mutations) {
      for (const untrustedPath of mutation.changedPaths) {
        const normalized = normalizeRepositoryPath(untrustedPath);
        const key = this.boundary.pathKey(normalized);
        if (!earliest.has(key)) earliest.set(key, { path: normalized, checkpointId: mutation.checkpointId });
      }
    }

    const allowed: Array<{ readonly path: string; readonly checkpointId: string }> = [];
    let excludedCount = 0;
    for (const candidate of earliest.values()) {
      if (!matchesRequestedPath(candidate.path, requested, this.boundary)) continue;
      if (!this.isPathAllowed(candidate.path)) {
        excludedCount += 1;
        continue;
      }
      allowed.push(candidate);
    }
    allowed.sort((left, right) => left.path.localeCompare(right.path));
    this.assertFileCount(allowed.length);

    const byCheckpoint = new Map<string, typeof allowed>();
    for (const candidate of allowed) {
      const group = byCheckpoint.get(candidate.checkpointId) ?? [];
      group.push(candidate);
      byCheckpoint.set(candidate.checkpointId, group);
    }

    const baselineByPath = new Map<string, BaselineCandidate>();
    for (const [checkpointId, candidates] of byCheckpoint) {
      throwIfAborted(signal);
      const snapshot = await this.loadCheckpoint(checkpointId);
      const entries = new Map(snapshot.entries.map((entry) => [this.boundary.pathKey(entry.path), entry]));
      for (const candidate of candidates) {
        const entry = entries.get(this.boundary.pathKey(candidate.path));
        if (entry === undefined) {
          throw new AgentError(
            "CHECKPOINT_CORRUPT",
            "A session mutation is missing its checkpoint before-image",
            { checkpointId },
          );
        }
        baselineByPath.set(this.boundary.pathKey(candidate.path), { ...candidate, entry });
      }
    }

    const selected = allowed.map((candidate) => {
      const baseline = baselineByPath.get(this.boundary.pathKey(candidate.path));
      if (baseline === undefined) {
        throw new AgentError("CHECKPOINT_CORRUPT", "Session checkpoint inventory is incomplete");
      }
      return baseline;
    });
    return this.render(
      "session",
      "earliest-agent-checkpoint",
      selected,
      excludedCount,
      request.maxBytes,
      signal,
    );
  }

  private async render(
    scope: SnapshotDiffResult["scope"],
    baseline: string,
    selected: readonly BaselineCandidate[],
    excludedCount: number,
    requestedMaxBytes: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<SnapshotDiffResult> {
    this.assertFileCount(selected.length);
    const limitBytes = boundedLimit(requestedMaxBytes, this.maxDiffBytes);
    const writer = new BoundedTextWriter(limitBytes);
    let inputBytes = 0;
    let comparedFileCount = 0;
    let changedFileCount = 0;

    for (const candidate of [...selected].sort((left, right) => left.path.localeCompare(right.path))) {
      throwIfAborted(signal);
      const before = candidate.entry.bytes;
      if (before !== null && before.length > this.maxFileBytes) {
        throw new AgentError("BUDGET_EXCEEDED", "Snapshot diff input exceeds the per-file limit");
      }
      const current = await this.currentBytes(candidate.path);
      inputBytes += (before?.length ?? 0) + (current?.length ?? 0);
      if (!Number.isSafeInteger(inputBytes) || inputBytes > this.maxInputBytes) {
        throw new AgentError("BUDGET_EXCEEDED", "Snapshot diff input exceeds the aggregate limit", {
          maxInputBytes: this.maxInputBytes,
        });
      }
      comparedFileCount += 1;
      if (sameOptionalBytes(before, current) && candidate.entry.existed === (current !== null)) continue;
      changedFileCount += 1;
      renderFileDiff(writer, candidate.path, before, current, candidate.entry.mode);
    }

    const bytes = writer.bytes();
    return {
      contractVersion: SNAPSHOT_DIFF_VERSION,
      scope,
      baseline,
      diff: bytes.toString("utf8"),
      truncated: writer.truncated,
      outputBytes: bytes.length,
      sha256: sha256(bytes),
      excludedCount,
      comparedFileCount,
      changedFileCount,
      limitBytes,
    };
  }

  private async currentBytes(repositoryRelativePath: string): Promise<Buffer | null> {
    const resolved = await this.boundary.resolve(repositoryRelativePath, { allowMissingLeaf: true });
    if (!resolved.exists) return null;
    const existing = await this.boundary.resolveExistingFile(repositoryRelativePath);
    return (await readRegularFile(existing.absolutePath, existing.relativePath, this.maxFileBytes)).bytes;
  }

  private async resolveRequestedPaths(paths: readonly string[]): Promise<readonly string[]> {
    const resolved: string[] = [];
    for (const candidate of paths) {
      const entry = await this.boundary.resolve(candidate, { allowMissingTail: true });
      resolved.push(entry.relativePath);
    }
    return [...new Set(resolved)].sort();
  }

  private async loadCheckpoint(checkpointId: string): Promise<CheckpointSnapshot> {
    try {
      return await this.checkpoints.snapshot(checkpointId);
    } catch (error) {
      if (error instanceof AgentError) {
        throw new AgentError(
          error.code,
          "Checkpoint baseline is unavailable or failed integrity validation",
          { checkpointId },
          { cause: error },
        );
      }
      throw error;
    }
  }

  private assertFileCount(count: number): void {
    if (count > this.maxFiles) {
      throw new AgentError("BUDGET_EXCEEDED", "Snapshot diff file count exceeds the configured limit", {
        fileCount: count,
        maxFiles: this.maxFiles,
      });
    }
  }
}

class BoundedTextWriter {
  private readonly chunks: Buffer[] = [];
  private retainedBytes = 0;
  public truncated = false;

  public constructor(private readonly maxBytes: number) {}

  public append(value: string): boolean {
    if (this.truncated) return false;
    const bytes = Buffer.from(value, "utf8");
    if (this.retainedBytes + bytes.length > this.maxBytes) {
      this.truncated = true;
      return false;
    }
    this.chunks.push(bytes);
    this.retainedBytes += bytes.length;
    return true;
  }

  public bytes(): Buffer {
    return Buffer.concat(this.chunks, this.retainedBytes);
  }
}

interface DiffLine {
  readonly text: string;
  readonly noNewline: boolean;
}

interface DiffOperation {
  readonly type: "equal" | "delete" | "add";
  readonly line: DiffLine;
}

interface PositionedOperation extends DiffOperation {
  readonly oldLine: number;
  readonly newLine: number;
}

function renderFileDiff(
  writer: BoundedTextWriter,
  repositoryRelativePath: string,
  before: Buffer | null,
  after: Buffer | null,
  beforeMode: number | null,
): void {
  if (!writer.append(`diff --git ${formatDiffPath("a", repositoryRelativePath)} ${formatDiffPath("b", repositoryRelativePath)}\n`)) {
    return;
  }
  if (before === null) writer.append(`new file mode ${formatMode(beforeMode)}\n`);
  if (after === null) writer.append(`deleted file mode ${formatMode(beforeMode)}\n`);
  writer.append(`--- ${before === null ? "/dev/null" : formatDiffPath("a", repositoryRelativePath)}\n`);
  writer.append(`+++ ${after === null ? "/dev/null" : formatDiffPath("b", repositoryRelativePath)}\n`);

  if (before !== null && after !== null && (looksBinary(before) || looksBinary(after))) {
    writer.append(`Binary files ${formatDiffPath("a", repositoryRelativePath)} and ${formatDiffPath("b", repositoryRelativePath)} differ\n`);
    return;
  }
  const beforeLines = decodeLines(before);
  const afterLines = decodeLines(after);
  if (beforeLines === undefined || afterLines === undefined) {
    writer.append(`Binary files ${before === null ? "/dev/null" : formatDiffPath("a", repositoryRelativePath)} and ${after === null ? "/dev/null" : formatDiffPath("b", repositoryRelativePath)} differ\n`);
    return;
  }
  const operations = diffLines(beforeLines, afterLines);
  if (operations.length === 0) {
    // Existence changes for empty files have no line edit, but the file headers
    // and explicit empty hunk still describe the checkpoint delta.
    writer.append("@@ -0,0 +0,0 @@\n");
    return;
  }
  for (const hunk of diffHunks(operations, 3)) {
    if (!writer.append(hunk.header)) return;
    for (const operation of hunk.operations) {
      const prefix = operation.type === "equal" ? " " : operation.type === "delete" ? "-" : "+";
      if (!writer.append(`${prefix}${operation.line.text}\n`)) return;
      if (operation.line.noNewline && !writer.append("\\ No newline at end of file\n")) return;
    }
  }
}

function decodeLines(bytes: Buffer | null): readonly DiffLine[] | undefined {
  if (bytes === null || bytes.length === 0) return [];
  if (looksBinary(bytes)) return undefined;
  let text: string;
  try {
    // Preserve line-ending bytes in the display model. A CRLF-to-LF-only edit
    // is still a real checkpoint delta and must not collapse to empty hunks.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  const hasFinalNewline = text.endsWith("\n");
  const values = text.split("\n");
  if (hasFinalNewline) values.pop();
  return values.map((value, index) => ({
    text: value,
    noNewline: !hasFinalNewline && index === values.length - 1,
  }));
}

function diffLines(before: readonly DiffLine[], after: readonly DiffLine[]): readonly DiffOperation[] {
  const cells = (before.length + 1) * (after.length + 1);
  if (Number.isSafeInteger(cells) && cells <= 1_000_000) {
    return lcsDiff(before, after);
  }
  return prefixSuffixDiff(before, after);
}

function lcsDiff(before: readonly DiffLine[], after: readonly DiffLine[]): readonly DiffOperation[] {
  const columns = after.length + 1;
  const table = new Uint32Array((before.length + 1) * columns);
  for (let oldIndex = before.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = after.length - 1; newIndex >= 0; newIndex -= 1) {
      const offset = oldIndex * columns + newIndex;
      table[offset] = sameLine(before[oldIndex], after[newIndex])
        ? 1 + (table[(oldIndex + 1) * columns + newIndex + 1] ?? 0)
        : Math.max(
            table[(oldIndex + 1) * columns + newIndex] ?? 0,
            table[oldIndex * columns + newIndex + 1] ?? 0,
          );
    }
  }
  const operations: DiffOperation[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < before.length || newIndex < after.length) {
    const oldLine = before[oldIndex];
    const newLine = after[newIndex];
    if (oldLine !== undefined && newLine !== undefined && sameLine(oldLine, newLine)) {
      operations.push({ type: "equal", line: oldLine });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      newLine !== undefined &&
      (oldLine === undefined ||
        (table[oldIndex * columns + newIndex + 1] ?? 0) >
          (table[(oldIndex + 1) * columns + newIndex] ?? 0))
    ) {
      operations.push({ type: "add", line: newLine });
      newIndex += 1;
    } else if (oldLine !== undefined) {
      operations.push({ type: "delete", line: oldLine });
      oldIndex += 1;
    }
  }
  return operations;
}

function prefixSuffixDiff(before: readonly DiffLine[], after: readonly DiffLine[]): readonly DiffOperation[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && sameLine(before[prefix], after[prefix])) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    sameLine(before[before.length - suffix - 1], after[after.length - suffix - 1])
  ) {
    suffix += 1;
  }
  return [
    ...before.slice(0, prefix).map((line): DiffOperation => ({ type: "equal", line })),
    ...before.slice(prefix, before.length - suffix).map((line): DiffOperation => ({ type: "delete", line })),
    ...after.slice(prefix, after.length - suffix).map((line): DiffOperation => ({ type: "add", line })),
    ...before.slice(before.length - suffix).map((line): DiffOperation => ({ type: "equal", line })),
  ];
}

function diffHunks(
  operations: readonly DiffOperation[],
  context: number,
): readonly { readonly header: string; readonly operations: readonly PositionedOperation[] }[] {
  const positioned: PositionedOperation[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const operation of operations) {
    positioned.push({ ...operation, oldLine, newLine });
    if (operation.type !== "add") oldLine += 1;
    if (operation.type !== "delete") newLine += 1;
  }
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < positioned.length; index += 1) {
    if (positioned[index]?.type === "equal") continue;
    const next = { start: Math.max(0, index - context), end: Math.min(positioned.length - 1, index + context) };
    const prior = ranges.at(-1);
    if (prior !== undefined && next.start <= prior.end + 1) prior.end = Math.max(prior.end, next.end);
    else ranges.push(next);
  }
  return ranges.map((range) => {
    const items = positioned.slice(range.start, range.end + 1);
    const oldItems = items.filter((item) => item.type !== "add");
    const newItems = items.filter((item) => item.type !== "delete");
    const first = items[0];
    const oldStart = oldItems[0]?.oldLine ?? Math.max(0, (first?.oldLine ?? 1) - 1);
    const newStart = newItems[0]?.newLine ?? Math.max(0, (first?.newLine ?? 1) - 1);
    return {
      header: `@@ -${oldStart},${oldItems.length} +${newStart},${newItems.length} @@\n`,
      operations: items,
    };
  });
}

function sameLine(left: DiffLine | undefined, right: DiffLine | undefined): boolean {
  return left !== undefined && right !== undefined && left.text === right.text && left.noNewline === right.noNewline;
}

function sameOptionalBytes(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

function matchesRequestedPath(
  candidate: string,
  requested: readonly string[],
  boundary: RepositoryBoundary,
): boolean {
  if (requested.length === 0) return true;
  const normalizedCandidate = boundary.pathKey(candidate);
  return requested.some((value) => {
    const normalized = boundary.pathKey(value);
    return normalizedCandidate === normalized || normalizedCandidate.startsWith(`${normalized}/`);
  });
}

function formatDiffPath(prefix: "a" | "b", repositoryRelativePath: string): string {
  const value = `${prefix}/${repositoryRelativePath}`;
  return /[\s"\\]/u.test(value) ? JSON.stringify(value) : value;
}

function formatMode(mode: number | null): string {
  return mode !== null && (mode & 0o111) !== 0 ? "100755" : "100644";
}

function boundedLimit(requested: number | undefined, configured: number): number {
  if (requested === undefined) return configured;
  return Math.min(positive(requested, "maxBytes"), configured);
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AgentError("CONFIG_INVALID", `${name} must be a positive safe integer`, { [name]: value });
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new AgentError("COMMAND_CANCELLED", "Snapshot diff was cancelled");
}
