#!/usr/bin/env node
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { inspectNpmArchive } from "./archive.mjs";
import { expectedChannelDocument, expectedSpdxDocumentNamespace } from "./generate.mjs";
import {
  MANIFEST_VERSION,
  MAX_ARTIFACT_BYTES,
  MAX_METADATA_BYTES,
  canonicalJson,
  canonicalJsonLine,
  exactObjectKeys,
  isWithin,
  readRegularFile,
  safeTopLevelFilename,
  sha256Bytes,
  verifyManifestSignature,
} from "./lib.mjs";

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export async function verifyRelease(rootInput, options = {}) {
  if (typeof rootInput !== "string" || rootInput.length === 0) throw new Error("A release directory is required");
  const requestedRoot = path.resolve(rootInput);
  const rootStat = await lstat(requestedRoot, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Release root must be a real directory");
  const root = await realpath(requestedRoot);

  const actualEntries = await readdir(root, { withFileTypes: true });
  if (actualEntries.length < 4 || actualEntries.length > 5 ||
      actualEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("Release directory must contain only its expected regular files");
  }
  const actualNames = new Set(actualEntries.map((entry) => entry.name));

  const { bytes: manifestBytes, value: manifest } = await readCanonicalJsonFile(
    path.join(root, "manifest.json"),
    "release manifest",
  );
  validateManifest(manifest);

  const artifactDescriptor = manifest.artifacts[0];
  const artifactName = safeTopLevelFilename(artifactDescriptor.path, "manifest artifact path");
  const artifactBytes = await readRegularFile(path.join(root, artifactName), MAX_ARTIFACT_BYTES);
  if (artifactBytes.length !== artifactDescriptor.bytes || sha256Bytes(artifactBytes) !== artifactDescriptor.sha256) {
    throw new Error("Release artifact size or digest does not match the manifest");
  }
  const archiveInspection = inspectNpmArchive(artifactBytes);
  if (canonicalJson(archiveInspection.entries) !== canonicalJson(artifactDescriptor.archive.entries) ||
      canonicalJson(archiveInspection.package) !== canonicalJson(artifactDescriptor.archive.package)) {
    throw new Error("Release archive contents do not match the signed manifest inventory");
  }

  const { bytes: sbomBytes, value: sbom } = await readCanonicalJsonFile(
    path.join(root, manifest.sbom.path),
    "SPDX SBOM",
  );
  if (sbomBytes.length !== manifest.sbom.bytes || sha256Bytes(sbomBytes) !== manifest.sbom.sha256) {
    throw new Error("SPDX SBOM size or digest does not match the manifest");
  }
  validateSpdx(sbom, manifest, artifactDescriptor);

  let signature;
  let signaturePresent = actualNames.has("manifest.sig.json");
  let publisherAuthenticated = false;
  if (signaturePresent) {
    signature = (await readCanonicalJsonFile(path.join(root, "manifest.sig.json"), "release signature")).value;
    let externalPublicKey;
    if (options.trustedPublicKeyFile !== undefined) {
      const trustPath = path.resolve(options.trustedPublicKeyFile);
      const trustStat = await lstat(trustPath);
      if (!trustStat.isFile() || trustStat.isSymbolicLink()) {
        throw new Error("Externally trusted publisher key must be a regular, non-symlink file");
      }
      const canonicalTrustPath = await realpath(trustPath);
      if (isWithin(root, canonicalTrustPath)) {
        throw new Error("Externally trusted publisher key must be outside the release bundle");
      }
      externalPublicKey = await readRegularFile(canonicalTrustPath, 64 * 1024);
    }
    ({ publisherAuthenticated } = verifyManifestSignature(manifestBytes, signature, externalPublicKey));
    if (options.trustedKeyId !== undefined) {
      if (!/^sha256:[a-f0-9]{64}$/u.test(options.trustedKeyId) || signature.keyId !== options.trustedKeyId) {
        throw new Error("Release signer does not match the externally trusted publisher key ID");
      }
      publisherAuthenticated = true;
    }
  }

  if (manifest.channel === "stable" && !signaturePresent) {
    throw new Error("Stable release evidence must contain a release signature");
  }
  if (options.requireSignature === true && !signaturePresent) {
    throw new Error("A cryptographically valid release signature is required");
  }
  if ((options.trustedPublicKeyFile !== undefined || options.trustedKeyId !== undefined) && !publisherAuthenticated) {
    throw new Error("Publisher authentication requires a valid signature and an external trust root");
  }

  const { value: channel } = await readCanonicalJsonFile(path.join(root, "channel.json"), "release channel");
  const expectedChannel = expectedChannelDocument(manifest, manifestBytes, signature);
  if (canonicalJson(channel) !== canonicalJson(expectedChannel)) {
    throw new Error("Release channel metadata does not exactly match the manifest and signature evidence");
  }

  const expectedNames = new Set([
    "channel.json",
    "manifest.json",
    "sbom.spdx.json",
    artifactName,
    ...(signaturePresent ? ["manifest.sig.json"] : []),
  ]);
  if (actualNames.size !== expectedNames.size || [...actualNames].some((name) => !expectedNames.has(name))) {
    throw new Error("Release directory contains unexpected or missing entries");
  }
  const finalEntries = await readdir(root, { withFileTypes: true });
  const finalRootStat = await lstat(root, { bigint: true });
  const finalNames = finalEntries.map((entry) => entry.name).sort();
  const initialNames = [...actualNames].sort();
  if (finalEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
      finalNames.length !== initialNames.length ||
      finalNames.some((name, index) => name !== initialNames[index]) ||
      rootStat.dev !== finalRootStat.dev || rootStat.ino !== finalRootStat.ino) {
    throw new Error("Release directory changed while it was being verified");
  }

  return {
    verified: true,
    integrityVerified: true,
    signaturePresent,
    publisherAuthenticated,
    manifestSha256: sha256Bytes(manifestBytes),
    version: manifest.version,
    channel: manifest.channel,
    artifact: artifactName,
    root,
    manifest,
  };
}

export async function readCanonicalJsonFile(filename, label, maximumBytes = MAX_METADATA_BYTES) {
  const bytes = await readRegularFile(filename, maximumBytes);
  let text;
  let value;
  try {
    text = utf8.decode(bytes);
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error });
  }
  if (text !== canonicalJsonLine(value)) throw new Error(`${label} is not canonical key-sorted JSON`);
  return { bytes, value };
}

