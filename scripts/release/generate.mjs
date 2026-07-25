#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { inspectNpmArchive } from "./archive.mjs";
import {
  CHANNEL_VERSION,
  MANIFEST_VERSION,
  canonicalJson,
  canonicalJsonLine,
  compareText,
  readRegularFile,
  safeTopLevelFilename,
  sha256Bytes,
  signManifest,
} from "./lib.mjs";

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const TOOL_VERSION = "cope-release-generator/2";

export async function generateRelease(options, environment = process.env, capabilities = {}) {
  const output = path.resolve(required(options.output, "output"));
  const packageFile = path.resolve(required(options.package, "package"));
  const lockFile = path.resolve(required(options.lock, "lock"));
  const artifactInput = path.resolve(required(options.artifact, "artifact"));
  const artifactName = safeTopLevelFilename(path.basename(artifactInput), "artifact filename");
  if (path.dirname(artifactInput) !== output) throw new Error("Release artifact must be a top-level file in the output directory");

  const channelName = required(options.channel, "channel");
  if (channelName !== "preview" && channelName !== "stable") throw new Error("Channel must be stable or preview");
  const createdAt = canonicalTimestamp(required(options.created, "created"));
  const sourceCommit = required(options.commit, "commit");
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sourceCommit)) {
    throw new Error("Source commit must be a complete lowercase Git object ID");
  }
  const builder = {
    arch: safeToken(required(options.arch, "arch"), "builder architecture"),
    node: versionToken(required(options.node_version, "node-version"), "Node.js version"),
    npm: versionToken(required(options.npm_version, "npm-version"), "npm version"),
    platform: safeToken(required(options.platform, "platform"), "builder platform"),
  };

  const packageDocument = JSON.parse(await readRegularFile(packageFile));
  const lockDocument = JSON.parse(await readRegularFile(lockFile));
  if (packageDocument?.name !== "@local/copilot-browser-agent" ||
      typeof packageDocument.version !== "string" || !SEMVER.test(packageDocument.version)) {
    throw new Error("package.json does not identify a valid Cope release");
  }
  if (channelName === "stable" &&
      !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(packageDocument.version)) {
    throw new Error("Stable evidence requires a release version without prerelease or build metadata");
  }
  if (lockDocument?.name !== packageDocument.name || lockDocument?.version !== packageDocument.version ||
      lockDocument?.packages?.[""]?.name !== packageDocument.name ||
      lockDocument?.packages?.[""]?.version !== packageDocument.version) {
    throw new Error("package-lock.json release identity does not match package.json");
  }
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (canonicalJson(packageDocument[field] ?? {}) !==
        canonicalJson(lockDocument.packages[""][field] ?? {})) {
      throw new Error(`package-lock.json root ${field} do not match package.json`);
    }
  }
  const runtimeDeclarations = {
    ...(packageDocument.dependencies ?? {}),
    ...(packageDocument.optionalDependencies ?? {}),
    ...(packageDocument.peerDependencies ?? {}),
  };
  for (const dependencyName of Object.keys(runtimeDeclarations)) {
    const resolved = lockDocument.packages[`node_modules/${dependencyName}`];
    if (resolved === null || typeof resolved !== "object" ||
        typeof resolved.version !== "string" || resolved.version.length === 0) {
      throw new Error(`package-lock.json does not resolve runtime dependency: ${dependencyName}`);
    }
  }

  const artifactBytes = await readRegularFile(artifactInput, 128 * 1024 * 1024);
  const archiveInspection = inspectNpmArchive(artifactBytes);
  const expectedPackageIdentity = {
    name: packageDocument.name,
    version: packageDocument.version,
    bin: packageDocument.bin,
    dependencies: packageDocument.dependencies ?? {},
    optionalDependencies: packageDocument.optionalDependencies ?? {},
    peerDependencies: packageDocument.peerDependencies ?? {},
  };
  if (canonicalJson(archiveInspection.package) !== canonicalJson(expectedPackageIdentity)) {
    throw new Error("Packed package.json identity does not match the source package metadata");
  }
  const artifact = {
    path: artifactName,
    bytes: artifactBytes.length,
    sha256: sha256Bytes(artifactBytes),
    archive: {
      format: "npm-tgz",
      entries: archiveInspection.entries,
      package: archiveInspection.package,
    },
  };

  const signingKeyPath = environment.COPE_RELEASE_SIGNING_KEY_FILE?.trim();
  if (channelName === "preview" && signingKeyPath) {
    throw new Error("Preview evidence must be unsigned; do not expose a signing key to repository-local tooling");
  }
  if (channelName === "stable" && !signingKeyPath) {
    throw new Error("Stable release evidence requires COPE_RELEASE_SIGNING_KEY_FILE");
  }
  if (channelName === "stable" && capabilities.allowTestOnlyLocalSigning !== true) {
    throw new Error("No production signer is implemented; repository-local stable signing is test-only");
  }

  const sbom = buildSpdxDocument({
    artifact,
    builder,
    channel: channelName,
    createdAt,
    lockDocument,
    packageDocument,
    sourceCommit,
  });
  const sbomBytes = Buffer.from(canonicalJsonLine(sbom));
  await exclusiveWrite(path.join(output, "sbom.spdx.json"), sbomBytes);

  const manifest = {
    schemaVersion: MANIFEST_VERSION,
    product: "cope",
    packageName: packageDocument.name,
    version: packageDocument.version,
    channel: channelName,
    sourceCommit,
    createdAt,
    builder,
    artifacts: [artifact],
    sbom: {
      path: "sbom.spdx.json",
      bytes: sbomBytes.length,
      sha256: sha256Bytes(sbomBytes),
      spdxVersion: "SPDX-2.3",
      documentNamespace: sbom.documentNamespace,
    },
  };
  const manifestBytes = Buffer.from(canonicalJsonLine(manifest));
  await exclusiveWrite(path.join(output, "manifest.json"), manifestBytes);

  let signature;
  if (signingKeyPath) {
    const privateKeyBytes = await readRegularFile(path.resolve(signingKeyPath), 64 * 1024);
    signature = signManifest(manifestBytes, privateKeyBytes);
    await exclusiveWrite(path.join(output, "manifest.sig.json"), Buffer.from(canonicalJsonLine(signature)));
  }

  const channel = expectedChannelDocument(manifest, manifestBytes, signature);
  await exclusiveWrite(path.join(output, "channel.json"), Buffer.from(canonicalJsonLine(channel)));
  return {
    output,
    signaturePresent: signature !== undefined,
    publisherAuthenticated: false,
    manifestSha256: sha256Bytes(manifestBytes),
  };
}

