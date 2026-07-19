import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SessionControlMonitor,
  writeControlRequest,
  type ActiveRuntimeControl,
} from "../../src/cli/control-channel.js";

test("active session control monitor forwards pause requests", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cba-control-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  let pauseReason: string | undefined;
  const runtime: ActiveRuntimeControl = {
    requestPause: async (reason) => { pauseReason = reason; },
    emergencyStop: async () => { throw new Error("unexpected abort"); },
  };
  const monitor = new SessionControlMonitor(directory, "session_control_1", runtime, 10);
  monitor.start();
  await writeControlRequest(directory, "session_control_1", "pause", "pause for review");
  const deadline = Date.now() + 1_000;
  while (pauseReason === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await monitor.stop();
  assert.equal(pauseReason, "pause for review");
});

test("abort request cannot be downgraded by a later pause request", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cba-control-priority-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  let action = "none";
  const runtime: ActiveRuntimeControl = {
    requestPause: async () => { action = "pause"; },
    emergencyStop: async () => { action = "abort"; },
  };
  await writeControlRequest(directory, "session_control_2", "abort", "stop");
  await writeControlRequest(directory, "session_control_2", "pause", "weaker");
  const monitor = new SessionControlMonitor(directory, "session_control_2", runtime, 10);
  monitor.start();
  const deadline = Date.now() + 1_000;
  while (action === "none" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await monitor.stop();
  assert.equal(action, "abort");
});
