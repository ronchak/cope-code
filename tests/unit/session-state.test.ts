import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SecretScanner } from "../../src/security/secrets.js";
import { BudgetMeter } from "../../src/session/budgets.js";
import { CompletionHandoffStore } from "../../src/session/completion-handoff-store.js";
import { SessionStore } from "../../src/session/store.js";
import { allowedTransitions, isTerminal, transitionSession } from "../../src/session/state-machine.js";
import {
  DEFAULT_BUDGET_LIMITS,
  SESSION_SCHEMA_VERSION,
  type SessionState,
  zeroBudgetUsage,
} from "../../src/session/types.js";

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    protocolVersion: "cba/1",
    sessionId: "session_12345678",
    taskId: "task_12345678",
    repositoryRoot: "/repo",
    repositoryFingerprintAtStart: "d".repeat(64),
    repositoryExcludedStateAtStart: "0".repeat(64),
    preExistingChanges: [],
    objective: "Fix it",
    acceptanceCriteria: [],
    mode: "auto",
    status: "created",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    policyHashes: { organization: "a".repeat(64), repository: "b".repeat(64), grant: "c".repeat(64) },
    budgetLimits: { ...DEFAULT_BUDGET_LIMITS },
    budgetUsage: zeroBudgetUsage(),
    turnSequence: 0,
    mutationSequence: 0,
    pendingOperations: [],
    completedOperationIds: [],
    mutations: [],
    validations: [],
    protocolRepairStreak: 0,
    ...overrides,
  };
}

test("state machine permits explicit lifecycle and rejects illegal jumps", () => {
  const state = makeState();
  transitionSession(state, "preflight", "2026-01-01T00:00:01.000Z");
  transitionSession(state, "grant_pending", "2026-01-01T00:00:02.000Z");
  assert.equal(state.status, "grant_pending");
  assert.throws(
    () => transitionSession(state, "completed", "2026-01-01T00:00:03.000Z"),
    /Invalid session transition/,
  );
  assert.deepEqual(allowedTransitions("completed"), ["rolled_back"]);
  assert.equal(isTerminal("failed"), true);
  const completed = makeState({ status: "completed", completedAt: "2026-01-01T00:00:03.000Z" });
  transitionSession(completed, "rolled_back", "2026-01-01T00:00:04.000Z");
  assert.equal(completed.status, "rolled_back");
  assert.equal(isTerminal(completed.status), true);
  assert.equal(isTerminal("paused"), false);
});

test("budget meter performs check-before-consume and never overdraws", () => {
  const state = makeState({
    budgetLimits: { ...DEFAULT_BUDGET_LIMITS, maxTurns: 1 },
  });
  const meter = new BudgetMeter(state);
  meter.consume("turns");
  assert.equal(meter.remaining("turns"), 0);
  assert.throws(() => meter.consume("turns"), /Budget exhausted/);
  assert.equal(state.budgetUsage.turns, 1);
  meter.refund("turns");
  assert.equal(meter.remaining("turns"), 1);
  assert.throws(() => meter.refund("turns"), /Invalid budget refund/u);
  assert.equal(state.budgetUsage.turns, 0);
});

test("session store writes atomically and rejects mismatched identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-session-"));
  const store = new SessionStore(root);
  const state = makeState();
  await store.create(state);
  assert.deepEqual(await store.read(state.sessionId), state);

  const filename = path.join(store.sessionDirectory(state.sessionId), "session.json");
  const parsed = JSON.parse(await readFile(filename, "utf8")) as Record<string, unknown>;
  parsed.sessionId = "session_tampered";
  await writeFile(filename, `${JSON.stringify(parsed)}\n`, "utf8");
  await assert.rejects(() => store.read(state.sessionId), /does not match/);
});

test("session store migrates legacy non-completed terminal handoffs on load", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-session-legacy-handoff-"));
  const store = new SessionStore(root);
  const state = makeState({
    status: "rolled_back",
    completedAt: "2026-01-01T00:00:03.000Z",
    completionHandoff: {
      version: "completion-handoff/1",
      integrity: "e".repeat(64),
      createdAt: "2026-01-01T00:00:02.000Z",
      redactionCount: 0,
    },
  });
  await store.create(state);
  const sessionDirectory = store.sessionDirectory(state.sessionId);
  const handoffFilename = path.join(sessionDirectory, "handoff", "completion.json");
  await mkdir(path.dirname(handoffFilename), { recursive: true, mode: 0o700 });
  await writeFile(handoffFilename, "legacy sensitive report\n", "utf8");

  const migrated = await store.read(state.sessionId);
  assert.equal(migrated.completionHandoff, undefined);
  await assert.rejects(() => readFile(handoffFilename, "utf8"), { code: "ENOENT" });
  const durable = JSON.parse(await readFile(path.join(sessionDirectory, "session.json"), "utf8")) as SessionState;
  assert.deepEqual(durable.completionHandoff, state.completionHandoff);
});

