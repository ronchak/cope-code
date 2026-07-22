import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AuditLog } from "../../src/audit/audit-log.js";
import { sha256, stableJson } from "../../src/shared/crypto.js";
import { AgentRuntime } from "../../src/orchestrator/agent-runtime.js";
import { ProtocolParseError } from "../../src/protocol/parser.js";
import type {
  NormalizedModelMessage,
  ParsedModelTurn,
  ProtocolAdapter,
  ToolExecutor,
} from "../../src/orchestrator/contracts.js";
import { OperationJournal } from "../../src/session/operation-journal.js";
import { SessionArtifactStore } from "../../src/session/artifact-store.js";
import { CompletionHandoffStore } from "../../src/session/completion-handoff-store.js";
import { SessionStore } from "../../src/session/store.js";
import { SecretScanner } from "../../src/security/secrets.js";
import {
  DEFAULT_BUDGET_LIMITS,
  SESSION_SCHEMA_VERSION,
  type SessionState,
  zeroBudgetUsage,
} from "../../src/session/types.js";
import {
  MODEL_TRANSPORT_CONTRACT_VERSION,
  type ModelTransport,
  type ReceiveResult,
  type ReceiveRequest,
  type SubmissionRequest,
} from "../../src/transport/model-transport.js";

const completionPathKey = (value: string): string => value.replaceAll("\\", "/");

class QueueTransport implements ModelTransport {
  public readonly transportKind = "test";
  public readonly submittedContents: string[] = [];
  public constructor(private readonly responses: readonly string[]) {}
  private index = 0;

  public async submit(request: SubmissionRequest) {
    this.submittedContents.push(request.content);
    return {
      contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
      taskId: request.taskId,
      turnId: request.turnId,
      submissionId: request.submissionId,
      status: "submitted" as const,
      observedAt: "2026-01-01T00:00:00.000Z",
      conversationId: "conversation_1",
    };
  }
  public async resolveSubmission(request: ReceiveRequest) {
    return {
      contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
      taskId: request.taskId,
      turnId: request.turnId,
      submissionId: request.submissionId,
      status: "submitted" as const,
      observedAt: "2026-01-01T00:00:00.000Z",
      conversationId: "conversation_1",
    };
  }
  public async receive(request: ReceiveRequest): Promise<ReceiveResult> {
    const content = this.responses[this.index++];
    if (content === undefined) throw new Error("response queue exhausted");
    return {
      contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
      taskId: request.taskId,
      turnId: request.turnId,
      submissionId: request.submissionId,
      observedAt: "2026-01-01T00:00:00.000Z",
      conversationId: "conversation_1",
      status: "completed" as const,
      responseId: `response_${this.index}`,
      content,
    };
  }
  public async emergencyStop() {}
  public async close() {}
}

class CancelledOnStopTransport extends QueueTransport {
  private markReceiveStarted!: () => void;
  private cancelReceive!: () => void;
  public readonly receiveStarted = new Promise<void>((resolve) => { this.markReceiveStarted = resolve; });
  private readonly stopped = new Promise<void>((resolve) => { this.cancelReceive = resolve; });

  public constructor() {
    super([]);
  }

  public override async receive(request: ReceiveRequest) {
    this.markReceiveStarted();
    await this.stopped;
    return {
      contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
      taskId: request.taskId,
      turnId: request.turnId,
      submissionId: request.submissionId,
      observedAt: "2026-01-01T00:00:00.000Z",
      conversationId: "conversation_1",
      status: "cancelled" as const,
      diagnosticCode: "ABORTED" as const,
    };
  }

  public override async emergencyStop() {
    this.cancelReceive();
  }
}

const protocol: ProtocolAdapter = {
  renderBootstrap: () => "bootstrap",
  parseModelTurn: (raw, expected): ParsedModelTurn => ({
    protocolVersion: "cba/1",
    ...expected,
    messages: JSON.parse(raw) as NormalizedModelMessage[],
  }),
  isRepairableParseError: (error) => !(error instanceof ProtocolParseError) || error.repairable,
  renderToolOutcomes: ({ outcomes }) => JSON.stringify(outcomes),
  renderProtocolError: (input) => JSON.stringify(input),
  renderUserDecision: (input) => JSON.stringify(input),
  renderCompletionRejected: (input) => JSON.stringify(input),
};

