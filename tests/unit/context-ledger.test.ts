import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ContextLedger, createContinuationCapsule } from "../../src/session/context-ledger.js";
import { DEFAULT_BUDGET_LIMITS, SESSION_SCHEMA_VERSION, zeroBudgetUsage, type SessionState } from "../../src/session/types.js";

const state = (): SessionState => ({
  schemaVersion: SESSION_SCHEMA_VERSION, protocolVersion: "cba/1", sessionId: "session_12345678",
  taskId: "task_12345678", repositoryRoot: "/repo", repositoryFingerprintAtStart: "d".repeat(64),
  repositoryExcludedStateAtStart: "0".repeat(64), preExistingChanges: [], objective: "Fix it",
  acceptanceCriteria: [], mode: "edit", status: "paused", createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z",
  policyHashes: { organization: "a".repeat(64), repository: "b".repeat(64), grant: "c".repeat(64) },
  budgetLimits: { ...DEFAULT_BUDGET_LIMITS }, budgetUsage: zeroBudgetUsage(), turnSequence: 1,
  mutationSequence: 0, pendingOperations: [], completedOperationIds: [], mutations: [], validations: [],
  protocolRepairStreak: 0, transportConversationId: "private-conversation-id",
});

test("context ledger records only deterministic metadata and verifies its chain", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-context-"));
  const filename = path.join(root, "context-ledger.jsonl");
  const ledger = new ContextLedger(filename, "session_12345678", "task_12345678", {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  await ledger.append({ turnId: "turn_0001", direction: "outbound", kind: "bootstrap", content: "secret source" });
  await ledger.append({ turnId: "turn_0001", direction: "outbound", kind: "bootstrap", content: "secret source" });
  await ledger.append({ turnId: "turn_0001", direction: "inbound", kind: "model_response", content: "reply" });
  assert.deepEqual(await ledger.summary(), {
    records: 2, outboundMessages: 1, inboundMessages: 1, outboundBytes: 13, inboundBytes: 5,
    lastTurnId: "turn_0001", finalHash: (await ledger.read())[1]?.recordHash,
  });
  assert.equal((await readFile(filename, "utf8")).includes("secret source"), false);
  await assert.rejects(
    () => ledger.append({ turnId: "turn_0001", direction: "outbound", kind: "bootstrap", content: "changed" }),
    /reused with different content/,
  );

  const records = (await readFile(filename, "utf8")).trimEnd().split("\n");
  const tampered = JSON.parse(records[0] ?? "{}") as Record<string, unknown>;
  tampered.bytes = 999;
  records[0] = JSON.stringify(tampered);
  await writeFile(filename, `${records.join("\n")}\n`, "utf8");
  await assert.rejects(() => ledger.read(), /integrity check failed/);
});

test("continuation capsule binds context and hashes the transport conversation identifier", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-capsule-"));
  const ledger = new ContextLedger(path.join(root, "ledger.jsonl"), "session_12345678", "task_12345678");
  const capsule = await createContinuationCapsule(state(), ledger, "2026-01-02T00:00:00.000Z");
  assert.equal(capsule.sourceConversationIdHash?.length, 64);
  assert.notEqual(capsule.sourceConversationIdHash, "private-conversation-id");
  assert.equal(capsule.capsuleHash.length, 64);
  assert.equal(capsule.context.records, 0);
});