export function expectedChannelDocument(manifest, manifestBytes, signature) {
  return {
    schemaVersion: CHANNEL_VERSION,
    product: manifest.product,
    version: manifest.version,
    channel: manifest.channel,
    manifest: {
      path: "manifest.json",
      sha256: sha256Bytes(manifestBytes),
    },
    artifact: {
      path: manifest.artifacts[0].path,
      sha256: manifest.artifacts[0].sha256,
    },
    signature: signature === undefined
      ? { status: "absent-unsigned-development" }
      : {
          status: "present-requires-external-trust",
          algorithm: signature.algorithm,
          keyId: signature.keyId,
        },
  };
}

function buildSpdxDocument({
  artifact,
  builder,
  channel,
  createdAt,
  lockDocument,
  packageDocument,
  sourceCommit,
}) {
  const rootId = "SPDXRef-Package-Cope";
  const rootPackage = {
    SPDXID: rootId,
    name: packageDocument.name,
    versionInfo: packageDocument.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    copyrightText: "NOASSERTION",
    primaryPackagePurpose: "APPLICATION",
    checksums: [{ algorithm: "SHA256", checksumValue: artifact.sha256 }],
  };

  const dependencyPackages = Object.entries(lockDocument.packages ?? {})
    .filter(([packagePath, entry]) => packagePath !== "" && entry?.dev !== true)
    .sort(([left], [right]) => compareText(left, right))
    .map(([packagePath, entry]) => {
      if (typeof entry.version !== "string" || entry.version.length === 0) {
        throw new Error(`Runtime dependency is missing a version: ${packagePath}`);
      }
      const dependency = {
        SPDXID: `SPDXRef-Dependency-${sha256Bytes(packagePath).slice(0, 24)}`,
        name: packageNameFromLockPath(packagePath),
        versionInfo: entry.version,
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "NOASSERTION",
        licenseDeclared: "NOASSERTION",
        copyrightText: "NOASSERTION",
        primaryPackagePurpose: "LIBRARY",
      };
      if (entry.integrity !== undefined) dependency.checksums = [integrityChecksum(entry.integrity, packagePath)];
      return dependency;
    });

  const document = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${packageDocument.name}-${packageDocument.version}`,
    creationInfo: {
      created: createdAt,
      creators: [`Tool: ${TOOL_VERSION}`],
    },
    documentDescribes: [rootId],
    packages: [rootPackage, ...dependencyPackages],
    relationships: dependencyPackages.map((dependency) => ({
      spdxElementId: rootId,
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: dependency.SPDXID,
    })),
  };
  return {
    ...document,
    documentNamespace: expectedSpdxDocumentNamespace({
      ...document,
      buildIdentity: { builder, channel, sourceCommit },
    }),
  };
}

export function expectedSpdxDocumentNamespace(document) {
  const identity = { ...document };
  delete identity.documentNamespace;
  return `https://github.com/ronchak/cope-code/spdx/${sha256Bytes(Buffer.from(canonicalJson(identity)))}`;
}

