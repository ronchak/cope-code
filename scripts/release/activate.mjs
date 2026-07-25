#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  ACTIVATION_VERSION,
  MAX_ARTIFACT_BYTES,
  MAX_METADATA_BYTES,
  canonicalJsonLine,
  compareText,
  exactObjectKeys,
  isWithin,
  safeTopLevelFilename,
} from "./lib.mjs";
import { readCanonicalJsonFile, verifyRelease } from "./verify.mjs";

export async function activateRelease(candidateInput, installRootInput, options) {
  const { candidate, installRoot, trustedPublicKeyFile } = await validateActivationPaths(
    candidateInput,
    installRootInput,
    options?.trustedPublicKeyFile,
  );
  return withActivationLock(installRoot, async () => {
    await cleanupActivationResidue(installRoot);
    const releasesRoot = path.join(installRoot, "releases");
    await mkdir(releasesRoot, { recursive: true, mode: 0o700 });
    await requireRealDirectory(releasesRoot, "Release store");

    let staging = path.join(installRoot, `.staged-${randomUUID()}`);
    try {
      await snapshotCandidateBundle(candidate, staging);
      const verification = await verifyRelease(staging, { trustedPublicKeyFile });
      if (verification.channel !== "stable" && options?.allowPreview !== true) {
        throw new Error("Activation accepts stable release evidence only; --allow-preview is development-only");
      }
      if (!verification.publisherAuthenticated) {
        throw new Error("Activation requires publisher authentication against an external trust root");
      }

      const releaseId = verification.manifestSha256;
      const releaseReference = { manifestSha256: releaseId, version: verification.version };
      const prior = await readActivationState(installRoot);
      if (prior !== undefined) {
        const precedence = compareReleaseVersions(releaseReference.version, prior.current.version);
        if (precedence < 0) {
          throw new Error("Ordinary activation refuses a signed downgrade; use the explicit authenticated rollback path");
        }
        if (precedence === 0 && releaseReference.manifestSha256 !== prior.current.manifestSha256) {
          throw new Error("Ordinary activation refuses same-version release equivocation");
        }
      }

      const releasePath = path.join(releasesRoot, releaseId);
      let releaseExists = false;
      try {
        const stat = await lstat(releasePath);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Stored release path is not a real directory");
        releaseExists = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (releaseExists) {
        const stored = await verifyRelease(releasePath, { trustedPublicKeyFile });
        if (stored.manifestSha256 !== releaseId || stored.version !== releaseReference.version ||
            !stored.publisherAuthenticated) {
          throw new Error("Existing release-store entry failed publisher-authenticated verification");
        }
        await removeStaging(staging);
      } else {
        await makeBundleReadOnly(staging);
        const finalVerification = await verifyRelease(staging, { trustedPublicKeyFile });
        if (!finalVerification.publisherAuthenticated ||
            finalVerification.manifestSha256 !== releaseReference.manifestSha256 ||
            finalVerification.version !== releaseReference.version) {
          throw new Error("Read-only activation snapshot changed before release-store publication");
        }
        await rename(staging, releasePath);
      }
      staging = undefined;

      if (prior?.current.manifestSha256 === releaseId) {
        return {
          activated: false,
          unchanged: true,
          current: releaseId,
          previous: prior.previous?.manifestSha256 ?? null,
          releasePath,
        };
      }
      const state = {
        schemaVersion: ACTIVATION_VERSION,
        current: releaseReference,
        previous: prior?.current ?? null,
      };
      await commitActivationState(installRoot, state);
      return {
        activated: true,
        unchanged: false,
        current: state.current.manifestSha256,
        previous: state.previous?.manifestSha256 ?? null,
        releasePath,
      };
    } finally {
      if (staging !== undefined) await removeStaging(staging);
    }
  });
}

export async function rollbackRelease(installRootInput, options) {
  const installRoot = await existingInstallRoot(installRootInput);
  const trustedPublicKeyFile = await externalTrustPath(options?.trustedPublicKeyFile, installRoot, undefined);
  return withActivationLock(installRoot, async () => {
    await cleanupActivationResidue(installRoot);
    const state = await readActivationState(installRoot);
    if (state === undefined || state.previous === null) throw new Error("No previously activated release is available");
    const previousPath = path.join(installRoot, "releases", state.previous.manifestSha256);
    const verification = await verifyRelease(previousPath, { trustedPublicKeyFile });
    if (!verification.publisherAuthenticated ||
        verification.manifestSha256 !== state.previous.manifestSha256 ||
        verification.version !== state.previous.version) {
      throw new Error("Previous release failed publisher-authenticated verification");
    }
    if (verification.channel !== "stable" && options?.allowPreview !== true) {
      throw new Error("Rollback target is preview evidence; --allow-preview is development-only");
    }
    const rolledBack = {
      schemaVersion: ACTIVATION_VERSION,
      current: state.previous,
      previous: state.current,
    };
    await commitActivationState(installRoot, rolledBack);
    return {
      rolledBack: true,
      current: rolledBack.current.manifestSha256,
      previous: rolledBack.previous.manifestSha256,
      releasePath: previousPath,
    };
  });
}

export async function readActivationState(installRoot) {
  const statePath = path.join(installRoot, "activation.json");
  try {
    const { value } = await readCanonicalJsonFile(statePath, "activation state", 16 * 1024);
    exactObjectKeys(value, ["current", "previous", "schemaVersion"], "Activation state");
    if (value.schemaVersion !== ACTIVATION_VERSION) {
      throw new Error("Activation state is invalid");
    }
    validateReleaseReference(value.current, "current activation");
    if (value.previous !== null) validateReleaseReference(value.previous, "previous activation");
    if (value.previous?.manifestSha256 === value.current.manifestSha256) throw new Error("Activation state is invalid");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function validateActivationPaths(candidateInput, installRootInput, trustInput) {
  if (typeof candidateInput !== "string" || candidateInput.length === 0) throw new Error("A candidate directory is required");
  const requestedCandidate = path.resolve(candidateInput);
  const candidateStat = await lstat(requestedCandidate);
  if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
    throw new Error("Candidate release must be a real directory");
  }
  const candidate = await realpath(requestedCandidate);
  const installRoot = await createInstallRoot(installRootInput);
  if (isWithin(candidate, installRoot) || isWithin(installRoot, candidate)) {
    throw new Error("Candidate release and install root must be disjoint");
  }
  const trustedPublicKeyFile = await externalTrustPath(trustInput, installRoot, candidate);
  return { candidate, installRoot, trustedPublicKeyFile };
}

async function createInstallRoot(input) {
  if (typeof input !== "string" || input.length === 0) throw new Error("An install root is required");
  const requested = path.resolve(input);
  if (requested === path.parse(requested).root) throw new Error("Filesystem roots cannot be activation targets");
  await mkdir(requested, { recursive: true, mode: 0o700 });
  return existingInstallRoot(requested);
}

async function existingInstallRoot(input) {
  if (typeof input !== "string" || input.length === 0) throw new Error("An install root is required");
  const requested = path.resolve(input);
  if (requested === path.parse(requested).root) throw new Error("Filesystem roots cannot be activation targets");
  const stat = await lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Install root must be a real directory");
  return realpath(requested);
}

async function externalTrustPath(input, installRoot, candidate) {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error("Activation requires --trusted-public-key or COPE_RELEASE_TRUSTED_PUBLIC_KEY_FILE");
  }
  const requested = path.resolve(input);
  const stat = await lstat(requested);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Trusted publisher key must be a regular, non-symlink file");
  const trusted = await realpath(requested);
  if (isWithin(installRoot, trusted) || (candidate !== undefined && isWithin(candidate, trusted))) {
    throw new Error("Trusted publisher key must be outside the candidate and install root");
  }
  return trusted;
}

async function requireRealDirectory(directory, label) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

async function snapshotCandidateBundle(candidate, staging) {
  const rootBefore = await lstat(candidate);
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
    throw new Error("Candidate release must remain a real directory while it is snapshotted");
  }
  const names = await boundedBundleNames(candidate);
  await mkdir(staging, { mode: 0o700 });
  for (const name of names) {
    const maximumBytes = name.endsWith(".tgz") ? MAX_ARTIFACT_BYTES : MAX_METADATA_BYTES;
    await copyBoundedRegularFile(path.join(candidate, name), path.join(staging, name), maximumBytes);
  }
  const namesAfter = await boundedBundleNames(candidate);
  const rootAfter = await lstat(candidate);
  if (!sameFileIdentity(rootBefore, rootAfter) ||
      names.length !== namesAfter.length ||
      names.some((name, index) => name !== namesAfter[index])) {
    throw new Error("Candidate release changed while it was being snapshotted");
  }
}

