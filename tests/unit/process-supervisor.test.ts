import assert from "node:assert/strict";
import test from "node:test";

import {
  ProcessSupervisorLaunchError,
  spawnSupervisedProcessWithExit,
} from "../../src/tools/process-supervisor.js";

test("POSIX supervisor distinguishes definite spawn failure from uncertain handshake", async (context) => {
  if (process.platform === "win32") {
    context.skip("The detached POSIX supervisor is not used on Windows");
    return;
  }
  await assert.rejects(
    spawnSupervisedProcessWithExit({
      executable: "/cope-missing/definitely-not-an-executable",
      arguments: [],
      cwd: process.cwd(),
      environment: { ...process.env },
      handshakeTimeoutMs: 2_000,
    }),
    (error: unknown) =>
      error instanceof ProcessSupervisorLaunchError &&
      error.reason === "spawn_failed",
  );
  await assert.rejects(
    spawnSupervisedProcessWithExit({
      executable: process.execPath,
      arguments: ["-e", "setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      environment: { ...process.env },
      handshakeTimeoutMs: 500,
      testHooks: { delayAfterSpawnMs: 1_000 },
    }),
    (error: unknown) =>
      error instanceof ProcessSupervisorLaunchError &&
      error.reason === "indeterminate",
  );
});
