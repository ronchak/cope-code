import { execFile, spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readlink,
  realpath,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { minimatch } from "minimatch";

import { AgentError } from "../shared/errors.js";
import { sha256, stableJson } from "../shared/crypto.js";
import { detectFilesystemIdentity, type FilesystemIdentity } from "../shared/filesystem-identity.js";
import { CURRENT_HOST_PLATFORM } from "../platform/index.js";
import {
  DEFAULT_GIT_EXECUTABLE,
  normalizeRepositoryPath,
  type RepositoryBoundary,
} from "./boundary.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_CONTROL_BYTES = 64 * 1024 * 1024;
const MAX_IGNORED_INTEGRITY_BYTES = 64 * 1024 * 1024;

export interface GitStatusEntry {
  readonly path: string;
  readonly originalPath?: string;
  readonly kind: "ordinary" | "renamed" | "unmerged" | "untracked" | "ignored";
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  /** Opaque hash of Git's index state and the current worktree object state. */
  readonly stateSha256: string;
}

export interface GitStatusResult {
  readonly branch: string | null;
  readonly head: string | null;
  readonly entries: readonly GitStatusEntry[];
  readonly hasConflicts: boolean;
  readonly excludedCount: number;
  /** Keyed aggregate of policy-hidden status entries; never includes raw paths or content. */
  readonly excludedStateSha256: string;
  readonly snapshotSha256: string;
}

export interface GitIndexIdentity {
  readonly sha256: string;
  readonly bytes: number;
}

export interface GitComponentFingerprints {
  readonly visibleStateSha256: string;
  readonly excludedStateSha256: string;
  readonly protectedWorktreeSha256: string;
  readonly normalTransitionsSha256: string;
  readonly gitControlsSha256: string;
}

export interface GitObservationEntry extends GitStatusEntry {
  readonly headMode?: string;
  readonly indexMode?: string;
  readonly worktreeMode?: string;
  readonly headObject?: string;
  readonly indexObject?: string;
  readonly worktreeIdentity?: {
    readonly mode: number;
    readonly size: number;
    readonly mtimeNs?: string;
    readonly ctimeNs?: string;
    readonly device?: string;
    readonly fileId?: string;
    readonly contentSha256?: string;
  };
}

export interface IsolatedGitReadResult {
  readonly bytes: Buffer;
  readonly truncated: boolean;
  readonly branch: string | null;
  readonly head: string | null;
}

export interface IsolatedGitNulReadResult {
  readonly records: number;
  readonly branch: string | null;
  readonly head: string | null;
}

export interface GitObservationControlFingerprints {
  readonly protectedWorktreeSha256: string;
  readonly normalTransitionsSha256: string;
  readonly gitControlsSha256: string;
}

/**
 * Local-only command boundary evidence. The ignored-worktree component is
 * deliberately never returned to Copilot because it may encode excluded path
 * names. Commands declared side-effect-free use the stronger form; approved
 * side-effecting validation commands may create ordinary ignored build output
 * but must still preserve Git-visible, protected, and Git-control state.
 */
export interface GitCommandBoundaryState {
  readonly status: GitStatusResult;
  readonly integritySha256: string;
  readonly includesIgnoredWorktree: boolean;
}

export interface GitDiffRequest {
  readonly baseline?: "worktree" | "staged" | "head";
  readonly paths?: readonly string[];
  readonly maxBytes?: number;
}

export interface GitDiffResult {
  readonly baseline: "worktree" | "staged" | "head";
  readonly diff: string;
  readonly truncated: boolean;
  readonly outputBytes: number;
  readonly sha256: string;
  /** Count only: denied path names must not cross the disclosure boundary. */
  readonly excludedCount: number;
  /** Effective post-clamp output ceiling. */
  readonly limitBytes: number;
}

export interface GitInspectorOptions {
  readonly gitExecutable?: string;
  readonly maxStatusBytes?: number;
  readonly maxDiffBytes?: number;
  /** Per-session key keeps persisted state fingerprints non-dictionaryable. */
  readonly fingerprintKey?: Uint8Array;
  /** Additional policy-protected path patterns bound into hidden-state integrity. */
  readonly integrityPatterns?: readonly string[];
  readonly maxIntegrityEntries?: number;
  readonly isPathAllowed?: (
    repositoryRelativePath: string,
    operation: "git_status" | "git_diff",
  ) => boolean;
}

export class GitInspector {
  private readonly gitExecutable: string;
  private readonly maxStatusBytes: number;
  private readonly maxDiffBytes: number;
  private readonly fingerprintKey: Uint8Array | undefined;
  private readonly integrityPatterns: readonly string[];
  private readonly maxIntegrityEntries: number;
  private readonly isPathAllowed: (
    repositoryRelativePath: string,
    operation: "git_status" | "git_diff",
  ) => boolean;

  public constructor(
    private readonly boundary: RepositoryBoundary,
    options: GitInspectorOptions = {},
  ) {
    this.gitExecutable = options.gitExecutable ?? DEFAULT_GIT_EXECUTABLE;
    this.maxStatusBytes = options.maxStatusBytes ?? 1024 * 1024;
    this.maxDiffBytes = options.maxDiffBytes ?? 512 * 1024;
    this.fingerprintKey = options.fingerprintKey;
    this.integrityPatterns = [...new Set([...DEFAULT_INTEGRITY_PATTERNS, ...(options.integrityPatterns ?? [])])];
    this.maxIntegrityEntries = options.maxIntegrityEntries ?? 50_000;
    this.isPathAllowed = (candidate, operation) =>
      defaultGitPathAllowed(candidate) && (options.isPathAllowed?.(candidate, operation) ?? true);
  }

  public async status(signal?: AbortSignal): Promise<GitStatusResult> {
    const output = await this.readIsolated(
      [
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
        "--ignore-submodules=all",
      ],
      this.maxStatusBytes,
      signal,
      false,
    );
    if (output.truncated) {
      throw new AgentError("BUDGET_EXCEEDED", "Git status exceeds the configured output limit", {
        maxBytes: this.maxStatusBytes,
      });
    }
    const parsed = {
      ...parseStatus(output.bytes),
      branch: output.branch,
      head: output.head,
    };
    const stateEntries: GitStatusEntry[] = [];
    // Keep descriptor use bounded even for unusually large dirty worktrees.
    for (const entry of parsed.entries) {
      // Ignored entry content hashes do not participate in any returned status
      // digest or summary. Skipping them is byte-compatible and avoids making
      // ignored build churn break ordinary status inspection.
      if (entry.kind === "ignored") {
        stateEntries.push(entry);
        continue;
      }
      stateEntries.push({
        ...entry,
        stateSha256: this.digest(stableJson({
          gitStateSha256: entry.stateSha256,
          worktreeStateSha256: await this.worktreeStateSha256(entry.path),
        })),
      });
    }
    const isVisible = (entry: GitStatusEntry): boolean =>
      entry.kind !== "ignored" &&
      this.isPathAllowed(entry.path, "git_status") &&
      (entry.originalPath === undefined || this.isPathAllowed(entry.originalPath, "git_status"));
    const entries = stateEntries.filter(isVisible);
    const policyHiddenEntries = stateEntries
      .filter((entry) => entry.kind !== "ignored" && !isVisible(entry))
      .sort((left, right) =>
        left.path.localeCompare(right.path) || (left.originalPath ?? "").localeCompare(right.originalPath ?? ""));
    const [protectedStateSha256, gitControlStateSha256] = await Promise.all([
      this.integritySensitiveStateSha256(),
      this.gitControlStateSha256(signal),
    ]);
    const excludedStateSha256 = this.digest(stableJson({
      policyHiddenEntries,
      protectedStateSha256,
      gitControlStateSha256,
    }));
    entries.sort((left, right) =>
      left.path.localeCompare(right.path) || (left.originalPath ?? "").localeCompare(right.originalPath ?? ""));
    return {
      ...parsed,
      entries,
      // Conflict safety is independent of model disclosure policy. A hidden
      // conflict must still prevent completion without revealing its path.
      hasConflicts: stateEntries.some((entry) => entry.kind === "unmerged"),
      excludedCount: parsed.entries.length - entries.length,
      excludedStateSha256,
      // Paths denied to the model remain hidden, while their keyed aggregate
      // still invalidates stale validation if protected state changes.
      snapshotSha256: this.digest(stableJson({
        branch: parsed.branch,
        head: parsed.head,
        entries,
        excludedStateSha256,
      })),
    };
  }

  /**
   * The repository observer's only direct Git execution seam. Commands execute
   * without a shell against the isolated, temporary-index view used by normal
   * inspection, and callers must provide their own strict output bound.
   */
  public async readIsolated(
    fixedArguments: readonly string[],
    maxBytes: number,
    signal?: AbortSignal,
    allowTruncation = false,
  ): Promise<IsolatedGitReadResult> {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 64 * 1024 * 1024
    ) {
      throw new AgentError("PROTOCOL_INVALID", "Isolated Git read bound is invalid");
    }
    const command = fixedArguments[0];
    if (
      command === undefined ||
      !ISOLATED_READ_BUILTINS.has(command) ||
      fixedArguments.some((argument) => argument.includes("\0")) ||
      (command === "hash-object" && fixedArguments.includes("-w"))
    ) {
      throw new AgentError(
        "PROTOCOL_INVALID",
        "Isolated Git reads require a fixed read-only builtin and NUL-free arguments",
      );
    }
    return this.invoke(fixedArguments, maxBytes, signal, allowTruncation);
  }

  /**
   * Streams a complete NUL-delimited read without retaining aggregate output.
   * This is used for exact large transition inventories under a per-record cap.
   */
  public async readIsolatedNul(
    fixedArguments: readonly string[],
    maxRecordBytes: number,
    onRecord: (record: Buffer) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<IsolatedGitNulReadResult> {
    const command = fixedArguments[0];
    if (
      command === undefined ||
      !ISOLATED_READ_BUILTINS.has(command) ||
      fixedArguments.some((argument) => argument.includes("\0")) ||
      (command === "hash-object" && fixedArguments.includes("-w")) ||
      !Number.isSafeInteger(maxRecordBytes) ||
      maxRecordBytes < 1 ||
      maxRecordBytes > 256 * 1024
    ) {
      throw new AgentError("PROTOCOL_INVALID", "Streaming isolated Git read is invalid");
    }
    const isolation = await createIsolatedGitView(
      this.gitExecutable,
      this.boundary.root,
      signal,
    );
    try {
      const child = spawn(
        this.gitExecutable,
        [
          "--no-optional-locks",
          "-c",
          "core.pager=cat",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "diff.external=",
          "-C",
          this.boundary.root,
          ...fixedArguments,
        ],
        {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...gitEnvironment(), ...isolation.environment },
          signal,
        },
      );
      const errors: Buffer[] = [];
      let errorBytes = 0;
      const closePromise = new Promise<{
        readonly code: number | null;
        readonly closeSignal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, closeSignal) => resolve({ code, closeSignal }));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (errorBytes >= 64 * 1024) return;
        const retained = chunk.subarray(0, 64 * 1024 - errorBytes);
        errors.push(retained);
        errorBytes += retained.length;
      });
      let pending = Buffer.alloc(0);
      let records = 0;
      try {
        for await (const chunk of child.stdout) {
          pending = Buffer.concat([pending, Buffer.from(chunk)]);
          let delimiter = pending.indexOf(0);
          while (delimiter !== -1) {
            const record = pending.subarray(0, delimiter);
            if (record.length > maxRecordBytes) {
              child.kill();
              throw new AgentError(
                "BUDGET_EXCEEDED",
                "Streaming Git record exceeds its path bound",
                { maxRecordBytes },
              );
            }
            await onRecord(record);
            records += 1;
            pending = pending.subarray(delimiter + 1);
            delimiter = pending.indexOf(0);
          }
          if (pending.length > maxRecordBytes) {
            child.kill();
            throw new AgentError(
              "BUDGET_EXCEEDED",
              "Streaming Git record exceeds its path bound",
              { maxRecordBytes },
            );
          }
        }
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await closePromise.catch(() => undefined);
        if (signal?.aborted === true) {
          throw new AgentError("COMMAND_CANCELLED", "Git operation was cancelled", {}, {
            cause: error,
          });
        }
        throw error;
      }
      const close = await closePromise;
      if (signal?.aborted === true) {
        throw new AgentError("COMMAND_CANCELLED", "Git operation was cancelled");
      }
      if (close.code !== 0 || pending.length !== 0) {
        throw new AgentError("COMMAND_FAILED", "Streaming Git inspection failed", {
          exitCode: close.code,
          signal: close.closeSignal,
          partialRecordBytes: pending.length,
          stderr: Buffer.concat(errors).toString("utf8"),
        });
      }
      return {
        records,
        branch: isolation.branch,
        head: isolation.head,
      };
    } finally {
      await isolation.cleanup();
    }
  }

  /** Path identity/disclosure decision shared with bounded observation. */
  public observationPathAllowed(repositoryRelativePath: string): boolean {
    return this.isPathAllowed(repositoryRelativePath, "git_status");
  }

  /** Uses the inspector's configured keyed or unkeyed fingerprint definition. */
  public observationDigest(value: string | Uint8Array): string {
    return this.digest(value);
  }

  /** Content-backed policy-hidden component, kept separate from Git controls. */
  public async observationPolicyHiddenStateSha256(
    signal?: AbortSignal,
  ): Promise<string> {
    const output = await this.readIsolated(
      [
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
        "--ignore-submodules=all",
      ],
      this.maxStatusBytes,
      signal,
      false,
    );
    const parsed = parseStatus(output.bytes);
    const hidden: GitStatusEntry[] = [];
    for (const entry of parsed.entries) {
      if (entry.kind === "ignored") continue;
      const visible =
        this.isPathAllowed(entry.path, "git_status") &&
        (
          entry.originalPath === undefined ||
          this.isPathAllowed(entry.originalPath, "git_status")
        );
      if (visible) continue;
      hidden.push({
        ...entry,
        stateSha256: this.digest(stableJson({
          gitStateSha256: entry.stateSha256,
          worktreeStateSha256: await this.worktreeStateSha256(entry.path),
        })),
      });
    }
    hidden.sort((left, right) =>
      compareGitPathBytes(left.path, right.path) ||
      compareGitPathBytes(left.originalPath ?? "", right.originalPath ?? ""));
    return this.digest(stableJson(hidden));
  }

  /** Object format used to authenticate an exact worktree blob identity. */
  public async observationObjectFormat(
    signal?: AbortSignal,
  ): Promise<"sha1" | "sha256"> {
    const output = await this.readIsolated(
      ["rev-parse", "--show-object-format"],
      64,
      signal,
    );
    const value = output.bytes.toString("utf8").trim();
    if (value !== "sha1" && value !== "sha256") {
      throw new AgentError(
        "RECOVERY_REQUIRED",
        "Git repository object format is unsupported",
        { objectFormat: value },
      );
    }
    return value;
  }

  /** Verifies an existing blob without writing or refreshing repository state. */
  public async observationBlobExists(
    objectId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(objectId)) {
      throw new AgentError("PROTOCOL_INVALID", "Git blob identity is malformed");
    }
    try {
      await this.readIsolated(
        ["cat-file", "-e", `${objectId}^{blob}`],
        1,
        signal,
      );
      return true;
    } catch (error) {
      if (
        error instanceof AgentError &&
        error.code === "COMMAND_FAILED" &&
        signal?.aborted !== true
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Streams the complete real-index identity without retaining an index
   * manifest. The isolated command view receives a copy of these exact bytes.
   */
  public async observationIndexIdentity(
    signal?: AbortSignal,
  ): Promise<GitIndexIdentity> {
    const indexPathRaw = await gitMetadata(
      this.gitExecutable,
      this.boundary.root,
      ["rev-parse", "--git-path", "index"],
      signal,
    );
    const indexPath = resolveGitMetadataPath(this.boundary.root, indexPathRaw);
    let handle;
    try {
      handle = await open(
        indexPath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if (isMissingFileSystemError(error)) {
        return { sha256: this.digest(Buffer.alloc(0)), bytes: 0 };
      }
      throw error;
    }
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink > 1n) {
        throw new AgentError(
          "RECOVERY_REQUIRED",
          "Git index identity cannot be captured safely",
        );
      }
      const digest = this.fingerprintKey === undefined
        ? createHash("sha256")
        : createHmac("sha256", this.fingerprintKey);
      let bytes = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        if (signal?.aborted === true) {
          throw new AgentError("COMMAND_CANCELLED", "Git index inspection was cancelled");
        }
        const data = Buffer.from(chunk);
        bytes += data.length;
        digest.update(data);
      }
      const after = await handle.stat({ bigint: true });
      const afterPath = await lstat(indexPath, { bigint: true });
      if (
        before.dev !== afterPath.dev ||
        before.ino !== afterPath.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        afterPath.isSymbolicLink() ||
        afterPath.nlink > 1n
      ) {
        throw new AgentError(
          "RECOVERY_REQUIRED",
          "Git index changed while its identity was captured",
        );
      }
      return { sha256: digest.digest("hex"), bytes };
    } finally {
      await handle.close();
    }
  }

  /** Additive component facts; status().snapshotSha256 remains unchanged. */
  public async observationControlFingerprints(
    signal?: AbortSignal,
  ): Promise<GitObservationControlFingerprints> {
    const [protectedWorktreeSha256, controls] = await Promise.all([
      this.integritySensitiveStateSha256(),
      this.gitControlComponentState(signal),
    ]);
    return {
      protectedWorktreeSha256,
      normalTransitionsSha256: controls.normalTransitionsSha256,
      gitControlsSha256: controls.gitControlsSha256,
    };
  }

  /**
   * Establishes a race-checked repository boundary around a child process.
   * Generic Git-ignored build products are intentionally outside the normal
   * completion fingerprint. For a command claiming to be side-effect-free we
   * additionally enumerate and hash ignored files under explicit bounds.
   */
  public async commandBoundaryState(
    options: { readonly includeIgnoredWorktree: boolean },
    signal?: AbortSignal,
  ): Promise<GitCommandBoundaryState> {
    const before = await this.status(signal);
    if (!options.includeIgnoredWorktree) {
      return {
        status: before,
        integritySha256: before.snapshotSha256,
        includesIgnoredWorktree: false,
      };
    }

    const ignoredStateSha256 = await this.ignoredWorktreeStateSha256(signal);
    const after = await this.status(signal);
    if (before.snapshotSha256 !== after.snapshotSha256) {
      throw new AgentError(
        "RECOVERY_REQUIRED",
        "Repository state changed while the command boundary was established",
      );
    }
    return {
      status: after,
      integritySha256: this.digest(stableJson({
        repositoryStateSha256: after.snapshotSha256,
        ignoredStateSha256,
      })),
      includesIgnoredWorktree: true,
    };
  }

  public async diff(request: GitDiffRequest = {}, signal?: AbortSignal): Promise<GitDiffResult> {
    const baseline = request.baseline ?? "worktree";
    const maxBytes = Math.min(request.maxBytes ?? this.maxDiffBytes, this.maxDiffBytes);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new AgentError("PROTOCOL_INVALID", "maxBytes must be a positive integer");
    }

    const requestedPathspecs: string[] = [];
    const excludedPaths = new Set<string>();
    for (const requestedPath of request.paths ?? []) {
      const resolved = await this.boundary.resolve(requestedPath, { allowMissingTail: true });
      if (!this.isPathAllowed(resolved.relativePath, "git_diff")) {
        throw new AgentError("POLICY_DENIED", "Git diff path is excluded by repository policy", {
          path: resolved.relativePath,
        });
      }
      requestedPathspecs.push(resolved.relativePath);
    }

    const baselineArguments =
      baseline === "staged" ? ["--cached"] : baseline === "head" ? ["HEAD"] : [];
    // Always expand pathspecs to concrete changed files before producing the
    // diff. Authorizing a directory path alone must not authorize a denied
    // descendant that Git would otherwise include in the output.
    const names = await this.invoke(
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--ignore-submodules=all",
        "--name-only",
        "-z",
        ...baselineArguments,
        "--",
        ...requestedPathspecs,
      ],
      this.maxStatusBytes,
      signal,
      false,
    );
    const approvedPaths: string[] = [];
    for (const candidate of names.bytes.toString("utf8").split("\0")) {
      if (candidate === "") {
        continue;
      }
      const resolved = await this.boundary.resolve(candidate, { allowMissingTail: true });
      if (this.isPathAllowed(resolved.relativePath, "git_diff")) {
        approvedPaths.push(resolved.relativePath);
      } else {
        excludedPaths.add(resolved.relativePath);
      }
    }
    const approvedUntrackedPaths: string[] = [];
    if (baseline !== "staged") {
      const statusOutput = await this.invoke(
        ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all"],
        this.maxStatusBytes,
        signal,
        false,
      );
      for (const entry of parseStatus(statusOutput.bytes).entries) {
        if (entry.kind !== "untracked" || !matchesRequestedPath(entry.path, requestedPathspecs, this.boundary)) continue;
        const resolved = await this.boundary.resolve(entry.path, { allowMissingTail: true });
        if (this.isPathAllowed(resolved.relativePath, "git_diff")) {
          approvedUntrackedPaths.push(resolved.relativePath);
        } else {
          excludedPaths.add(resolved.relativePath);
        }
      }
    }
    if (approvedPaths.length === 0 && approvedUntrackedPaths.length === 0) {
      const empty = Buffer.alloc(0);
      return {
        baseline,
        diff: "",
        truncated: false,
        outputBytes: 0,
        sha256: sha256(empty),
        excludedCount: excludedPaths.size,
        limitBytes: maxBytes,
      };
    }

    const output = approvedPaths.length === 0
      ? { bytes: Buffer.alloc(0), truncated: false }
      : await this.invoke(
          [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--ignore-submodules=all",
            "--no-color",
            "--unified=3",
            ...baselineArguments,
            "--",
            ...approvedPaths,
          ],
          maxBytes,
          signal,
          true,
        );
    const chunks: Buffer[] = [output.bytes];
    let retainedBytes = output.bytes.length;
    let truncated = output.truncated;
    for (const untrackedPath of approvedUntrackedPaths.sort()) {
      if (retainedBytes >= maxBytes) {
        truncated = true;
        break;
      }
      const synthetic = await this.renderUntrackedDiff(untrackedPath, maxBytes - retainedBytes);
      chunks.push(synthetic.bytes);
      retainedBytes += synthetic.bytes.length;
      truncated ||= synthetic.truncated;
    }
    const bytes = Buffer.concat(chunks);
    const diff = bytes.toString("utf8");
    return {
      baseline,
      diff,
      truncated,
      outputBytes: bytes.length,
      sha256: sha256(bytes),
      excludedCount: excludedPaths.size,
      limitBytes: maxBytes,
    };
  }

  private async renderUntrackedDiff(
    repositoryRelativePath: string,
    maxBytes: number,
  ): Promise<{ readonly bytes: Buffer; readonly truncated: boolean }> {
    const resolved = await this.boundary.resolveExistingFile(repositoryRelativePath);
    const metadata = await lstat(resolved.absolutePath);
    const header = Buffer.from(
      `diff --git a/${repositoryRelativePath} b/${repositoryRelativePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${repositoryRelativePath}\n`,
      "utf8",
    );
    if (header.length >= maxBytes || metadata.size > maxBytes) {
      return { bytes: header.subarray(0, maxBytes), truncated: true };
    }
    const handle = await open(resolved.absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink > 1) {
        throw new AgentError("UNSUPPORTED_FILE", "Untracked diff target is not a safe regular file", {
          path: repositoryRelativePath,
        });
      }
      const content = await handle.readFile();
      const after = await handle.stat();
      if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
        throw new AgentError("RECOVERY_REQUIRED", "Untracked file changed while its diff was prepared", {
          path: repositoryRelativePath,
        });
      }
      if (content.includes(0)) {
        const binary = Buffer.from(`Binary files /dev/null and b/${repositoryRelativePath} differ\n`, "utf8");
        const combined = Buffer.concat([header, binary]);
        return { bytes: combined.subarray(0, maxBytes), truncated: combined.length > maxBytes };
      }
      const text = content.toString("utf8").replaceAll("\r\n", "\n");
      const lines = text === "" ? [] : text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const body = Buffer.from(
        `@@ -0,0 +1,${String(lines.length)} @@\n${lines.map((line) => `+${line}`).join("\n")}${lines.length === 0 ? "" : "\n"}`,
        "utf8",
      );
      const combined = Buffer.concat([header, body]);
      return { bytes: combined.subarray(0, maxBytes), truncated: combined.length > maxBytes };
    } finally {
      await handle.close();
    }
  }

  private async invoke(
    fixedArguments: readonly string[],
    maxBytes: number,
    signal: AbortSignal | undefined,
    allowTruncation: boolean,
  ): Promise<{
    readonly bytes: Buffer;
    readonly truncated: boolean;
    readonly branch: string | null;
    readonly head: string | null;
  }> {
    const isolation = await createIsolatedGitView(this.gitExecutable, this.boundary.root, signal);
    try {
      const output = await new Promise<{ readonly bytes: Buffer; readonly truncated: boolean }>((resolve, reject) => {
      const child = spawn(
        this.gitExecutable,
        [
          "--no-optional-locks",
          "-c",
          "core.pager=cat",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "diff.external=",
          "-C",
          this.boundary.root,
          ...fixedArguments,
        ],
        {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...gitEnvironment(), ...isolation.environment },
          signal,
        },
      );
      const chunks: Buffer[] = [];
      const errors: Buffer[] = [];
      let retainedBytes = 0;
      let truncated = false;

      child.stdout.on("data", (chunk: Buffer) => {
        if (retainedBytes >= maxBytes) {
          truncated = true;
          return;
        }
        const available = maxBytes - retainedBytes;
        const retained = chunk.length > available ? chunk.subarray(0, available) : chunk;
        chunks.push(retained);
        retainedBytes += retained.length;
        truncated ||= retained.length !== chunk.length;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const current = errors.reduce((sum, value) => sum + value.length, 0);
        if (current < 64 * 1024) {
          errors.push(chunk.subarray(0, 64 * 1024 - current));
        }
      });
      child.once("error", (error) => {
        if (signal?.aborted === true) {
          reject(new AgentError("COMMAND_CANCELLED", "Git operation was cancelled"));
          return;
        }
        reject(
          new AgentError(
            "COMMAND_FAILED",
            "Unable to start Git",
            { executable: this.gitExecutable },
            { cause: error },
          ),
        );
      });
      child.once("close", (code, closeSignal) => {
        if (signal?.aborted === true) {
          reject(new AgentError("COMMAND_CANCELLED", "Git operation was cancelled"));
          return;
        }
        if (code !== 0) {
          reject(
            new AgentError("COMMAND_FAILED", "Git inspection failed", {
              exitCode: code,
              signal: closeSignal,
              stderr: Buffer.concat(errors).toString("utf8"),
            }),
          );
          return;
        }
        if (truncated && !allowTruncation) {
          reject(
            new AgentError("BUDGET_EXCEEDED", "Git output exceeds the configured limit", {
              maxBytes,
            }),
          );
          return;
        }
        resolve({ bytes: Buffer.concat(chunks), truncated });
      });
      });
      return { ...output, branch: isolation.branch, head: isolation.head };
    } finally {
      await isolation.cleanup();
    }
  }

  /**
   * Hashes bytes and object type without returning repository content. Opening
   * through a descriptor and validating it before reading avoids following a
   * repository symlink into an unrelated location.
   */
  private async worktreeStateSha256(repositoryRelativePath: string): Promise<string> {
    const resolved = await this.boundary.resolve(repositoryRelativePath, { allowMissingTail: true })
      .catch((error: unknown) => {
        if (isMissingPathError(error)) return undefined;
        if (error instanceof AgentError && error.code === "UNSUPPORTED_FILE") return undefined;
        throw error;
      });
    const normalizedPath = normalizeRepositoryPath(repositoryRelativePath);
    const absolutePath = resolved?.absolutePath ??
      path.join(this.boundary.root, ...normalizedPath.split("/"));

    let before;
    try {
      before = await lstat(absolutePath);
    } catch (error) {
      if (isMissingFileSystemError(error)) {
        return this.digest(stableJson({ state: "missing" }));
      }
      throw error;
    }
    if (before.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      return this.digest(stableJson({ state: "symbolic-link", targetSha256: this.digest(target) }));
    }
    if (before.isDirectory()) {
      return this.digest(stableJson({ state: "directory" }));
    }
    if (!before.isFile()) {
      return this.digest(stableJson({ state: "special", mode: before.mode }));
    }
    if (before.nlink > 1) {
      throw new AgentError("UNSUPPORTED_FILE", "Hard-linked dirty files cannot be fingerprinted safely", {
        path: repositoryRelativePath,
        linkCount: before.nlink,
      });
    }

    const handle = await open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      const afterOpen = await lstat(absolutePath);
      if (
        !opened.isFile() ||
        afterOpen.isSymbolicLink() ||
        opened.dev !== afterOpen.dev ||
        opened.ino !== afterOpen.ino ||
        opened.nlink > 1
      ) {
        throw new AgentError("RECOVERY_REQUIRED", "Dirty file changed identity while it was fingerprinted", {
          path: repositoryRelativePath,
        });
      }
      const contentDigest = this.fingerprintKey === undefined
        ? createHash("sha256")
        : createHmac("sha256", this.fingerprintKey);
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        contentDigest.update(chunk);
      }
      const afterRead = await handle.stat();
      if (
        opened.size !== afterRead.size ||
        opened.mtimeMs !== afterRead.mtimeMs ||
        opened.ctimeMs !== afterRead.ctimeMs
      ) {
        throw new AgentError("RECOVERY_REQUIRED", "Dirty file changed while it was fingerprinted", {
          path: repositoryRelativePath,
        });
      }
      return this.digest(stableJson({
        state: "file",
        contentSha256: contentDigest.digest("hex"),
      }));
    } finally {
      await handle.close();
    }
  }

  private async ignoredWorktreeStateSha256(signal?: AbortSignal): Promise<string> {
    const listIgnored = async (): Promise<Buffer> => {
      const result = await this.invoke(
        ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
        this.maxStatusBytes,
        signal,
        false,
      );
      return result.bytes;
    };
    const firstListing = await listIgnored();
    const rawPaths = firstListing.toString("utf8").split("\0");
    if (rawPaths.at(-1) === "") rawPaths.pop();
    if (rawPaths.length > this.maxIntegrityEntries) {
      throw new AgentError("BUDGET_EXCEEDED", "Ignored-worktree integrity inventory exceeds its entry bound", {
        maxEntries: this.maxIntegrityEntries,
      });
    }

    const inventory: Array<{ readonly pathSha256: string; readonly stateSha256: string }> = [];
    let totalBytes = 0;
    for (const candidate of rawPaths) {
      const relativePath = normalizeRepositoryPath(candidate);
      const resolved = await this.boundary.resolve(relativePath, { allowMissingTail: true });
      const state = await lstat(resolved.absolutePath);
      if (state.isFile()) {
        totalBytes += state.size;
        if (totalBytes > MAX_IGNORED_INTEGRITY_BYTES) {
          throw new AgentError("BUDGET_EXCEEDED", "Ignored-worktree integrity inventory exceeds its byte bound", {
            maxBytes: MAX_IGNORED_INTEGRITY_BYTES,
          });
        }
      }
      inventory.push({
        pathSha256: this.digest(relativePath),
        stateSha256: await this.worktreeStateSha256(relativePath),
      });
    }
    const secondListing = await listIgnored();
    if (!firstListing.equals(secondListing)) {
      throw new AgentError("RECOVERY_REQUIRED", "Ignored worktree changed during command-boundary inventory");
    }
    inventory.sort((left, right) =>
      compareGitPathBytes(left.pathSha256, right.pathSha256));
    return this.digest(stableJson(inventory));
  }

  private async integritySensitiveStateSha256(): Promise<string> {
    const inventory: Array<{ readonly pathSha256: string; readonly stateSha256: string }> = [];
    const queue: Array<{ readonly relativePath: string; readonly absolutePath: string }> = [
      { relativePath: "", absolutePath: this.boundary.root },
    ];
    let traversed = 0;
    while (queue.length > 0) {
      const directory = queue.shift();
      if (directory === undefined) break;
      const before = await lstat(directory.absolutePath);
      this.boundary.assertDevice(before.dev, directory.relativePath);
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw new AgentError("RECOVERY_REQUIRED", "Repository integrity traversal encountered an unsafe directory");
      }
      const handle = await opendir(directory.absolutePath);
      const children = [];
      for await (const child of handle) {
        traversed += 1;
        if (traversed > this.maxIntegrityEntries) {
          throw new AgentError("BUDGET_EXCEEDED", "Protected repository integrity inventory exceeds its entry bound", {
            maxEntries: this.maxIntegrityEntries,
          });
        }
        children.push(child);
      }
      children.sort((left, right) =>
        compareGitPathBytes(left.name, right.name));
      for (const child of children) {
        const relativePath = directory.relativePath === ""
          ? child.name
          : `${directory.relativePath}/${child.name}`;
        const childState = await lstat(path.join(directory.absolutePath, child.name));
        this.boundary.assertDevice(childState.dev, relativePath);
        if (childState.isSymbolicLink()) {
          if (this.matchesIntegrityPattern(relativePath)) {
            throw new AgentError("RECOVERY_REQUIRED", "Repository integrity traversal encountered a symbolic link");
          }
          continue;
        }
        if (childState.isDirectory()) {
          if (shouldSkipIntegrityDirectory(relativePath)) continue;
          queue.push({ relativePath, absolutePath: path.join(directory.absolutePath, child.name) });
          continue;
        }
        if (!this.matchesIntegrityPattern(relativePath)) continue;
        inventory.push({
          pathSha256: this.digest(relativePath),
          stateSha256: await this.worktreeStateSha256(relativePath),
        });
      }
      const after = await lstat(directory.absolutePath);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      ) {
        throw new AgentError("RECOVERY_REQUIRED", "Repository changed during protected-state inventory");
      }
    }
    inventory.sort((left, right) =>
      compareGitPathBytes(left.pathSha256, right.pathSha256));
    return this.digest(stableJson(inventory));
  }

  /**
   * Binds validation and completion to security-relevant Git control data.
   * Merely inspecting through the isolated Git view prevents hooks/config from
   * executing, but it would not otherwise notice a command replacing a hook,
   * ref, index, or repository-local configuration file.
   */
  private async gitControlStateSha256(signal?: AbortSignal): Promise<string> {
    return (await this.gitControlComponentState(signal)).combinedSha256;
  }

  private async gitControlComponentState(signal?: AbortSignal): Promise<{
    readonly combinedSha256: string;
    readonly normalTransitionsSha256: string;
    readonly gitControlsSha256: string;
  }> {
    const [gitDirectoryRaw, commonDirectoryRaw, indexPathRaw] = await Promise.all([
      gitMetadata(this.gitExecutable, this.boundary.root, ["rev-parse", "--absolute-git-dir"], signal),
      gitMetadata(this.gitExecutable, this.boundary.root, ["rev-parse", "--git-common-dir"], signal),
      gitMetadata(this.gitExecutable, this.boundary.root, ["rev-parse", "--git-path", "index"], signal),
    ]);
    const gitDirectory = await realpath(resolveGitMetadataPath(this.boundary.root, gitDirectoryRaw));
    const commonDirectory = await realpath(resolveGitMetadataPath(this.boundary.root, commonDirectoryRaw));
    const indexPath = await canonicalIfExists(resolveGitMetadataPath(this.boundary.root, indexPathRaw));
    if (!isContainedPath(gitDirectory, indexPath) && !isContainedPath(commonDirectory, indexPath)) {
      throw new AgentError("RECOVERY_REQUIRED", "Git index escaped the repository control directory");
    }

    const [gitIdentity, commonIdentity, indexIdentity] = await Promise.all([
      detectFilesystemIdentity(gitDirectory),
      detectFilesystemIdentity(commonDirectory),
      detectFilesystemIdentity(path.dirname(indexPath)),
    ]);
    const inventory: Array<{
      readonly pathSha256: string;
      readonly stateSha256: string;
      readonly category: "transition" | "control";
    }> = [];
    const seen = new Set<string>();
    let entries = 0;
    let bytes = 0;
    const inspectFile = async (
      absolutePath: string,
      identity: string,
      filesystemIdentity: FilesystemIdentity,
      category: "transition" | "control",
    ): Promise<void> => {
      const key = `${String(filesystemIdentity.device)}:${filesystemIdentity.pathKey(absolutePath)}`;
      if (seen.has(key)) return;
      seen.add(key);
      let before;
      try {
        before = await lstat(absolutePath);
      } catch (error) {
        if (isMissingFileSystemError(error)) return;
        throw error;
      }
      if (before.dev !== filesystemIdentity.device) {
        throw new AgentError("RECOVERY_REQUIRED", "Git control data crossed a filesystem device boundary", {
          diagnosticCode: "GIT_CONTROL_DEVICE_TRANSITION",
          control: identity,
        });
      }
      entries += 1;
      if (entries > this.maxIntegrityEntries) {
        throw new AgentError("BUDGET_EXCEEDED", "Git control inventory exceeds its entry bound", {
          maxEntries: this.maxIntegrityEntries,
        });
      }
      if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1) {
        throw new AgentError("RECOVERY_REQUIRED", "Git control inventory encountered an unsafe file", {
          control: identity,
        });
      }
      if (identity !== "gitdir/index") bytes += before.size;
      if (bytes > MAX_GIT_CONTROL_BYTES) {
        throw new AgentError("BUDGET_EXCEEDED", "Git control inventory exceeds its byte bound", {
          maxBytes: MAX_GIT_CONTROL_BYTES,
        });
      }
      const handle = await open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        const contentDigest = this.fingerprintKey === undefined
          ? createHash("sha256")
          : createHmac("sha256", this.fingerprintKey);
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          contentDigest.update(chunk);
        }
        const after = await handle.stat();
        const afterPath = await lstat(absolutePath);
        if (
          !opened.isFile() ||
          opened.dev !== afterPath.dev ||
          opened.ino !== afterPath.ino ||
          opened.size !== after.size ||
          opened.mtimeMs !== after.mtimeMs ||
          opened.ctimeMs !== after.ctimeMs ||
          afterPath.isSymbolicLink() ||
          afterPath.nlink > 1
        ) {
          throw new AgentError("RECOVERY_REQUIRED", "Git control data changed during inventory", {
            control: identity,
          });
        }
        inventory.push({
          pathSha256: this.digest(identity),
          stateSha256: contentDigest.digest("hex"),
          category,
        });
      } finally {
        await handle.close();
      }
    };
    const scanDirectory = async (
      root: string,
      identityRoot: string,
      filesystemIdentity: FilesystemIdentity,
      category: "transition" | "control",
    ): Promise<void> => {
      let rootState;
      try {
        rootState = await lstat(root);
      } catch (error) {
        if (isMissingFileSystemError(error)) return;
        throw error;
      }
      if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
        throw new AgentError("RECOVERY_REQUIRED", "Git control directory is unsafe", {
          control: identityRoot,
        });
      }
      if (rootState.dev !== filesystemIdentity.device) {
        throw new AgentError("RECOVERY_REQUIRED", "Git control directory crossed a filesystem device boundary", {
          diagnosticCode: "GIT_CONTROL_DEVICE_TRANSITION",
          control: identityRoot,
        });
      }
      const queue: Array<{ readonly absolutePath: string; readonly identity: string }> = [
        { absolutePath: root, identity: identityRoot },
      ];
      while (queue.length > 0) {
        const directory = queue.shift();
        if (directory === undefined) break;
        const handle = await opendir(directory.absolutePath);
        const children = [];
        for await (const child of handle) children.push(child);
        children.sort((left, right) =>
          compareGitPathBytes(left.name, right.name));
        for (const child of children) {
          const absolutePath = path.join(directory.absolutePath, child.name);
          const identity = `${directory.identity}/${child.name}`;
          const childState = await lstat(absolutePath);
          if (childState.dev !== filesystemIdentity.device) {
            throw new AgentError("RECOVERY_REQUIRED", "Git control traversal crossed a filesystem device boundary", {
              diagnosticCode: "GIT_CONTROL_DEVICE_TRANSITION",
              control: identity,
            });
          }
          if (childState.isDirectory() && !childState.isSymbolicLink()) {
            queue.push({ absolutePath, identity });
          } else {
            await inspectFile(absolutePath, identity, filesystemIdentity, category);
          }
        }
      }
    };

    await Promise.all([
      inspectFile(path.join(gitDirectory, "HEAD"), "gitdir/HEAD", gitIdentity, "transition"),
      inspectFile(path.join(gitDirectory, "config.worktree"), "gitdir/config.worktree", gitIdentity, "control"),
      inspectFile(indexPath, "gitdir/index", indexIdentity, "transition"),
      inspectFile(path.join(commonDirectory, "config"), "common/config", commonIdentity, "control"),
      inspectFile(path.join(commonDirectory, "packed-refs"), "common/packed-refs", commonIdentity, "transition"),
      inspectFile(path.join(commonDirectory, "shallow"), "common/shallow", commonIdentity, "transition"),
      inspectFile(path.join(commonDirectory, "info", "attributes"), "common/info/attributes", commonIdentity, "control"),
      inspectFile(path.join(commonDirectory, "info", "exclude"), "common/info/exclude", commonIdentity, "control"),
      scanDirectory(path.join(commonDirectory, "refs"), "common/refs", commonIdentity, "transition"),
      scanDirectory(path.join(commonDirectory, "hooks"), "common/hooks", commonIdentity, "control"),
    ]);
    inventory.sort((left, right) =>
      compareGitPathBytes(left.pathSha256, right.pathSha256));
    const withoutCategory = inventory.map(({ pathSha256, stateSha256 }) => ({
      pathSha256,
      stateSha256,
    }));
    const transitionInventory = inventory
      .filter((entry) => entry.category === "transition")
      .map(({ pathSha256, stateSha256 }) => ({ pathSha256, stateSha256 }));
    const controlInventory = inventory
      .filter((entry) => entry.category === "control")
      .map(({ pathSha256, stateSha256 }) => ({ pathSha256, stateSha256 }));
    return {
      combinedSha256: this.digest(stableJson(withoutCategory)),
      normalTransitionsSha256: this.digest(stableJson(transitionInventory)),
      gitControlsSha256: this.digest(stableJson(controlInventory)),
    };
  }

  private matchesIntegrityPattern(repositoryRelativePath: string): boolean {
    return this.integrityPatterns.some((pattern) => minimatch(
      this.boundary.filesystemIdentity.normalize(repositoryRelativePath),
      this.boundary.filesystemIdentity.normalize(pattern), {
      dot: true,
      nocase: !this.boundary.filesystemIdentity.caseSensitive,
      matchBase: !pattern.includes("/"),
      nobrace: true,
      noext: true,
    }));
  }

  private digest(value: string | Uint8Array): string {
    return this.fingerprintKey === undefined
      ? sha256(value)
      : createHmac("sha256", this.fingerprintKey).update(value).digest("hex");
  }
}

