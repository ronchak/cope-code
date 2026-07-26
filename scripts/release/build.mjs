#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { inspectNpmArchive } from "./archive.mjs";
import { generateRelease } from "./generate.mjs";
import {
  MAX_ARTIFACT_BYTES,
  isWithin,
  readRegularFile,
  regularFileStat,
  safeTopLevelFilename,
  sha256Bytes,
} from "./lib.mjs";
import { verifyRelease } from "./verify.mjs";

const MAX_SOURCE_ENTRIES = 20_000;
const MAX_SOURCE_TREE_BYTES = 256 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const WINDOWS_RESERVED_NAME = /^(?:AUX|CON|NUL|PRN|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;

export async function buildRelease(outputInput, channel, environment = process.env) {
  if (typeof outputInput !== "string" || outputInput.length === 0) throw new Error("An explicit release output directory is required");
  if (channel !== "preview") {
    throw new Error("Repository-local release builds create unsigned preview evidence only; no production signer is implemented");
  }
  if (environment.COPE_RELEASE_SIGNING_KEY_FILE !== undefined) {
    throw new Error("Do not expose signing-key material to repository-local release builds");
  }

  const projectRoot = await realpath(process.cwd());
  const requestedOutput = path.resolve(outputInput);
  if (requestedOutput === path.parse(requestedOutput).root) throw new Error("Filesystem roots cannot be release output directories");
  const outputParent = await realpath(path.dirname(requestedOutput));
  const output = path.join(outputParent, path.basename(requestedOutput));
  if (isWithin(projectRoot, output)) throw new Error("Release output must be outside the source checkout");
  try {
    await lstat(output);
    throw new Error("Release output already exists; refusing to overwrite it");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const npmCli = environment.npm_execpath;
  if (typeof npmCli !== "string" || !path.isAbsolute(npmCli)) {
    throw new Error("Run release builds through npm so npm_execpath identifies the active npm CLI");
  }
  await regularFileStat(npmCli, 16 * 1024 * 1024);
  requireCleanCheckout(projectRoot);
  const sourceCommit = git(["rev-parse", "--verify", "HEAD^{commit}"], projectRoot);
  const sourceTree = readGitTree(projectRoot, sourceCommit);
  const commitEpoch = git(["show", "-s", "--format=%ct", sourceCommit], projectRoot);
  if (!/^(?:0|[1-9][0-9]{0,11})$/u.test(commitEpoch)) {
    throw new Error("Git returned an invalid source commit timestamp");
  }
  if (environment.SOURCE_DATE_EPOCH !== undefined && environment.SOURCE_DATE_EPOCH !== commitEpoch) {
    throw new Error("SOURCE_DATE_EPOCH must exactly match the source commit timestamp");
  }
  const milliseconds = Number(commitEpoch) * 1000;
  if (!Number.isSafeInteger(milliseconds)) throw new Error("SOURCE_DATE_EPOCH is out of range");
  const created = new Date(milliseconds).toISOString().replace(".000Z", "Z");

  let buildRoot = await mkdtemp(path.join(outputParent, ".cope-build-"));
  let staging = await mkdtemp(path.join(outputParent, ".cope-release-"));
  try {
    const trackedDescriptors = await materializeGitTree(projectRoot, buildRoot, sourceTree);
    const packageBytes = descriptorBytes(trackedDescriptors, "package.json");
    const packageDocument = JSON.parse(utf8.decode(packageBytes));
    if (packageDocument?.name !== "@local/copilot-browser-agent" ||
        typeof packageDocument.version !== "string") {
      throw new Error("Source package.json does not identify a Cope release");
    }

    const buildEnvironment = {
      ...environment,
      SOURCE_DATE_EPOCH: commitEpoch,
    };
    runNpm(npmCli, [
      "ci",
      "--ignore-scripts",
      "--include=dev",
      "--no-audit",
      "--no-fund",
    ], buildRoot, buildEnvironment, "inherit");
    runNpm(npmCli, ["run", "clean"], buildRoot, buildEnvironment, "inherit");
    runNpm(npmCli, ["run", "build"], buildRoot, buildEnvironment, "inherit");

    const generatedDescriptors = await snapshotGeneratedFiles(
      buildRoot,
      sourceTree,
      new Set(Object.values(packageDocument.bin ?? {})),
    );
    const expectedDescriptors = [...trackedDescriptors, ...generatedDescriptors];
    const requiredGeneratedPaths = generatedDescriptors
      .map((entry) => entry.path)
      .filter((entry) => entry.startsWith("dist/src/"));
    await validateIsolatedBuildState(buildRoot, expectedDescriptors);

    const packOutput = runNpm(npmCli, [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      staging,
    ], buildRoot, buildEnvironment, "pipe");
    await validateIsolatedBuildState(buildRoot, expectedDescriptors);
    const packed = JSON.parse(packOutput);
    if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== "string" ||
        packed[0]?.name !== "@local/copilot-browser-agent") {
      throw new Error("npm pack did not report exactly one Cope artifact");
    }
    if (packed[0].version !== packageDocument.version) throw new Error("npm pack version does not match package.json");
    const packedName = safeTopLevelFilename(packed[0].filename, "npm pack filename");
    const artifactName = safeTopLevelFilename(`cope-${packageDocument.version}.tgz`, "release artifact filename");
    const artifactPath = path.join(staging, artifactName);
    await rename(path.join(staging, packedName), artifactPath);
    const artifactBytes = await readRegularFile(artifactPath, MAX_ARTIFACT_BYTES);
    validatePackedSourceInventory(
      artifactBytes,
      expectedDescriptors,
      requiredGeneratedPaths,
    );
    const expectedArtifact = {
      bytes: artifactBytes.length,
      sha256: sha256Bytes(artifactBytes),
    };

    const npmVersion = runNpm(npmCli, ["--version"], buildRoot, buildEnvironment, "pipe").trim();
    await generateRelease({
      output: staging,
      package: path.join(buildRoot, "package.json"),
      lock: path.join(buildRoot, "package-lock.json"),
      platform: process.platform,
      arch: process.arch,
      commit: sourceCommit,
      created,
      channel,
      artifact: artifactPath,
      node_version: process.versions.node,
      npm_version: npmVersion,
    }, buildEnvironment, { expectedArtifact });
    await verifyRelease(staging);
    requireCleanCheckout(projectRoot, sourceCommit);
    await rename(staging, output);
    staging = undefined;
    return { output, channel, sourceCommit };
  } finally {
    if (buildRoot !== undefined) {
      await rm(buildRoot, { recursive: true, force: true });
      buildRoot = undefined;
    }
    if (staging !== undefined) await rm(staging, { recursive: true, force: true });
  }
}

export function validatePackedSourceInventory(
  artifactBytes,
  expectedDescriptors,
  requiredGeneratedPaths = [],
) {
  if (!Array.isArray(expectedDescriptors) || !Array.isArray(requiredGeneratedPaths)) {
    throw new Error("Expected release inventory is invalid");
  }
  const expected = new Map();
  for (const descriptor of expectedDescriptors) {
    if (descriptor === null || typeof descriptor !== "object" ||
        typeof descriptor.path !== "string" || descriptor.path.length === 0 ||
        !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0 ||
        !/^[a-f0-9]{64}$/u.test(descriptor.sha256) ||
        (descriptor.mode !== 0o644 && descriptor.mode !== 0o755) ||
        expected.has(descriptor.path)) {
      throw new Error("Expected release inventory is invalid");
    }
    expected.set(descriptor.path, descriptor);
  }
  const required = new Set(requiredGeneratedPaths);
  if (required.size !== requiredGeneratedPaths.length ||
      requiredGeneratedPaths.some((entry) => typeof entry !== "string" || !expected.has(entry))) {
    throw new Error("Required generated release inventory is invalid");
  }

  const packed = new Set();
  for (const entry of inspectNpmArchive(artifactBytes).entries) {
    const packedPath = entry.path.slice("package/".length);
    const descriptor = expected.get(packedPath);
    if (descriptor === undefined) {
      throw new Error(
        `npm artifact contains a file not bound to the source commit or isolated build: ${packedPath}`,
      );
    }
    if (entry.bytes !== descriptor.bytes ||
        entry.mode !== descriptor.mode ||
        entry.sha256 !== descriptor.sha256) {
      throw new Error(`npm artifact file differs from its bound source/build bytes: ${packedPath}`);
    }
    packed.add(packedPath);
  }
  for (const requiredPath of required) {
    if (!packed.has(requiredPath)) {
      throw new Error(`npm artifact omits an expected isolated build output: ${requiredPath}`);
    }
  }
}

function readGitTree(projectRoot, sourceCommit) {
  const output = execFileSync("git", [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    sourceCommit,
  ], {
    cwd: projectRoot,
    encoding: null,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  const text = utf8.decode(output);
  if (text !== "" && !text.endsWith("\0")) throw new Error("Git returned a truncated source tree");
  const entries = text.split("\0").filter((entry) => entry !== "").map((entry) => {
    const tab = entry.indexOf("\t");
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})$/u.exec(entry.slice(0, tab));
    const sourcePath = entry.slice(tab + 1);
    if (tab < 0 || match === null) {
      throw new Error("Release source tree contains a link, submodule, or unsupported Git object");
    }
    validateSourcePath(sourcePath);
    return {
      gitMode: match[1],
      objectId: match[2],
      path: sourcePath,
    };
  });
  if (entries.length === 0 || entries.length > MAX_SOURCE_ENTRIES) {
    throw new Error("Release source tree is empty or exceeds the entry limit");
  }
  return entries;
}

async function materializeGitTree(projectRoot, buildRoot, sourceTree) {
  const descriptors = [];
  let totalBytes = 0;
  for (const entry of sourceTree) {
    const bytes = execFileSync("git", ["cat-file", "blob", entry.objectId], {
      cwd: projectRoot,
      encoding: null,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: MAX_ARTIFACT_BYTES + 1,
    });
    totalBytes += bytes.length;
    if (totalBytes > MAX_SOURCE_TREE_BYTES) {
      throw new Error("Release source tree exceeds the materialization size limit");
    }
    const destination = path.join(buildRoot, ...entry.path.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    const mode = process.platform === "win32" || entry.gitMode === "100644" ? 0o644 : 0o755;
    await writeFile(destination, bytes, { flag: "wx", mode });
    if (process.platform !== "win32") await chmod(destination, mode);
    descriptors.push({
      path: entry.path,
      bytes: bytes.length,
      sha256: sha256Bytes(bytes),
      mode,
      sourceBytes: bytes,
    });
  }
  return descriptors;
}

function descriptorBytes(descriptors, sourcePath) {
  const descriptor = descriptors.find((entry) => entry.path === sourcePath);
  if (descriptor === undefined) throw new Error(`Release source tree is missing ${sourcePath}`);
  return descriptor.sourceBytes;
}

async function validateIsolatedBuildState(buildRoot, descriptors) {
  const expectedPaths = new Set(descriptors.map((entry) => entry.path));
  if (expectedPaths.size !== descriptors.length) {
    throw new Error("Isolated build contains a path claimed by both Git and the compiler");
  }
  const actualPaths = await listBuildRootFiles(buildRoot);
  if (actualPaths.length !== expectedPaths.size ||
      actualPaths.some((entry) => !expectedPaths.has(entry))) {
    throw new Error("Isolated build created an unexpected file outside node_modules");
  }
  for (const descriptor of descriptors) {
    const filename = path.join(buildRoot, ...descriptor.path.split("/"));
    const bytes = await readRegularFile(filename, MAX_ARTIFACT_BYTES);
    if (bytes.length !== descriptor.bytes || sha256Bytes(bytes) !== descriptor.sha256) {
      throw new Error(`Isolated build file changed after it was bound: ${descriptor.path}`);
    }
  }
}

async function snapshotGeneratedFiles(buildRoot, sourceTree, binTargets) {
  const expectedPaths = new Set();
  for (const entry of sourceTree) {
    if (!entry.path.endsWith(".ts") || entry.path.endsWith(".d.ts")) {
      continue;
    }
    const outputBase = `dist/${entry.path.slice(0, -".ts".length)}`;
    for (const suffix of [".d.ts", ".d.ts.map", ".js", ".js.map"]) {
      expectedPaths.add(`${outputBase}${suffix}`);
    }
  }
  const actualPaths = await listRegularFiles(path.join(buildRoot, "dist"), "dist");
  if (actualPaths.length !== expectedPaths.size ||
      actualPaths.some((entry) => !expectedPaths.has(entry))) {
    throw new Error("Isolated TypeScript build outputs do not exactly match the source tree");
  }

  const descriptors = [];
  for (const generatedPath of actualPaths.sort()) {
    const bytes = await readRegularFile(
      path.join(buildRoot, ...generatedPath.split("/")),
      MAX_ARTIFACT_BYTES,
    );
    descriptors.push({
      path: generatedPath,
      bytes: bytes.length,
      sha256: sha256Bytes(bytes),
      mode: process.platform !== "win32" && binTargets.has(generatedPath) ? 0o755 : 0o644,
    });
  }
  return descriptors;
}

async function listBuildRootFiles(buildRoot) {
  const result = [];
  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (relativeDirectory === "" && entry.name === "node_modules" &&
          entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      validateSourcePath(relativePath);
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(filename, relativePath);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        result.push(relativePath);
      } else {
        throw new Error(`Isolated build contains a link or non-regular entry: ${relativePath}`);
      }
      if (result.length > MAX_SOURCE_ENTRIES) throw new Error("Isolated build exceeds the entry limit");
    }
  }
  await visit(buildRoot, "");
  return result;
}