function validateManifest(manifest) {
  exactObjectKeys(manifest, [
    "artifacts",
    "builder",
    "channel",
    "createdAt",
    "packageName",
    "product",
    "sbom",
    "schemaVersion",
    "sourceCommit",
    "version",
  ], "Release manifest");
  if (manifest.schemaVersion !== MANIFEST_VERSION || manifest.product !== "cope" ||
      manifest.packageName !== "@local/copilot-browser-agent" ||
      typeof manifest.version !== "string" || !SEMVER.test(manifest.version) ||
      (manifest.channel !== "preview" && manifest.channel !== "stable") ||
      (manifest.channel === "stable" && !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(manifest.version)) ||
      typeof manifest.createdAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(manifest.createdAt) ||
      new Date(manifest.createdAt).toISOString().replace(".000Z", "Z") !== manifest.createdAt ||
      typeof manifest.sourceCommit !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(manifest.sourceCommit)) {
    throw new Error("Release manifest identity or source metadata is invalid");
  }

  exactObjectKeys(manifest.builder, ["arch", "node", "npm", "platform"], "Release builder");
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(manifest.builder.arch) ||
      !/^[A-Za-z0-9._-]{1,64}$/u.test(manifest.builder.platform) ||
      !/^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/u.test(manifest.builder.node) ||
      !/^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/u.test(manifest.builder.npm)) {
    throw new Error("Release builder metadata is invalid");
  }

  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 1) {
    throw new Error("Release manifest must describe exactly one npm artifact");
  }
  const artifact = manifest.artifacts[0];
  exactObjectKeys(artifact, ["archive", "bytes", "path", "sha256"], "Release artifact");
  safeTopLevelFilename(artifact.path, "release artifact path");
  if (!artifact.path.endsWith(".tgz") || !safeByteCount(artifact.bytes, MAX_ARTIFACT_BYTES) ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256)) {
    throw new Error("Release artifact descriptor is invalid");
  }
  exactObjectKeys(artifact.archive, ["entries", "format", "package"], "Release archive descriptor");
  if (artifact.archive.format !== "npm-tgz" || !Array.isArray(artifact.archive.entries) ||
      artifact.archive.entries.length === 0 || artifact.archive.entries.length > 10000) {
    throw new Error("Release archive inventory is invalid");
  }
  const archivePaths = new Set();
  for (const entry of artifact.archive.entries) {
    exactObjectKeys(entry, ["bytes", "mode", "path", "sha256"], "Release archive entry");
    if (typeof entry.path !== "string" || !entry.path.startsWith("package/") ||
        entry.path.includes("\\") || entry.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
        archivePaths.has(entry.path) || !safeByteCount(entry.bytes, MAX_ARTIFACT_BYTES) ||
        (entry.mode !== 0o644 && entry.mode !== 0o755) || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
      throw new Error("Release archive inventory contains an unsafe or invalid entry");
    }
    archivePaths.add(entry.path);
  }
  exactObjectKeys(artifact.archive.package, ["bin", "dependencies", "name", "version"], "Packed package identity");
  exactObjectKeys(artifact.archive.package.bin, ["cope", "copilot-agent"], "Packed package executable mapping");
  if (artifact.archive.package.name !== manifest.packageName ||
      artifact.archive.package.version !== manifest.version ||
      artifact.archive.package.bin.cope !== "dist/src/cli/main.js" ||
      artifact.archive.package.bin["copilot-agent"] !== "dist/src/cli/main.js" ||
      artifact.archive.package.dependencies === null ||
      typeof artifact.archive.package.dependencies !== "object" ||
      Array.isArray(artifact.archive.package.dependencies) ||
      Object.keys(artifact.archive.package.dependencies).length > 1000 ||
      Object.entries(artifact.archive.package.dependencies).some(([name, version]) =>
        name.length > 214 || !NPM_PACKAGE_NAME.test(name) ||
        typeof version !== "string" || version.length === 0 || version.length > 256)) {
    throw new Error("Packed package identity does not match the release manifest");
  }

  exactObjectKeys(manifest.sbom, [
    "bytes",
    "documentNamespace",
    "path",
    "sha256",
    "spdxVersion",
  ], "Release SBOM descriptor");
  if (manifest.sbom.path !== "sbom.spdx.json" || manifest.sbom.spdxVersion !== "SPDX-2.3" ||
      !safeByteCount(manifest.sbom.bytes, MAX_METADATA_BYTES) ||
      !/^[a-f0-9]{64}$/u.test(manifest.sbom.sha256) ||
      typeof manifest.sbom.documentNamespace !== "string" ||
      !/^https:\/\/github\.com\/ronchak\/cope-code\/spdx\/[a-f0-9]{64}$/u.test(manifest.sbom.documentNamespace)) {
    throw new Error("Release SBOM descriptor is invalid");
  }
}

