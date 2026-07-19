import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { AgentError } from "./errors.js";

export interface FilesystemIdentity {
  readonly device: number;
  readonly caseSensitive: boolean;
  readonly unicodeNormalizationAliases: boolean;
  normalize(value: string): string;
  pathKey(value: string): string;
}

export interface FilesystemIdentityFacts {
  readonly device: number;
  readonly caseSensitive: boolean;
  readonly unicodeNormalizationAliases: boolean;
}

const identityByDevice = new Map<number, Promise<FilesystemIdentity>>();

export function createFilesystemIdentity(facts: FilesystemIdentityFacts): FilesystemIdentity {
  if (!Number.isSafeInteger(facts.device) || facts.device < 0) {
    throw new TypeError("Filesystem device identity must be a non-negative safe integer");
  }
  const normalize = (value: string): string => {
    const separators = value.replaceAll("\\", "/");
    const unicode = facts.unicodeNormalizationAliases ? separators.normalize("NFC") : separators;
    return facts.caseSensitive ? unicode : unicode.toLowerCase();
  };
  return Object.freeze({
    ...facts,
    normalize,
    pathKey: normalize,
  });
}

export async function detectFilesystemIdentity(anchor: string): Promise<FilesystemIdentity> {
  const canonical = await realpath(anchor);
  const metadata = await stat(canonical);
  const directory = metadata.isDirectory() ? canonical : path.dirname(canonical);
  const device = metadata.dev;
  const existing = identityByDevice.get(device);
  if (existing !== undefined) return existing;
  const pending = probeFilesystemIdentity(directory, device).catch((error: unknown) => {
    identityByDevice.delete(device);
    throw error;
  });
  identityByDevice.set(device, pending);
  return pending;
}

/** Exported for deterministic probe-cleanup verification; production callers use the cached detector. */
export async function probeFilesystemIdentity(
  startDirectory: string,
  device: number,
): Promise<FilesystemIdentity> {
  const probeParent = await findWritableDirectoryOnDevice(startDirectory, device);
  let probeDirectory: string | undefined;
  try {
    probeDirectory = await mkdtemp(path.join(probeParent, ".cope-fs-identity-"));
    await mkdir(probeDirectory, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const caseName = "CopeCaseAa";
    const casePath = path.join(probeDirectory, caseName);
    await writeFile(casePath, "case\n", { flag: "wx", mode: 0o600 });
    const caseAliases = await aliasesSameEntry(casePath, path.join(probeDirectory, caseName.toLowerCase()));

    const nfcName = "CopeUnicode-\u00e9";
    const nfdName = nfcName.normalize("NFD");
    const unicodePath = path.join(probeDirectory, nfcName);
    await writeFile(unicodePath, "unicode\n", { flag: "wx", mode: 0o600 });
    const unicodeAliases = await aliasesSameEntry(unicodePath, path.join(probeDirectory, nfdName));
    return createFilesystemIdentity({
      device,
      caseSensitive: !caseAliases,
      unicodeNormalizationAliases: unicodeAliases,
    });
  } catch (error) {
    throw new AgentError("CONFIG_INVALID", "Filesystem case and Unicode identity could not be verified", {
      diagnosticCode: "FILESYSTEM_IDENTITY_UNVERIFIED",
      device,
    }, { cause: error });
  } finally {
    if (probeDirectory !== undefined) await rm(probeDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function findWritableDirectoryOnDevice(start: string, device: number): Promise<string> {
  let cursor = start;
  for (;;) {
    const metadata = await lstat(cursor);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new AgentError("CONFIG_INVALID", "Filesystem probe anchor is not a real directory");
    }
    if (metadata.dev !== device) break;
    try {
      await access(cursor, constants.W_OK);
      return cursor;
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  throw new AgentError("CONFIG_INVALID", "No writable probe directory exists on the controlled volume", {
    diagnosticCode: "FILESYSTEM_IDENTITY_PROBE_UNAVAILABLE",
    device,
  });
}

async function aliasesSameEntry(original: string, alias: string): Promise<boolean> {
  const left = await lstat(original);
  try {
    const right = await lstat(alias);
    return left.dev === right.dev && left.ino === right.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
