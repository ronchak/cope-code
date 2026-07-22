import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AuditLog } from "../../src/audit/audit-log.js";
import { CheckpointStore } from "../../src/repository/checkpoint.js";
import { RepositoryBoundary } from "../../src/repository/boundary.js";
import { PatchEngine } from "../../src/repository/patch-engine.js";
import { ProtectedPathPolicy } from "../../src/security/protected-paths.js";
import { sha256 } from "../../src/shared/crypto.js";
import { OperationJournal } from "../../src/session/operation-journal.js";
import { ScriptedFixtureTransport } from "../../src/transport/scripted-fixture.js";
import {
  FaultSchedule,
  InjectedFault,
  RELIABILITY_ITERATIONS,
  RELIABILITY_SEED,
  reliabilityScenario,
} from "../helpers/reliability.js";

test("seeded journal crash matrix never replays uncertain mutation", async (context) => {
  await reliabilityScenario("journal-crash-matrix", RELIABILITY_SEED, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cope-reliability-journal-"));
    context.after(async () => rm(root, { recursive: true, force: true }));
    for (let iteration = 0; iteration < RELIABILITY_ITERATIONS; iteration += 1) {
      const directory = path.join(root, String(iteration));
      const journal = new OperationJournal(directory, "session_12345678");
      const operationId = `op_fault_${iteration}`;
      const request = { content: `value-${iteration}` };
      const registered = await journal.register(operationId, "apply_patch", true, request, "2026-01-01T00:00:00Z");
      if (iteration % 2 === 0) {
        await journal.markExecuting(registered.record, "2026-01-01T00:00:01Z");
        const recovered = await journal.register(operationId, "apply_patch", true, request, "2026-01-01T00:00:02Z");
        assert.equal(recovered.kind, "indeterminate_mutation");
      } else {
        const recovered = await journal.register(operationId, "apply_patch", true, request, "2026-01-01T00:00:02Z");
        assert.equal(recovered.kind, "retry_safe");
      }
    }
  });
});

test("seeded audit corruption fuzz fails closed with reproducible diagnostics", async (context) => {
  await reliabilityScenario("audit-corruption-fuzz", RELIABILITY_SEED ^ 0xa11d17, async (random) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cope-reliability-audit-"));
    context.after(async () => rm(root, { recursive: true, force: true }));
    for (let iteration = 0; iteration < RELIABILITY_ITERATIONS; iteration += 1) {
      const filename = path.join(root, `${iteration}.jsonl`);
      const log = new AuditLog(filename, "session_12345678");
      await log.append({ type: "session.created", taskId: "task_1", data: { sample: random.text(64) } });
      const bytes = Buffer.from(await readFile(filename));
      const offset = random.integer(Math.max(1, bytes.length - 1));
      bytes[offset] = (bytes[offset] ?? 0) ^ 1;
      await writeFile(filename, bytes);
      await assert.rejects(() => AuditLog.verify(filename, "session_12345678"));
    }
  });
});

test("seeded patch soak preserves atomic apply and rollback", async (context) => {
  await reliabilityScenario("patch-rollback-soak", RELIABILITY_SEED ^ 0x5a0c, async (random) => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "cope-reliability-patch-"));
    context.after(async () => rm(temporary, { recursive: true, force: true }));
    const root = path.join(temporary, "repo");
    await mkdir(root);
    const boundary = await RepositoryBoundary.create(root);
    const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
    const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy(), { allowCreate: true });
    for (let iteration = 0; iteration < RELIABILITY_ITERATIONS; iteration += 1) {
      const relative = `sample-${iteration}.txt`;
      const content = `${random.text(512)}\n`;
      const result = await engine.applyPatch({
        operationId: `op_patch_${iteration}`,
        changes: [{ kind: "create", path: relative, content }],
      });
      assert.equal(await readFile(path.join(root, relative), "utf8"), content);
      await checkpoints.rollback(result.checkpointId);
      await assert.rejects(readFile(path.join(root, relative)));
    }
  });
});

test("transport correlation fuzz preserves exactly-once submissions within a performance ceiling", async () => {
  await reliabilityScenario("transport-correlation-soak", RELIABILITY_SEED ^ 0x7a4e5, async (random) => {
    const turns = Array.from({ length: RELIABILITY_ITERATIONS }, (_, index) => ({
      taskId: "task-reliability",
      turnId: `turn-${index}`,
      submissionId: `submission-${index}`,
      expectedContent: `payload-${index}-${random.text(32)}`,
      response: { status: "completed" as const, content: `response-${index}` },
    }));
    const transport = new ScriptedFixtureTransport(turns);
    const startedAt = performance.now();
    for (const turn of turns) {
      const request = {
        taskId: turn.taskId,
        turnId: turn.turnId,
        submissionId: turn.submissionId,
        content: turn.expectedContent,
      };
      const first = await transport.submit(request);
      const duplicate = await transport.submit(request);
      assert.equal(duplicate.transportMarker, first.transportMarker);
      assert.equal((await transport.receive(request)).status, "completed");
    }
    assert.equal(transport.remainingTurns, 0);
    assert.equal(performance.now() - startedAt < 5_000, true, "offline transport soak exceeded 5 seconds");
  });
});

test("fault schedules enumerate every runtime boundary deterministically", () => {
  const boundaries = ["persist-intent", "submit", "resolve", "receive", "parse", "authorize", "execute", "journal", "return"];
  for (let failAt = 1; failAt <= boundaries.length; failAt += 1) {
    const schedule = new FaultSchedule(RELIABILITY_SEED, failAt);
    let injected: InjectedFault | undefined;
    try {
      for (const boundary of boundaries) schedule.checkpoint(boundary);
    } catch (error) {
      if (error instanceof InjectedFault) injected = error;
      else throw error;
    }
    assert.equal(injected?.occurrence, failAt);
    assert.equal(schedule.trace().length, failAt);
    assert.equal(injected?.checkpoint, boundaries[failAt - 1]);
  }
});

test("failed seeded scenarios emit bounded reproduction diagnostics", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cope-reliability-diagnostics-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const prior = process.env.COPE_RELIABILITY_ARTIFACT_DIR;
  process.env.COPE_RELIABILITY_ARTIFACT_DIR = directory;
  try {
    await assert.rejects(
      () => reliabilityScenario("diagnostic contract", 1234, async () => { throw new Error("reproducible failure"); }),
      /reproducible failure/,
    );
  } finally {
    if (prior === undefined) delete process.env.COPE_RELIABILITY_ARTIFACT_DIR;
    else process.env.COPE_RELIABILITY_ARTIFACT_DIR = prior;
  }
  const diagnostic = JSON.parse(
    await readFile(path.join(directory, "diagnostic_contract-1234.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(diagnostic, {
    errorFingerprint: sha256("reproducible failure"),
    errorName: "Error",
    scenario: "diagnostic contract",
    schemaVersion: 1,
    seed: 1234,
  });
});
