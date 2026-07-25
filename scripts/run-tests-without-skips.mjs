#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";

import { validateChromiumSafetyManifest } from "./validate-chromium-safety-inventory.mjs";

const tapSkipDirective = /^\s*(?:not )?ok \d+(?:\s+-\s+.*?)?\s+# SKIP(?:\s|$)/imu;
const args = process.argv.slice(2);
let testFiles = args;
let expectedTestCount;
if (args[0] === "--manifest" && args.length === 2) {
  const inventory = await validateChromiumSafetyManifest(args[1]);
  expectedTestCount = inventory.expectedTestCount;
  testFiles = inventory.sourceFiles.map((source) =>
    path.resolve("dist", source.replace(/\.ts$/u, ".js")));
} else if (args.includes("--manifest")) {
  testFiles = [];
}

if (testFiles.length === 0) {
  process.stderr.write(
    "Usage: run-tests-without-skips.mjs <test-file> [...] | --manifest <manifest.json>\n",
  );
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
  } else if (tapSkipDirective.test(result.stdout ?? "")) {
    process.stderr.write("Safety test contract violated: one or more tests were skipped.\n");
    process.exitCode = 1;
  } else if (expectedTestCount !== undefined) {
    const reportedTestCount = /^# tests (\d+)$/mu.exec(result.stdout ?? "")?.[1];
    if (reportedTestCount === undefined || Number(reportedTestCount) !== expectedTestCount) {
      process.stderr.write(
        `Safety test contract violated: expected ${expectedTestCount} tests, ` +
        `but TAP reported ${reportedTestCount ?? "no root count"}.\n`,
      );
      process.exitCode = 1;
    }
  }
}