test("session store removes an orphaned legacy terminal handoff without a state reference", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-session-orphaned-handoff-"));
  const store = new SessionStore(root);
  const state = makeState({
    status: "failed",
    completedAt: "2026-01-01T00:00:03.000Z",
    failure: { code: "INTERNAL_ERROR", message: "legacy failure" },
  });
  await store.create(state);
  const handoffFilename = path.join(store.sessionDirectory(state.sessionId), "handoff", "completion.json");
  await mkdir(path.dirname(handoffFilename), { recursive: true, mode: 0o700 });
  await writeFile(handoffFilename, "orphaned legacy report\n", "utf8");

  const migrated = await store.read(state.sessionId);
  assert.equal(migrated.status, "failed");
  assert.equal(migrated.completionHandoff, undefined);
  await assert.rejects(() => readFile(handoffFilename, "utf8"), { code: "ENOENT" });
});

test("hosts without directory fsync commit completion handoffs inline with session state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-session-inline-handoff-"));
  const sessionStore = new SessionStore(root);
  const state = makeState();
  await sessionStore.create(state);
  const handoffDirectory = path.join(sessionStore.sessionDirectory(state.sessionId), "handoff");
  const legacyFilename = path.join(handoffDirectory, "completion.json");
  await mkdir(handoffDirectory, { recursive: true, mode: 0o700 });
  await writeFile(legacyFilename, "orphaned 0.1.6 report\n", "utf8");
  const handoffs = new CompletionHandoffStore(
    handoffDirectory,
    state.sessionId,
    new SecretScanner(Buffer.alloc(32, 17)),
    false,
  );
  const reference = await handoffs.save({
    summary: "Inline Windows completion",
    acceptanceCriteria: [],
    validation: [],
    skippedValidation: [],
    remainingRisks: [],
    recommendedFollowUp: [],
  }, {
    accepted: true,
    reasons: [],
    actual: {
      changedPaths: [],
      agentChangedPaths: [],
      preExistingPaths: [],
      successfulCommands: [],
      failedCommands: [],
      gitStatusSummary: "clean",
      repositoryFingerprint: "f".repeat(64),
    },
  }, "2026-01-01T00:00:02.000Z");
  assert.ok(reference.inlineRecord);
  await assert.rejects(() => readFile(legacyFilename, "utf8"), { code: "ENOENT" });

  state.status = "completed";
  state.completedAt = "2026-01-01T00:00:03.000Z";
  state.completionHandoff = reference;
  await sessionStore.write(state);
  // A power loss may restore the unflushable legacy directory entry. The
  // completed inline state is a durable cleanup tombstone on every load.
  await writeFile(legacyFilename, "resurrected 0.1.6 report\n", "utf8");
  const durable = await sessionStore.read(state.sessionId);
  assert.deepEqual(durable.completionHandoff, reference);
  assert.equal((await handoffs.read(durable.completionHandoff)).claim.summary, "Inline Windows completion");
  await assert.rejects(() => readFile(legacyFilename, "utf8"), { code: "ENOENT" });

  const inlineRecord = reference.inlineRecord;
  assert.ok(inlineRecord);
  const tampered: SessionState = {
    ...state,
    completionHandoff: {
      ...reference,
      inlineRecord: {
        ...inlineRecord,
        claim: { ...inlineRecord.claim, summary: "tampered after hashing" },
      },
    },
  };
  await assert.rejects(() => sessionStore.write(tampered), /reference is malformed/u);
});

test("file-backed handoff creation flushes its parent before publishing the file", async () => {
  const operations: string[] = [];
  const directory = path.join("/state", "sessions", "session_12345678", "handoff");
  const handoffs = new CompletionHandoffStore(
    directory,
    "session_12345678",
    new SecretScanner(Buffer.alloc(32, 19)),
    true,
    {
      makeDirectory: async (target) => {
        operations.push(`mkdir:${target}`);
      },
      syncDirectory: async (target) => {
        operations.push(`sync:${target}`);
      },
      writeAtomically: async (target) => {
        operations.push(`write:${target}`);
      },
    },
  );

  await handoffs.save({
    summary: "File-backed completion",
    acceptanceCriteria: [],
    validation: [],
    skippedValidation: [],
    remainingRisks: [],
    recommendedFollowUp: [],
  }, {
    accepted: true,
    reasons: [],
    actual: {
      changedPaths: [],
      agentChangedPaths: [],
      preExistingPaths: [],
      successfulCommands: [],
      failedCommands: [],
      gitStatusSummary: "clean",
      repositoryFingerprint: "f".repeat(64),
    },
  }, "2026-01-01T00:00:02.000Z");

  assert.deepEqual(operations, [
    `mkdir:${directory}`,
    `sync:${path.dirname(directory)}`,
    `write:${path.join(directory, "completion.json")}`,
  ]);
});

