import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import path from "node:path";

import { assertValidSessionGrant, type SessionGrant } from "../policy/index.js";
import { sha256, stableJson } from "../shared/crypto.js";
import { AgentError, errorMessage } from "../shared/errors.js";
import type { TransportSelection } from "./arguments.js";
import { CURRENT_HOST_PLATFORM } from "../platform/index.js";

export const SESSION_RUNTIME_MANIFEST_VERSION = "cba-session-runtime/1" as const;

export interface SessionRuntimeManifest {
  readonly schema_version: typeof SESSION_RUNTIME_MANIFEST_VERSION;
  readonly transport: TransportSelection;
  readonly source_file?: string;
  readonly source_sha256?: string;
  readonly browser_config_sha256?: string;
  readonly browser_identity_sha256?: string;
  readonly created_at: string;
}

export function grantFile(sessionDirectory: string): string {
  return path.join(sessionDirectory, "grant.json");
}

export function runtimeManifestFile(sessionDirectory: string): string {
  return path.join(sessionDirectory, "runtime.json");
}

export async function writeSessionGrant(sessionDirectory: string, grant: SessionGrant): Promise<string> {
  assertValidSessionGrant(grant);
  const serialized = stableJson(grant);
  await atomicWrite(grantFile(sessionDirectory), `${serialized}\n`);
  return sha256(serialized);
}

export async function readSessionGrant(sessionDirectory: string): Promise<SessionGrant> {
  const filename = grantFile(sessionDirectory);
  try {
    const value = JSON.parse(await readFile(filename, "utf8")) as unknown;
    assertValidSessionGrant(value);
    return value;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError("RECOVERY_REQUIRED", `Unable to load the session grant: ${errorMessage(error)}`, {
      filename,
    }, { cause: error });
  }
}

export async function writeRuntimeManifest(
  sessionDirectory: string,
  manifest: SessionRuntimeManifest,
): Promise<void> {
  validateRuntimeManifest(manifest);
  await atomicWrite(runtimeManifestFile(sessionDirectory), `${stableJson(manifest)}\n`);
}

export async function readRuntimeManifest(sessionDirectory: string): Promise<SessionRuntimeManifest> {
  const filename = runtimeManifestFile(sessionDirectory);
  try {
    const manifest = JSON.parse(await readFile(filename, "utf8")) as unknown;
    validateRuntimeManifest(manifest);
    return manifest;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError("RECOVERY_REQUIRED", `Unable to load the session runtime manifest: ${errorMessage(error)}`, {
      filename,
    }, { cause: error });
  }
}

export async function sourceFileIdentity(filename: string): Promise<{
  readonly canonicalPath: string;
  readonly sha256: string;
}> {
  try {
    const canonicalPath = await realpath(filename);
    const bytes = await readFile(canonicalPath);
    if (bytes.length > 32 * 1024 * 1024) {
      throw new AgentError("CONFIG_INVALID", "Transport source file exceeds 32 MiB", { filename: canonicalPath });
    }
    return { canonicalPath, sha256: sha256(bytes) };
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError("CONFIG_INVALID", `Unable to inspect transport source: ${errorMessage(error)}`, {
      filename,
    }, { cause: error });
  }
}

export function assertBrowserRuntimeManifestMatches(
  manifest: SessionRuntimeManifest,
  hashes: {
    readonly browser?: string;
    readonly browserIdentity?: string;
    readonly browserIdentityAliases?: readonly string[];
  },
): void {
  if (manifest.browser_config_sha256 !== hashes.browser) {
    throw new AgentError("RECOVERY_REQUIRED", "Browser configuration changed during the session");
  }
  if (
    manifest.browser_identity_sha256 !== undefined &&
    manifest.browser_identity_sha256 !== hashes.browserIdentity &&
    !(hashes.browserIdentityAliases ?? []).includes(manifest.browser_identity_sha256)
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Verified browser identity changed during the session");
  }
}

function validateRuntimeManifest(value: unknown): asserts value is SessionRuntimeManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentError("RECOVERY_REQUIRED", "Session runtime manifest must be an object");
  }
  const item = value as Partial<SessionRuntimeManifest> & Readonly<Record<string, unknown>>;
  const unknown = Object.keys(item).filter((key) => ![
    "schema_version",
    "transport",
    "source_file",
    "source_sha256",
    "browser_config_sha256",
    "browser_identity_sha256",
    "created_at",
  ].includes(key));
  if (
    unknown.length > 0 ||
    item.schema_version !== SESSION_RUNTIME_MANIFEST_VERSION ||
    !["edge", "fixture", "replay"].includes(item.transport ?? "") ||
    typeof item.created_at !== "string" ||
    (item.source_file === undefined) !== (item.source_sha256 === undefined) ||
    (item.source_file !== undefined && typeof item.source_file !== "string") ||
    (item.source_sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(item.source_sha256)) ||
    (item.browser_config_sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(item.browser_config_sha256)) ||
    (item.browser_identity_sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(item.browser_identity_sha256)) ||
    (item.browser_identity_sha256 !== undefined &&
      (item.browser_config_sha256 === undefined || item.transport !== "edge"))
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Session runtime manifest failed validation", { unknown });
  }
  if (item.transport === "edge" && item.source_file !== undefined) {
    throw new AgentError("RECOVERY_REQUIRED", "Live browser sessions cannot have an offline source file");
  }
  if (item.transport !== "edge" && item.source_file === undefined) {
    throw new AgentError("RECOVERY_REQUIRED", "Offline sessions require a pinned source file");
  }
}

async function atomicWrite(filename: string, content: string): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filename);
  if (CURRENT_HOST_PLATFORM.supportsDirectoryFsync) {
    const directory = await open(path.dirname(filename), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
