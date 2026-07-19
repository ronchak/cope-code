import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("POSIX supervisor closes every parent-death launch race without a surviving command", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX process groups are not available on Windows");
    return;
  }
  for (const phase of ["before-armed", "armed", "before-spawn", "before-started", "active", "during-cancel"] as const) {
    await context.test(phase, async (phaseContext) => runCrashPhase(phase, phaseContext));
  }
});

async function runCrashPhase(
  phase: "before-armed" | "armed" | "before-spawn" | "before-started" | "active" | "during-cancel",
  context: { after(callback: () => void | Promise<void>): void },
): Promise<void> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), `cope-supervisor-${phase}-`));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const readyFile = path.join(temporary, "ready.json");
  const commandPidFile = path.join(temporary, "command.pid");
  const childPidFile = path.join(temporary, "child.pid");
  const grandchildPidFile = path.join(temporary, "grandchild.pid");
  const harness = spawn(
    process.execPath,
    [fileURLToPath(new URL("../fixtures/process-supervisor-harness.js", import.meta.url))],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        COPE_HARNESS_READY_FILE: readyFile,
        COPE_HARNESS_COMMAND_PID_FILE: commandPidFile,
        COPE_HARNESS_CHILD_PID_FILE: childPidFile,
        COPE_HARNESS_GRANDCHILD_PID_FILE: grandchildPidFile,
        COPE_HARNESS_PHASE: phase,
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  context.after(() => { if (isAlive(harness.pid)) harness.kill("SIGKILL"); });
  const ready = JSON.parse(await waitForFile(readyFile)) as { readonly supervisorPid: number };
  const descendantPids = (
    await Promise.all([commandPidFile, childPidFile, grandchildPidFile].map(optionalPid))
  ).filter((pid): pid is number => pid !== undefined);
  assert.equal(Number.isSafeInteger(ready.supervisorPid) && ready.supervisorPid > 1, true);
  assert.equal(isAlive(ready.supervisorPid), true);
  for (const pid of descendantPids) assert.equal(isAlive(pid), true);
  if (phase === "before-started" || phase === "active" || phase === "during-cancel") {
    assert.equal(descendantPids.length, 3, `${phase} must observe command, child, and grandchild`);
  }

  if (phase === "during-cancel") {
    try { process.kill(-ready.supervisorPid, "SIGTERM"); } catch { /* supervisor may already be closing */ }
  }
  harness.kill("SIGKILL");
  await waitForExit(harness);
  await waitForDead(ready.supervisorPid);
  for (const pid of descendantPids) await waitForDead(pid);
  assert.equal(isAlive(ready.supervisorPid), false);
  for (const pid of descendantPids) assert.equal(isAlive(pid), false);
}

async function waitForFile(filename: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { return await readFile(filename, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filename}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForDead(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`Process ${String(pid)} survived its parent`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function optionalPid(filename: string): Promise<number | undefined> {
  const deadline = Date.now() + 150;
  while (Date.now() < deadline) {
    try {
      const value = Number(await readFile(filename, "utf8"));
      return Number.isSafeInteger(value) && value > 1 ? value : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
