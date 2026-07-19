import { lstat, mkdir, opendir, realpath } from "node:fs/promises";
import path from "node:path";

import { AgentError } from "../shared/errors.js";
import { detectFilesystemIdentity } from "../shared/filesystem-identity.js";
import type { HostPlatform } from "./contracts.js";

const DEFAULT_MAX_PRIVATE_STORAGE_ENTRIES = 200_000;
const PROFILE_LOCK = ".copilot-agent-profile.lock";
const PROFILE_MARKER = ".copilot-agent-profile-v1.json";

export async function preparePrivateStateHome(
  requested: string,
  host: HostPlatform,
  maxEntries = DEFAULT_MAX_PRIVATE_STORAGE_ENTRIES,
): Promise<string> {
  const resolved = path.resolve(requested);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  if (host.platform === "darwin") await verifyDarwinPrivateStateHome(resolved, maxEntries);
  return await realpath(resolved);
}

export async function verifyPrivateStateHome(
  stateHome: string,
  host: HostPlatform,
  maxEntries = DEFAULT_MAX_PRIVATE_STORAGE_ENTRIES,
): Promise<void> {
  if (host.platform === "darwin") await verifyDarwinPrivateStateHome(stateHome, maxEntries);
}

export async function prepareDedicatedProfileRoot(
  profileDirectory: string,
  host: HostPlatform,
  maxEntries = DEFAULT_MAX_PRIVATE_STORAGE_ENTRIES,
): Promise<string> {
  const resolved = path.resolve(profileDirectory);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  if (host.platform === "darwin") await verifyDarwinDedicatedProfileRoot(resolved, maxEntries);
  return await realpath(resolved);
}

export async function verifyDedicatedProfileRoot(
  profileDirectory: string,
  host: HostPlatform,
  maxEntries = DEFAULT_MAX_PRIVATE_STORAGE_ENTRIES,
): Promise<void> {
  if (host.platform === "darwin") await verifyDarwinDedicatedProfileRoot(profileDirectory, maxEntries);
}

export async function verifyDarwinPrivateStateHome(
  stateHome: string,
  maxEntries = DEFAULT_MAX_PRIVATE_STORAGE_ENTRIES,
): Promise<void> {
  const uid = requiredUid();
  const canonical = await assertSafeRoot(stateHome, uid, "state", 0o700);
  const identity = await detectFilesystemIdentity(canonical);
  await traversePrivateTree(canonical, identity.device, uid, maxEntries, true);
}

export async function verifyDarwinDedicatedProfileRoot(
  profileDirectory: string,
  maxEntries = DEFAULT_MAX_PRIVATE_STORAGE_ENTRIES,
): Promise<void> {
  const uid = requiredUid();
  const canonical = await assertSafeRoot(profileDirectory, uid, "profile", 0o700);
  const identity = await detectFilesystemIdentity(canonical);
  await traversePrivateTree(canonical, identity.device, uid, maxEntries, false);
}

async function assertSafeRoot(
  requested: string,
  uid: number,
  kind: "state" | "profile",
  requiredMode: number,
): Promise<string> {
  const resolved = path.resolve(requested);
  const lexicalState = await lstat(resolved);
  if (lexicalState.isSymbolicLink() || !lexicalState.isDirectory()) {
    throw storageError(kind, "Private storage root must be a real directory", resolved);
  }
  assertOwnerAndMode(lexicalState, uid, requiredMode, kind, resolved);
  return await realpath(resolved);
}

