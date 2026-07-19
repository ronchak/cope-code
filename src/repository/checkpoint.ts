import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { AgentError } from "../shared/errors.js";
import { newId, sha256, stableJson } from "../shared/crypto.js";
import { isOperationId } from "../shared/operation-id.js";
import type { RepositoryBoundary } from "./boundary.js";
import { normalizeRepositoryPath } from "./boundary.js";
import { CURRENT_HOST_PLATFORM } from "../platform/index.js";

export const CHECKPOINT_VERSION = "checkpoint.v1" as const;

interface CheckpointEntry {
  readonly path: string;
  readonly existed: boolean;
  readonly sizeBytes: number;
  readonly sha256: string | null;
  readonly mode: number | null;
  readonly blob: string | null;
  readonly expectedAfter?: {
    readonly existed: boolean;
    readonly sha256: string | null;
  };
}

interface CheckpointBody {
  readonly version: typeof CHECKPOINT_VERSION;
  readonly id: string;
  readonly createdAt: string;
  readonly repositoryFingerprint: string;
  /** Durable association written before the first worktree mutation. */
  readonly operationId?: string;
  readonly sealedAt?: string;
  readonly entries: readonly CheckpointEntry[];
  readonly totalBytes: number;
}

interface CheckpointManifest extends CheckpointBody {
  readonly integrity: string;
}

export interface CheckpointSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly paths: readonly string[];
  readonly totalBytes: number;
  readonly integrity: string;
  readonly operationId?: string;
  readonly sealed: boolean;
}

/** Integrity-verified before-image bytes captured for one mutation boundary. */
export interface CheckpointFileSnapshot {
  readonly path: string;
  readonly existed: boolean;
  readonly bytes: Buffer | null;
  readonly mode: number | null;
  readonly sha256: string | null;
}

export interface CheckpointSnapshot {
  readonly id: string;
  readonly createdAt: string;
  readonly operationId?: string;
  readonly entries: readonly CheckpointFileSnapshot[];
}

export interface CheckpointPostState {
  readonly path: string;
  readonly sha256: string | null;
}

export interface RollbackOptions {
  /** Explicitly permits overwriting content that changed after the agent patch. */
  readonly force?: boolean;
}

export interface CheckpointStoreOptions {
  readonly maxCheckpointBytes?: number;
  readonly maxFiles?: number;
  readonly allowInsideRepository?: boolean;
}

export class CheckpointStore {
  private readonly maxCheckpointBytes: number;
  private readonly maxFiles: number;

  private constructor(
    private readonly boundary: RepositoryBoundary,
    public readonly storageDirectory: string,
    options: CheckpointStoreOptions,
  ) {
    this.maxCheckpointBytes = options.maxCheckpointBytes ?? 16 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 200;
  }

  public static async create(
    boundary: RepositoryBoundary,
    storageDirectory: string,
    options: CheckpointStoreOptions = {},
  ): Promise<CheckpointStore> {
    const lexicalStorage = await canonicalizeProspectivePath(storageDirectory);
    if (
      options.allowInsideRepository !== true &&
      isWithin(boundary.root, lexicalStorage)
    ) {
      throw new AgentError(
        "CONFIG_INVALID",
        "Checkpoint storage must be outside the repository unless explicitly approved",
        { storageDirectory: lexicalStorage },
      );
    }
    await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
    const canonicalStorage = await realpath(storageDirectory);
    if (
      options.allowInsideRepository !== true &&
      isWithin(boundary.root, canonicalStorage)
    ) {
      throw new AgentError(
        "CONFIG_INVALID",
        "Checkpoint storage must be outside the repository unless explicitly approved",
        { storageDirectory: canonicalStorage },
      );
    }
    return new CheckpointStore(boundary, canonicalStorage, options);
  }

