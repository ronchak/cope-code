import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import test from "node:test";

import { WindowsHostPlatform } from "../../src/platform/index.js";

test("Windows process-tree cancellation selects exact taskkill semantics", async () => {
  let observedExecutable = "";
  let observedArguments: readonly string[] = [];
  let observedOptions: Readonly<Record<string, unknown>> = {};
  const killer = new EventEmitter() as ChildProcess;
  const spawnProcess = ((executable: string, args: readonly string[], options: Readonly<Record<string, unknown>>) => {
    observedExecutable = executable;
    observedArguments = args;
    observedOptions = options;
    queueMicrotask(() => killer.emit("close", 0));
    return killer;
  }) as unknown as typeof import("node:child_process").spawn;
  const host = new WindowsHostPlatform("x64", spawnProcess);
  const child = {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  } as unknown as ChildProcess;

  await host.terminateProcessTree(child);
  assert.equal(observedExecutable, "taskkill.exe");
  assert.deepEqual(observedArguments, ["/pid", "4242", "/T", "/F"]);
  assert.equal(observedOptions.shell, false);
  assert.equal(observedOptions.windowsHide, true);
  assert.equal(observedOptions.stdio, "ignore");
});