function state(repositoryRoot: string): SessionState {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    protocolVersion: "cba/1",
    sessionId: "session_12345678",
    taskId: "task_12345678",
    repositoryRoot,
    repositoryFingerprintAtStart: "d".repeat(64),
    repositoryExcludedStateAtStart: "0".repeat(64),
    preExistingChanges: [],
    objective: "Inspect and finish",
    acceptanceCriteria: [],
    mode: "auto",
    status: "grant_pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    policyHashes: { organization: "a".repeat(64), repository: "b".repeat(64), grant: "c".repeat(64) },
    budgetLimits: { ...DEFAULT_BUDGET_LIMITS, maxElapsedMs: 9_999_999_999_999 },
    budgetUsage: zeroBudgetUsage(),
    turnSequence: 0,
    mutationSequence: 0,
    pendingOperations: [],
    completedOperationIds: [],
    mutations: [],
    validations: [],
    protocolRepairStreak: 0,
  };
}

test("runtime completes a multi-turn autonomous tool loop", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const clock = { now: () => new Date("2026-01-01T00:01:00.000Z") };
  const transport = new QueueTransport([
    JSON.stringify([
      {
        type: "tool_request",
        calls: [{ operationId: "op_list", name: "list_files", arguments: {} }],
      },
    ]),
    JSON.stringify([
      {
        type: "complete_task",
        operationId: "op_complete",
        claim: {
          summary: "Repository inspected.",
          acceptanceCriteria: [],
          validation: [],
          skippedValidation: [],
          remainingRisks: [],
          recommendedFollowUp: [],
        },
      },
    ]),
  ]);
  const tools: ToolExecutor = {
    execute: async (call) => ({
      operationId: call.operationId,
      tool: call.name,
      status: "success",
      data: { entries: ["src/index.ts"] },
      safeMetadata: { entryCount: 1, disclosedBytes: 12 },
    }),
      inspectCompletionState: async () => ({
        pathKey: completionPathKey,
        known: true,
      fingerprint: "d".repeat(64),
      excludedStateFingerprint: "0".repeat(64),
      hasConflicts: false,
      changedPaths: [],
      outOfScopePaths: [],
      gitStatusSummary: "clean",
    }),
  };
  const completionHandoffs = new CompletionHandoffStore(
    path.join(root, "handoff"),
    localState.sessionId,
    new SecretScanner(Buffer.alloc(32, 7)),
  );
  const runtime = new AgentRuntime({
    state: localState,
    store,
    journal: new OperationJournal(path.join(root, "operations"), localState.sessionId),
    audit: new AuditLog(path.join(root, "audit.jsonl"), localState.sessionId, clock),
    protocol,
    policy: {
      summarize: () => ({ mode: "auto" }),
      authorize: () => ({ outcome: "allow", reasonCode: "IN_GRANT", explanation: "Allowed" }),
      expandSessionGrant: async () => false,
    },
    tools,
    completionHandoffs,
    transport,
    disclosure: { inspectAndSerialize: async (message) => message },
    user: {
      requestInput: async () => ({ answer: "unused" }),
      requestCapability: async () => ({ decision: "deny" }),
    },
    completionRequirements: {
      requiredCommandIds: [],
      requireValidationAfterLastMutation: true,
      requireCleanPendingOperations: true,
    },
    clock,
    idFactory: (() => {
      let value = 0;
      return () => `submission_${++value}`;
    })(),
  });

  const result = await runtime.run();
  assert.equal(result.status, "completed", result.reason);
  assert.equal(localState.turnSequence, 2);
  assert.deepEqual(localState.completedOperationIds, ["op_list"]);
  assert.equal(localState.budgetUsage.disclosedBytes > 0, true);
  assert.equal(localState.completionHandoff !== undefined, true);
  const durableHandoff = await completionHandoffs.read(localState.completionHandoff);
  assert.equal(durableHandoff.claim.summary, "Repository inspected.");
  assert.equal(durableHandoff.verification.accepted, true);
});

