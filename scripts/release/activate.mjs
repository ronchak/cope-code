#!/usr/bin/env node
import { cp, lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const candidate = path.resolve(process.argv[2] ?? "");
const installRoot = path.resolve(process.argv[3] ?? "");
if (!candidate || !installRoot || candidate === installRoot || installRoot === path.parse(installRoot).root) throw new Error("Safe candidate and install root are required");
const trustedKeyId = process.env.COPE_RELEASE_TRUSTED_KEY_ID;
if (!trustedKeyId || !/^[a-f0-9]{64}$/u.test(trustedKeyId)) throw new Error("COPE_RELEASE_TRUSTED_KEY_ID must pin the approved publisher key");
const verifier = fileURLToPath(new URL("./verify.mjs", import.meta.url));
const verification = spawnSync(process.execPath, [verifier, candidate, "--require-signature", "--trusted-key-id", trustedKeyId], { encoding: "utf8" });
if (verification.status !== 0) throw new Error(`Candidate verification failed: ${verification.stderr.trim()}`);
await mkdir(installRoot, { recursive: true, mode: 0o700 });
const current = path.join(installRoot, "current");
const previous = path.join(installRoot, "previous");
const staged = path.join(installRoot, `.staged-${process.pid}`);
await rm(staged, { recursive: true, force: true });
await cp(candidate, staged, { recursive: true, errorOnExist: true });
await rm(previous, { recursive: true, force: true });
let hadCurrent = false;
try { hadCurrent = (await lstat(current)).isDirectory(); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (hadCurrent) await rename(current, previous);
try { await rename(staged, current); } catch (error) {
  if (hadCurrent) await rename(previous, current);
  throw error;
}
process.stdout.write(`${JSON.stringify({ activated: true, rollbackAvailable: hadCurrent })}\n`);
