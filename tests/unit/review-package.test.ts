import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AuditLog } from "../../src/audit/audit-log.js";
import type { AuditEvent } from "../../src/audit/types.js";
import {
  createReviewPackage,
  REVIEW_PACKAGE_VERSION,
  verifyReviewPackage,
  type ReviewPackage,
} from "../../src/review/review-package.js";
import { DisclosureLedger, type DisclosureRecord } from "../../src/security/disclosure-ledger.js";
import { sha256, stableJson } from "../../src/shared/crypto.js";
import {
  DEFAULT_BUDGET_LIMITS,
  SESSION_SCHEMA_VERSION,
  type SessionState,
  zeroBudgetUsage,
} from "../../src/session/types.js";

const NOW = "2026-07-17T12:00:00.000Z";
const clock = { now: () => new Date(NOW) };

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    protocolVersion: "cba/1",
    sessionId: "session_review_1",
    taskId: "task_review_1",
    repositoryRoot: "C:\\Customers\\Project-SECRET-ROOT",
    repositoryFingerprintAtStart: "f".repeat(64),
    repositoryExcludedStateAtStart: "0".repeat(64),
    preExistingChanges: ["preexisting/SECRET-PATH.ts"],
    objective: "OBJECTIVE-SECRET: repair the internal billing rule",
    acceptanceCriteria: ["CRITERION-SECRET: preserve private behavior"],
    mode: "auto",
    status: "paused",
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    pauseReason: "PAUSE-SECRET",
    policyHashes: {
      organization: "a".repeat(64),
      repository: "b".repeat(64),
      grant: "c".repeat(64),
    },
    budgetLimits: { ...DEFAULT_BUDGET_LIMITS },
    budgetUsage: { ...zeroBudgetUsage(), turns: 3, operations: 4, disclosedBytes: 60 },
    turnSequence: 3,
    mutationSequence: 1,
    pendingOperations: [
      {
        operationId: "op-pending",
        tool: "repository.read",
        mutating: false,
        requestHash: "d".repeat(64),
        status: "accepted",
        acceptedAt: NOW,
      },
    ],
    completedOperationIds: ["op-edit", "op-test"],
    mutations: [
      {
        operationId: "op-edit",
        checkpointId: "checkpoint_1",
        changedPaths: ["src/SECRET-PATH.ts", "src/second-private-name.ts"],
        changedLines: 7,
        completedAt: NOW,
        repositoryFingerprint: "e".repeat(64),
      },
    ],
    validations: [
      {
        operationId: "op-test",
        commandId: "npm-test",
        outcome: "success",
        exitCode: 0,
        completedAt: NOW,
        mutationSequence: 1,
      },
    ],
    protocolRepairStreak: 0,
    ...overrides,
  };
}

async function makeVerifiedEvidence(state: SessionState): Promise<{
  readonly auditEvents: readonly AuditEvent[];
  readonly disclosureRecords: readonly DisclosureRecord[];
}> {
  const root = await mkdtemp(path.join(tmpdir(), "cba-review-package-"));
  const auditFile = path.join(root, "audit.jsonl");
  const audit = new AuditLog(auditFile, state.sessionId, clock);
  await audit.append({
    type: "session.created",
    taskId: state.taskId,
    data: {
      rawOutput: "AUDIT-DATA-SECRET",
      tenantUrl: "https://TENANT-URL-SECRET.example/chat",
      identity: "IDENTITY-SECRET@example.com",
    },
  });
  await audit.append({
    type: "mutation.completed",
    taskId: state.taskId,
    operationId: "op-edit",
    data: { path: "AUDIT-SECRET-PATH.ts" },
  });
  const auditEvents = await AuditLog.verify(auditFile, state.sessionId);

  const disclosure = new DisclosureLedger(state.sessionId, { clock });
  await disclosure.record({
    operationId: "op-read",
    source: "repository-file",
    path: "src/DISCLOSURE-SECRET-PATH.ts",
    classification: "CLASSIFICATION-SECRET",
    content: "[REDACTED:credential-assignment:0123456789abcdef]",
    originalByteCount: 75,
    findings: [
      {
        kind: "credential-assignment",
        severity: "high",
        start: 0,
        end: 30,
        line: 9,
        column: 4,
        fingerprint: "0123456789abcdef",
      },
    ],
  });
  await disclosure.record({
    operationId: "op-blocked",
    source: "command-output",
    content: "",
    originalByteCount: 25,
    disclosed: false,
  });
  assert.equal(disclosure.verifyIntegrity(), true);
  return { auditEvents, disclosureRecords: disclosure.records() };
}