test("runtime sends protocol repair feedback and continues", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const validCompletion = JSON.stringify([
    {
      type: "complete_task",
      operationId: "op_complete",
      claim: {
        summary: "Finished after repair.",
        acceptanceCriteria: [],
        validation: [],
        skippedValidation: [],
        remainingRisks: [],
        recommendedFollowUp: [],
      },
    },
  ]);
  const runtime = new AgentRuntime({
    state: localState,
    store,
    journal: new OperationJournal(path.join(root, "operations"), localState.sessionId),
    audit: new AuditLog(path.join(root, "audit.jsonl"), localState.sessionId),
    protocol,
    policy: {
      summarize: () => ({}),
      authorize: () => ({ outcome: "allow", reasonCode: "OK", explanation: "ok" }),
      expandSessionGrant: async () => false,
    },
    tools: {
      execute: async () => { throw new Error("unused"); },
      inspectCompletionState: async () => ({ pathKey: completionPathKey, known: true, fingerprint: "d".repeat(64), excludedStateFingerprint: "0".repeat(64), hasConflicts: false, changedPaths: [], outOfScopePaths: [], gitStatusSummary: "clean" }),
    },
    transport: new QueueTransport(["not-json", validCompletion]),
    disclosure: { inspectAndSerialize: async (message) => message },
    user: {
      requestInput: async () => ({}),
      requestCapability: async () => ({ decision: "deny" }),
    },
    completionRequirements: { requiredCommandIds: [], requireValidationAfterLastMutation: true, requireCleanPendingOperations: true },
    clock: { now: () => new Date("2026-01-01T00:01:00.000Z") },
    idFactory: (() => { let value = 0; return () => `submission_${++value}`; })(),
  });

  const result = await runtime.run();
  assert.equal(result.status, "completed");
  assert.equal(localState.budgetUsage.protocolRepairs, 1);
});

test("runtime fails closed without retrying a non-repairable protocol violation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-non-repairable-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new QueueTransport(["untrusted response"]);
  const nonRepairableProtocol: ProtocolAdapter = {
    ...protocol,
    parseModelTurn: () => {
      throw new ProtocolParseError("TASK_MISMATCH", "response belongs to another task", {}, false);
    },
  };
  const runtime = new AgentRuntime({
    state: localState,
    store,
    journal: new OperationJournal(path.join(root, "operations"), localState.sessionId),
    audit: new AuditLog(path.join(root, "audit.jsonl"), localState.sessionId),
    protocol: nonRepairableProtocol,
    policy: {
      summarize: () => ({}),
      authorize: () => ({ outcome: "allow", reasonCode: "OK", explanation: "ok" }),
      expandSessionGrant: async () => false,
    },
    tools: {
      execute: async () => { throw new Error("unused"); },
      inspectCompletionState: async () => ({ pathKey: completionPathKey, known: false, fingerprint: "x", excludedStateFingerprint: "0".repeat(64), hasConflicts: false, changedPaths: [], outOfScopePaths: [], gitStatusSummary: "unknown" }),
    },
    transport,
    disclosure: { inspectAndSerialize: async (message) => message },
    user: { requestInput: async () => ({}), requestCapability: async () => ({ decision: "deny" }) },
    completionRequirements: { requiredCommandIds: [], requireValidationAfterLastMutation: true, requireCleanPendingOperations: true },
    clock: { now: () => new Date("2026-01-01T00:01:00.000Z") },
    idFactory: () => "submission_1",
  });

  const result = await runtime.run();
  assert.equal(result.status, "failed");
  assert.match(result.reason ?? "", /Non-repairable protocol violation/u);
  assert.equal(transport.submittedContents.length, 1, "must not submit repair feedback");
  assert.equal(localState.budgetUsage.protocolRepairs, 0);
});

test("user-requested pause wins when transport reports cancellation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-pause-race-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new CancelledOnStopTransport();
  const runtime = new AgentRuntime({
    state: localState,
    store,
    journal: new OperationJournal(path.join(root, "operations"), localState.sessionId),
    audit: new AuditLog(path.join(root, "audit.jsonl"), localState.sessionId),
    protocol,
    policy: {
      summarize: () => ({}),
      authorize: () => ({ outcome: "allow", reasonCode: "OK", explanation: "ok" }),
      expandSessionGrant: async () => false,
    },
    tools: {
      execute: async () => { throw new Error("unused"); },
      inspectCompletionState: async () => ({ pathKey: completionPathKey, known: false, fingerprint: "x", excludedStateFingerprint: "0".repeat(64), hasConflicts: false, changedPaths: [], outOfScopePaths: [], gitStatusSummary: "unknown" }),
    },
    transport,
    disclosure: { inspectAndSerialize: async (message) => message },
    user: { requestInput: async () => ({}), requestCapability: async () => ({ decision: "deny" }) },
    completionRequirements: { requiredCommandIds: [], requireValidationAfterLastMutation: true, requireCleanPendingOperations: true },
    clock: { now: () => new Date("2026-01-01T00:01:00.000Z") },
    idFactory: () => "submission_1",
  });

  const run = runtime.run();
  await transport.receiveStarted;
  await runtime.requestPause("operator pause");
  const result = await run;
  assert.equal(result.status, "paused");
  assert.equal(result.reason, "operator pause");
});

