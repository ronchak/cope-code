import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AuditLog } from "../../src/audit/audit-log.js";
import { CheckpointStore } from "../../src/repository/checkpoint.js";
import { RepositoryBoundary } from "../../src/repository/boundary.js";
import { PatchEngine } from "../../src/repository/patch-engine.js";
import { ProtectedPathPolicy } from "../../src/security/protected-paths.js";
import { sha256 } from "../../src/shared/crypto.js";
import { OperationJournal } from "../../src/session/operation-journal.js";
import { SessionStore } from "../../src/session/store.js";
import { ScriptedFixtureTransport } from "../../src/transport/scripted-fixture.js";
import {
  RELIABILITY_ITERATIONS,
  RELIABILITY_SEED,
  deriveScenarioSeed,
  reliabilityScenario,
} from "../helpers/reliability.js";
import {
  CRASH_EXIT_CODE,
  OPERATION_ID,
  PersistentToolExecutor,
  PersistentTransport,
  SESSION_ID,
  createReliabilityRuntime,
} from "../helpers/runtime-reliability.js";

const runtimeCrashChild = fileURLToPath(new URL("../fixtures/reliability-runtime-crash.js", import.meta.url));
const patchCrashChild = fileURLToPath(new URL("../fixtures/reliability-patch-crash.js", import.meta.url));

const runtimeBoundaries = [
  "state-prepared",
  "transport-submitted",
  "state-submitted",
  "state-answered",
  "journal-accepted",
  "state-operation-accepted",
  "journal-executing",
  "state-operation-executing",
  "tool-side-effect",
  "journal-completed",
  "state-operation-completed",
] as const;
const pauseBoundaries = new Set<(typeof runtimeBoundaries)[number]>([
  "state-operation-executing",
  "tool-side-effect",
]);
const noReplayBoundaries = new Set<(typeof runtimeBoundaries)[number]>([
  ...pauseBoundaries,
  "journal-completed",
  "state-operation-completed",
]);