async function boundedBundleNames(candidate) {
  const entries = await readdir(candidate, { withFileTypes: true });
  if (entries.length < 4 || entries.length > 5 ||
      entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("Candidate release must contain only four or five regular top-level files");
  }
  const names = entries.map((entry) => safeTopLevelFilename(entry.name, "candidate release filename"));
  const nameSet = new Set(names);
  const artifactNames = names.filter((name) => name.endsWith(".tgz"));
  const requiredNames = ["channel.json", "manifest.json", "sbom.spdx.json"];
  if (artifactNames.length !== 1 ||
      requiredNames.some((name) => !nameSet.has(name)) ||
      names.some((name) => !requiredNames.includes(name) && name !== "manifest.sig.json" && !name.endsWith(".tgz")) ||
      (names.length === 5) !== nameSet.has("manifest.sig.json")) {
    throw new Error("Candidate release has unexpected or missing top-level files");
  }
  return names.sort(compareText);
}

async function copyBoundedRegularFile(source, destination, maximumBytes) {
  const before = await lstat(source);
  if (!before.isFile() || before.isSymbolicLink() ||
      !Number.isSafeInteger(before.size) || before.size < 0 || before.size > maximumBytes) {
    throw new Error(`Candidate entry is not a bounded regular file: ${path.basename(source)}`);
  }

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const sourceHandle = await open(source, fsConstants.O_RDONLY | noFollow);
  let destinationHandle;
  try {
    const opened = await sourceHandle.stat();
    if (!opened.isFile() || !sameFileIdentity(before, opened) || opened.size > maximumBytes) {
      throw new Error(`Candidate entry changed before it could be snapshotted: ${path.basename(source)}`);
    }
    destinationHandle = await open(destination, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < opened.size) {
      const requested = Math.min(buffer.length, opened.size - position);
      const { bytesRead } = await sourceHandle.read(buffer, 0, requested, position);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
        if (result.bytesWritten === 0) throw new Error("Could not complete candidate snapshot");
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    const { bytesRead: trailingBytes } = await sourceHandle.read(trailing, 0, 1, position);
    const afterOpen = await sourceHandle.stat();
    const afterPath = await lstat(source);
    if (position !== opened.size || trailingBytes !== 0 ||
        !sameFileIdentity(opened, afterOpen) || afterOpen.size !== opened.size ||
        !sameFileIdentity(before, afterPath) || afterPath.size !== before.size ||
        !afterPath.isFile() || afterPath.isSymbolicLink()) {
      throw new Error(`Candidate entry changed while it was being snapshotted: ${path.basename(source)}`);
    }
    await destinationHandle.sync();
  } finally {
    if (destinationHandle !== undefined) await destinationHandle.close();
    await sourceHandle.close();
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function makeBundleReadOnly(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("Verified activation snapshot contains a non-regular entry");
  }
  for (const entry of entries) await chmod(path.join(directory, entry.name), 0o444);
}

async function removeStaging(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    await chmod(directory, 0o700).catch(() => {});
    for (const entry of entries) await chmod(path.join(directory, entry.name), 0o600).catch(() => {});
  } catch {
    // The staging path may not have been created yet or may be only partially present.
  }
  await rm(directory, { recursive: true, force: true });
}

async function cleanupActivationResidue(installRoot) {
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const residue = new RegExp(`^(?:\\.staged-${uuid}|\\.activation-${uuid}\\.json)$`, "u");
  const entries = await readdir(installRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (residue.test(entry.name)) await removeStaging(path.join(installRoot, entry.name));
  }
}

function validateReleaseReference(value, label) {
  exactObjectKeys(value, ["manifestSha256", "version"], label);
  if (!/^[a-f0-9]{64}$/u.test(value.manifestSha256) || !parseReleaseVersion(value.version)) {
    throw new Error("Activation state is invalid");
  }
}

function compareReleaseVersions(left, right) {
  const leftVersion = parseReleaseVersion(left);
  const rightVersion = parseReleaseVersion(right);
  if (leftVersion === undefined || rightVersion === undefined) throw new Error("Cannot compare invalid release versions");
  for (let index = 0; index < 3; index += 1) {
    const comparison = compareNumericIdentifier(leftVersion.core[index], rightVersion.core[index]);
    if (comparison !== 0) return comparison;
  }
  if (leftVersion.prerelease.length === 0 || rightVersion.prerelease.length === 0) {
    return leftVersion.prerelease.length === rightVersion.prerelease.length
      ? 0
      : leftVersion.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return compareNumericIdentifier(leftPart, rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function parseReleaseVersion(value) {
  if (typeof value !== "string") return undefined;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
  if (match === null) return undefined;
  const prerelease = match[4] === undefined ? [] : match[4].split(".");
  if (prerelease.some((part) => part === "" || (/^\d+$/u.test(part) && part.length > 1 && part.startsWith("0")))) {
    return undefined;
  }
  return { core: [match[1], match[2], match[3]], prerelease };
}

function compareNumericIdentifier(left, right) {
  return left.length === right.length ? (left < right ? -1 : left > right ? 1 : 0) : left.length < right.length ? -1 : 1;
}

async function withActivationLock(installRoot, operation) {
  const lockPath = path.join(installRoot, ".activation.lock");
  const token = randomUUID();
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("Another activation may be running; a stale lock requires explicit operator inspection");
    }
    throw error;
  }
  try {
    await writeExclusive(path.join(lockPath, "owner.json"), {
      schemaVersion: "cope-release-activation-lock/1",
      pid: process.pid,
      token,
      createdAt: new Date().toISOString(),
    });
    return await operation();
  } finally {
    let owned = false;
    try {
      const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
      owned = owner?.token === token;
    } catch {
      owned = false;
    }
    if (owned) await rm(lockPath, { recursive: true, force: true });
  }
}

async function commitActivationState(installRoot, state) {
  const temporary = path.join(installRoot, `.activation-${randomUUID()}.json`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(canonicalJsonLine(state), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path.join(installRoot, "activation.json"));
  } finally {
    if (handle !== undefined) await handle.close();
    await rm(temporary, { force: true });
  }
}

async function writeExclusive(filename, value) {
  const handle = await open(filename, "wx", 0o600);
  try {
    await handle.writeFile(canonicalJsonLine(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseArguments(args, environment) {
  let rollback = false;
  let allowPreview = false;
  let trustedPublicKeyFile = environment.COPE_RELEASE_TRUSTED_PUBLIC_KEY_FILE;
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--rollback") {
      if (rollback) throw new Error("Duplicate --rollback");
      rollback = true;
    } else if (argument === "--allow-preview") {
      if (allowPreview) throw new Error("Duplicate --allow-preview");
      allowPreview = true;
    } else if (argument === "--trusted-public-key") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("Missing value for --trusted-public-key");
      trustedPublicKeyFile = value;
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unsupported activation argument: ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  if (rollback) {
    if (positional.length !== 1) throw new Error("Usage: activate.mjs --rollback <install-root> --trusted-public-key <file>");
    return { rollback, installRoot: positional[0], options: { allowPreview, trustedPublicKeyFile } };
  }
  if (positional.length !== 2) {
    throw new Error("Usage: activate.mjs <candidate> <install-root> --trusted-public-key <file>");
  }
  return {
    rollback,
    candidate: positional[0],
    installRoot: positional[1],
    options: { allowPreview, trustedPublicKeyFile },
  };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const parsed = parseArguments(process.argv.slice(2), process.env);
    const result = parsed.rollback
      ? await rollbackRelease(parsed.installRoot, parsed.options)
      : await activateRelease(parsed.candidate, parsed.installRoot, parsed.options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