test("runtime resumes from an integrity-checked cached model response without resubmitting", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-recovery-"));
  const localState = state(root);
  localState.status = "paused";
  localState.pauseReason = "process restarted";
  localState.turnSequence = 1;
  localState.submission = {
    submissionId: "submission_1",
    turnId: "turn_0001",
    messageHash: "a".repeat(64),
    marker: "marker",
    state: "answered",
    preparedAt: "2026-01-01T00:00:00.000Z",
    submittedAt: "2026-01-01T00:00:01.000Z",
    answeredAt: "2026-01-01T00:00:02.000Z",
  };
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  await artifacts.put("response", "turn_0001", JSON.stringify([
    {
      type: "complete_task",
      operationId: "op_complete",
      claim: {
        summary: "Recovered and complete.",
        acceptanceCriteria: [],
        validation: [],
        skippedValidation: [],
        remainingRisks: [],
        recommendedFollowUp: [],
      },
    },
  ]));

  const runtime = new AgentRuntime({
    state: localState,
    store,
    journal: new OperationJournal(path.join(root, "operations"), localState.sessionId),
    audit: new AuditLog(path.join(root, "audit.jsonl"), localState.sessionId),
    protocol,
    policy: {
      summarize: () => ({}),
      authorize: () => ({ outcome: "allow", reasonCode: "OK", explanation: "ok" }),
      expandSessionGrant: async () => false,
    },
    tools: {
      execute: async () => { throw new Error("unused"); },
      inspectCompletionState: async () => ({ pathKey: completionPathKey, known: true, fingerprint: "d".repeat(64), excludedStateFingerprint: "0".repeat(64), hasConflicts: false, changedPaths: [], outOfScopePaths: [], gitStatusSummary: "clean" }),
    },
    transport: new QueueTransport([]),
    disclosure: { inspectAndSerialize: async (message) => message },
    user: {
      requestInput: async () => ({}),
      requestCapability: async () => ({ decision: "deny" }),
    },
    completionRequirements: { requiredCommandIds: [], requireValidationAfterLastMutation: true, requireCleanPendingOperations: true },
    clock: { now: () => new Date("2026-01-01T00:01:00.000Z") },
    artifacts,
  });

  const result = await runtime.run();
  assert.equal(result.status, "completed");
  assert.equal(result.modelSummary, "Recovered and complete.");
  assert.equal(localState.turnSequence, 1);
  await assert.rejects(() => artifacts.get("response", "turn_0001"));
});

test("runtime pauses instead of replaying an indeterminate mutation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-indeterminate-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const journal = new OperationJournal(path.join(root, "operations"), localState.sessionId);
  const runtime = new AgentRuntime({
    state: localState,
    store,
    journal,
    audit: new AuditLog(path.join(root, "audit.jsonl"), localState.sessionId),
    protocol,
    policy: {
      summarize: () => ({}),
      authorize: () => ({ outcome: "allow", reasonCode: "OK", explanation: "ok" }),
      expandSessionGrant: async () => false,
    },
    tools: {
      execute: async (call) => ({
        operationId: call.operationId,
        tool: call.name,
        status: "indeterminate",
        data: { code: "RECOVERY_REQUIRED" },
        safeMetadata: { diagnosticCode: "MUTATION_OUTCOME_UNKNOWN" },
      }),
      inspectCompletionState: async () => ({ pathKey: completionPathKey, known: false, fingerprint: "x", excludedStateFingerprint: "0".repeat(64), hasConflicts: false, changedPaths: [], outOfScopePaths: [], gitStatusSummary: "unknown" }),
    },
    transport: new QueueTransport([JSON.stringify([{
      type: "tool_request",
      calls: [{ operationId: "op_mutate", name: "apply_patch", arguments: { changes: [] } }],
    }])]),
    disclosure: { inspectAndSerialize: async (message) => message },
    user: {
      requestInput: async () => ({}),
      requestCapability: async () => ({ decision: "deny" }),
    },
    completionRequirements: { requiredCommandIds: [], requireValidationAfterLastMutation: true, requireCleanPendingOperations: true },
    clock: { now: () => new Date("2026-01-01T00:01:00.000Z") },
    idFactory: () => "submission_1",
  });

  const result = await runtime.run();
  assert.equal(result.status, "paused");
  assert.match(result.reason ?? "", /rollback or reconciliation/);
  assert.equal(localState.pendingOperations[0]?.status, "indeterminate");
  assert.equal((await journal.read("op_mutate")).status, "indeterminate");
});

