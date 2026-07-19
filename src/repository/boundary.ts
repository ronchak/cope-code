import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { AgentError } from "../shared/errors.js";
import {
  detectFilesystemIdentity,
  type FilesystemIdentity,
} from "../shared/filesystem-identity.js";
import { CURRENT_HOST_PLATFORM } from "../platform/index.js";

const execFileAsync = promisify(execFile);

const DEFAULT_BOUNDARY_SCAN_ENTRIES = 500_000;
const MAX_GIT_INDEX_RECORD_BYTES = 256 * 1024;

/**
 * Resolve the concrete Git for Windows installation deterministically from
 * the two machine-map-supported locations, then fall back to controlled PATH.
 * Live certification must still record and approve the selected executable.
 */
export const DEFAULT_GIT_EXECUTABLE = defaultGitExecutable();

function defaultGitExecutable(): string {
  return CURRENT_HOST_PLATFORM.gitExecutableCandidates(process.env)
    .find((candidate) => candidate === "git" || existsSync(candidate)) ?? "git";
}

const WINDOWS_DEVICE_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CLOCK$",
  "CONIN$",
  "CONOUT$",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

export interface ResolvePathOptions {
  readonly allowRepositoryRoot?: boolean;
  readonly allowMissingLeaf?: boolean;
  readonly allowMissingTail?: boolean;
  readonly expectedType?: "file" | "directory";
}

export interface ResolvedRepositoryPath {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly exists: boolean;
}

export interface RepositoryBoundaryInvariantOptions {
  readonly gitExecutable?: string;
  readonly maxTraversalEntries?: number;
}

/**
 * Normalizes an untrusted model-supplied path using Windows-safe rules on every
 * platform. The returned path always uses forward slashes.
 */
export function normalizeRepositoryPath(input: string, allowRoot = false): string {
  if (typeof input !== "string" || input.includes("\0") || input.length > 32_767) {
    throw pathError(input, "Path must be a NUL-free string");
  }

  const withForwardSlashes = input.replaceAll("\\", "/");
  if (withForwardSlashes === "" || withForwardSlashes === ".") {
    if (allowRoot) {
      return "";
    }
    throw pathError(input, "A file path is required");
  }

  if (
    withForwardSlashes.startsWith("/") ||
    /^[a-zA-Z]:/.test(withForwardSlashes) ||
    /^(?:\\\\|\/\/|\\\?\\|\\\.\\|\\\?\?\\)/.test(input)
  ) {
    throw pathError(input, "Absolute, drive-relative, UNC, and device paths are not allowed");
  }

  const segments = withForwardSlashes.split("/");
  if (segments.some((segment) => segment === "")) {
    throw pathError(input, "Empty path segments are not allowed");
  }

  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw pathError(input, "Traversal segments are not allowed");
    }
    if (segment.includes(":")) {
      throw pathError(input, "NTFS alternate data streams are not allowed");
    }
    if (segment.length > 255 || /[\u0001-\u001f<>"|?*]/u.test(segment)) {
      throw pathError(input, "Path contains characters or components unsupported on Windows");
    }
    if (/[. ]$/.test(segment)) {
      throw pathError(input, "Windows-normalized trailing dots and spaces are not allowed");
    }
    const deviceCandidate = segment.split(".", 1)[0]?.toUpperCase();
    if (deviceCandidate !== undefined && WINDOWS_DEVICE_NAMES.has(deviceCandidate)) {
      throw pathError(input, "Windows device names are not allowed");
    }
  }

  return segments.join("/");
}

export async function discoverRepositoryRoot(
  startPath: string,
  gitExecutable = DEFAULT_GIT_EXECUTABLE,
): Promise<string> {
  const canonicalStart = await realpath(startPath);
  try {
    const { stdout } = await execFileAsync(
      gitExecutable,
      ["-C", canonicalStart, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: controlledGitEnvironment(),
      },
    );
    const reportedRoot = stdout.trim();
    if (reportedRoot === "") {
      throw new Error("Git returned an empty repository root");
    }
    return await realpath(reportedRoot);
  } catch (error) {
    throw new AgentError(
      "CONFIG_INVALID",
      `Unable to resolve a Git repository from ${startPath}`,
      { startPath },
      { cause: error },
    );
  }
}