test("hosts without directory fsync still unlink legacy handoff files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-session-inline-legacy-cleanup-"));
  const handoffDirectory = path.join(root, "handoff");
  const filename = path.join(handoffDirectory, "completion.json");
  await mkdir(handoffDirectory, { recursive: true, mode: 0o700 });
  await writeFile(filename, "legacy report\n", "utf8");

  await CompletionHandoffStore.removeAt(handoffDirectory, false);
  await assert.rejects(() => readFile(filename, "utf8"), { code: "ENOENT" });
});

test("legacy handoff migration cannot overwrite a concurrent terminal state write", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-session-handoff-race-"));
  const store = new SessionStore(root);
  const state = makeState({
    status: "blocked",
    completedAt: "2026-01-01T00:00:03.000Z",
    pauseReason: "legacy block",
    completionHandoff: {
      version: "completion-handoff/1",
      integrity: "e".repeat(64),
      createdAt: "2026-01-01T00:00:02.000Z",
      redactionCount: 0,
    },
  });
  await store.create(state);
  const handoffFilename = path.join(store.sessionDirectory(state.sessionId), "handoff", "completion.json");
  await mkdir(path.dirname(handoffFilename), { recursive: true, mode: 0o700 });
  await writeFile(handoffFilename, "legacy report\n", "utf8");

  const originalRemoveAt = CompletionHandoffStore.removeAt;
  let releaseRemoval!: () => void;
  const removalReleased = new Promise<void>((resolve) => {
    releaseRemoval = resolve;
  });
  let removalEnteredResolve!: () => void;
  const removalEntered = new Promise<void>((resolve) => {
    removalEnteredResolve = resolve;
  });
  CompletionHandoffStore.removeAt = async (directory: string): Promise<void> => {
    removalEnteredResolve();
    await removalReleased;
    await originalRemoveAt(directory);
  };

  try {
    const migration = store.read(state.sessionId);
    await removalEntered;
    const rolledBack: SessionState = {
      ...state,
      status: "rolled_back",
      updatedAt: "2026-01-01T00:00:04.000Z",
      completedAt: "2026-01-01T00:00:04.000Z",
    };
    delete rolledBack.pauseReason;
    delete rolledBack.completionHandoff;
    const concurrentWrite = store.write(rolledBack);
    await concurrentWrite;
    releaseRemoval();
    const migrated = await migration;
    assert.equal(migrated.status, "rolled_back");
  } finally {
    releaseRemoval();
    CompletionHandoffStore.removeAt = originalRemoveAt;
  }

  const durable = await store.read(state.sessionId);
  assert.equal(durable.status, "rolled_back");
  assert.equal(durable.completionHandoff, undefined);
});

test("session store rejects unknown fields and partial durable state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-session-strict-"));
  const store = new SessionStore(root);
  const state = makeState();
  await store.create(state);
  const filename = path.join(store.sessionDirectory(state.sessionId), "session.json");
  const parsed = JSON.parse(await readFile(filename, "utf8")) as Record<string, unknown>;
  parsed.unversionedField = true;
  await writeFile(filename, `${JSON.stringify(parsed)}\n`, "utf8");
  await assert.rejects(() => store.read(state.sessionId), /structural validation/);
  delete parsed.unversionedField;
  await writeFile(filename, JSON.stringify(parsed), "utf8");
  await assert.rejects(() => store.read(state.sessionId), /partial/);
});

test("workspace lock enforces one active session per repository", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-lock-"));
  const store = new SessionStore(root);
  const first = await store.acquireWorkspaceLock("/repo", "session_12345678", new Date().toISOString());
  await assert.rejects(
    () => store.acquireWorkspaceLock("/repo", "session_87654321", new Date().toISOString()),
    /owns this repository/,
  );
  await first.release();
  const second = await store.acquireWorkspaceLock("/repo", "session_87654321", new Date().toISOString());
  await second.release();
});
