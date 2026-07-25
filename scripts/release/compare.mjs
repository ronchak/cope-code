#!/usr/bin/env node
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { compareText, readRegularFile, sha256Bytes } from "./lib.mjs";

export async function compareReleaseDirectories(leftInput, rightInput) {
  const left = await realpath(path.resolve(leftInput));
  const right = await realpath(path.resolve(rightInput));
  const leftEntries = await releaseEntries(left);
  const rightEntries = await releaseEntries(right);
  if (leftEntries.length !== rightEntries.length ||
      leftEntries.some((entry, index) => entry !== rightEntries[index])) {
    throw new Error("Release directories contain different file inventories");
  }
  for (const name of leftEntries) {
    const [leftBytes, rightBytes] = await Promise.all([
      readRegularFile(path.join(left, name)),
      readRegularFile(path.join(right, name)),
    ]);
    if (leftBytes.length !== rightBytes.length || sha256Bytes(leftBytes) !== sha256Bytes(rightBytes)) {
      throw new Error(`Release outputs are not byte-for-byte reproducible: ${name}`);
    }
  }
  return { identical: true, files: leftEntries.length };
}

async function releaseEntries(root) {
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("Release comparison accepts regular files only");
  }
  return entries.map((entry) => entry.name).sort(compareText);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: compare.mjs <first-release> <second-release>");
    const result = await compareReleaseDirectories(process.argv[2], process.argv[3]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