function integrityChecksum(value, packagePath) {
  if (typeof value !== "string") throw new Error(`Invalid dependency integrity for ${packagePath}`);
  const sha512 = value.split(/\s+/u).find((entry) => entry.startsWith("sha512-"));
  if (sha512 === undefined) throw new Error(`Runtime dependency lacks a SHA-512 integrity for ${packagePath}`);
  const encoded = sha512.slice("sha512-".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error(`Invalid SHA-512 integrity for ${packagePath}`);
  const digest = Buffer.from(encoded, "base64");
  if (digest.length !== 64 || digest.toString("base64") !== encoded) {
    throw new Error(`Non-canonical SHA-512 integrity for ${packagePath}`);
  }
  return { algorithm: "SHA512", checksumValue: digest.toString("hex") };
}

function packageNameFromLockPath(packagePath) {
  const segments = packagePath.replaceAll("\\", "/").split("/");
  const nodeModulesIndex = segments.lastIndexOf("node_modules");
  const remainder = segments.slice(nodeModulesIndex + 1);
  const name = remainder[0]?.startsWith("@") ? remainder.slice(0, 2).join("/") : remainder[0];
  if (nodeModulesIndex < 0 || name === undefined || name.length === 0) {
    throw new Error(`Unsupported package-lock dependency path: ${packagePath}`);
  }
  return name;
}

async function exclusiveWrite(filename, bytes) {
  await writeFile(filename, bytes, { flag: "wx", mode: 0o644 });
}

function required(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing --${label}`);
  return value;
}

function safeToken(value, label) {
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(value)) throw new Error(`Unsafe ${label}`);
  return value;
}

function versionToken(value, label) {
  if (!/^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function canonicalTimestamp(value) {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.valueOf()) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value) ||
      timestamp.toISOString().replace(".000Z", "Z") !== value) {
    throw new Error("--created must be a canonical whole-second UTC ISO-8601 timestamp");
  }
  return value;
}

export function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (typeof flag !== "string" || !flag.startsWith("--") || typeof value !== "string") {
      throw new Error(`Invalid release argument: ${flag ?? "<missing>"}`);
    }
    const key = flag.slice(2).replaceAll("-", "_");
    if (result[key] !== undefined) throw new Error(`Duplicate release argument: ${flag}`);
    result[key] = value;
  }
  const allowed = new Set([
    "arch",
    "artifact",
    "channel",
    "commit",
    "created",
    "lock",
    "node_version",
    "npm_version",
    "output",
    "package",
    "platform",
  ]);
  for (const key of Object.keys(result)) if (!allowed.has(key)) throw new Error(`Unsupported release argument: --${key}`);
  return result;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await generateRelease(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