export class RepositoryBoundary {
  private constructor(
    public readonly root: string,
    public readonly filesystemIdentity: FilesystemIdentity,
    public readonly rootDevice: number,
  ) {}

  public static async create(root: string, identity?: FilesystemIdentity): Promise<RepositoryBoundary> {
    const canonicalRoot = await realpath(root);
    const rootStat = await stat(canonicalRoot);
    if (!rootStat.isDirectory()) {
      throw new AgentError("CONFIG_INVALID", "Repository root must be a directory", {
        root: canonicalRoot,
      });
    }
    const filesystemIdentity = identity ?? await detectFilesystemIdentity(canonicalRoot);
    if (filesystemIdentity.device !== rootStat.dev) {
      throw new AgentError("CONFIG_INVALID", "Filesystem identity does not match the repository volume", {
        diagnosticCode: "FILESYSTEM_IDENTITY_DEVICE_MISMATCH",
      });
    }
    return new RepositoryBoundary(canonicalRoot, filesystemIdentity, rootStat.dev);
  }

  public static async discover(
    startPath: string,
    gitExecutable = DEFAULT_GIT_EXECUTABLE,
  ): Promise<RepositoryBoundary> {
    return RepositoryBoundary.create(await discoverRepositoryRoot(startPath, gitExecutable));
  }

  /**
   * V1 is deliberately single-repository. Reject both registered gitlinks and
   * descendant Git worktrees before repository tools become available. The
   * Git probe is a fixed, read-only builtin and never invokes hooks or a shell.
   */
  public async assertNoNestedGitBoundaries(
    options: RepositoryBoundaryInvariantOptions = {},
  ): Promise<void> {
    const maxTraversalEntries = options.maxTraversalEntries ?? DEFAULT_BOUNDARY_SCAN_ENTRIES;
    if (!Number.isSafeInteger(maxTraversalEntries) || maxTraversalEntries < 1) {
      throw new AgentError("CONFIG_INVALID", "Nested Git boundary scan limit is invalid", {
        maxTraversalEntries,
      });
    }
    await assertIndexHasNoGitlinks(
      this.root,
      options.gitExecutable ?? DEFAULT_GIT_EXECUTABLE,
    );
    await assertWorktreeHasNoNestedGitMarkers(this, maxTraversalEntries);
  }