function validateSpdx(sbom, manifest, artifact) {
  exactObjectKeys(sbom, [
    "SPDXID",
    "creationInfo",
    "dataLicense",
    "documentDescribes",
    "documentNamespace",
    "name",
    "packages",
    "relationships",
    "spdxVersion",
  ], "SPDX document");
  if (sbom.spdxVersion !== "SPDX-2.3" || sbom.dataLicense !== "CC0-1.0" ||
      sbom.SPDXID !== "SPDXRef-DOCUMENT" || sbom.documentNamespace !== manifest.sbom.documentNamespace ||
      sbom.name !== `${manifest.packageName}-${manifest.version}` ||
      sbom.documentNamespace !== expectedSpdxDocumentNamespace({
        ...sbom,
        buildIdentity: {
          builder: manifest.builder,
          channel: manifest.channel,
          sourceCommit: manifest.sourceCommit,
        },
      })) {
    throw new Error("SPDX document identity is invalid");
  }
  exactObjectKeys(sbom.creationInfo, ["created", "creators"], "SPDX creation information");
  if (sbom.creationInfo.created !== manifest.createdAt ||
      !Array.isArray(sbom.creationInfo.creators) || sbom.creationInfo.creators.length !== 1 ||
      sbom.creationInfo.creators[0] !== "Tool: cope-release-generator/2") {
    throw new Error("SPDX creation information is invalid");
  }
  if (!Array.isArray(sbom.documentDescribes) || sbom.documentDescribes.length !== 1 ||
      sbom.documentDescribes[0] !== "SPDXRef-Package-Cope" ||
      !Array.isArray(sbom.packages) || sbom.packages.length === 0 ||
      !Array.isArray(sbom.relationships)) {
    throw new Error("SPDX package graph is incomplete");
  }

  const packageIds = new Set();
  for (const [index, packageEntry] of sbom.packages.entries()) {
    const expectedKeys = [
      "SPDXID",
      "copyrightText",
      "downloadLocation",
      "filesAnalyzed",
      "licenseConcluded",
      "licenseDeclared",
      "name",
      "primaryPackagePurpose",
      "versionInfo",
      ...(packageEntry.checksums === undefined ? [] : ["checksums"]),
    ];
    exactObjectKeys(packageEntry, expectedKeys, "SPDX package");
    if (typeof packageEntry.SPDXID !== "string" || !/^SPDXRef-[A-Za-z0-9.-]+$/u.test(packageEntry.SPDXID) ||
        packageIds.has(packageEntry.SPDXID) || typeof packageEntry.name !== "string" || packageEntry.name.length === 0 ||
        typeof packageEntry.versionInfo !== "string" || packageEntry.versionInfo.length === 0 ||
        packageEntry.downloadLocation !== "NOASSERTION" || packageEntry.filesAnalyzed !== false ||
        packageEntry.licenseConcluded !== "NOASSERTION" || packageEntry.licenseDeclared !== "NOASSERTION" ||
        packageEntry.copyrightText !== "NOASSERTION" ||
        (packageEntry.primaryPackagePurpose !== "APPLICATION" && packageEntry.primaryPackagePurpose !== "LIBRARY")) {
      throw new Error("SPDX package contains invalid required fields");
    }
    packageIds.add(packageEntry.SPDXID);
    if (packageEntry.checksums !== undefined) validateSpdxChecksums(packageEntry.checksums);
    if (index === 0) {
      if (packageEntry.SPDXID !== "SPDXRef-Package-Cope" || packageEntry.name !== manifest.packageName ||
          packageEntry.versionInfo !== manifest.version || packageEntry.primaryPackagePurpose !== "APPLICATION" ||
          packageEntry.checksums?.length !== 1 || packageEntry.checksums[0]?.algorithm !== "SHA256" ||
          packageEntry.checksums[0]?.checksumValue !== artifact.sha256) {
        throw new Error("SPDX primary package does not describe the signed artifact");
      }
    } else if (packageEntry.primaryPackagePurpose !== "LIBRARY") {
      throw new Error("SPDX dependency package purpose is invalid");
    }
  }
  if (sbom.relationships.length !== sbom.packages.length - 1) {
    throw new Error("SPDX dependency relationships do not cover the runtime package inventory");
  }
  const related = new Set();
  for (const relationship of sbom.relationships) {
    exactObjectKeys(relationship, ["relatedSpdxElement", "relationshipType", "spdxElementId"], "SPDX relationship");
    if (relationship.spdxElementId !== "SPDXRef-Package-Cope" ||
        relationship.relationshipType !== "DEPENDS_ON" ||
        !packageIds.has(relationship.relatedSpdxElement) ||
        relationship.relatedSpdxElement === "SPDXRef-Package-Cope" ||
        related.has(relationship.relatedSpdxElement)) {
      throw new Error("SPDX dependency relationship is invalid");
    }
    related.add(relationship.relatedSpdxElement);
  }
}

