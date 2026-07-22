#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const output = path.resolve(process.argv[2] ?? "release-out");
const channel = process.argv[3] ?? "preview";
if (!['stable', 'preview'].includes(channel)) throw new Error("Channel must be stable or preview");
const npmCli = process.env.npm_execpath;
if (!npmCli || !path.isAbsolute(npmCli)) throw new Error("npm_execpath must identify the active npm JavaScript CLI");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true, mode: 0o755 });
execFileSync(process.execPath, [npmCli, "run", "clean"], { stdio: "inherit" });
execFileSync(process.execPath, [npmCli, "run", "build"], { stdio: "inherit" });
execFileSync(process.execPath, [npmCli, "pack", "--pack-destination", output, "--ignore-scripts"], { stdio: "inherit" });
const packedArtifact = (await readdir(output)).find((name) => name.endsWith(".tgz"));
if (!packedArtifact) throw new Error("npm pack did not create an artifact");
const packageDocument = JSON.parse(await readFile("package.json", "utf8"));
const artifact = `cope-${packageDocument.version}-${process.platform}-${process.arch}.tgz`;
await rename(path.join(output, packedArtifact), path.join(output, artifact));
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const sourceEpoch = process.env.SOURCE_DATE_EPOCH ?? execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], { encoding: "utf8" }).trim();
const created = new Date(Number(sourceEpoch) * 1000).toISOString();
execFileSync(process.execPath, [fileURLToPath(new URL("./generate.mjs", import.meta.url)),
  "--output", output, "--package", "package.json", "--lock", "package-lock.json",
  "--platform", process.platform, "--arch", process.arch, "--commit", commit,
  "--created", created, "--channel", channel, "--artifact", path.join(output, artifact),
], { stdio: "inherit", env: process.env });