  public async resolve(
    untrustedPath: string,
    options: ResolvePathOptions = {},
  ): Promise<ResolvedRepositoryPath> {
    const relativePath = normalizeRepositoryPath(
      untrustedPath,
      options.allowRepositoryRoot ?? false,
    );
    const candidate =
      relativePath === "" ? this.root : path.join(this.root, ...relativePath.split("/"));
    this.assertContained(candidate, untrustedPath);

    const segments = relativePath === "" ? [] : relativePath.split("/");
    let cursor = this.root;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment === undefined) {
        throw new AgentError("INTERNAL_ERROR", "Path segment unexpectedly missing");
      }
      cursor = path.join(cursor, segment);
      let entryStat;
      try {
        entryStat = await lstat(cursor);
      } catch (error) {
        if (
          isMissing(error) &&
          (options.allowMissingTail === true ||
            (options.allowMissingLeaf === true && index === segments.length - 1))
        ) {
          if (options.allowMissingTail !== true) {
            const canonicalParent = await realpath(path.dirname(cursor));
            this.assertContained(canonicalParent, untrustedPath);
            this.assertDevice((await stat(canonicalParent)).dev, relativePath);
          }
          return { relativePath, absolutePath: candidate, exists: false };
        }
        throw pathError(untrustedPath, "Path does not exist", error);
      }
      this.assertDevice(entryStat.dev, relativePath);
      if (entryStat.isSymbolicLink()) {
        throw new AgentError("UNSUPPORTED_FILE", "Symbolic links and junctions are not supported", {
          path: relativePath,
        });
      }
      if (entryStat.isDirectory()) {
        await assertDirectoryIsNotNestedGitBoundary(cursor, relativePath);
      }
    }

    const canonicalCandidate = await realpath(candidate);
    this.assertContained(canonicalCandidate, untrustedPath);
    const candidateStat = await stat(canonicalCandidate);
    this.assertDevice(candidateStat.dev, relativePath);
    if (candidateStat.isFile() && candidateStat.nlink > 1) {
      throw new AgentError("UNSUPPORTED_FILE", "Hard-linked files are not supported", {
        path: relativePath,
        linkCount: candidateStat.nlink,
      });
    }
    if (options.expectedType === "file" && !candidateStat.isFile()) {
      throw new AgentError("UNSUPPORTED_FILE", "Expected a regular file", { path: relativePath });
    }
    if (options.expectedType === "directory" && !candidateStat.isDirectory()) {
      throw new AgentError("UNSUPPORTED_FILE", "Expected a directory", { path: relativePath });
    }

    return { relativePath, absolutePath: canonicalCandidate, exists: true };
  }

  public pathKey(value: string): string {
    return this.filesystemIdentity.pathKey(value);
  }

  public assertDevice(device: number, repositoryRelativePath: string): void {
    if (device !== this.rootDevice) {
      throw new AgentError("UNSUPPORTED_FILE", "Repository paths must not cross a filesystem device boundary", {
        diagnosticCode: "REPOSITORY_DEVICE_TRANSITION",
        path: repositoryRelativePath,
      });
    }
  }

  public async resolveExistingFile(untrustedPath: string): Promise<ResolvedRepositoryPath> {
    return this.resolve(untrustedPath, { expectedType: "file" });
  }

  public async resolveExistingDirectory(untrustedPath = "."): Promise<ResolvedRepositoryPath> {
    return this.resolve(untrustedPath, {
      allowRepositoryRoot: true,
      expectedType: "directory",
    });
  }

  public async resolveForCreate(untrustedPath: string): Promise<ResolvedRepositoryPath> {
    return this.resolve(untrustedPath, { allowMissingLeaf: true });
  }

  private assertContained(candidate: string, originalInput: string): void {
    const relative = path.relative(this.root, candidate);
    if (relative === "") {
      return;
    }
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw pathError(originalInput, "Path resolves outside the repository");
    }
  }

}

async function assertIndexHasNoGitlinks(repositoryRoot: string, gitExecutable: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      gitExecutable,
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.pager=cat",
        "-c",
        "diff.external=",
        "-C",
        repositoryRoot,
        "ls-files",
        "--stage",
        "-z",
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: controlledGitEnvironment(),
      },
    );
    let pending = Buffer.alloc(0);
    const errors: Buffer[] = [];
    let errorBytes = 0;
    let gitlinkFound = false;
    let malformed = false;
    let settled = false;

    const stop = (): void => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (gitlinkFound || malformed) return;
      pending = Buffer.concat([pending, chunk]);
      let delimiter = pending.indexOf(0);
      while (delimiter !== -1) {
        const record = pending.subarray(0, delimiter);
        pending = pending.subarray(delimiter + 1);
        if (record.subarray(0, 7).toString("ascii") === "160000 ") {
          gitlinkFound = true;
          stop();
          return;
        }
        delimiter = pending.indexOf(0);
      }
      if (pending.length > MAX_GIT_INDEX_RECORD_BYTES) {
        malformed = true;
        stop();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorBytes >= 64 * 1024) return;
      const retained = chunk.subarray(0, 64 * 1024 - errorBytes);
      errors.push(retained);
      errorBytes += retained.length;
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new AgentError(
        "CONFIG_INVALID",
        "Unable to inspect the Git index for unsupported submodules",
        { executable: gitExecutable },
        { cause: error },
      ));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (gitlinkFound) {
        reject(new AgentError(
          "UNSUPPORTED_FILE",
          "Repositories containing submodule gitlinks are not supported in cba/1",
        ));
        return;
      }
      if (malformed || pending.length !== 0) {
        reject(new AgentError(
          "CONFIG_INVALID",
          "Git index inspection returned an oversized or partial record",
        ));
        return;
      }
      if (code !== 0) {
        reject(new AgentError("CONFIG_INVALID", "Git index inspection failed", {
          exitCode: code,
          stderr: boundedDiagnostic(Buffer.concat(errors).toString("utf8")),
        }));
        return;
      }
      resolve();
    });
  });
}