async function traversePrivateTree(
  root: string,
  rootDevice: number,
  uid: number,
  maxEntries: number,
  exactModes: boolean,
): Promise<void> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new AgentError("CONFIG_INVALID", "Private storage traversal limit is invalid");
  }
  const kind = exactModes ? "state" : "profile";
  const queue = [root];
  let traversed = 0;
  while (queue.length > 0) {
    const directory = queue.shift();
    if (directory === undefined) break;
    const before = await lstat(directory);
    assertSafeEntry(before, rootDevice, uid, kind, directory);
    if (!before.isDirectory()) throw storageError(kind, "Private storage traversal expected a directory", directory);
    if (exactModes || directory === root) assertExactMode(before.mode, 0o700, kind, directory);
    const handle = await opendir(directory);
    const children = [];
    for await (const child of handle) {
      traversed += 1;
      if (traversed > maxEntries) {
        throw new AgentError("BUDGET_EXCEEDED", "Private storage tree exceeds its deterministic entry limit", {
          diagnosticCode: "PRIVATE_STORAGE_ENTRY_LIMIT",
          maxEntries,
        });
      }
      children.push(child.name);
    }
    children.sort((left, right) => left.localeCompare(right));
    for (const name of children) {
      const childPath = path.join(directory, name);
      const state = await lstat(childPath);
      assertSafeEntry(state, rootDevice, uid, kind, childPath);
      if (state.isDirectory()) {
        if (exactModes) assertExactMode(state.mode, 0o700, kind, childPath);
        queue.push(childPath);
        continue;
      }
      if (!state.isFile()) throw storageError(kind, "Private storage contains an unsupported entry", childPath);
      if (exactModes || (directory === root && (name === PROFILE_LOCK || name === PROFILE_MARKER))) {
        assertExactMode(state.mode, 0o600, kind, childPath);
      }
    }
    const after = await lstat(directory);
    if (before.dev !== after.dev || before.ino !== after.ino || after.isSymbolicLink()) {
      throw storageError(kind, "Private storage changed identity during verification", directory);
    }
  }
}

function assertSafeEntry(
  state: Awaited<ReturnType<typeof lstat>>,
  rootDevice: number,
  uid: number,
  kind: "state" | "profile",
  entryPath: string,
): void {
  if (state.isSymbolicLink()) throw storageError(kind, "Private storage must not contain links", entryPath);
  if (state.dev !== rootDevice) {
    throw storageError(kind, "Private storage crossed a filesystem device boundary", entryPath, {
      diagnosticCode: "PRIVATE_STORAGE_DEVICE_TRANSITION",
    });
  }
  if (state.uid !== uid) throw storageError(kind, "Private storage ownership does not match the current user", entryPath);
}

function assertOwnerAndMode(
  state: Awaited<ReturnType<typeof lstat>>,
  uid: number,
  mode: number,
  kind: "state" | "profile",
  entryPath: string,
): void {
  if (state.uid !== uid) throw storageError(kind, "Private storage ownership does not match the current user", entryPath);
  assertExactMode(Number(state.mode), mode, kind, entryPath);
}

function assertExactMode(
  observedMode: number,
  expectedMode: number,
  kind: "state" | "profile",
  entryPath: string,
): void {
  const observed = observedMode & 0o777;
  if (observed !== expectedMode) {
    throw storageError(kind, "Private storage permissions are broader than the required private mode", entryPath, {
      expectedMode: expectedMode.toString(8).padStart(3, "0"),
      observedMode: observed.toString(8).padStart(3, "0"),
    });
  }
}

function requiredUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid <= 0) {
    throw new AgentError("ELEVATED_EXECUTION_REFUSED", "Unable to verify a non-root owner for private macOS storage", {
      diagnosticCode: uid === 0 ? "DARWIN_ROOT_REFUSED" : "DARWIN_UID_UNVERIFIED",
    });
  }
  return uid;
}

function storageError(
  kind: "state" | "profile",
  message: string,
  entryPath: string,
  details: Readonly<Record<string, unknown>> = {},
): AgentError {
  return new AgentError("CONFIG_INVALID", message, {
    diagnosticCode: kind === "state" ? "DARWIN_PRIVATE_STATE_UNSAFE" : "DARWIN_PRIVATE_PROFILE_UNSAFE",
    path: entryPath,
    ...details,
  });
}