const DEFAULT_INTEGRITY_PATTERNS = [
  ".cba/**",
  ".copilot-agent/**",
  ".github/workflows/**",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "*.pem",
  "*.key",
  "*.pfx",
  "*.p12",
  "credentials*",
  "secrets*",
] as const;

const ISOLATED_READ_BUILTINS = new Set([
  "cat-file",
  "diff",
  "diff-tree",
  "hash-object",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "status",
  "symbolic-ref",
]);

function shouldSkipIntegrityDirectory(repositoryRelativePath: string): boolean {
  const normalized = repositoryRelativePath.replaceAll("\\", "/").toLowerCase();
  const name = normalized.split("/").at(-1) ?? normalized;
  return name === ".git" ||
    name === "node_modules" ||
    name === "dist" ||
    name === "build" ||
    name === "coverage" ||
    name === "vendor";
}

export interface IsolatedGitView {
  readonly branch: string | null;
  readonly head: string | null;
  readonly environment: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

/**
 * Git diff can otherwise execute repository-local clean filters while merely
 * inspecting a worktree. The shadow gitdir exposes only HEAD, the existing
 * read-only index, and object storage; it intentionally contains no local
 * config, hooks, info attributes, or refs. Repository .gitattributes may name
 * a filter, but without its local command definition Git treats it as inert.
 */
export async function createIsolatedGitView(
  gitExecutable: string,
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<IsolatedGitView> {
  const [
    gitDirectoryRaw,
    commonDirectoryRaw,
    indexPathRaw,
    head,
    branch,
    objectFormat,
  ] = await Promise.all([
    gitMetadata(gitExecutable, repositoryRoot, ["rev-parse", "--absolute-git-dir"], signal),
    gitMetadata(gitExecutable, repositoryRoot, ["rev-parse", "--git-common-dir"], signal),
    gitMetadata(gitExecutable, repositoryRoot, ["rev-parse", "--git-path", "index"], signal),
    optionalGitMetadata(gitExecutable, repositoryRoot, ["rev-parse", "--verify", "HEAD"], signal),
    optionalGitMetadata(gitExecutable, repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal),
    gitMetadata(gitExecutable, repositoryRoot, ["rev-parse", "--show-object-format"], signal),
  ]);
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new AgentError(
      "COMMAND_FAILED",
      "Git repository object format is unsupported",
      { objectFormat },
    );
  }
  const gitDirectory = await realpath(resolveGitMetadataPath(repositoryRoot, gitDirectoryRaw));
  const commonDirectory = await realpath(resolveGitMetadataPath(repositoryRoot, commonDirectoryRaw));
  const indexPath = await canonicalIfExists(resolveGitMetadataPath(repositoryRoot, indexPathRaw));
  // Both locations must remain inside Git's own metadata tree. This prevents a
  // malicious output/config interaction from pointing the shadow view at an
  // unrelated index or object database.
  if (!isContainedPath(gitDirectory, indexPath) && !isContainedPath(commonDirectory, indexPath)) {
    throw new AgentError("COMMAND_FAILED", "Git index path is outside the repository metadata directory");
  }
  const objectsDirectory = await realpath(path.join(commonDirectory, "objects"));
  if ([repositoryRoot, indexPath, objectsDirectory].some((value) => /[\0\r\n]/u.test(value))) {
    throw new AgentError("COMMAND_FAILED", "Git metadata paths contain unsupported control characters");
  }
  const shadow = await mkdtemp(path.join(tmpdir(), "cba-git-view-"));
  try {
    await Promise.all([
      mkdir(path.join(shadow, "objects", "info"), { recursive: true, mode: 0o700 }),
      mkdir(path.join(shadow, "objects", "pack"), { recursive: true, mode: 0o700 }),
      mkdir(path.join(shadow, "refs", "heads"), { recursive: true, mode: 0o700 }),
      mkdir(path.join(shadow, "refs", "tags"), { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(
      path.join(shadow, "objects", "info", "alternates"),
      `${objectsDirectory.replaceAll("\\", "/")}\n`,
      { flag: "wx", mode: 0o600, flush: true },
    );
    if (objectFormat === "sha256") {
      await writeFile(
        path.join(shadow, "config"),
        "[core]\n\trepositoryFormatVersion = 1\n[extensions]\n\tobjectFormat = sha256\n",
        { flag: "wx", mode: 0o600, flush: true },
      );
    }
    if (head === undefined) {
      await writeFile(path.join(shadow, "HEAD"), "ref: refs/heads/cba-unborn\n", {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
    } else {
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(head)) {
        throw new AgentError("COMMAND_FAILED", "Git HEAD object identifier is invalid");
      }
      await writeFile(path.join(shadow, "HEAD"), `${head}\n`, {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
    }
    const isolatedIndexPath = path.join(shadow, "index");
    try {
      await cp(indexPath, isolatedIndexPath, { preserveTimestamps: true });
    } catch (error) {
      if (!isMissingFileSystemError(error)) throw error;
    }
    const sharedChecksum = await splitIndexChecksum(
      isolatedIndexPath,
      objectFormat,
      signal,
    );
    if (sharedChecksum !== undefined) {
      const fileName = `sharedindex.${sharedChecksum}`;
      await copySharedIndex(
        path.join(path.dirname(indexPath), fileName),
        path.join(shadow, fileName),
        sharedChecksum,
        objectFormat,
        signal,
      );
    }
    return {
      branch: branch ?? null,
      head: head ?? null,
      environment: {
        GIT_DIR: shadow,
        GIT_WORK_TREE: repositoryRoot,
        GIT_INDEX_FILE: isolatedIndexPath,
        GIT_ATTR_NOSYSTEM: "1",
      },
      cleanup: async () => rm(shadow, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(shadow, { recursive: true, force: true });
    throw error;
  }
}

async function splitIndexChecksum(
  indexPath: string,
  objectFormat: "sha1" | "sha256",
  signal?: AbortSignal,
): Promise<string | undefined> {
  const hashBytes = objectFormat === "sha256" ? 32 : 20;
  let handle;
  try {
    handle = await open(
      indexPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (isMissingFileSystemError(error)) return undefined;
    throw error;
  }
  try {
    const state = await handle.stat({ bigint: true });
    if (
      !state.isFile() ||
      state.nlink !== 1n ||
      state.size > BigInt(Number.MAX_SAFE_INTEGER) ||
      state.size < BigInt(12 + hashBytes)
    ) {
      throw malformedIndex("Git index is not a safely parseable regular file");
    }
    const size = Number(state.size);
    const contentEnd = size - hashBytes;
    const digest = createHash(objectFormat);
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      start: 0,
      end: contentEnd - 1,
    })) {
      throwIfSharedIndexCopyCancelled(signal);
      digest.update(Buffer.from(chunk));
    }
    const trailingChecksum = await readIndexBytes(
      handle,
      contentEnd,
      hashBytes,
    );
    if (!digest.digest().equals(trailingChecksum)) {
      throw malformedIndex("Git index checksum is invalid");
    }
    const header = await readIndexBytes(handle, 0, 12);
    if (!header.subarray(0, 4).equals(Buffer.from("DIRC", "ascii"))) {
      throw malformedIndex("Git index signature is invalid");
    }
    const version = header.readUInt32BE(4);
    if (![2, 3, 4].includes(version)) {
      throw malformedIndex("Git index version is unsupported");
    }
    const entryCount = header.readUInt32BE(8);
    const fixedEntryBytes = 42 + hashBytes;
    if (
      entryCount >
      Math.floor(Math.max(0, contentEnd - 12) / fixedEntryBytes)
    ) {
      throw malformedIndex("Git index entry count exceeds its byte length");
    }
    let offset = 12;
    for (let index = 0; index < entryCount; index += 1) {
      throwIfSharedIndexCopyCancelled(signal);
      const entryStart = offset;
      const fixed = await readIndexBytes(
        handle,
        offset,
        fixedEntryBytes,
        contentEnd,
      );
      const flags = fixed.readUInt16BE(40 + hashBytes);
      offset += fixedEntryBytes;
      if ((flags & 0x4000) !== 0) {
        if (version < 3) {
          throw malformedIndex(
            "Git index v2 entry unexpectedly has extended flags",
          );
        }
        await readIndexBytes(handle, offset, 2, contentEnd);
        offset += 2;
      }
      if (version === 4) {
        let variableBytes = 0;
        while (true) {
          const encoded = await readIndexBytes(handle, offset, 1, contentEnd);
          offset += 1;
          variableBytes += 1;
          if (variableBytes > 10) {
            throw malformedIndex(
              "Git index v4 path prefix encoding is malformed",
            );
          }
          if (((encoded[0] ?? 0) & 0x80) === 0) break;
        }
        offset = await indexNulEnd(handle, offset, contentEnd, signal);
        continue;
      }
      const encodedNameLength = flags & 0x0fff;
      const pathLength =
        encodedNameLength === 0x0fff
          ? (await indexNulEnd(handle, offset, contentEnd, signal)) - offset - 1
          : encodedNameLength;
      if (encodedNameLength !== 0x0fff) {
        const terminator = await readIndexBytes(
          handle,
          offset + pathLength,
          1,
          contentEnd,
        );
        if (terminator[0] !== 0) {
          throw malformedIndex("Git index entry path is not NUL-terminated");
        }
      }
      const entryWithoutPadding =
        offset + pathLength - entryStart;
      const padding = 8 - (entryWithoutPadding % 8);
      const paddingBytes = await readIndexBytes(
        handle,
        offset + pathLength,
        padding,
        contentEnd,
      );
      if (paddingBytes.some((value) => value !== 0)) {
        throw malformedIndex("Git index entry padding is malformed");
      }
      offset += pathLength + padding;
    }

    let linkChecksum: string | undefined;
    let sawLink = false;
    while (offset < contentEnd) {
      const extensionHeader = await readIndexBytes(
        handle,
        offset,
        8,
        contentEnd,
      );
      const signature = extensionHeader.subarray(0, 4).toString("ascii");
      const extensionBytes = extensionHeader.readUInt32BE(4);
      offset += 8;
      if (extensionBytes > contentEnd - offset) {
        throw malformedIndex("Git index extension exceeds its byte length");
      }
      if (signature === "link") {
        if (sawLink || extensionBytes < hashBytes) {
          throw malformedIndex("Git split-index link extension is malformed");
        }
        sawLink = true;
        const checksum = await readIndexBytes(
          handle,
          offset,
          hashBytes,
          contentEnd,
        );
        if (!checksum.equals(Buffer.alloc(hashBytes))) {
          linkChecksum = checksum.toString("hex");
        }
      }
      offset += extensionBytes;
    }
    if (offset !== contentEnd) {
      throw malformedIndex("Git index extensions are misaligned");
    }
    return linkChecksum;
  } finally {
    await handle.close();
  }
}

async function indexNulEnd(
  handle: FileHandle,
  start: number,
  contentEnd: number,
  signal?: AbortSignal,
): Promise<number> {
  let offset = start;
  while (offset < contentEnd) {
    throwIfSharedIndexCopyCancelled(signal);
    const bytes = await readIndexBytes(
      handle,
      offset,
      Math.min(4 * 1024, contentEnd - offset),
      contentEnd,
    );
    const nul = bytes.indexOf(0);
    if (nul >= 0) return offset + nul + 1;
    offset += bytes.length;
  }
  throw malformedIndex("Git index entry path is not NUL-terminated");
}

async function readIndexBytes(
  handle: FileHandle,
  position: number,
  length: number,
  contentEnd = Number.MAX_SAFE_INTEGER,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(position) ||
    !Number.isSafeInteger(length) ||
    position < 0 ||
    length < 0 ||
    position + length > contentEnd
  ) {
    throw malformedIndex("Git index structure exceeds its byte length");
  }
  const result = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const chunk = await handle.read(
      result,
      read,
      length - read,
      position + read,
    );
    if (chunk.bytesRead < 1) {
      throw malformedIndex("Git index ended before its declared structure");
    }
    read += chunk.bytesRead;
  }
  return result;
}

function malformedIndex(message: string): AgentError {
  return new AgentError("RECOVERY_REQUIRED", message);
}

async function copySharedIndex(
  sourcePath: string,
  destinationPath: string,
  expectedChecksum: string,
  objectFormat: "sha1" | "sha256",
  signal?: AbortSignal,
): Promise<void> {
  const checksumBytes = objectFormat === "sha256" ? 32 : 20;
  const expected = Buffer.from(expectedChecksum, "hex");
  let source;
  let destination;
  let completed = false;
  try {
    throwIfSharedIndexCopyCancelled(signal);
    const initialPath = await lstat(sourcePath, { bigint: true });
    if (
      !initialPath.isFile() ||
      initialPath.isSymbolicLink() ||
      initialPath.nlink !== 1n
    ) {
      throw new AgentError(
        "RECOVERY_REQUIRED",
        "Git split-index backing is not a bounded regular file",
      );
    }
    source = await open(
      sourcePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const before = await source.stat({ bigint: true });
    const beforePath = await lstat(sourcePath, { bigint: true });
    if (
      !before.isFile() ||
      beforePath.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.dev !== beforePath.dev ||
      before.ino !== beforePath.ino ||
      before.size !== beforePath.size ||
      initialPath.dev !== before.dev ||
      initialPath.ino !== before.ino ||
      initialPath.size !== before.size ||
      initialPath.mtimeNs !== before.mtimeNs ||
      initialPath.ctimeNs !== before.ctimeNs ||
      before.size < BigInt(checksumBytes) ||
      before.size > BigInt(MAX_GIT_CONTROL_BYTES)
    ) {
      throw new AgentError(
        "RECOVERY_REQUIRED",
        "Git split-index backing is not a bounded regular file",
      );
    }
    destination = await open(
      destinationPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    const digest = createHash(objectFormat);
    let checksumTail = Buffer.alloc(0);
    let copiedBytes = 0;
    for await (const chunk of source.createReadStream({ autoClose: false })) {
      throwIfSharedIndexCopyCancelled(signal);
      const data = Buffer.from(chunk);
      copiedBytes += data.length;
      if (copiedBytes > MAX_GIT_CONTROL_BYTES) {
        throw new AgentError(
          "BUDGET_EXCEEDED",
          "Git split-index backing exceeds its copy bound",
          { maxBytes: MAX_GIT_CONTROL_BYTES },
        );
      }
      const withTail = Buffer.concat([checksumTail, data]);
      if (withTail.length > checksumBytes) {
        const digestLength = withTail.length - checksumBytes;
        digest.update(withTail.subarray(0, digestLength));
        checksumTail = Buffer.from(withTail.subarray(digestLength));
      } else {
        checksumTail = withTail;
      }
      let written = 0;
      while (written < data.length) {
        const result = await destination.write(
          data,
          written,
          data.length - written,
          null,
        );
        if (result.bytesWritten < 1) {
          throw new AgentError(
            "COMMAND_FAILED",
            "Git split-index backing copy made no progress",
          );
        }
        written += result.bytesWritten;
      }
    }
    const calculated = digest.digest();
    if (
      checksumTail.length !== checksumBytes ||
      !checksumTail.equals(expected) ||
      !calculated.equals(expected)
    ) {
      throw new AgentError(
        "RECOVERY_REQUIRED",
        "Git split-index backing checksum does not match its link identity",
      );
    }
    const after = await source.stat({ bigint: true });
    const afterPath = await lstat(sourcePath, { bigint: true });
    if (
      !after.isFile() ||
      afterPath.isSymbolicLink() ||
      after.nlink !== 1n ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.dev !== afterPath.dev ||
      after.ino !== afterPath.ino ||
      after.size !== afterPath.size
    ) {
      throw new AgentError(
        "RECOVERY_REQUIRED",
        "Git split-index backing changed while it was copied",
      );
    }
    await destination.sync();
    completed = true;
  } catch (error) {
    if (isMissingFileSystemError(error)) {
      throw new AgentError(
        "RECOVERY_REQUIRED",
        "Git split-index backing is missing",
        {},
        { cause: error },
      );
    }
    throw error;
  } finally {
    await Promise.all([
      source?.close().catch(() => undefined),
      destination?.close().catch(() => undefined),
    ]);
    if (!completed) {
      await rm(destinationPath, { force: true }).catch(() => undefined);
    }
  }
}

function throwIfSharedIndexCopyCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new AgentError(
      "COMMAND_CANCELLED",
      "Git split-index backing copy was cancelled",
    );
  }
}

async function gitMetadata(
  gitExecutable: string,
  repositoryRoot: string,
  fixedArguments: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await execFileAsync(
      gitExecutable,
      ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.external=", "-C", repositoryRoot, ...fixedArguments],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: gitEnvironment(),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const value = String(result.stdout).trim();
    if (value === "" || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
      throw new Error("Git returned malformed metadata");
    }
    return value;
  } catch (error) {
    throw new AgentError("COMMAND_FAILED", "Git metadata inspection failed", {}, { cause: error });
  }
}

async function optionalGitMetadata(
  gitExecutable: string,
  repositoryRoot: string,
  fixedArguments: readonly string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    return await gitMetadata(gitExecutable, repositoryRoot, fixedArguments, signal);
  } catch (error) {
    const cause = error instanceof Error && "cause" in error ? error.cause : undefined;
    const exitCode = cause !== null && typeof cause === "object" && "code" in cause
      ? (cause as { readonly code?: unknown }).code
      : undefined;
    if (exitCode === 1 || exitCode === 128) return undefined;
    throw error;
  }
}

function resolveGitMetadataPath(repositoryRoot: string, value: string): string {
  return path.isAbsolute(value) || path.win32.isAbsolute(value)
    ? value
    : path.resolve(repositoryRoot, value);
}

async function canonicalIfExists(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch (error) {
    if (isMissingFileSystemError(error)) return path.resolve(value);
    throw error;
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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

function defaultGitPathAllowed(candidate: string): boolean {
  const normalized = candidate.replaceAll("\\", "/").toLowerCase();
  const name = normalized.split("/").at(-1) ?? normalized;
  return !(
    name === ".env" ||
    name.startsWith(".env.") ||
    /\.(?:pem|key|pfx|p12)$/u.test(name) ||
    /^(?:credentials?|secrets?)(?:\.|$)/u.test(name)
  );
}

function parseStatus(bytes: Buffer): GitStatusResult {
  const raw = bytes.toString("utf8");
  const records = raw.split("\0");
  let branch: string | null = null;
  let head: string | null = null;
  const entries: GitStatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record === "") {
      continue;
    }
    if (record.startsWith("# branch.head ")) {
      const value = record.slice("# branch.head ".length);
      branch = value === "(detached)" ? null : value;
      continue;
    }
    if (record.startsWith("# branch.oid ")) {
      const value = record.slice("# branch.oid ".length);
      head = value === "(initial)" ? null : value;
      continue;
    }
    if (record.startsWith("? ")) {
      entries.push({
        path: record.slice(2),
        kind: "untracked",
        indexStatus: "?",
        worktreeStatus: "?",
        stateSha256: sha256(stableJson({ kind: "untracked" })),
      });
      continue;
    }
    if (record.startsWith("! ")) {
      entries.push({
        path: record.slice(2).replace(/\/$/u, ""),
        kind: "ignored",
        indexStatus: "!",
        worktreeStatus: "!",
        stateSha256: sha256(stableJson({ kind: "ignored" })),
      });
      continue;
    }

    const fields = record.split(" ");
    const xy = fields[1] ?? "..";
    if (record.startsWith("1 ")) {
      entries.push({
        path: fields.slice(8).join(" "),
        kind: "ordinary",
        indexStatus: xy[0] ?? ".",
        worktreeStatus: xy[1] ?? ".",
        stateSha256: sha256(stableJson({ kind: "ordinary", git: fields.slice(1, 8) })),
      });
    } else if (record.startsWith("2 ")) {
      const originalPath = records[index + 1] ?? "";
      index += 1;
      entries.push({
        path: fields.slice(9).join(" "),
        originalPath,
        kind: "renamed",
        indexStatus: xy[0] ?? ".",
        worktreeStatus: xy[1] ?? ".",
        stateSha256: sha256(stableJson({ kind: "renamed", git: fields.slice(1, 9) })),
      });
    } else if (record.startsWith("u ")) {
      entries.push({
        path: fields.slice(10).join(" "),
        kind: "unmerged",
        indexStatus: xy[0] ?? "U",
        worktreeStatus: xy[1] ?? "U",
        stateSha256: sha256(stableJson({ kind: "unmerged", git: fields.slice(1, 10) })),
      });
    }
  }

  return {
    branch,
    head,
    entries,
    hasConflicts: entries.some((entry) => entry.kind === "unmerged"),
    excludedCount: 0,
    excludedStateSha256: sha256("[]"),
    snapshotSha256: sha256(bytes),
  };
}

function isMissingFileSystemError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof AgentError && error.code === "PATH_OUTSIDE_REPOSITORY" &&
    /does not exist/iu.test(error.message);
}

function compareGitPathBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: CURRENT_HOST_PLATFORM.nullDevice,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
  };
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
  ]) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}
