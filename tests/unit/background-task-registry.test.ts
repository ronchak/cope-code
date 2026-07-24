import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BackgroundTaskRegistry,
  type BackgroundTaskRecord,
  type CatalogCommandRunner,
} from "../../src/tools/background-task-registry.js";
import type { RunCommandRequest } from "../../src/tools/command-catalog.js";
import type { CommandOutcome } from "../../src/tools/process-runner.js";
import { AgentError } from "../../src/shared/errors.js";

const taskIds = Array.from({ length: 8 }, (_, index) =>
  `background_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);

function resolved(commandId: string) {
  return {
    id: commandId,
    category: "validation",
    risk: "low" as const,
    sideEffects: false,
    networkRequired: false,
    networkHosts: [],
    executable: "/approved/node",
    arguments: [],
    workingDirectory: "",
    environment: {},
    timeoutMs: 1_000,
    maxOutputBytes: 64,
    successExitCodes: [0],
    repositoryPathParameters: [],
  };
}

function success(commandId: string): CommandOutcome {
  return {
    commandId,
    outcome: "success",
    exitCode: 0,
    signal: null,
    stdout: "ok",
    stderr: "",
    truncated: false,
    durationMs: 4,
    redactionCount: 0,
  };
}

async function eventuallyTerminal(registry: BackgroundTaskRegistry, taskId: string): Promise<BackgroundTaskRecord> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const record = await registry.status(taskId);
    if (record.status !== "queued" && record.status !== "running") return record;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("background task did not settle");
}

test("registry durably tracks a configured catalog command through completion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-background-"));
  const journal = path.join(root, "tasks.jsonl");
  let idIndex = 0;
  const requests: RunCommandRequest[] = [];
  const runner: CatalogCommandRunner = {
    describe: (request) => {
      if (request.command_id !== "test") throw new AgentError("POLICY_DENIED", "not catalogued");
      return resolved(request.command_id);
    },
    run: async (request) => {
      requests.push(request);
      return success(request.command_id);
    },
  };
  const registry = new BackgroundTaskRegistry(journal, runner, { idFactory: () => taskIds[idIndex++]! });

  const handle = await registry.start({ command_id: "test", parameters: { suite: "unit" }, timeout_ms: 500 });
  const final = await eventuallyTerminal(registry, handle.taskId);
  assert.equal(final.status, "success");
  assert.equal(final.outcome?.stdout, "ok");
  assert.deepEqual(requests, [{ command_id: "test", parameters: { suite: "unit" }, timeout_ms: 500 }]);

  const recovered = new BackgroundTaskRegistry(journal, runner);
  assert.deepEqual(await recovered.status(handle.taskId), final);
  assert.equal((await readFile(journal, "utf8")).trimEnd().split("\n").length, 3);
});

test("registry rejects non-catalog commands and bounds concurrent work", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-background-"));
  let idIndex = 0;
  const completions = new Map<string, (outcome: CommandOutcome) => void>();
  const runner: CatalogCommandRunner = {
    describe: (request) => {
      if (request.command_id !== "test") throw new AgentError("POLICY_DENIED", "not catalogued");
      return resolved(request.command_id);
    },
    run: async (request, signal) => await new Promise<CommandOutcome>((resolve) => {
      completions.set(request.operationId ?? "missing", resolve);
      signal?.addEventListener("abort", () => resolve({ ...success(request.command_id), outcome: "cancelled" }), { once: true });
    }),
  };
  const registry = new BackgroundTaskRegistry(path.join(root, "tasks.jsonl"), runner, {
    maxConcurrent: 2,
    idFactory: () => taskIds[idIndex++]!,
  });

  await assert.rejects(() => registry.start({ command_id: "sh", parameters: { command: "rm -rf ." } }), /catalogued/);
  const first = await registry.start({ command_id: "test", operationId: "op_first" });
  const second = await registry.start({ command_id: "test", operationId: "op_second" });
  await assert.rejects(() => registry.start({ command_id: "test", operationId: "op_third" }), /concurrency/);
  assert.equal((await registry.cancel(first.taskId)).status, "cancelled");
  while (!completions.has("op_second")) await new Promise<void>((resolve) => setImmediate(resolve));
  completions.get("op_second")?.(success("test"));
  assert.equal((await eventuallyTerminal(registry, second.taskId)).status, "success");
});

test("restart marks unfinished work interrupted without replaying it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-background-"));
  const journal = path.join(root, "tasks.jsonl");
  let runs = 0;
  const runner: CatalogCommandRunner = {
    describe: (request) => resolved(request.command_id),
    run: async () => {
      runs += 1;
      return await new Promise<CommandOutcome>(() => undefined);
    },
  };
  const original = new BackgroundTaskRegistry(journal, runner, { idFactory: () => taskIds[0]! });
  const handle = await original.start({ command_id: "test" });
  assert.equal((await original.status(handle.taskId)).status, "running");

  const recovered = new BackgroundTaskRegistry(journal, runner);
  assert.equal((await recovered.status(handle.taskId)).status, "interrupted");
  assert.equal(runs, 1);
});

test("registry fails closed when its journal is modified", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-background-"));
  const journal = path.join(root, "tasks.jsonl");
  const runner: CatalogCommandRunner = {
    describe: (request) => resolved(request.command_id),
    run: async (request) => success(request.command_id),
  };
  const registry = new BackgroundTaskRegistry(journal, runner, { idFactory: () => taskIds[0]! });
  const handle = await registry.start({ command_id: "test" });
  await eventuallyTerminal(registry, handle.taskId);
  const raw = await readFile(journal, "utf8");
  await writeFile(journal, raw.replace('"commandId":"test"', '"commandId":"evil"'), "utf8");

  await assert.rejects(
    () => new BackgroundTaskRegistry(journal, runner).initialize(),
    /integrity/,
  );
});
