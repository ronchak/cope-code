import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AuditLog } from "../../src/audit/audit-log.js";
import type { AuditEvent, AuditEventInput } from "../../src/audit/types.js";
import {
  createReviewPackage,
  REVIEW_PACKAGE_VERSION,
  verifyReviewPackage,
  type ReviewPackage,
} from "../../src/review/review-package.js";
import { DisclosureLedger, type DisclosureRecord } from "../../src/security/disclosure-ledger.js";
import { sha256, stableJson } from "../../src/shared/crypto.js";
import { AgentError } from "../../src/shared/errors.js";
import {
  DEFAULT_BUDGET_LIMITS,
  SESSION_SCHEMA_VERSION,
  type FullTerminalMutationRecord,
  type SessionState,
  zeroBudgetUsage,
} from "../../src/session/types.js";

const NOW = "2026-07-17T12:00:00.000Z";
const clock = { now: () => new Date(NOW) };
const INTERNAL_RECOVERY_OPERATION_ID =
  "_cope_internal_budget_recovery_disclosed_bytes_turn_0003";
const INTERNAL_PENDING_RECOVERY_OPERATION_ID =
  "_cope_internal_budget_recovery_operations_turn_0004";

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

async function makeVerifiedEvidence(
  state: SessionState,
  additionalAuditEvents: readonly AuditEventInput[] = [],
): Promise<{
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
  if (state.completedOperationIds.includes(INTERNAL_RECOVERY_OPERATION_ID)) {
    await audit.append({
      type: "user.decided",
      taskId: state.taskId,
      operationId: INTERNAL_RECOVERY_OPERATION_ID,
      data: { kind: "capability", decision: "allow_once" },
    });
  }
  for (const event of additionalAuditEvents) {
    await audit.append(event);
  }
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
  assert.deepEqual(first.body.capture, { state: "not_recorded" });
  assert.deepEqual(first.body.mutations, [
    {
      operationId: "op-edit",
      kind: "patch",
      checkpointId: "checkpoint_1",
      changedFileCount: 2,
      changedLines: 7,
    },
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

test("review package records reconstructed capture evidence with only sanitized fields", async () => {
  const state = makeState();
  const evidence = await makeVerifiedEvidence(state, [{
    type: "model.response",
    taskId: state.taskId,
    data: {
      captureEvidence: {
        contractVersion: "response-capture/v2",
        status: "protocol_reconstructed",
        protocolVersion: "cba-agent/1",
        reasonCode: "CAPTURE_RECONSTRUCTED",
        codeBlockCount: 1,
        protocolBlockCount: 1,
        editorCount: 2,
        bannerCount: 1,
        lineCount: 3,
        contentBytes: 128,
        bannerContract: "supported",
        bannerTokenCount: 2,
        bannerMatchesBaseline: true,
        bannerVariant: "cafebabe",
        rawResponseContent: "RAW-RESPONSE-CAPTURE-SECRET",
        auditTaint: "AUDIT-CAPTURE-TAINT",
      },
    },
  }]);

  const reviewPackage = createReviewPackage({ state, ...evidence });
  assert.equal(reviewPackage.body.capture.state, "recorded");
  if (reviewPackage.body.capture.state !== "recorded") {
    throw new Error("expected recorded capture evidence");
  }
  assert.equal(reviewPackage.body.capture.evidence.bannerMatchesBaseline, true);
  assert.equal(reviewPackage.body.capture.evidence.bannerVariant, "cafebabe");
  assert.deepEqual(reviewPackage.body.capture, {
    state: "recorded",
    evidence: {
      contractVersion: "response-capture/v2",
      status: "protocol_reconstructed",
      protocolVersion: "cba-agent/1",
      reasonCode: "CAPTURE_RECONSTRUCTED",
      codeBlockCount: 1,
      protocolBlockCount: 1,
      editorCount: 2,
      bannerCount: 1,
      lineCount: 3,
      contentBytes: 128,
      bannerContract: "supported",
      bannerTokenCount: 2,
      bannerMatchesBaseline: true,
      bannerVariant: "cafebabe",
    },
  });
  const serialized = JSON.stringify(reviewPackage);
  assert.equal(serialized.includes("RAW-RESPONSE-CAPTURE-SECRET"), false);
  assert.equal(serialized.includes("AUDIT-CAPTURE-TAINT"), false);
});

test("review package chooses the newest failing protocol classification over an earlier reconstruction", async () => {
  const state = makeState();
  const evidence = await makeVerifiedEvidence(state, [
    {
      type: "model.response",
      taskId: state.taskId,
      data: {
        captureEvidence: {
          contractVersion: "response-capture/v2",
          status: "protocol_reconstructed",
          protocolVersion: "cba-agent/1",
          reasonCode: "CAPTURE_RECONSTRUCTED",
          codeBlockCount: 1,
          protocolBlockCount: 1,
          editorCount: 1,
          bannerCount: 1,
          lineCount: 1,
          contentBytes: 64,
          bannerContract: "supported",
          bannerTokenCount: 1,
          bannerMatchesBaseline: true,
          bannerVariant: "cafebabe",
          earlierCaptureTaint: "EARLIER-CAPTURE-TAINT",
        },
      },
    },
    {
      type: "protocol.error",
      taskId: state.taskId,
      data: {
        captureEvidence: {
          contractVersion: "response-capture/v2",
          status: "model_protocol_malformed",
          protocolVersion: "cba-agent/1",
          reasonCode: "MODEL_PROTOCOL_INVALID_CAPTURE",
          protocolErrorCode: "SCHEMA_INVALID",
          codeBlockCount: 1,
          protocolBlockCount: 1,
          editorCount: 1,
          bannerCount: 1,
          lineCount: 2,
          contentBytes: 96,
          bannerContract: "supported",
          bannerTokenCount: 1,
          bannerMatchesBaseline: false,
          bannerVariant: "deadbeef",
          responseContent: "LATEST-RAW-CAPTURE-SECRET",
          auditTaint: "LATEST-AUDIT-CAPTURE-TAINT",
        },
      },
    },
  ]);

  const reviewPackage = createReviewPackage({ state, ...evidence });
  assert.equal(reviewPackage.body.capture.state, "recorded");
  if (reviewPackage.body.capture.state !== "recorded") {
    throw new Error("expected recorded capture evidence");
  }
  assert.equal(reviewPackage.body.capture.evidence.bannerMatchesBaseline, false);
  assert.equal(reviewPackage.body.capture.evidence.bannerVariant, "deadbeef");
  assert.deepEqual(reviewPackage.body.capture, {
    state: "recorded",
    evidence: {
      contractVersion: "response-capture/v2",
      status: "model_protocol_malformed",
      protocolVersion: "cba-agent/1",
      reasonCode: "MODEL_PROTOCOL_INVALID_CAPTURE",
      protocolErrorCode: "SCHEMA_INVALID",
      codeBlockCount: 1,
      protocolBlockCount: 1,
      editorCount: 1,
      bannerCount: 1,
      lineCount: 2,
      contentBytes: 96,
      bannerContract: "supported",
      bannerTokenCount: 1,
      bannerMatchesBaseline: false,
      bannerVariant: "deadbeef",
    },
  });
  const serialized = JSON.stringify(reviewPackage);
  assert.equal(serialized.includes("EARLIER-CAPTURE-TAINT"), false);
  assert.equal(serialized.includes("LATEST-RAW-CAPTURE-SECRET"), false);
  assert.equal(serialized.includes("LATEST-AUDIT-CAPTURE-TAINT"), false);
});

test("review package fails closed when the newest capture-bearing event fails strict validation", async () => {
  const state = makeState();
  const invalidEvidence = await makeVerifiedEvidence(state, [
    {
      type: "model.response",
      taskId: state.taskId,
      data: {
        captureEvidence: {
          contractVersion: "response-capture/v2",
          status: "protocol_reconstructed",
          codeBlockCount: 1,
          protocolBlockCount: 1,
          editorCount: 1,
          bannerCount: 1,
          lineCount: 1,
          contentBytes: 64,
          bannerMatchesBaseline: true,
          bannerVariant: "cafebabe",
        },
      },
    },
    {
      type: "protocol.error",
      taskId: state.taskId,
      data: {
        captureEvidence: {
          contractVersion: "response-capture/v2",
          status: "protocol_reconstructed",
          codeBlockCount: 1,
          protocolBlockCount: 1,
          editorCount: 1,
          bannerCount: 1,
          lineCount: 1,
          contentBytes: -1,
          bannerMatchesBaseline: false,
          bannerVariant: "deadbeef",
        },
      },
    },
  ]);

  assert.throws(
    () => createReviewPackage({ state, ...invalidEvidence }),
    (error: unknown) =>
      error instanceof AgentError &&
      error.code === "RECOVERY_REQUIRED" &&
      error.message === "Review-package capture evidence failed strict validation",
  );

  const nonRecordEvidence = await makeVerifiedEvidence(state, [{
    type: "model.response",
    taskId: state.taskId,
    data: { captureEvidence: "not-a-capture-record" },
  }]);
  assert.throws(
    () => createReviewPackage({ state, ...nonRecordEvidence }),
    (error: unknown) =>
      error instanceof AgentError &&
      error.code === "RECOVERY_REQUIRED" &&
      error.message === "Review-package capture evidence failed strict validation",
  );
});

test("review package accepts local recovery IDs in journal and audit metadata", async () => {
  const state = makeState({
    completedOperationIds: [
      "op-edit",
      "op-test",
      INTERNAL_RECOVERY_OPERATION_ID,
    ],
    unreturnedOperationIds: [INTERNAL_RECOVERY_OPERATION_ID],
    pendingOperations: [
      {
        operationId: INTERNAL_PENDING_RECOVERY_OPERATION_ID,
        tool: "request_capability",
        mutating: false,
        requestHash: "d".repeat(64),
        status: "accepted",
        acceptedAt: NOW,
      },
    ],
  });
  const evidence = await makeVerifiedEvidence(state);

  assert.equal(
    verifyReviewPackage(createReviewPackage({ state, ...evidence })),
    true,
  );
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

  const mutation = state.mutations[0];
  if (mutation === undefined || mutation.kind === "terminal") {
    throw new Error("expected patch mutation fixture");
  }
  const unsafeState = makeState({
    mutations: [{ ...mutation, checkpointId: "C:\\private\\checkpoint" }],
  });
  assert.throws(
    () => createReviewPackage({ state: unsafeState, ...evidence }),
    /mutation metadata is unsafe/,
  );
});

test("review package exports exact terminal totals, process outcomes, and limitations without source facts", async () => {
  const operationId = "op-terminal-summary";
  const terminal: FullTerminalMutationRecord = {
    kind: "terminal",
    recordContract: "terminal-mutation/2",
    operationId,
    changedPaths: [
      "src/TERMINAL-SECRET-PATH.ts",
      "private/SECOND-TERMINAL-SECRET.txt",
    ],
    changedLines: 17,
    createdPaths: ["src/TERMINAL-SECRET-PATH.ts"],
    updatedPaths: ["private/SECOND-TERMINAL-SECRET.txt"],
    deletedPaths: [],
    renamedPaths: [{
      from: "private/RENAMED-SECRET-BEFORE.txt",
      to: "private/RENAMED-SECRET-AFTER.txt",
    }],
    preExistingTouchedPaths: ["notes/USER-WORK-SECRET.txt"],
    processOutcome: "timed_out",
    createdTotal: 2,
    updatedTotal: 3,
    deletedTotal: 1,
    renamedTotal: 1,
    preExistingTouchedTotal: 2,
    changedPathCount: 9,
    pathEndpointTotal: 10,
    omittedPathEndpointTotal: 5,
    pathFactsTruncated: true,
    pathFactsSha256: "9".repeat(64),
    unavailableBaselineCount: 4,
    completedAt: NOW,
    observationOutcome: "unknown",
    preObservation: {
      kind: "terminal-pre-observation",
      id: operationId,
      bytes: 10,
      sha256: "1".repeat(64),
    },
    postObservation: {
      kind: "terminal-post-observation",
      id: operationId,
      bytes: 10,
      sha256: "2".repeat(64),
    },
    terminalResult: {
      kind: "terminal-result",
      id: operationId,
      bytes: 10,
      sha256: "3".repeat(64),
    },
  };
  const renameOnlyOperationId = "op-terminal-rename-only";
  const renameOnly: FullTerminalMutationRecord = {
    ...terminal,
    operationId: renameOnlyOperationId,
    changedPaths: [
      "private/RENAME-ONLY-SECRET-BEFORE.txt",
      "private/RENAME-ONLY-SECRET-AFTER.txt",
    ],
    changedLines: 0,
    createdPaths: [],
    updatedPaths: [],
    deletedPaths: [],
    renamedPaths: [{
      from: "private/RENAME-ONLY-SECRET-BEFORE.txt",
      to: "private/RENAME-ONLY-SECRET-AFTER.txt",
    }],
    preExistingTouchedPaths: [],
    processOutcome: "completed",
    createdTotal: 0,
    updatedTotal: 0,
    deletedTotal: 0,
    renamedTotal: 1,
    preExistingTouchedTotal: 0,
    changedPathCount: 2,
    pathEndpointTotal: 2,
    omittedPathEndpointTotal: 0,
    pathFactsTruncated: false,
    pathFactsSha256: "8".repeat(64),
    unavailableBaselineCount: 0,
    preObservation: {
      kind: "terminal-pre-observation",
      id: renameOnlyOperationId,
      bytes: 10,
      sha256: "4".repeat(64),
    },
    postObservation: {
      kind: "terminal-post-observation",
      id: renameOnlyOperationId,
      bytes: 10,
      sha256: "5".repeat(64),
    },
    terminalResult: {
      kind: "terminal-result",
      id: renameOnlyOperationId,
      bytes: 10,
      sha256: "6".repeat(64),
    },
  };
  const state = makeState({
    completionAuthority: "observed",
    mutations: [...makeState().mutations, terminal, renameOnly],
    mutationSequence: 3,
    pendingTerminalEffectOperationIds: [operationId],
  });
  const evidence = await makeVerifiedEvidence(state);

  const reviewPackage = createReviewPackage({ state, ...evidence });

  assert.equal(reviewPackage.body.session.completionAuthority, "observed");
  assert.deepEqual(reviewPackage.body.counts, {
    acceptanceCriteria: 1,
    preExistingChanges: 1,
    completedOperations: 2,
    pendingOperations: 1,
    mutations: 3,
    patchMutations: 1,
    terminalMutations: 2,
    validations: 1,
    pendingTerminalEffects: 1,
  });
  assert.deepEqual(reviewPackage.body.mutations[1], {
    operationId,
    kind: "terminal",
    observationOutcome: "unknown",
    changedFileCount: 7,
    changedLines: 17,
    terminal: {
      processOutcome: "timed_out",
      createdCount: 2,
      updatedCount: 3,
      deletedCount: 1,
      renamedCount: 1,
      preExistingTouchedCount: 2,
      changedPathCount: 9,
      pathEndpointCount: 10,
      omittedPathEndpointCount: 5,
      unavailableBaselineCount: 4,
      pathFactsTruncated: true,
      legacyEvidence: false,
      limitationCodes: [
        "non_clean_observation",
        "path_facts_truncated",
        "unavailable_baselines",
      ],
    },
  });
  assert.deepEqual(reviewPackage.body.mutations[2], {
    operationId: renameOnlyOperationId,
    kind: "terminal",
    observationOutcome: "unknown",
    changedFileCount: 1,
    changedLines: 0,
    terminal: {
      processOutcome: "completed",
      createdCount: 0,
      updatedCount: 0,
      deletedCount: 0,
      renamedCount: 1,
      preExistingTouchedCount: 0,
      changedPathCount: 2,
      pathEndpointCount: 2,
      omittedPathEndpointCount: 0,
      unavailableBaselineCount: 0,
      pathFactsTruncated: false,
      legacyEvidence: false,
      limitationCodes: ["non_clean_observation"],
    },
  });
  const serialized = JSON.stringify(reviewPackage);
  for (const forbidden of [
    "TERMINAL-SECRET-PATH",
    "SECOND-TERMINAL-SECRET",
    "RENAMED-SECRET",
    "USER-WORK-SECRET",
    "RENAME-ONLY-SECRET",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