async function assertWorktreeHasNoNestedGitMarkers(
  boundary: RepositoryBoundary,
  maxTraversalEntries: number,
): Promise<void> {
  const repositoryRoot = boundary.root;
  const queue = [repositoryRoot];
  let traversedEntries = 0;
  while (queue.length > 0) {
    const directory = queue.shift();
    if (directory === undefined) break;
    let handle;
    try {
      handle = await opendir(directory);
    } catch (error) {
      throw new AgentError(
        "CONFIG_INVALID",
        "Repository boundary scan could not inspect a directory",
        { path: repositoryRelativeDiagnostic(repositoryRoot, directory) },
        { cause: error },
      );
    }
    const children = [];
    for await (const child of handle) {
      traversedEntries += 1;
      if (traversedEntries > maxTraversalEntries) {
        throw new AgentError(
          "BUDGET_EXCEEDED",
          "Repository boundary scan exceeds its deterministic entry limit",
          { maxTraversalEntries },
        );
      }
      children.push(child);
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const childPath = path.join(directory, child.name);
      const childMetadata = await lstat(childPath);
      if (childMetadata.dev !== boundary.rootDevice) {
        throw new AgentError("UNSUPPORTED_FILE", "Repository traversal crossed a filesystem device boundary", {
          diagnosticCode: "REPOSITORY_DEVICE_TRANSITION",
          path: repositoryRelativeDiagnostic(repositoryRoot, childPath),
        });
      }
      const isGitMarker = boundary.pathKey(child.name) === boundary.pathKey(".git");
      if (isGitMarker) {
        if (directory === repositoryRoot) continue;
        throw new AgentError(
          "UNSUPPORTED_FILE",
          "Nested Git repositories and checked-out submodules are not supported in cba/1",
          { path: repositoryRelativeDiagnostic(repositoryRoot, directory) },
        );
      }
      if (child.isDirectory() && !child.isSymbolicLink()) {
        queue.push(childPath);
      }
    }
  }
}

async function assertDirectoryIsNotNestedGitBoundary(
  directory: string,
  requestedPath: string,
): Promise<void> {
  try {
    await lstat(path.join(directory, ".git"));
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new AgentError(
    "UNSUPPORTED_FILE",
    "Paths inside nested Git repositories and submodules are not supported in cba/1",
    { path: requestedPath },
  );
}

function repositoryRelativeDiagnostic(repositoryRoot: string, candidate: string): string {
  const relative = path.relative(repositoryRoot, candidate).replaceAll(path.sep, "/");
  return relative === "" ? "." : relative;
}

function boundedDiagnostic(value: string): string {
  return value.slice(0, 2_048).replace(/[\r\n]+/gu, " ");
}

function controlledGitEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
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
  ];
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: CURRENT_HOST_PLATFORM.nullDevice,
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function pathError(input: unknown, message: string, cause?: unknown): AgentError {
  return new AgentError(
    "PATH_OUTSIDE_REPOSITORY",
    message,
    { path: typeof input === "string" ? input : String(input) },
    cause === undefined ? undefined : { cause },
  );
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