test("runtime replays a completed journal record while recovering an interrupted tool turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-tool-replay-"));
  const localState = state(root);
  localState.status = "executing_tools";
  localState.turnSequence = 1;
  localState.submission = {
    submissionId: "submission_1",
    turnId: "turn_0001",
    messageHash: "a".repeat(64),
    marker: "marker",
    state: "answered",
    preparedAt: "2026-01-01T00:00:00.000Z",
    answeredAt: "2026-01-01T00:00:02.000Z",
  };
  const call = { operationId: "op_list", name: "list_files" as const, arguments: {} };
  const store = new SessionStore(path.join(root, "state"));
  const journal = new OperationJournal(path.join(root, "operations"), localState.sessionId);
  const registered = await journal.register("op_list", "list_files", false, call, "2026-01-01T00:00:00.000Z");
  const executing = await journal.markExecuting(registered.record, "2026-01-01T00:00:01.000Z");
  const completed = await journal.markCompleted(executing, "2026-01-01T00:00:02.000Z", "success", { entryCount: 1 });
  localState.pendingOperations = [];
  localState.completedOperationIds = ["op_list"];
  await store.create(localState);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  await artifacts.put("response", "turn_0001", JSON.stringify([{ type: "tool_request", calls: [call] }]));
  let unexpectedExecutions = 0;
  const runtime = new AgentRuntime({
    state: localState,
    store,
    journal,
    audit: new AuditLog(path.join(root, "audit.jsonl"), localState.sessionId),
    protocol,
    policy: {
      summarize: () => ({}),
      authorize: () => ({ outcome: "allow", reasonCode: "OK", explanation: "ok" }),
      expandSessionGrant: async () => false,
    },
    tools: {
      execute: async () => { unexpectedExecutions += 1; throw new Error("must not execute"); },
      inspectCompletionState: async () => ({ pathKey: completionPathKey, known: true, fingerprint: "d".repeat(64), excludedStateFingerprint: "0".repeat(64), hasConflicts: false, changedPaths: [], outOfScopePaths: [], gitStatusSummary: "clean" }),
    },
    transport: new QueueTransport([JSON.stringify([{
      type: "complete_task",
      operationId: "op_complete",
      claim: {
        summary: "Recovered safely.",
        acceptanceCriteria: [],
        validation: [],
        skippedValidation: [],
        remainingRisks: [],
        recommendedFollowUp: [],
      },
    }])]),
    disclosure: { inspectAndSerialize: async (message) => message },
    user: {
      requestInput: async () => ({}),
      requestCapability: async () => ({ decision: "deny" }),
    },
    completionRequirements: { requiredCommandIds: [], requireValidationAfterLastMutation: true, requireCleanPendingOperations: true },
    clock: { now: () => new Date("2026-01-01T00:01:00.000Z") },
    idFactory: () => "submission_2",
    artifacts,
  });

  const result = await runtime.run();
  assert.equal(result.status, "completed", result.reason);
  assert.equal(unexpectedExecutions, 0);
  assert.equal(localState.pendingOperations.length, 0);
});

