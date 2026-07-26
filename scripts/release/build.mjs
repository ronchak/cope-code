#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
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
} from "./lib.mjs";

const utf8 = new TextDecoder("utf-8", { fatal: true });

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
  const trackedPaths = gitNulPaths([
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    sourceCommit,
  ], projectRoot);

  let staging = await mkdtemp(path.join(outputParent, ".cope-release-"));
  try {
    runNpm(npmCli, ["run", "clean"], projectRoot, environment, "inherit");
    runNpm(npmCli, ["run", "build"], projectRoot, environment, "inherit");
    const packOutput = runNpm(npmCli, [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      staging,
    ], projectRoot, environment, "pipe");
    const packed = JSON.parse(packOutput);
    if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== "string" ||
        packed[0]?.name !== "@local/copilot-browser-agent") {
      throw new Error("npm pack did not report exactly one Cope artifact");
    }
    const packedName = safeTopLevelFilename(packed[0].filename, "npm pack filename");
    const packageDocument = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
    if (packed[0].version !== packageDocument.version) throw new Error("npm pack version does not match package.json");
    const artifactName = safeTopLevelFilename(`cope-${packageDocument.version}.tgz`, "release artifact filename");
    const artifactPath = path.join(staging, artifactName);
    await rename(path.join(staging, packedName), artifactPath);
    validatePackedSourceInventory(
      await readRegularFile(artifactPath, MAX_ARTIFACT_BYTES),
      trackedPaths,
    );

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
    const npmVersion = runNpm(npmCli, ["--version"], projectRoot, environment, "pipe").trim();

    await generateRelease({
      output: staging,
      package: path.join(projectRoot, "package.json"),
      lock: path.join(projectRoot, "package-lock.json"),
      platform: process.platform,
      arch: process.arch,
      commit: sourceCommit,
      created,
      channel,
      artifact: artifactPath,
      node_version: process.versions.node,
      npm_version: npmVersion,
    }, environment);
    requireCleanCheckout(projectRoot, sourceCommit);
    await rename(staging, output);
    staging = undefined;
    return { output, channel, sourceCommit };
  } finally {
    if (staging !== undefined) await rm(staging, { recursive: true, force: true });
  }
}

export function validatePackedSourceInventory(artifactBytes, trackedPaths) {
  if (!Array.isArray(trackedPaths) ||
      trackedPaths.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error("Tracked source inventory is invalid");
  }
  const allowed = new Set(trackedPaths);
  for (const sourcePath of trackedPaths) {
    if (!sourcePath.startsWith("src/") || !sourcePath.endsWith(".ts") ||
        sourcePath.endsWith(".d.ts")) {
      continue;
    }
    const outputBase = `dist/${sourcePath.slice(0, -".ts".length)}`;
    for (const suffix of [".d.ts", ".d.ts.map", ".js", ".js.map"]) {
      allowed.add(`${outputBase}${suffix}`);
    }
  }

  for (const entry of inspectNpmArchive(artifactBytes).entries) {
    const packedPath = entry.path.slice("package/".length);
    if (!allowed.has(packedPath)) {
      throw new Error(
        `npm artifact contains a file not bound to the source commit or TypeScript build: ${packedPath}`,
      );
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

function gitNulPaths(arguments_, cwd) {
  const output = execFileSync("git", arguments_, {
    cwd,
    encoding: null,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const text = utf8.decode(output);
  if (text !== "" && !text.endsWith("\0")) throw new Error("Git returned a truncated path inventory");
  return text.split("\0").filter((entry) => entry !== "");
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