test("hard-exit runtime matrix reconstructs real durable commits without duplicate delivery or mutation", async () => {
  await reliabilityScenario("runtime-hard-exit-matrix", RELIABILITY_SEED, async (random) => {
    const ordered = [...runtimeBoundaries];
    for (let index = ordered.length - 1; index > 0; index -= 1) {
      const swapIndex = random.integer(index + 1);
      const current = ordered[index];
      ordered[index] = ordered[swapIndex]!;
      ordered[swapIndex] = current!;
    }
    for (const boundaryName of ordered) {
      const root = await mkdtemp(path.join(os.tmpdir(), "cope-runtime-crash-"));
      try {
        const crash = spawnSync(process.execPath, [runtimeCrashChild, root, boundaryName], {
          encoding: "utf8",
          env: withoutNodeTestContext(process.env),
          timeout: 15_000,
        });
        assert.equal(
          crash.status,
          CRASH_EXIT_CODE,
          `${boundaryName} did not hard-exit at its durable boundary\n${crash.stderr}`,
        );

        const store = new SessionStore(path.join(root, "state"));
        const state = await store.read(SESSION_ID);
        const journal = new OperationJournal(path.join(root, "operations"), SESSION_ID);
        const transport = new PersistentTransport(root);
        const tools = new PersistentToolExecutor(root);
        const result = await createReliabilityRuntime({ root, state, store, journal, transport, tools }).run();

        if (pauseBoundaries.has(boundaryName)) {
          assert.equal(result.status, "paused", boundaryName);
          assert.match(result.reason ?? "", /rollback|reconcil/u, boundaryName);
          assert.equal(state.pendingOperations[0]?.status, "indeterminate", boundaryName);
        } else {
          assert.equal(result.status, "completed", `${boundaryName}: ${result.reason ?? ""}`);
          assert.equal(state.completedOperationIds.filter((id) => id === OPERATION_ID).length, 1, boundaryName);
          assert.equal(state.mutations.filter((entry) => entry.operationId === OPERATION_ID).length, 1, boundaryName);
          assert.equal(await readFile(path.join(root, "repository", "effect.txt"), "utf8"), "committed\n");
        }
        assert.equal(
          tools.executeCount,
          noReplayBoundaries.has(boundaryName) ? 0 : 1,
          `${boundaryName} mutation execution count`,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});

test("hard-exit patch matrix distinguishes checkpoint, worktree commit, and seal recovery", async () => {
  await reliabilityScenario("patch-hard-exit-matrix", RELIABILITY_SEED, async () => {
    for (const boundaryName of ["checkpoint-created", "worktree-committed", "checkpoint-sealed"] as const) {
      const root = await mkdtemp(path.join(os.tmpdir(), "cope-patch-crash-"));
      try {
        const crash = spawnSync(process.execPath, [patchCrashChild, root, boundaryName], {
          encoding: "utf8",
          env: withoutNodeTestContext(process.env),
          timeout: 15_000,
        });
        assert.equal(
          crash.status,
          CRASH_EXIT_CODE,
          `${boundaryName} did not hard-exit at its durable boundary\n${crash.stderr}`,
        );
        const repository = path.join(root, "repository");
        const boundary = await RepositoryBoundary.create(repository);
        const checkpoints = await CheckpointStore.create(boundary, path.join(root, "checkpoints"));
        const checkpoint = await checkpoints.latest("op_patch_crash");
        assert.notEqual(checkpoint, undefined, boundaryName);
        assert.equal(checkpoint?.sealed, boundaryName === "checkpoint-sealed", boundaryName);
        assert.equal(
          await readFile(path.join(repository, "sample.txt"), "utf8"),
          boundaryName === "checkpoint-created" ? "before\n" : "after\n",
          boundaryName,
        );
        if (boundaryName === "checkpoint-sealed") {
          await checkpoints.rollback(checkpoint!.id);
        } else {
          await assert.rejects(() => checkpoints.rollback(checkpoint!.id), /no verified post-mutation state/u);
          await checkpoints.rollback(checkpoint!.id, { force: true });
        }
        assert.equal(await readFile(path.join(repository, "sample.txt"), "utf8"), "before\n", boundaryName);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});

test("seeded audit corruption fails closed", async () => {
  await reliabilityScenario("audit-corruption-fuzz", RELIABILITY_SEED, async (random) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cope-reliability-audit-"));
    try {
      for (let iteration = 0; iteration < RELIABILITY_ITERATIONS; iteration += 1) {
        const filename = path.join(root, `${iteration}.jsonl`);
        const log = new AuditLog(filename, SESSION_ID);
        await log.append({ type: "session.created", taskId: "task_1", data: { sample: random.text(64) } });
        const bytes = Buffer.from(await readFile(filename));
        const offset = random.integer(Math.max(1, bytes.length - 1));
        bytes[offset] = (bytes[offset] ?? 0) ^ 1;
        await writeFile(filename, bytes);
        await assert.rejects(() => AuditLog.verify(filename, SESSION_ID));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("seeded patch soak preserves apply and rollback", async () => {
  await reliabilityScenario("patch-rollback-soak", RELIABILITY_SEED, async (random) => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "cope-reliability-patch-"));
    try {
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
        await assert.rejects(
          () => access(path.join(root, relative)),
          (error: NodeJS.ErrnoException) => error.code === "ENOENT",
        );
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

test("seeded transport correlation preserves fixture idempotency", async () => {
  await reliabilityScenario("transport-correlation-soak", RELIABILITY_SEED, async (random) => {
    const turns = Array.from({ length: RELIABILITY_ITERATIONS }, (_, index) => ({
      taskId: "task-reliability",
      turnId: `turn-${index}`,
      submissionId: `submission-${index}`,
      expectedContent: `payload-${index}-${random.text(32)}`,
      response: { status: "completed" as const, content: `response-${index}` },
    }));
    const transport = new ScriptedFixtureTransport(turns);
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
  });
});

test("failure diagnostic records a base seed that reproduces the exact derived trace in a subprocess", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cope-reliability-diagnostics-"));
  const prior = process.env.COPE_RELIABILITY_ARTIFACT_DIR;
  process.env.COPE_RELIABILITY_ARTIFACT_DIR = directory;
  const expectedTrace: number[] = [];
  try {
    await assert.rejects(
      () => reliabilityScenario("diagnostic contract", 1234, async (random) => {
        for (let index = 0; index < 8; index += 1) expectedTrace.push(random.nextUint32());
        throw new Error("reproducible failure");
      }),
      /reproducible failure/u,
    );
  } finally {
    if (prior === undefined) delete process.env.COPE_RELIABILITY_ARTIFACT_DIR;
    else process.env.COPE_RELIABILITY_ARTIFACT_DIR = prior;
  }
  try {
    const diagnostic = JSON.parse(
      await readFile(path.join(directory, "diagnostic_contract-1234.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(diagnostic, {
      baseSeed: 1234,
      errorFingerprint: sha256("reproducible failure"),
      errorName: "Error",
      scenario: "diagnostic contract",
      scenarioSeed: deriveScenarioSeed(1234, "diagnostic contract"),
      schemaVersion: 2,
    });

    const helperUrl = new URL("../helpers/reliability.js", import.meta.url).href;
    const reproduction = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `import { RELIABILITY_SEED, SeededRandom, deriveScenarioSeed } from ${JSON.stringify(helperUrl)};` +
        `const seed=deriveScenarioSeed(RELIABILITY_SEED,"diagnostic contract");` +
        `const random=new SeededRandom(seed);` +
        `process.stdout.write(JSON.stringify({seed,trace:Array.from({length:8},()=>random.nextUint32())}));`,
    ], {
      encoding: "utf8",
      env: { ...withoutNodeTestContext(process.env), COPE_RELIABILITY_SEED: String(diagnostic.baseSeed) },
    });
    assert.equal(reproduction.status, 0, reproduction.stderr);
    assert.deepEqual(JSON.parse(reproduction.stdout), {
      seed: diagnostic.scenarioSeed,
      trace: expectedTrace,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function withoutNodeTestContext(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment };
  delete result.NODE_TEST_CONTEXT;
  return result;
}