test("completed mutation replay idempotently restores durable session effects without re-execution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-mutation-effects-"));
  const localState = state(root);
  localState.status = "executing_tools";
  localState.turnSequence = 1;
  localState.submission = {
    submissionId: "submission_1",
    turnId: "turn_0001",
    messageHash: "a".repeat(64),
    marker: "marker",
    state: "answered",
    preparedAt: "2026-01-01T00:00:00.000Z",
    answeredAt: "2026-01-01T00:00:02.000Z",
  };
  const call = {
    operationId: "op_mutate",
    name: "apply_patch" as const,
    arguments: { changes: [{ path: "src/index.ts", content: "export const value = 2;\n" }] },
  };
  const store = new SessionStore(path.join(root, "state"));
  const journal = new OperationJournal(path.join(root, "operations"), localState.sessionId);
  const registered = await journal.register(call.operationId, call.name, true, call, "2026-01-01T00:00:00.000Z");
  const executing = await journal.markExecuting(registered.record, "2026-01-01T00:00:01.000Z");
  await journal.markCompleted(executing, "2026-01-01T00:00:02.000Z", "success", {
    changedFileCount: 1,
    changedLines: 2,
    checkpointId: "checkpoint_12345678",
    changedPaths: ["src/index.ts"],
    repositoryFingerprint: "d".repeat(64),
  });
  await store.create(localState);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  await artifacts.put("response", "turn_0001", JSON.stringify([{ type: "tool_request", calls: [call] }]));
  let unexpectedExecutions = 0;
  const runtime = new AgentRuntime({
    state: localState,
    store,
    journal,
    audit: new AuditLog(path.join(root, "audit.jsonl"), localState.sessionId),
    protocol,
    policy: {
      summarize: () => ({}),
      authorize: () => ({ outcome: "allow", reasonCode: "OK", explanation: "ok" }),
      expandSessionGrant: async () => false,
    },
    tools: {
      execute: async () => { unexpectedExecutions += 1; throw new Error("must not execute"); },
      inspectCompletionState: async () => ({
        pathKey: completionPathKey,
        known: true,
        fingerprint: "d".repeat(64),
        excludedStateFingerprint: "0".repeat(64),
        hasConflicts: false,
        changedPaths: ["src/index.ts"],
        outOfScopePaths: [],
        gitStatusSummary: "1 changed path",
      }),
    },
    transport: new QueueTransport([JSON.stringify([{
      type: "complete_task",
      operationId: "op_complete",
      claim: {
        summary: "Recovered mutation effects.",
        acceptanceCriteria: [],
        validation: [],
        skippedValidation: [],
        remainingRisks: [],
        recommendedFollowUp: [],
      },
    }])]),
    disclosure: { inspectAndSerialize: async (message) => message },
    user: {
      requestInput: async () => ({}),
      requestCapability: async () => ({ decision: "deny" }),
    },
    completionRequirements: {
      requiredCommandIds: [],
      requireValidationAfterLastMutation: true,
      requireCleanPendingOperations: true,
    },
    clock: { now: () => new Date("2026-01-01T00:01:00.000Z") },
    idFactory: () => "submission_2",
    artifacts,
  });

  const result = await runtime.run();
  assert.equal(result.status, "completed");
  assert.equal(unexpectedExecutions, 0);
  assert.equal(localState.mutationSequence, 1);
  assert.equal(localState.mutations.length, 1);
  assert.equal(localState.mutations[0]?.checkpointId, "checkpoint_12345678");
  assert.equal(localState.lastCheckpointId, "checkpoint_12345678");
  assert.equal(localState.budgetUsage.operations, 1);
  assert.equal(localState.budgetUsage.changedFiles, 1);
  assert.equal(localState.budgetUsage.changedLines, 2);
  assert.deepEqual(localState.completedOperationIds, ["op_mutate"]);
});

test("completed command replay restores validation evidence used by completion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-command-effects-"));
  const localState = state(root);
  localState.status = "executing_tools";
  localState.turnSequence = 1;
  localState.submission = {
    submissionId: "submission_1",
    turnId: "turn_0001",
    messageHash: "a".repeat(64),
    marker: "marker",
    state: "answered",
    preparedAt: "2026-01-01T00:00:00.000Z",
    answeredAt: "2026-01-01T00:00:02.000Z",
  };
  const call = { operationId: "op_validate", name: "run_command" as const, arguments: { commandId: "test" } };
  const store = new SessionStore(path.join(root, "state"));
  const journal = new OperationJournal(path.join(root, "operations"), localState.sessionId);
  const registered = await journal.register(call.operationId, call.name, true, call, "2026-01-01T00:00:00.000Z");
  const executing = await journal.markExecuting(registered.record, "2026-01-01T00:00:01.000Z");
  await journal.markCompleted(executing, "2026-01-01T00:00:02.000Z", "success", {
    commandId: "test",
    outcome: "success",
    exitCode: 0,
    outputBytes: 17,
    repositoryFingerprint: "e".repeat(64),
  });
  await store.create(localState);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  await artifacts.put("response", "turn_0001", JSON.stringify([{ type: "tool_request", calls: [call] }]));
  let unexpectedExecutions = 0;
  const runtime = new AgentRuntime({
    state: localState,
    store,
    journal,
    audit: new AuditLog(path.join(root, "audit.jsonl"), localState.sessionId),
    protocol,
    policy: {
      summarize: () => ({}),
      authorize: () => ({ outcome: "allow", reasonCode: "OK", explanation: "ok" }),
      expandSessionGrant: async () => false,
    },
    tools: {
      execute: async () => { unexpectedExecutions += 1; throw new Error("must not execute"); },
      inspectCompletionState: async () => ({
        pathKey: completionPathKey,
        known: true,
        fingerprint: "e".repeat(64),
        excludedStateFingerprint: "0".repeat(64),
        hasConflicts: false,
        changedPaths: [],
        outOfScopePaths: [],
        gitStatusSummary: "clean",
      }),
    },
    transport: new QueueTransport([JSON.stringify([{
      type: "complete_task",
      operationId: "op_complete",
      claim: {
        summary: "Recovered validation evidence.",
        acceptanceCriteria: [],
        validation: [{ commandId: "test", status: "passed", summary: "exit code 0" }],
        skippedValidation: [],
        remainingRisks: [],
        recommendedFollowUp: [],
      },
    }])]),
    disclosure: { inspectAndSerialize: async (message) => message },
    user: {
      requestInput: async () => ({}),
      requestCapability: async () => ({ decision: "deny" }),
    },
    completionRequirements: {
      requiredCommandIds: ["test"],
      requireValidationAfterLastMutation: true,
      requireCleanPendingOperations: true,
    },
    clock: { now: () => new Date("2026-01-01T00:01:00.000Z") },
    idFactory: () => "submission_2",
    artifacts,
  });

  const result = await runtime.run();
  assert.equal(result.status, "completed", result.reason);
  assert.equal(unexpectedExecutions, 0);
  assert.equal(localState.validations.length, 1);
  assert.equal(localState.validations[0]?.commandId, "test");
  assert.equal(localState.validations[0]?.outcome, "success");
  assert.equal(localState.validations[0]?.mutationSequence, 0);
  assert.equal(localState.validations[0]?.repositoryFingerprint, "e".repeat(64));
  assert.equal(localState.budgetUsage.operations, 1);
  assert.equal(localState.budgetUsage.commandOutputBytes, 17);
  assert.deepEqual(localState.completedOperationIds, ["op_validate"]);
});