function validateSpdxChecksums(checksums) {
  if (!Array.isArray(checksums) || checksums.length !== 1) throw new Error("SPDX package checksum list is invalid");
  const checksum = checksums[0];
  exactObjectKeys(checksum, ["algorithm", "checksumValue"], "SPDX checksum");
  const expectedLength = checksum.algorithm === "SHA256" ? 64 : checksum.algorithm === "SHA512" ? 128 : 0;
  if (expectedLength === 0 || typeof checksum.checksumValue !== "string" ||
      !new RegExp(`^[a-f0-9]{${expectedLength}}$`, "u").test(checksum.checksumValue)) {
    throw new Error("SPDX checksum must use lowercase hexadecimal SHA-256 or SHA-512");
  }
}

function safeByteCount(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function parseArguments(args) {
  if (args.length === 0 || args[0].startsWith("--")) throw new Error("Usage: verify.mjs <release-directory> [options]");
  const root = args[0];
  const options = {};
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--require-signature") {
      if (options.requireSignature === true) throw new Error("Duplicate --require-signature");
      options.requireSignature = true;
    } else if (flag === "--trusted-public-key" || flag === "--trusted-key-id") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      const key = flag === "--trusted-public-key" ? "trustedPublicKeyFile" : "trustedKeyId";
      if (options[key] !== undefined) throw new Error(`Duplicate ${flag}`);
      options[key] = value;
      index += 1;
    } else {
      throw new Error(`Unsupported verification argument: ${flag}`);
    }
  }
  return { root, options };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { root, options } = parseArguments(process.argv.slice(2));
    const result = await verifyRelease(root, options);
    const { manifest: _manifest, root: _root, ...output } = result;
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
