import { constants } from "node:fs";
import { access, lstat, open, readFile, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { AgentError } from "../shared/errors.js";
import { newId } from "../shared/crypto.js";
import { validateEdgeProfileDirectoryPath } from "./config.js";
import { detectFilesystemIdentity, type FilesystemIdentity } from "../shared/filesystem-identity.js";
import { CURRENT_HOST_PLATFORM, type HostPlatform } from "../platform/index.js";
import { prepareDedicatedProfileRoot } from "../platform/private-storage.js";

const LOCK_FILE = ".copilot-agent-profile.lock";
const PROFILE_MARKER = ".copilot-agent-profile-v1.json";
const PROFILE_MARKER_KIND = "copilot-agent-dedicated-edge-profile/v1";

interface LockMetadata {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
  readonly createdAt: string;
}

export interface EdgeProfilePathBoundaries {
  readonly repositoryRoot: string;
  readonly stateHome: string;
  readonly ordinaryProfileRoots?: readonly string[];
}

/**
 * Resolves an existing profile or its deepest existing ancestor before
 * checking both directions of overlap with protected local roots. The result
 * is safe to persist in runtime configuration and use for launch.
 */
export async function resolveSafeEdgeProfileDirectory(
  configuredPath: string,
  boundaries: EdgeProfilePathBoundaries,
  identityDetector: (anchor: string) => Promise<FilesystemIdentity> = detectFilesystemIdentity,
): Promise<string> {
  try {
    validateEdgeProfileDirectoryPath(configuredPath);
    const [profile, repositoryRoot, stateHome] = await Promise.all([
      canonicalizeProspectiveDirectory(configuredPath),
      canonicalizeExistingDirectory(boundaries.repositoryRoot, "repository root"),
      canonicalizeExistingDirectory(boundaries.stateHome, "state root"),
    ]);
    // A local-looking junction may resolve to a share or device namespace.
    validateEdgeProfileDirectoryPath(profile.path);
    const [profileIdentity, repositoryIdentity, stateIdentity] = await Promise.all([
      identityDetector(profile.existingAncestor),
      identityDetector(repositoryRoot),
      identityDetector(stateHome),
    ]);

    for (const [name, protectedRoot, protectedIdentity] of [
      ["repository", repositoryRoot, repositoryIdentity],
      ["state", stateHome, stateIdentity],
    ] as const) {
      if (pathsOverlap(profile.path, profileIdentity, protectedRoot, protectedIdentity)) {
        throw new AgentError(
          "CONFIG_INVALID",
          `Dedicated Edge profile directory must not overlap the ${name} root`,
          { diagnosticCode: "EDGE_PROFILE_PATH_OVERLAP", boundary: name },
        );
      }
    }
    for (const ordinaryRoot of boundaries.ordinaryProfileRoots ?? []) {
      const protectedProfile = await canonicalizeProspectiveDirectory(ordinaryRoot);
      const protectedIdentity = await identityDetector(protectedProfile.existingAncestor);
      if (pathsOverlap(profile.path, profileIdentity, protectedProfile.path, protectedIdentity)) {
        throw new AgentError(
          "CONFIG_INVALID",
          "Dedicated Edge profile directory must not overlap an ordinary Microsoft Edge profile",
          { diagnosticCode: "EDGE_PROFILE_PATH_OVERLAP", boundary: "ordinary-edge-profile" },
        );
      }
    }
    return profile.path;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError(
      "CONFIG_INVALID",
      `Dedicated Edge profile path is unsafe: ${error instanceof Error ? error.message : String(error)}`,
      { diagnosticCode: "EDGE_PROFILE_PATH_UNSAFE" },
      { cause: error },
    );
  }
}

export class ExclusiveProfileLock {
  readonly profileDirectory: string;
  readonly #lockPath: string;
  readonly #token: string;
  #released = false;

  private constructor(profileDirectory: string, lockPath: string, token: string) {
    this.profileDirectory = profileDirectory;
    this.#lockPath = lockPath;
    this.#token = token;
  }

  public static async acquire(
    profileDirectory: string,
    host: HostPlatform = CURRENT_HOST_PLATFORM,
  ): Promise<ExclusiveProfileLock> {
    const canonicalProfileDirectory = await prepareDedicatedProfileRoot(profileDirectory, host);
    profileDirectory = canonicalProfileDirectory;
    await assertDirectoryIsNotLink(profileDirectory);
    const lockPath = path.join(profileDirectory, LOCK_FILE);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = newId("profile-lock");
      const metadata: LockMetadata = {
        version: 1,
        pid: process.pid,
        token,
        createdAt: new Date().toISOString(),
      };
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(metadata), "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return new ExclusiveProfileLock(profileDirectory, lockPath, token);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const owner = await readLockMetadata(lockPath);
        if (owner === undefined) {
          throw new AgentError(
            "TRANSPORT_UNAVAILABLE",
            "The dedicated Edge profile lock cannot be verified",
            { diagnosticCode: "EDGE_PROFILE_LOCK_UNREADABLE" },
          );
        }
        if (isProcessAlive(owner.pid)) {
          throw new AgentError(
            "TRANSPORT_UNAVAILABLE",
            "The dedicated Edge profile is already in use",
            { diagnosticCode: "EDGE_PROFILE_LOCKED" },
          );
        }
        // A dead owner's lock is recoverable. The token check in release and
        // exclusive recreate keep this bounded race fail-closed.
        await unlink(lockPath).catch((unlinkError: unknown) => {
          if (!isNotFound(unlinkError)) throw unlinkError;
        });
      }
    }
    throw new AgentError("TRANSPORT_UNAVAILABLE", "Could not acquire the Edge profile lock", {
      diagnosticCode: "EDGE_PROFILE_LOCK_RACE",
    });
  }

  public async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    const owner = await readLockMetadata(this.#lockPath);
    if (owner?.token !== this.#token) return;
    await unlink(this.#lockPath).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }
}

/** Refuses to attach automation to an existing, unmarked everyday profile. */
export async function prepareDedicatedProfile(profileDirectory: string): Promise<void> {
  await assertDirectoryIsNotLink(profileDirectory);
  const markerPath = path.join(profileDirectory, PROFILE_MARKER);
  const entries = await readdir(profileDirectory);
  const hasMarker = entries.includes(PROFILE_MARKER);
  if (hasMarker) {
    const marker = await readProfileMarker(markerPath);
    if (marker !== PROFILE_MARKER_KIND) {
      throw new AgentError("CONFIG_INVALID", "Dedicated Edge profile marker is invalid", {
        diagnosticCode: "EDGE_PROFILE_MARKER_INVALID",
      });
    }
    return;
  }

  const foreignEntries = entries.filter((entry) => entry !== LOCK_FILE);
  if (foreignEntries.length > 0) {
    throw new AgentError(
      "CONFIG_INVALID",
      "Refusing to use a non-empty, unmarked Edge profile directory",
      { diagnosticCode: "EDGE_PROFILE_NOT_DEDICATED", entryCount: foreignEntries.length },
    );
  }
  await writeFile(
    markerPath,
    `${JSON.stringify({ kind: PROFILE_MARKER_KIND, createdAt: new Date().toISOString() })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
}

async function canonicalizeProspectiveDirectory(candidate: string): Promise<{
  readonly path: string;
  readonly existingAncestor: string;
}> {
  let cursor = path.resolve(candidate);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      await lstat(cursor);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.push(path.basename(cursor));
      cursor = parent;
      continue;
    }
    // lstat proved this entry exists. A dangling or inaccessible link must
    // fail here rather than being mistaken for another missing path segment.
    const canonicalAncestor = await realpath(cursor);
    const metadata = await stat(canonicalAncestor);
    if (!metadata.isDirectory()) {
      throw new TypeError("profileDirectory or its existing ancestor is not a directory");
    }
    return {
      path: path.join(canonicalAncestor, ...missingSegments.reverse()),
      existingAncestor: canonicalAncestor,
    };
  }
}

async function canonicalizeExistingDirectory(candidate: string, label: string): Promise<string> {
  const canonical = await realpath(candidate);
  if (!(await stat(canonical)).isDirectory()) {
    throw new TypeError(`${label} must be a directory`);
  }
  return canonical;
}

function pathsOverlap(
  left: string,
  leftIdentity: FilesystemIdentity,
  right: string,
  rightIdentity: FilesystemIdentity,
): boolean {
  if (leftIdentity.device !== rightIdentity.device) return false;
  return isSameOrWithin(left, right, leftIdentity) || isSameOrWithin(right, left, leftIdentity);
}

function isSameOrWithin(root: string, candidate: string, identity: FilesystemIdentity): boolean {
  const comparisonRoot = identity.pathKey(path.resolve(root)).replace(/\/+$/u, "");
  const comparisonCandidate = identity.pathKey(path.resolve(candidate)).replace(/\/+$/u, "");
  return comparisonCandidate === comparisonRoot || comparisonCandidate.startsWith(`${comparisonRoot}/`);
}

async function assertDirectoryIsNotLink(profileDirectory: string): Promise<void> {
  const metadata = await lstat(profileDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new AgentError("CONFIG_INVALID", "Dedicated Edge profile path must be a real directory", {
      diagnosticCode: "EDGE_PROFILE_PATH_UNSAFE",
    });
  }
}

async function readProfileMarker(path: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed !== null && typeof parsed === "object" && "kind" in parsed) {
      const kind = (parsed as { kind?: unknown }).kind;
      return typeof kind === "string" ? kind : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function readLockMetadata(path: string): Promise<LockMetadata | undefined> {
  try {
    await access(path, constants.R_OK);
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { version?: unknown }).version === 1 &&
      Number.isSafeInteger((parsed as { pid?: unknown }).pid) &&
      typeof (parsed as { token?: unknown }).token === "string" &&
      typeof (parsed as { createdAt?: unknown }).createdAt === "string"
    ) {
      return parsed as LockMetadata;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isPermissionDenied(error);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isPermissionDenied(error: unknown): boolean {
  return isNodeError(error) && error.code === "EPERM";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
