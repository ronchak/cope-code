import { execFile, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, opendir, readlink, realpath, rm, writeFile } from "node:fs/promises";
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
    const output = await this.invoke(
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
      const bytes = await handle.readFile();
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
      return this.digest(stableJson({ state: "file", contentSha256: this.digest(bytes) }));
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
    inventory.sort((left, right) => left.pathSha256.localeCompare(right.pathSha256));
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
      children.sort((left, right) => left.name.localeCompare(right.name));
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
    inventory.sort((left, right) => left.pathSha256.localeCompare(right.pathSha256));
    return this.digest(stableJson(inventory));
  }

  /**
   * Binds validation and completion to security-relevant Git control data.
   * Merely inspecting through the isolated Git view prevents hooks/config from
   * executing, but it would not otherwise notice a command replacing a hook,
   * ref, index, or repository-local configuration file.
   */
  private async gitControlStateSha256(signal?: AbortSignal): Promise<string> {
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
    const inventory: Array<{ readonly pathSha256: string; readonly stateSha256: string }> = [];
    const seen = new Set<string>();
    let entries = 0;
    let bytes = 0;
    const inspectFile = async (
      absolutePath: string,
      identity: string,
      filesystemIdentity: FilesystemIdentity,
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
      bytes += before.size;
      if (bytes > MAX_GIT_CONTROL_BYTES) {
        throw new AgentError("BUDGET_EXCEEDED", "Git control inventory exceeds its byte bound", {
          maxBytes: MAX_GIT_CONTROL_BYTES,
        });
      }
      const handle = await open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        const content = await handle.readFile();
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
          stateSha256: this.digest(content),
        });
      } finally {
        await handle.close();
      }
    };
    const scanDirectory = async (
      root: string,
      identityRoot: string,
      filesystemIdentity: FilesystemIdentity,
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
        children.sort((left, right) => left.name.localeCompare(right.name));
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
            await inspectFile(absolutePath, identity, filesystemIdentity);
          }
        }
      }
    };

    await Promise.all([
      inspectFile(path.join(gitDirectory, "HEAD"), "gitdir/HEAD", gitIdentity),
      inspectFile(path.join(gitDirectory, "config.worktree"), "gitdir/config.worktree", gitIdentity),
      inspectFile(indexPath, "gitdir/index", indexIdentity),
      inspectFile(path.join(commonDirectory, "config"), "common/config", commonIdentity),
      inspectFile(path.join(commonDirectory, "packed-refs"), "common/packed-refs", commonIdentity),
      inspectFile(path.join(commonDirectory, "shallow"), "common/shallow", commonIdentity),
      inspectFile(path.join(commonDirectory, "info", "attributes"), "common/info/attributes", commonIdentity),
      inspectFile(path.join(commonDirectory, "info", "exclude"), "common/info/exclude", commonIdentity),
      scanDirectory(path.join(commonDirectory, "refs"), "common/refs", commonIdentity),
      scanDirectory(path.join(commonDirectory, "hooks"), "common/hooks", commonIdentity),
    ]);
    inventory.sort((left, right) => left.pathSha256.localeCompare(right.pathSha256));
    return this.digest(stableJson(inventory));
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

interface IsolatedGitView {
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
async function createIsolatedGitView(
  gitExecutable: string,
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<IsolatedGitView> {
  const [gitDirectoryRaw, commonDirectoryRaw, indexPathRaw, head, branch] = await Promise.all([
    gitMetadata(gitExecutable, repositoryRoot, ["rev-parse", "--absolute-git-dir"], signal),
    gitMetadata(gitExecutable, repositoryRoot, ["rev-parse", "--git-common-dir"], signal),
    gitMetadata(gitExecutable, repositoryRoot, ["rev-parse", "--git-path", "index"], signal),
    optionalGitMetadata(gitExecutable, repositoryRoot, ["rev-parse", "--verify", "HEAD"], signal),
    optionalGitMetadata(gitExecutable, repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal),
  ]);
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
    return {
      branch: branch ?? null,
      head: head ?? null,
      environment: {
        GIT_DIR: shadow,
        GIT_WORK_TREE: repositoryRoot,
        GIT_INDEX_FILE: indexPath,
        GIT_ATTR_NOSYSTEM: "1",
      },
      cleanup: async () => rm(shadow, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(shadow, { recursive: true, force: true });
    throw error;
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
