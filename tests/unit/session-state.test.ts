import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BudgetMeter } from "../../src/session/budgets.js";
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