test("completed user decision is replayed from an integrity-checked artifact without reprompting", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-user-decision-"));
  const localState = state(root);
  localState.status = "awaiting_user";
  localState.turnSequence = 1;
  localState.submission = {
    submissionId: "submission_1",
    turnId: "turn_0001",
    messageHash: "a".repeat(64),
    marker: "marker",
    state: "answered",
    preparedAt: "2026-01-01T00:00:00.000Z",
    answeredAt: "2026-01-01T00:00:02.000Z",
  };
  const action = {
    type: "request_user_input" as const,
    requestId: "request_info",
    question: "Which supported target?",
    choices: ["one", "two"],
  };
  const store = new SessionStore(path.join(root, "state"));
  const journal = new OperationJournal(path.join(root, "operations"), localState.sessionId);
  const registered = await journal.register(
    action.requestId,
    "request_user_input",
    false,
    action,
    "2026-01-01T00:00:00.000Z",
  );
  const executing = await journal.markExecuting(registered.record, "2026-01-01T00:00:01.000Z");
  await journal.markCompleted(executing, "2026-01-01T00:00:02.000Z", "answered", {
    decisionHash: sha256(stableJson({ answer: "two" })),
  });
  await store.create(localState);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  await artifacts.put("response", "turn_0001", JSON.stringify([action]));
  await artifacts.put("decision", "decision_request_info", JSON.stringify({ answer: "two" }));
  let prompts = 0;
  const runtime = new AgentRuntime({
    state: localState,
    store,
    journal,
    audit: new AuditLog(path.join(root, "audit.jsonl"), localState.sessionId),
    protocol,
    policy: {
      summarize: () => ({}),
      authorize: () => ({ outcome: "allow", reasonCode: "OK", explanation: "ok" }),
      expandSessionGrant: async () => false,
    },
    tools: {
      execute: async () => { throw new Error("unused"); },
      inspectCompletionState: async () => ({
        pathKey: completionPathKey,
        known: true,
        fingerprint: "d".repeat(64),
        excludedStateFingerprint: "0".repeat(64),
        hasConflicts: false,
        changedPaths: [],
        outOfScopePaths: [],
        gitStatusSummary: "clean",
      }),
    },
    transport: new QueueTransport([JSON.stringify([{
      type: "complete_task",
      operationId: "op_complete",
      claim: {
        summary: "Recovered user choice.",
        acceptanceCriteria: [],
        validation: [],
        skippedValidation: [],
        remainingRisks: [],
        recommendedFollowUp: [],
      },
    }])]),
    disclosure: { inspectAndSerialize: async (message) => message },
    user: {
      requestInput: async () => { prompts += 1; return { answer: "unexpected" }; },
      requestCapability: async () => ({ decision: "deny" }),
    },
    completionRequirements: {
      requiredCommandIds: [],
      requireValidationAfterLastMutation: true,
      requireCleanPendingOperations: true,
    },
    clock: { now: () => new Date("2026-01-01T00:01:00.000Z") },
    idFactory: () => "submission_2",
    artifacts,
  });

  const result = await runtime.run();
  assert.equal(result.status, "completed", result.reason);
  assert.equal(prompts, 0);
  assert.deepEqual(localState.completedOperationIds, ["request_info"]);
  assert.equal(localState.budgetUsage.operations, 1);
});