  public async createCheckpoint(
    untrustedPaths: readonly string[],
    operationId?: string,
  ): Promise<CheckpointSummary> {
    if (operationId !== undefined && !isOperationId(operationId)) {
      throw new AgentError("PROTOCOL_INVALID", "Checkpoint operation identifier is invalid");
    }
    const normalizedPaths = new Map<string, string>();
    for (const value of untrustedPaths) {
      const normalized = normalizeRepositoryPath(value);
      const key = this.boundary.pathKey(normalized);
      if (normalizedPaths.has(key)) {
        throw new AgentError("PROTOCOL_INVALID", "Checkpoint paths contain filesystem aliases", {
          path: normalized,
        });
      }
      normalizedPaths.set(key, normalized);
    }
    const paths = [...normalizedPaths.values()].sort();
    if (paths.length === 0 || paths.length > this.maxFiles) {
      throw new AgentError("BUDGET_EXCEEDED", "Checkpoint file count is outside the configured bound", {
        fileCount: paths.length,
        maxFiles: this.maxFiles,
      });
    }

    const id = newId("checkpoint");
    const checkpointDirectory = path.join(this.storageDirectory, id);
    const blobDirectory = path.join(checkpointDirectory, "blobs");
    await mkdir(blobDirectory, { recursive: true, mode: 0o700 });
    const entries: CheckpointEntry[] = [];
    let totalBytes = 0;

    try {
      for (let index = 0; index < paths.length; index += 1) {
        const relativePath = paths[index];
        if (relativePath === undefined) {
          throw new AgentError("INTERNAL_ERROR", "Checkpoint path unexpectedly missing");
        }
        const resolved = await this.boundary.resolve(relativePath, { allowMissingLeaf: true });
        if (!resolved.exists) {
          entries.push({
            path: relativePath,
            existed: false,
            sizeBytes: 0,
            sha256: null,
            mode: null,
            blob: null,
          });
          continue;
        }
        const existing = await this.boundary.resolveExistingFile(relativePath);
        const entryStat = await stat(existing.absolutePath);
        const bytes = await readFile(existing.absolutePath);
        totalBytes += bytes.length;
        if (totalBytes > this.maxCheckpointBytes) {
          throw new AgentError("BUDGET_EXCEEDED", "Checkpoint exceeds the configured size limit", {
            totalBytes,
            maxBytes: this.maxCheckpointBytes,
          });
        }
        const blob = `${index}.bin`;
        await writeFile(path.join(blobDirectory, blob), bytes, {
          flag: "wx",
          mode: 0o600,
          flush: true,
        });
        entries.push({
          path: relativePath,
          existed: true,
          sizeBytes: bytes.length,
          sha256: sha256(bytes),
          mode: entryStat.mode & 0o777,
          blob,
        });
      }

      const body: CheckpointBody = {
        version: CHECKPOINT_VERSION,
        id,
        createdAt: new Date().toISOString(),
        repositoryFingerprint: repositoryFingerprint(this.boundary),
        ...(operationId === undefined ? {} : { operationId }),
        entries,
        totalBytes,
      };
      const manifest: CheckpointManifest = { ...body, integrity: sha256(stableJson(body)) };
      const temporaryManifest = path.join(checkpointDirectory, "manifest.json.tmp");
      await writeFile(temporaryManifest, `${stableJson(manifest)}\n`, {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      await rename(temporaryManifest, path.join(checkpointDirectory, "manifest.json"));
      return summary(manifest);
    } catch (error) {
      await rm(checkpointDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  public async verify(checkpointId: string): Promise<CheckpointSummary> {
    return summary(await this.loadAndVerify(checkpointId));
  }

  /**
   * Loads checkpoint before-images through the same integrity boundary used by
   * rollback. Returned buffers are local repository data and must still pass
   * path/disclosure policy before leaving the repository layer.
   */
  public async snapshot(checkpointId: string): Promise<CheckpointSnapshot> {
    const manifest = await this.loadAndVerify(checkpointId);
    const checkpointDirectory = path.join(this.storageDirectory, checkpointId);
    const entries: CheckpointFileSnapshot[] = [];
    for (const entry of manifest.entries) {
      if (!entry.existed) {
        entries.push({
          path: entry.path,
          existed: false,
          bytes: null,
          mode: null,
          sha256: null,
        });
        continue;
      }
      if (entry.blob === null || entry.sha256 === null || entry.mode === null) {
        throw new AgentError("CHECKPOINT_CORRUPT", "Verified checkpoint entry became invalid", {
          checkpointId,
        });
      }
      // Recheck after the manifest verification so a blob replacement between
      // verification and this read cannot cross the snapshot boundary.
      const bytes = await readFile(path.join(checkpointDirectory, "blobs", entry.blob));
      if (bytes.length !== entry.sizeBytes || sha256(bytes) !== entry.sha256) {
        throw new AgentError("CHECKPOINT_CORRUPT", "Checkpoint blob changed during snapshot load", {
          checkpointId,
        });
      }
      entries.push({
        path: entry.path,
        existed: true,
        bytes,
        mode: entry.mode,
        sha256: entry.sha256,
      });
    }
    return {
      id: manifest.id,
      createdAt: manifest.createdAt,
      ...(manifest.operationId === undefined ? {} : { operationId: manifest.operationId }),
      entries,
    };
  }

  /**
   * Returns the newest integrity-verified checkpoint in this session store.
   * The optional operation filter recovers the durable mutation intent even
   * when a process stopped before SessionState learned the checkpoint ID.
   */
  public async latest(operationId?: string): Promise<CheckpointSummary | undefined> {
    if (operationId !== undefined && !isOperationId(operationId)) {
      throw new AgentError("PROTOCOL_INVALID", "Checkpoint operation identifier is invalid");
    }
    const directoryEntries = await readdir(this.storageDirectory, { withFileTypes: true });
    const checkpoints: CheckpointSummary[] = [];
    for (const entry of directoryEntries) {
      if (!entry.isDirectory() || !/^checkpoint_[0-9a-f-]{36}$/iu.test(entry.name)) continue;
      const manifest = await this.loadAndVerify(entry.name);
      if (operationId === undefined || manifest.operationId === operationId) {
        checkpoints.push(summary(manifest));
      }
    }
    checkpoints.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    return checkpoints.at(-1);
  }

  /**
   * Records the exact post-mutation hashes. Sealing turns rollback into a
   * compare-and-restore operation so later user edits cannot be overwritten
   * silently. An unsealed checkpoint is an interrupted transaction. It remains
   * recoverable, but only through the explicit force path because the harness
   * cannot distinguish partial agent writes from later user edits.
   */
  public async seal(
    checkpointId: string,
    states: readonly CheckpointPostState[],
    now = new Date().toISOString(),
  ): Promise<CheckpointSummary> {
    const manifest = await this.loadAndVerify(checkpointId);
    const normalizedStates = new Map<string, string | null>();
    for (const state of states) {
      const normalized = normalizeRepositoryPath(state.path);
      const key = this.boundary.pathKey(normalized);
      if (normalizedStates.has(key) || (state.sha256 !== null && !/^[0-9a-f]{64}$/u.test(state.sha256))) {
        throw new AgentError("PROTOCOL_INVALID", "Checkpoint post-state inventory is invalid", {
          path: state.path,
        });
      }
      normalizedStates.set(key, state.sha256);
    }
    if (normalizedStates.size !== manifest.entries.length) {
      throw new AgentError("RECOVERY_REQUIRED", "Checkpoint post-state inventory is incomplete", {
        checkpointId,
      });
    }
    const entries = manifest.entries.map((entry) => {
      const entryKey = this.boundary.pathKey(entry.path);
      if (!normalizedStates.has(entryKey)) {
        throw new AgentError("RECOVERY_REQUIRED", "Checkpoint post-state inventory path does not match", {
          checkpointId,
          path: entry.path,
        });
      }
      const postHash = normalizedStates.get(entryKey) ?? null;
      return {
        ...entry,
        expectedAfter: { existed: postHash !== null, sha256: postHash },
      };
    });
    if (manifest.sealedAt !== undefined) {
      if (stableJson(entries) !== stableJson(manifest.entries)) {
        throw new AgentError("RECOVERY_REQUIRED", "Checkpoint was already sealed with a different post-state", {
          checkpointId,
        });
      }
      return summary(manifest);
    }
    const { integrity: _integrity, ...priorBody } = manifest;
    const body: CheckpointBody = { ...priorBody, entries, sealedAt: now };
    const sealed: CheckpointManifest = { ...body, integrity: sha256(stableJson(body)) };
    await this.replaceManifest(sealed);
    return summary(sealed);
  }

  public async rollback(checkpointId: string, options: RollbackOptions = {}): Promise<CheckpointSummary> {
    const manifest = await this.loadAndVerify(checkpointId);
    if (manifest.sealedAt === undefined && options.force !== true) {
      throw new AgentError(
        "STALE_STATE",
        "Interrupted checkpoint has no verified post-mutation state; reconcile it or use the explicit force override",
        { checkpointId },
      );
    }
    if (manifest.sealedAt !== undefined && options.force !== true) {
      await this.assertExpectedPostState(manifest);
    }
    const rollbackState: Array<{
      readonly path: string;
      readonly existed: boolean;
      readonly bytes?: Buffer;
      readonly mode?: number;
    }> = [];

    for (const entry of manifest.entries) {
      const resolved = await this.boundary.resolve(entry.path, { allowMissingLeaf: true });
      if (!resolved.exists) {
        rollbackState.push({ path: entry.path, existed: false });
      } else {
        const existing = await this.boundary.resolveExistingFile(entry.path);
        const existingStat = await stat(existing.absolutePath);
        rollbackState.push({
          path: entry.path,
          existed: true,
          bytes: await readFile(existing.absolutePath),
          mode: existingStat.mode & 0o777,
        });
      }
    }

    try {
      await this.restoreManifest(manifest);
    } catch (error) {
      try {
        await this.restoreSnapshots(rollbackState);
      } catch (restoreError) {
        throw new AgentError(
          "RECOVERY_REQUIRED",
          "Checkpoint rollback failed and the pre-rollback state could not be restored",
          { checkpointId, restoreError: String(restoreError) },
          { cause: error },
        );
      }
      throw new AgentError(
        "RECOVERY_REQUIRED",
        "Checkpoint rollback failed; the pre-rollback state was restored",
        { checkpointId },
        { cause: error },
      );
    }
    return summary(manifest);
  }

  private async assertExpectedPostState(manifest: CheckpointManifest): Promise<void> {
    for (const entry of manifest.entries) {
      if (entry.expectedAfter === undefined) {
        throw new AgentError("CHECKPOINT_CORRUPT", "Sealed checkpoint lacks post-state evidence", {
          checkpointId: manifest.id,
          path: entry.path,
        });
      }
      const current = await this.boundary.resolve(entry.path, { allowMissingLeaf: true });
      if (current.exists !== entry.expectedAfter.existed) {
        throw new AgentError("STALE_STATE", "Rollback target changed after the agent mutation", {
          checkpointId: manifest.id,
          path: entry.path,
        });
      }
      if (current.exists) {
        const existing = await this.boundary.resolveExistingFile(entry.path);
        const currentHash = sha256(await readFile(existing.absolutePath));
        if (currentHash !== entry.expectedAfter.sha256) {
          throw new AgentError("STALE_STATE", "Rollback target changed after the agent mutation", {
            checkpointId: manifest.id,
            path: entry.path,
            expectedSha256: entry.expectedAfter.sha256,
            actualSha256: currentHash,
          });
        }
      }
    }
  }

  private async replaceManifest(manifest: CheckpointManifest): Promise<void> {
    const destination = path.join(this.storageDirectory, manifest.id, "manifest.json");
    const temporary = `${destination}.${newId("seal")}.tmp`;
    try {
      await writeFile(temporary, `${stableJson(manifest)}\n`, {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async loadAndVerify(checkpointId: string): Promise<CheckpointManifest> {
    if (!/^checkpoint_[0-9a-f-]{36}$/iu.test(checkpointId)) {
      throw new AgentError("CHECKPOINT_CORRUPT", "Checkpoint identifier is invalid", {
        checkpointId,
      });
    }
    const checkpointDirectory = path.join(this.storageDirectory, checkpointId);
    const manifestPath = path.join(checkpointDirectory, "manifest.json");
    let raw: string;
    try {
      const manifestStat = await stat(manifestPath);
      if (manifestStat.size > 1024 * 1024) {
        throw new AgentError("CHECKPOINT_CORRUPT", "Checkpoint manifest is oversized", {
          checkpointId,
        });
      }
      raw = await readFile(manifestPath, "utf8");
    } catch (error) {
      if (error instanceof AgentError) {
        throw error;
      }
      throw new AgentError(
        "CHECKPOINT_CORRUPT",
        "Checkpoint manifest is unavailable",
        { checkpointId },
        { cause: error },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new AgentError(
        "CHECKPOINT_CORRUPT",
        "Checkpoint manifest is not valid JSON",
        { checkpointId },
        { cause: error },
      );
    }
    if (!isManifest(parsed)) {
      throw new AgentError("CHECKPOINT_CORRUPT", "Checkpoint manifest has an invalid shape", {
        checkpointId,
      });
    }
    const { integrity: _integrity, ...body } = parsed;
    if (sha256(stableJson(body)) !== parsed.integrity) {
      throw new AgentError("CHECKPOINT_CORRUPT", "Checkpoint manifest integrity check failed", {
        checkpointId,
      });
    }
    if (parsed.id !== checkpointId) {
      throw new AgentError("CHECKPOINT_CORRUPT", "Checkpoint manifest identifier does not match", {
        checkpointId,
      });
    }
    if (parsed.repositoryFingerprint !== repositoryFingerprint(this.boundary)) {
      throw new AgentError("CHECKPOINT_CORRUPT", "Checkpoint belongs to a different repository", {
        checkpointId,
      });
    }
    if (parsed.entries.length > this.maxFiles || parsed.totalBytes > this.maxCheckpointBytes) {
      throw new AgentError("CHECKPOINT_CORRUPT", "Checkpoint exceeds configured recovery limits", {
        checkpointId,
      });
    }

    const seen = new Set<string>();
    let observedTotal = 0;
    for (const entry of parsed.entries) {
      const normalized = normalizeRepositoryPath(entry.path);
      const key = this.boundary.pathKey(normalized);
      if (normalized !== entry.path || seen.has(key)) {
        throw new AgentError("CHECKPOINT_CORRUPT", "Checkpoint contains an unsafe path", {
          checkpointId,
          path: entry.path,
        });
      }
      seen.add(key);
      await this.boundary.resolve(normalized, { allowMissingLeaf: true });
      if (!entry.existed) {
        if (
          entry.blob !== null ||
          entry.sha256 !== null ||
          entry.mode !== null ||
          entry.sizeBytes !== 0
        ) {
          throw new AgentError("CHECKPOINT_CORRUPT", "Absent checkpoint entry is inconsistent", {
            checkpointId,
            path: entry.path,
          });
        }
        continue;
      }
      if (entry.blob === null || !/^\d+\.bin$/u.test(entry.blob) || entry.sha256 === null) {
        throw new AgentError("CHECKPOINT_CORRUPT", "Checkpoint blob reference is invalid", {
          checkpointId,
          path: entry.path,
        });
      }
      const blobPath = path.join(checkpointDirectory, "blobs", entry.blob);
      const bytes = await readFile(blobPath);
      observedTotal += bytes.length;
      if (bytes.length !== entry.sizeBytes || sha256(bytes) !== entry.sha256) {
        throw new AgentError("CHECKPOINT_CORRUPT", "Checkpoint blob integrity check failed", {
          checkpointId,
          path: entry.path,
        });
      }
    }
    if (observedTotal !== parsed.totalBytes) {
      throw new AgentError("CHECKPOINT_CORRUPT", "Checkpoint byte inventory is inconsistent", {
        checkpointId,
      });
    }
    return parsed;
  }

  private async restoreManifest(manifest: CheckpointManifest): Promise<void> {
    const checkpointDirectory = path.join(this.storageDirectory, manifest.id);
    for (const entry of manifest.entries) {
      const target = await this.boundary.resolve(entry.path, { allowMissingLeaf: true });
      if (!entry.existed) {
        if (target.exists) {
          await rm(target.absolutePath, { force: false });
        }
        await cleanupMutationArtifacts(target.absolutePath, entry.path, manifest.id);
        continue;
      }
      if (entry.blob === null || entry.mode === null) {
        throw new AgentError("CHECKPOINT_CORRUPT", "Verified checkpoint entry became invalid");
      }
      const bytes = await readFile(path.join(checkpointDirectory, "blobs", entry.blob));
      await atomicWrite(target.absolutePath, bytes, entry.mode);
      await cleanupMutationArtifacts(target.absolutePath, entry.path, manifest.id);
    }
  }

  private async restoreSnapshots(
    snapshots: readonly {
      readonly path: string;
      readonly existed: boolean;
      readonly bytes?: Buffer;
      readonly mode?: number;
    }[],
  ): Promise<void> {
    for (const snapshot of snapshots) {
      const target = await this.boundary.resolve(snapshot.path, { allowMissingLeaf: true });
      if (!snapshot.existed) {
        if (target.exists) {
          await rm(target.absolutePath, { force: false });
        }
      } else {
        if (snapshot.bytes === undefined || snapshot.mode === undefined) {
          throw new Error("Rollback snapshot is incomplete");
        }
        await atomicWrite(target.absolutePath, snapshot.bytes, snapshot.mode);
      }
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function canonicalizeProspectivePath(candidate: string): Promise<string> {
  let cursor = path.resolve(candidate);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      const canonicalAncestor = await realpath(cursor);
      return path.join(canonicalAncestor, ...missingSegments.reverse());
    } catch (error) {
      if (
        error === null ||
        typeof error !== "object" ||
        !("code" in error) ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw error;
      }
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function checkpointMutationArtifactPaths(
  absoluteTarget: string,
  relativePath: string,
  checkpointId: string,
): { readonly temporaryPath: string; readonly backupPath: string } {
  const key = sha256(relativePath).slice(0, 20);
  const prefix = `.cba-${checkpointId}-${key}`;
  return {
    temporaryPath: path.join(path.dirname(absoluteTarget), `${prefix}.new`),
    backupPath: path.join(path.dirname(absoluteTarget), `${prefix}.old`),
  };
}

async function cleanupMutationArtifacts(
  absoluteTarget: string,
  relativePath: string,
  checkpointId: string,
): Promise<void> {
  const artifacts = checkpointMutationArtifactPaths(absoluteTarget, relativePath, checkpointId);
  for (const artifact of [artifacts.temporaryPath, artifacts.backupPath]) {
    await rm(artifact, { force: true });
  }
}

async function atomicWrite(target: string, bytes: Buffer, mode: number): Promise<void> {
  const temporary = path.join(path.dirname(target), `.cba-restore-${newId("file")}`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600, flush: true });
    await rename(temporary, target);
    if (CURRENT_HOST_PLATFORM.supportsPosixModes) {
      await chmod(target, mode);
    }
  } finally {
    try {
      await access(temporary, constants.F_OK);
      await rm(temporary, { force: true });
    } catch {
      // The rename normally consumes the temporary path.
    }
  }
}

function repositoryFingerprint(boundary: RepositoryBoundary): string {
  return sha256(boundary.pathKey(boundary.root));
}

function summary(manifest: CheckpointManifest): CheckpointSummary {
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    paths: manifest.entries.map((entry) => entry.path),
    totalBytes: manifest.totalBytes,
    integrity: manifest.integrity,
    ...(manifest.operationId === undefined ? {} : { operationId: manifest.operationId }),
    sealed: manifest.sealedAt !== undefined,
  };
}

function isManifest(value: unknown): value is CheckpointManifest {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CheckpointManifest>;
  return (
    candidate.version === CHECKPOINT_VERSION &&
    typeof candidate.id === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.repositoryFingerprint === "string" &&
    (candidate.operationId === undefined || isOperationId(candidate.operationId)) &&
    (candidate.sealedAt === undefined || typeof candidate.sealedAt === "string") &&
    typeof candidate.integrity === "string" &&
    typeof candidate.totalBytes === "number" &&
    Array.isArray(candidate.entries) &&
    candidate.entries.every(
      (entry: unknown) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as CheckpointEntry).path === "string" &&
        typeof (entry as CheckpointEntry).existed === "boolean" &&
        typeof (entry as CheckpointEntry).sizeBytes === "number" &&
        (typeof (entry as CheckpointEntry).sha256 === "string" ||
          (entry as CheckpointEntry).sha256 === null) &&
        (typeof (entry as CheckpointEntry).mode === "number" ||
          (entry as CheckpointEntry).mode === null) &&
        (typeof (entry as CheckpointEntry).blob === "string" ||
          (entry as CheckpointEntry).blob === null) &&
        ((entry as CheckpointEntry).expectedAfter === undefined ||
          (typeof (entry as CheckpointEntry).expectedAfter?.existed === "boolean" &&
            ((entry as CheckpointEntry).expectedAfter?.sha256 === null ||
              (typeof (entry as CheckpointEntry).expectedAfter?.sha256 === "string" &&
                /^[0-9a-f]{64}$/u.test((entry as CheckpointEntry).expectedAfter?.sha256 ?? ""))))),
    ) &&
    (candidate.sealedAt === undefined ||
      candidate.entries.every((entry) => (entry as CheckpointEntry).expectedAfter !== undefined))
  );
}