test("review package is deterministic, integrity protected, and contains only safe metadata", async () => {
  const state = makeState();
  const evidence = await makeVerifiedEvidence(state);
  const first = createReviewPackage({ state, ...evidence });
  const second = createReviewPackage({ state, ...evidence });

  assert.deepEqual(first, second);
  assert.equal(first.version, REVIEW_PACKAGE_VERSION);
  assert.equal(first.integrity.bodySha256, sha256(stableJson(first.body)));
  assert.equal(verifyReviewPackage(first), true);
  assert.deepEqual(first.body.mutations, [
    { operationId: "op-edit", checkpointId: "checkpoint_1", changedFileCount: 2, changedLines: 7 },
  ]);
  assert.deepEqual(first.body.audit, {
    eventCount: 2,
    finalHash: evidence.auditEvents[1]?.eventHash,
  });
  assert.deepEqual(first.body.disclosures.bySource, {
    "repository-file": 1,
    "repository-search": 0,
    "command-output": 1,
    "tool-result": 0,
  });
  assert.equal(first.body.disclosures.originalByteCount, 100);
  assert.equal(first.body.disclosures.disclosedRecordCount, 1);
  assert.equal(first.body.disclosures.withheldRecordCount, 1);
  assert.deepEqual(first.body.disclosures.findings, [
    {
      operationId: "op-read",
      kind: "credential-assignment",
      severity: "high",
      line: 9,
      column: 4,
      fingerprint: "0123456789abcdef",
    },
  ]);

  const serialized = JSON.stringify(first);
  for (const forbidden of [
    "Project-SECRET-ROOT",
    "OBJECTIVE-SECRET",
    "CRITERION-SECRET",
    "PAUSE-SECRET",
    "SECRET-PATH",
    "AUDIT-DATA-SECRET",
    "TENANT-URL-SECRET",
    "IDENTITY-SECRET",
    "AUDIT-SECRET-PATH",
    "DISCLOSURE-SECRET-PATH",
    "CLASSIFICATION-SECRET",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `export leaked ${forbidden}`);
  }

  const tampered = structuredClone(first) as ReviewPackage & {
    body: { counts: { mutations: number } };
  };
  tampered.body.counts.mutations += 1;
  assert.equal(verifyReviewPackage(tampered), false);
});

test("review package rejects audit and disclosure evidence that was altered after verification", async () => {
  const state = makeState();
  const evidence = await makeVerifiedEvidence(state);
  const alteredAudit = evidence.auditEvents.map((event, index) =>
    index === 0 ? { ...event, data: { rawOutput: "tampered" } } : event,
  );
  assert.throws(
    () => createReviewPackage({ state, auditEvents: alteredAudit, disclosureRecords: evidence.disclosureRecords }),
    /audit integrity/,
  );

  const alteredDisclosure = evidence.disclosureRecords.map((record, index) =>
    index === 0 ? { ...record, path: "tampered/path.ts" } : record,
  );
  assert.throws(
    () => createReviewPackage({ state, auditEvents: evidence.auditEvents, disclosureRecords: alteredDisclosure }),
    /disclosure integrity/,
  );
});

test("review package rejects mismatched identities and free-form values in exported identifier slots", async () => {
  const state = makeState();
  const evidence = await makeVerifiedEvidence(state);
  const mismatchedState = makeState({ sessionId: "session_review_2" });
  assert.throws(
    () => createReviewPackage({ state: mismatchedState, ...evidence }),
    /audit metadata is inconsistent/,
  );

  const unsafeState = makeState({
    mutations: [{ ...state.mutations[0]!, checkpointId: "C:\\private\\checkpoint" }],
  });
  assert.throws(
    () => createReviewPackage({ state: unsafeState, ...evidence }),
    /mutation metadata is unsafe/,
  );
});