test("standalone allow_once capability decision is durable but not treated as unbound authority", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-capability-decision-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  const transport = new QueueTransport([
    JSON.stringify([{
      type: "request_capability",
      requestId: "cap_request",
      capability: { kind: "path", access: "write", paths: ["src/new.ts"] },
      reason: "Need one edit",
    }]),
    JSON.stringify([{
      type: "complete_task",
      operationId: "op_complete",
      claim: {
        summary: "Capability outcome handled.",
        acceptanceCriteria: [],
        validation: [],
        skippedValidation: [],
        remainingRisks: [],
        recommendedFollowUp: [],
      },
    }]),
  ]);
  let prompts = 0;
  let expansions = 0;
  const runtime = new AgentRuntime({
    state: localState,
    store,
    journal: new OperationJournal(path.join(root, "operations"), localState.sessionId),
    audit: new AuditLog(path.join(root, "audit.jsonl"), localState.sessionId),
    protocol,
    policy: {
      summarize: () => ({}),
      authorize: () => ({ outcome: "allow", reasonCode: "OK", explanation: "ok" }),
      expandSessionGrant: async () => { expansions += 1; return true; },
    },
    tools: {
      execute: async () => { throw new Error("unused"); },
      inspectCompletionState: async () => ({
        pathKey: completionPathKey,
        known: true,
        fingerprint: "d".repeat(64),
        excludedStateFingerprint: "0".repeat(64),
        hasConflicts: false,
        changedPaths: [],
        outOfScopePaths: [],
        gitStatusSummary: "clean",
      }),
    },
    transport,
    disclosure: { inspectAndSerialize: async (message) => message },
    user: {
      requestInput: async () => ({}),
      requestCapability: async () => { prompts += 1; return { decision: "allow_once" }; },
    },
    completionRequirements: {
      requiredCommandIds: [],
      requireValidationAfterLastMutation: true,
      requireCleanPendingOperations: true,
    },
    clock: { now: () => new Date("2026-01-01T00:01:00.000Z") },
    idFactory: (() => { let value = 0; return () => `submission_${++value}`; })(),
    artifacts,
  });

  const result = await runtime.run();
  assert.equal(result.status, "completed", result.reason);
  assert.equal(prompts, 1);
  assert.equal(expansions, 0);
  assert.deepEqual(localState.completedOperationIds, ["cap_request"]);
  const renderedDecision = JSON.parse(transport.submittedContents[1] ?? "{}") as {
    readonly decision?: { readonly effective?: boolean; readonly reasonCode?: string };
  };
  assert.equal(renderedDecision.decision?.effective, false);
  assert.equal(renderedDecision.decision?.reasonCode, "ALLOW_ONCE_REQUIRES_EXACT_OPERATION");
});

test("caller stop signal leaves a resumable paused session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-pause-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const controller = new AbortController();
  controller.abort("operator pause");
  const runtime = new AgentRuntime({
    state: localState,
    store,
    journal: new OperationJournal(path.join(root, "operations"), localState.sessionId),
    audit: new AuditLog(path.join(root, "audit.jsonl"), localState.sessionId),
    protocol,
    policy: {
      summarize: () => ({}),
      authorize: () => ({ outcome: "allow", reasonCode: "OK", explanation: "ok" }),
      expandSessionGrant: async () => false,
    },
    tools: {
      execute: async () => { throw new Error("unused"); },
      inspectCompletionState: async () => ({ pathKey: completionPathKey, known: false, fingerprint: "x", excludedStateFingerprint: "0".repeat(64), hasConflicts: false, changedPaths: [], outOfScopePaths: [], gitStatusSummary: "unknown" }),
    },
    transport: new QueueTransport([]),
    disclosure: { inspectAndSerialize: async (message) => message },
    user: {
      requestInput: async () => ({}),
      requestCapability: async () => ({ decision: "deny" }),
    },
    completionRequirements: { requiredCommandIds: [], requireValidationAfterLastMutation: true, requireCleanPendingOperations: true },
    clock: { now: () => new Date("2026-01-01T00:01:00.000Z") },
    signal: controller.signal,
  });

  const result = await runtime.run();
  assert.equal(result.status, "paused");
  assert.equal(result.reason, "operator pause");
});
