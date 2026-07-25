#!/usr/bin/env node
import path from "node:path";
import process from "node:process";

import { buildRelease } from "./build.mjs";
import { compareReleaseDirectories } from "./compare.mjs";
import { verifyRelease } from "./verify.mjs";

const runnerTemp = process.env.RUNNER_TEMP;
if (typeof runnerTemp !== "string" || runnerTemp.length === 0) {
  throw new Error("RUNNER_TEMP is required for release evidence CI");
}
const first = path.join(runnerTemp, "cope-release-first");
const second = path.join(runnerTemp, "cope-release-second");
await buildRelease(first, "preview");
await verifyRelease(first);
await buildRelease(second, "preview");
await verifyRelease(second);
const comparison = await compareReleaseDirectories(first, second);
process.stdout.write(`${JSON.stringify({ verified: true, reproducible: comparison.identical })}\n`);