async function listRegularFiles(root, prefix) {
  const result = [];
  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      validateSourcePath(`${prefix}/${relativePath}`);
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(filename, relativePath);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        result.push(`${prefix}/${relativePath}`);
      } else {
        throw new Error(`Isolated build output contains a link or non-regular entry: ${prefix}/${relativePath}`);
      }
      if (result.length > MAX_SOURCE_ENTRIES) throw new Error("Isolated build output exceeds the entry limit");
    }
  }
  await visit(root, "");
  return result;
}

function validateSourcePath(value) {
  if (value.length === 0 || value.length > 240 || value.includes("\\") || value.includes("\0")) {
    throw new Error(`Release source path is unsafe or non-portable: ${value}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." ||
      segment.toLowerCase() === ".git")) {
    throw new Error(`Release source path is unsafe or non-portable: ${value}`);
  }
  for (const segment of segments) {
    if (segment.normalize("NFC") !== segment ||
        /[^\u0020-\u007e]/u.test(segment) ||
        /[<>:"|?*]/u.test(segment) ||
        /[. ]$/u.test(segment) ||
        WINDOWS_RESERVED_NAME.test(segment)) {
      throw new Error(`Release source path is unsafe or non-portable: ${value}`);
    }
  }
}

function runNpm(npmCli, arguments_, cwd, environment, stdio) {
  return execFileSync(process.execPath, [npmCli, ...arguments_], {
    cwd,
    env: environment,
    encoding: stdio === "pipe" ? "utf8" : undefined,
    stdio,
    maxBuffer: 32 * 1024 * 1024,
  }) ?? "";
}

function git(arguments_, cwd) {
  return execFileSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function requireCleanCheckout(cwd, expectedHead) {
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"], cwd);
  if (status !== "") throw new Error("Release builds require a clean source checkout");
  if (expectedHead !== undefined &&
      git(["rev-parse", "--verify", "HEAD^{commit}"], cwd) !== expectedHead) {
    throw new Error("Release source commit changed during the build");
  }
}

function parseArguments(args) {
  if (args.length !== 2) throw new Error("Usage: build.mjs <output-directory> preview");
  return args;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [output, channel] = parseArguments(process.argv.slice(2));
    const result = await buildRelease(output, channel);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
