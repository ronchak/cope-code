#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const testFiles = process.argv.slice(2);
if (testFiles.length === 0) {
  process.stderr.write("Usage: run-tests-without-skips.mjs <test-file> [...]\n");
  process.exitCode = 2;
} else {
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-concurrency=1", "--test-reporter=tap", ...testFiles],
    { encoding: "utf8", env: process.env, windowsHide: true },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error !== undefined) {
    process.stderr.write(`Unable to launch test process: ${result.error.message}\n`);
    process.exitCode = 1;
  } else if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  } else if (/# SKIP\b/u.test(result.stdout ?? "")) {
    process.stderr.write("Safety test contract violated: one or more tests were skipped.\n");
    process.exitCode = 1;
  }
}
