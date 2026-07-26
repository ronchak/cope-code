import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AuditLog } from "../../src/audit/audit-log.js";
import { LOCAL_TOOL_NAMES, TOOL_REGISTRY } from "../../src/protocol/index.js";
import { sha256, stableJson } from "../../src/shared/crypto.js";
import { AgentRuntime } from "../../src/orchestrator/agent-runtime.js";
import { CbaProtocolAdapter } from "../../src/orchestrator/cba-protocol-adapter.js";
import type {
  CompletionClaim,
  CompletionVerification,
} from "../../src/orchestrator/completion.js";
import { ProtocolParseError } from "../../src/protocol/parser.js";
import { serializeProtocolEnvelope } from "../../src/protocol/index.js";
import type {
  DisclosureGuard,
  NormalizedModelMessage,
  ParsedModelTurn,
  ProtocolAdapter,
  RuntimePolicy,
  ToolExecutor,
  UserInteraction,
} from "../../src/orchestrator/contracts.js";
import { OperationJournal } from "../../src/session/operation-journal.js";
import { SessionArtifactStore } from "../../src/session/artifact-store.js";
import {
  CompletionHandoffStore,
  type CompletionHandoffReference,
} from "../../src/session/completion-handoff-store.js";
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
  type SubmissionReceipt,
  type SubmissionRequest,
} from "../../src/transport/model-transport.js";

const completionPathKey = (value: string): string => value.replaceAll("\\", "/");

class QueueTransport implements ModelTransport {
  public readonly transportKind = "test";
  public readonly submittedContents: string[] = [];
  public closeCalls = 0;
  public constructor(private readonly responses: readonly string[]) {}
  private index = 0;

  public async submit(request: SubmissionRequest): Promise<SubmissionReceipt> {
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
  public async close() {
    this.closeCalls += 1;
  }
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

class CompletedOnStopTransport extends QueueTransport {
  private markReceiveStarted!: () => void;
  private finishReceive!: () => void;
  public readonly receiveStarted = new Promise<void>((resolve) => { this.markReceiveStarted = resolve; });
  private readonly stopped = new Promise<void>((resolve) => { this.finishReceive = resolve; });

  public constructor(private readonly content: string) {
    super([]);
  }

  public override async receive(request: ReceiveRequest): Promise<ReceiveResult> {
    this.markReceiveStarted();
    await this.stopped;
    return {
      contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
      taskId: request.taskId,
      turnId: request.turnId,
      submissionId: request.submissionId,
      observedAt: "2026-01-01T00:00:00.000Z",
      conversationId: "conversation_1",
      status: "completed",
      responseId: "response_completed_during_pause",
      content: this.content,
    };
  }

  public override async emergencyStop() {
    this.finishReceive();
  }
}

class RecoveredPrefixTransport extends QueueTransport {
  public override async receive(request: ReceiveRequest): Promise<ReceiveResult> {
    const result = await super.receive(request);
    return result.status === "completed"
      ? { ...result, responseId: "recovered_untrusted_transport_value" }
      : result;
  }
}

class MismatchedReceiptTransport extends QueueTransport {
  public receiveCalls = 0;

  public override async submit(request: SubmissionRequest) {
    const receipt = await super.submit(request);
    return { ...receipt, turnId: "turn_wrong" };
  }

  public override async receive(request: ReceiveRequest): Promise<ReceiveResult> {
    this.receiveCalls += 1;
    return super.receive(request);
  }
}

class MismatchedResultTransport extends QueueTransport {
  public override async receive(request: ReceiveRequest): Promise<ReceiveResult> {
    const result = await super.receive(request);
    return { ...result, submissionId: "submission_wrong" };
  }
}

class MissingConversationReceiptTransport extends QueueTransport {
  public receiveCalls = 0;

  public override async submit(request: SubmissionRequest) {
    const receipt = await super.submit(request);
    const { conversationId: _conversationId, ...withoutConversation } = receipt;
    return withoutConversation;
  }

  public override async receive(request: ReceiveRequest): Promise<ReceiveResult> {
    this.receiveCalls += 1;
    return super.receive(request);
  }
}

class MissingConversationResultTransport extends QueueTransport {
  public override async receive(request: ReceiveRequest): Promise<ReceiveResult> {
    const result = await super.receive(request);
    if (result.status !== "completed") return result;
    const { conversationId: _conversationId, ...withoutConversation } = result;
    return withoutConversation;
  }
}

class UntrustedConversationResultTransport extends QueueTransport {
  public override async submit(request: SubmissionRequest) {
    const receipt = await super.submit(request);
    const { conversationId: _conversationId, ...withoutConversation } = receipt;
    return withoutConversation;
  }

  public override async receive(request: ReceiveRequest): Promise<ReceiveResult> {
    return {
      contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
      taskId: request.taskId,
      turnId: request.turnId,
      submissionId: request.submissionId,
      observedAt: "2026-01-01T00:00:00.000Z",
      conversationId: "conversation_untrusted",
      status: "indeterminate",
      diagnosticCode: "CONVERSATION_CHANGED_DURING_RESPONSE",
    };
  }
}

class TerminalBlockedTransport extends QueueTransport {
  public override async receive(request: ReceiveRequest): Promise<ReceiveResult> {
    return {
      contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
      taskId: request.taskId,
      turnId: request.turnId,
      submissionId: request.submissionId,
      observedAt: "2026-01-01T00:00:00.000Z",
      status: "blocked",
      reason: "service-error",
      retryable: false,
      diagnosticCode: "TERMINAL_TEST_BLOCK",
    };
  }
}

class StaleReceiptConversationTransport extends QueueTransport {
  public readonly receiveExpectedConversationIds: Array<string | undefined> = [];
  public resolveCalls = 0;

  public override async submit(request: SubmissionRequest) {
    const receipt = await super.submit(request);
    return { ...receipt, conversationId: "conversation_stale_receipt" };
  }

  public override async resolveSubmission(request: ReceiveRequest) {
    this.resolveCalls += 1;
    const receipt = await super.resolveSubmission(request);
    return { ...receipt, conversationId: "conversation_stale_receipt" };
  }

  public override async receive(request: ReceiveRequest): Promise<ReceiveResult> {
    this.receiveExpectedConversationIds.push(request.expectedConversationId);
    return super.receive(request);
  }
}

class CompletionWriteGateStore extends SessionStore {
  private completionWriteSeen = false;
  private markCompletionWriteStarted!: () => void;
  private finishCompletionWrite!: () => void;
  public readonly completionWriteStarted = new Promise<void>((resolve) => {
    this.markCompletionWriteStarted = resolve;
  });
  private readonly completionWriteReleased = new Promise<void>((resolve) => {
    this.finishCompletionWrite = resolve;
  });

  public releaseCompletionWrite(): void {
    this.finishCompletionWrite();
  }

  public override async write(session: SessionState): Promise<void> {
    if (session.status === "completed" && !this.completionWriteSeen) {
      this.completionWriteSeen = true;
      this.markCompletionWriteStarted();
      await this.completionWriteReleased;
    }
    await super.write(session);
  }
}

class FailingCompletionWriteStore extends SessionStore {
  public completionWriteAttempts = 0;

  public override async write(session: SessionState): Promise<void> {
    if (session.status === "completed" && this.completionWriteAttempts === 0) {
      this.completionWriteAttempts += 1;
      throw new Error("completion state write failed");
    }
    await super.write(session);
  }
}

class FailingFailureWriteStore extends SessionStore {
  public failureWriteAttempts = 0;

  public override async write(session: SessionState): Promise<void> {
    if (session.status === "failed") {
      this.failureWriteAttempts += 1;
      throw new Error("failure state write failed");
    }
    await super.write(session);
  }
}

class CompletionHandoffSaveGateStore extends CompletionHandoffStore {
  public saveCalls = 0;
  private markFirstSaveCompleted!: () => void;
  private finishFirstSave!: () => void;
  public readonly firstSaveCompleted = new Promise<void>((resolve) => {
    this.markFirstSaveCompleted = resolve;
  });
  private readonly firstSaveReleased = new Promise<void>((resolve) => {
    this.finishFirstSave = resolve;
  });

  public releaseFirstSave(): void {
    this.finishFirstSave();
  }

  public override async save(
    claim: CompletionClaim,
    verification: CompletionVerification,
    _createdAt?: string,
  ): Promise<CompletionHandoffReference> {
    this.saveCalls += 1;
    const reference = await super.save(
      claim,
      verification,
      `2026-01-01T00:0${this.saveCalls}:00.000Z`,
    );
    if (this.saveCalls === 1) {
      this.markFirstSaveCompleted();
      await this.firstSaveReleased;
    }
    return reference;
  }
}

class PauseWriteGateStore extends SessionStore {
  private pauseWriteSeen = false;
  private markPauseWriteStarted!: () => void;
  private finishPauseWrite!: () => void;
  public readonly pauseWriteStarted = new Promise<void>((resolve) => {
    this.markPauseWriteStarted = resolve;
  });
  private readonly pauseWriteReleased = new Promise<void>((resolve) => {
    this.finishPauseWrite = resolve;
  });

  public releasePauseWrite(): void {
    this.finishPauseWrite();
  }

  public override async write(session: SessionState): Promise<void> {
    if (session.status === "paused" && !this.pauseWriteSeen) {
      this.pauseWriteSeen = true;
      this.markPauseWriteStarted();
      await this.pauseWriteReleased;
    }
    await super.write(session);
  }
}

class ToolExecutionWriteGateStore extends SessionStore {
  private executingWriteSeen = false;
  private markExecutingWriteStarted!: () => void;
  private finishExecutingWrite!: () => void;
  public readonly executingWriteStarted = new Promise<void>((resolve) => {
    this.markExecutingWriteStarted = resolve;
  });
  private readonly executingWriteReleased = new Promise<void>((resolve) => {
    this.finishExecutingWrite = resolve;
  });

  public releaseExecutingWrite(): void {
    this.finishExecutingWrite();
  }

  public override async write(session: SessionState): Promise<void> {
    if (
      !this.executingWriteSeen &&
      session.pendingOperations.some((operation) => operation.status === "executing")
    ) {
      this.executingWriteSeen = true;
      this.markExecutingWriteStarted();
      await this.executingWriteReleased;
    }
    await super.write(session);
  }
}

class RecoveryProbeTransport extends QueueTransport {
  public resolveCalls = 0;

  public override async resolveSubmission(request: ReceiveRequest) {
    this.resolveCalls += 1;
    return super.resolveSubmission(request);
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

function runtimeForTest(input: {
  readonly root: string;
  readonly state: SessionState;
  readonly store: SessionStore;
  readonly transport: ModelTransport;
  readonly protocol?: ProtocolAdapter;
  readonly artifacts?: SessionArtifactStore;
  readonly completionHandoffs?: CompletionHandoffStore;
  readonly execute?: ToolExecutor["execute"];
  readonly inspectCompletionState?: ToolExecutor["inspectCompletionState"];
  readonly disclosure?: DisclosureGuard;
  readonly policy?: RuntimePolicy;
  readonly user?: UserInteraction;
  readonly idFactory?: (prefix: string) => string;
}): AgentRuntime {
  return new AgentRuntime({
    state: input.state,
    store: input.store,
    journal: new OperationJournal(path.join(input.root, "operations"), input.state.sessionId),
    audit: new AuditLog(path.join(input.root, "audit.jsonl"), input.state.sessionId),
    protocol: input.protocol ?? protocol,
    policy: input.policy ?? {
      summarize: () => ({}),
      authorize: () => ({ outcome: "allow", reasonCode: "OK", explanation: "ok" }),
      expandSessionGrant: async () => false,
    },
    tools: {
      execute: input.execute ?? (async () => { throw new Error("unused"); }),
      inspectCompletionState: input.inspectCompletionState ?? (async () => ({
        pathKey: completionPathKey,
        known: true,
        fingerprint: "d".repeat(64),
        excludedStateFingerprint: "0".repeat(64),
        hasConflicts: false,
        changedPaths: [],
        outOfScopePaths: [],
        gitStatusSummary: "clean",
      })),
    },
    transport: input.transport,
    disclosure: input.disclosure ?? { inspectAndSerialize: async (message) => message },
    user: input.user ?? {
      requestInput: async () => ({}),
      requestCapability: async () => ({ decision: "deny" }),
    },
    completionRequirements: {
      requiredCommandIds: [],
      requireValidationAfterLastMutation: true,
      requireCleanPendingOperations: true,
    },
    clock: { now: () => new Date("2026-01-01T00:01:00.000Z") },
    idFactory: input.idFactory ?? (() => "submission_1"),
    ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
    ...(input.completionHandoffs === undefined ? {} : { completionHandoffs: input.completionHandoffs }),
  });
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

test("runtime journals every local tool according to registry read-only metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-registry-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const journal = new OperationJournal(path.join(root, "operations"), localState.sessionId);
  const responses = [
    ...LOCAL_TOOL_NAMES.map((tool) => JSON.stringify([{
      type: "tool_request",
      calls: [{ operationId: `op_${tool}`, name: tool, arguments: {} }],
    }])),
    JSON.stringify([{
      type: "blocked",
      reason: "Registry classification test complete.",
      recoverable: false,
    }]),
  ];
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
        status: "failure",
        data: { code: "EXPECTED_TEST_FAILURE", message: "No tool side effect is needed." },
        safeMetadata: {},
      }),
      inspectCompletionState: async () => ({
        pathKey: completionPathKey,
        known: false,
        fingerprint: "unknown",
        excludedStateFingerprint: "0".repeat(64),
        hasConflicts: false,
        changedPaths: [],
        outOfScopePaths: [],
        gitStatusSummary: "unused",
      }),
    },
    transport: new QueueTransport(responses),
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
    idFactory: (() => {
      let value = 0;
      return () => `submission_registry_${++value}`;
    })(),
  });

  const result = await runtime.run();
  assert.equal(result.status, "blocked");
  for (const tool of LOCAL_TOOL_NAMES) {
    const record = await journal.read(`op_${tool}`);
    assert.equal(
      record.mutating,
      !TOOL_REGISTRY[tool].read_only,
      `${tool} journal mutation classification must match the registry`,
    );
  }
});

test("runtime independently enforces registry batchability before policy or execution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-batchability-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new QueueTransport([
    JSON.stringify([{
      type: "tool_request",
      calls: [
        { operationId: "op_batch_read", name: "list_files", arguments: {} },
        { operationId: "op_batch_patch", name: "apply_patch", arguments: {} },
      ],
    }]),
    JSON.stringify([{
      type: "blocked",
      reason: "Batchability test complete.",
      recoverable: false,
    }]),
  ]);
  let policyChecks = 0;
  let executions = 0;
  const runtime = new AgentRuntime({
    state: localState,
    store,
    journal: new OperationJournal(path.join(root, "operations"), localState.sessionId),
    audit: new AuditLog(path.join(root, "audit.jsonl"), localState.sessionId),
    protocol,
    policy: {
      summarize: () => ({}),
      authorize: () => {
        policyChecks += 1;
        return { outcome: "allow", reasonCode: "OK", explanation: "ok" };
      },
      expandSessionGrant: async () => false,
    },
    tools: {
      execute: async (call) => {
        executions += 1;
        return {
          operationId: call.operationId,
          tool: call.name,
          status: "success",
          data: {},
          safeMetadata: {},
        };
      },
      inspectCompletionState: async () => ({
        pathKey: completionPathKey,
        known: false,
        fingerprint: "unknown",
        excludedStateFingerprint: "0".repeat(64),
        hasConflicts: false,
        changedPaths: [],
        outOfScopePaths: [],
        gitStatusSummary: "unused",
      }),
    },
    transport,
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
    idFactory: (() => {
      let value = 0;
      return () => `submission_batch_${++value}`;
    })(),
  });

  const result = await runtime.run();
  assert.equal(result.status, "blocked");
  assert.equal(policyChecks, 0);
  assert.equal(executions, 0);
  const outcomes = JSON.parse(transport.submittedContents[1] ?? "[]") as ReadonlyArray<{
    readonly data?: { readonly code?: string };
  }>;
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes.every((outcome) => outcome.data?.code === "SEQUENCING_REQUIRED"), true);
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

test("runtime does not send or charge a repair after the protocol-repair budget is exhausted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-repair-budget-"));
  const localState = state(root);
  localState.budgetLimits = { ...localState.budgetLimits, maxProtocolRepairs: 1 };
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new QueueTransport(["first-invalid-response", "second-invalid-response"]);
  const runtime = runtimeForTest({ root, state: localState, store, transport });

  const result = await runtime.run();
  assert.equal(result.status, "failed");
  assert.match(result.reason ?? "", /exhausted the protocol-repair budget/u);
  assert.equal(transport.submittedContents.length, 2, "only bootstrap and one repair may be submitted");
  assert.equal(localState.budgetUsage.protocolRepairs, 1);
  assert.equal(localState.protocolRepairStreak, 1);
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
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  await artifacts.put("decision", "sentinel", "must be cleared on terminal failure");
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
    artifacts,
  });

  const result = await runtime.run();
  assert.equal(result.status, "failed");
  assert.match(result.reason ?? "", /Non-repairable protocol violation/u);
  assert.equal(transport.submittedContents.length, 1, "must not submit repair feedback");
  assert.equal(localState.budgetUsage.protocolRepairs, 0);
  assert.equal(await artifacts.getOptional("response", "turn_0001"), undefined);
  assert.equal(await artifacts.getOptional("decision", "sentinel"), undefined);
});

test("failed failure-state persistence preserves the recoverable response and lifecycle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-failure-write-failure-"));
  const localState = state(root);
  const handoffReference: CompletionHandoffReference = {
    version: "completion-handoff/1",
    integrity: "a".repeat(64),
    createdAt: "2026-01-01T00:00:30.000Z",
    redactionCount: 0,
  };
  localState.completionHandoff = handoffReference;
  const store = new FailingFailureWriteStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new QueueTransport(["untrusted response"]);
  const nonRepairableProtocol: ProtocolAdapter = {
    ...protocol,
    parseModelTurn: () => {
      throw new ProtocolParseError("TASK_MISMATCH", "response belongs to another task", {}, false);
    },
  };
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  const runtime = runtimeForTest({
    root,
    state: localState,
    store,
    transport,
    protocol: nonRepairableProtocol,
    artifacts,
  });

  await assert.rejects(() => runtime.run(), /failure state write failed/u);
  assert.equal(store.failureWriteAttempts, 1);
  assert.equal(transport.closeCalls, 1, "transport cleanup must still run");
  assert.equal(localState.status, "awaiting_model");
  assert.deepEqual(localState.completionHandoff, handoffReference);
  assert.match(await artifacts.get("response", "turn_0001"), /untrusted response/u);
  const durableState = await store.read(localState.sessionId);
  assert.equal(durableState.status, "awaiting_model");
  assert.deepEqual(durableState.completionHandoff, handoffReference);
  assert.equal(durableState.submission?.state, "answered");
});

test("a live transport cannot opt into recovery replay through its response id", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-untrusted-recovery-id-"));
  const localState = state(root);
  localState.completedOperationIds = ["op_used"];
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const response = serializeProtocolEnvelope({
    protocol: "cba/1",
    message_type: "tool_request",
    message_id: "msg_replayed",
    task_id: localState.taskId,
    turn_id: 1,
    operations: [{ operation_id: "op_used", tool: "git_status", arguments: {} }],
  });
  const transport = new RecoveredPrefixTransport([response]);
  let executions = 0;
  const runtime = runtimeForTest({
    root,
    state: localState,
    store,
    transport,
    protocol: new CbaProtocolAdapter({
      seenOperationIds: () => new Set(localState.completedOperationIds),
    }),
    execute: async (call) => {
      executions += 1;
      return {
        operationId: call.operationId,
        tool: call.name,
        status: "success",
        data: {},
        safeMetadata: {},
      };
    },
  });

  const result = await runtime.run();
  assert.equal(result.status, "failed");
  assert.match(result.reason ?? "", /already been used/u);
  assert.equal(executions, 0);
  assert.equal(transport.submittedContents.length, 1, "must not submit duplicate-operation repair feedback");
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

test("user-requested pause wins when a completed response arrives during transport shutdown", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-pause-completed-race-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new CompletedOnStopTransport(JSON.stringify([{
    type: "complete_task",
    operationId: "op_complete",
    claim: {
      summary: "Must remain cached until resume.",
      acceptanceCriteria: [],
      validation: [],
      skippedValidation: [],
      remainingRisks: [],
      recommendedFollowUp: [],
    },
  }]));
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  const runtime = runtimeForTest({ root, state: localState, store, transport, artifacts });

  const run = runtime.run();
  await transport.receiveStarted;
  await runtime.requestPause("operator pause");
  const result = await run;
  assert.equal(result.status, "paused");
  assert.equal(result.reason, "operator pause");
  assert.equal(localState.submission?.state, "answered", "the completed response remains recoverable");
  assert.equal(localState.lastModelSummaryHash, undefined, "the response must not be processed after pause");
  assert.match(await artifacts.get("response", "turn_0001"), /Must remain cached until resume/u);
});

test("pause during completion inspection prevents completion and preserves the cached response", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-pause-completion-inspection-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new QueueTransport([JSON.stringify([{
    type: "complete_task",
    operationId: "op_complete",
    claim: {
      summary: "Must not complete after a racing pause.",
      acceptanceCriteria: [],
      validation: [],
      skippedValidation: [],
      remainingRisks: [],
      recommendedFollowUp: [],
    },
  }])]);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  let markInspectionStarted!: () => void;
  const inspectionStarted = new Promise<void>((resolve) => { markInspectionStarted = resolve; });
  let finishInspection!: () => void;
  const inspectionReleased = new Promise<void>((resolve) => { finishInspection = resolve; });
  const runtime = runtimeForTest({
    root,
    state: localState,
    store,
    transport,
    artifacts,
    inspectCompletionState: async () => {
      markInspectionStarted();
      await inspectionReleased;
      return {
        pathKey: completionPathKey,
        known: true,
        fingerprint: "d".repeat(64),
        excludedStateFingerprint: "0".repeat(64),
        hasConflicts: false,
        changedPaths: [],
        outOfScopePaths: [],
        gitStatusSummary: "clean",
      };
    },
  });

  const run = runtime.run();
  await inspectionStarted;
  await runtime.requestPause("pause during completion inspection");
  finishInspection();
  const result = await run;
  assert.equal(result.status, "paused");
  assert.equal(result.reason, "pause during completion inspection");
  assert.equal(localState.lastModelSummaryHash, undefined);
  assert.equal(localState.completionHandoff, undefined);
  assert.match(await artifacts.get("response", "turn_0001"), /Must not complete after a racing pause/u);
});

test("pause after a nonterminal action durably queues its outbound without replaying the action", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-pause-after-action-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new QueueTransport([
    JSON.stringify([{
      type: "tool_request",
      calls: [{ operationId: "op_once", name: "list_files", arguments: {} }],
    }]),
    JSON.stringify([{
      type: "complete_task",
      operationId: "op_complete",
      claim: {
        summary: "The queued result resumed without replay.",
        acceptanceCriteria: [],
        validation: [],
        skippedValidation: [],
        remainingRisks: [],
        recommendedFollowUp: [],
      },
    }]),
  ]);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  let markToolResultSerializationStarted!: () => void;
  const toolResultSerializationStarted = new Promise<void>((resolve) => {
    markToolResultSerializationStarted = resolve;
  });
  let finishToolResultSerialization!: () => void;
  const toolResultSerializationReleased = new Promise<void>((resolve) => {
    finishToolResultSerialization = resolve;
  });
  let toolResultSerializations = 0;
  const disclosure: DisclosureGuard = {
    inspectAndSerialize: async (message, context) => {
      if (context.kind === "tool_result") {
        toolResultSerializations += 1;
        markToolResultSerializationStarted();
        await toolResultSerializationReleased;
      }
      return message;
    },
  };
  let executions = 0;
  let submissionSequence = 0;
  const idFactory = (): string => `submission_${++submissionSequence}`;
  const execute: ToolExecutor["execute"] = async (call) => {
    executions += 1;
    return {
      operationId: call.operationId,
      tool: call.name,
      status: "success",
      data: { entries: ["src/index.ts"] },
      safeMetadata: { entryCount: 1 },
    };
  };
  const runtime = runtimeForTest({
    root,
    state: localState,
    store,
    transport,
    artifacts,
    disclosure,
    execute,
    idFactory,
  });

  const run = runtime.run();
  await toolResultSerializationStarted;
  await runtime.requestPause("pause after action result");
  finishToolResultSerialization();
  const paused = await run;
  assert.equal(paused.status, "paused");
  assert.equal(executions, 1);
  assert.equal(toolResultSerializations, 1);
  assert.equal(localState.queuedOutbound?.turnId, "turn_0002");
  assert.equal(await artifacts.getOptional("response", "turn_0001"), undefined);
  const queued = localState.queuedOutbound;
  assert.notEqual(queued, undefined);
  await artifacts.get("outbox", queued!.artifactId);
  const disclosedBytesAtPause = localState.budgetUsage.disclosedBytes;

  const resumed = await runtimeForTest({
    root,
    state: localState,
    store,
    transport,
    artifacts,
    disclosure,
    execute,
    idFactory,
  }).run();
  assert.equal(resumed.status, "completed", resumed.reason);
  assert.equal(executions, 1, "the completed action must not replay on resume");
  assert.equal(toolResultSerializations, 1, "the queued outbound must not be serialized or charged again");
  assert.equal(localState.budgetUsage.disclosedBytes, disclosedBytesAtPause);
});

test("interruption during completed-state persistence still clears terminal artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-pause-completed-persist-"));
  const localState = state(root);
  const store = new CompletionWriteGateStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new QueueTransport([JSON.stringify([{
    type: "complete_task",
    operationId: "op_complete",
    claim: {
      summary: "Completion is already committed.",
      acceptanceCriteria: [],
      validation: [],
      skippedValidation: [],
      remainingRisks: [],
      recommendedFollowUp: [],
    },
  }])]);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  await artifacts.put("decision", "sentinel", "must be cleared");
  const runtime = runtimeForTest({ root, state: localState, store, transport, artifacts });

  const run = runtime.run();
  await store.completionWriteStarted;
  await runtime.requestPause("pause after completion commit began");
  store.releaseCompletionWrite();
  const result = await run;
  assert.equal(result.status, "completed");
  assert.equal(localState.status, "completed");
  assert.equal(await artifacts.getOptional("response", "turn_0001"), undefined);
  assert.equal(await artifacts.getOptional("decision", "sentinel"), undefined);
});

test("completion is not exposed when its durable state write fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-completion-write-failure-"));
  const localState = state(root);
  const store = new FailingCompletionWriteStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new QueueTransport([JSON.stringify([{
    type: "complete_task",
    operationId: "op_complete",
    claim: {
      summary: "This completion must not be reported without a durable state commit.",
      acceptanceCriteria: [],
      validation: [],
      skippedValidation: [],
      remainingRisks: [],
      recommendedFollowUp: [],
    },
  }])]);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  const completionHandoffs = new CompletionHandoffStore(
    path.join(root, "handoff"),
    localState.sessionId,
    new SecretScanner(Buffer.alloc(32, 12)),
  );
  const runtime = runtimeForTest({
    root,
    state: localState,
    store,
    transport,
    artifacts,
    completionHandoffs,
  });

  const result = await runtime.run();
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "completion state write failed");
  assert.equal(result.completion, undefined);
  assert.equal(result.modelSummary, undefined);
  assert.equal(result.modelReport, undefined);
  assert.equal(localState.status, "failed");
  assert.equal(localState.completionHandoff, undefined);
  assert.equal(store.completionWriteAttempts, 1);
  const durableState = await store.read(localState.sessionId);
  assert.equal(durableState.status, "failed");
  assert.equal(durableState.completionHandoff, undefined);
  assert.equal(await artifacts.getOptional("response", "turn_0001"), undefined);
  await assert.rejects(
    () => completionHandoffs.read(),
    /Completion handoff is unavailable/u,
    "terminal failure cleanup must remove the unreferenced provisional handoff",
  );
});

test("resume reuses an accepted completion handoff saved before a pause", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-pause-after-handoff-save-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new QueueTransport([JSON.stringify([{
    type: "complete_task",
    operationId: "op_complete",
    claim: {
      summary: "The accepted handoff must remain stable across resume.",
      acceptanceCriteria: [],
      validation: [],
      skippedValidation: [],
      remainingRisks: [],
      recommendedFollowUp: [],
    },
  }])]);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  const completionHandoffs = new CompletionHandoffSaveGateStore(
    path.join(root, "handoff"),
    localState.sessionId,
    new SecretScanner(Buffer.alloc(32, 9)),
  );
  const runtime = runtimeForTest({
    root,
    state: localState,
    store,
    transport,
    artifacts,
    completionHandoffs,
  });

  const run = runtime.run();
  await completionHandoffs.firstSaveCompleted;
  await runtime.requestPause("pause after completion handoff save");
  completionHandoffs.releaseFirstSave();
  const paused = await run;
  assert.equal(paused.status, "paused");
  assert.equal(completionHandoffs.saveCalls, 1);
  const pausedReference = localState.completionHandoff;
  assert.notEqual(pausedReference, undefined);
  await completionHandoffs.read(pausedReference);
  assert.match(
    await artifacts.get("response", "turn_0001"),
    /accepted handoff must remain stable/u,
  );

  let markInspectionStarted!: () => void;
  const inspectionStarted = new Promise<void>((resolve) => { markInspectionStarted = resolve; });
  let releaseInspection!: () => void;
  const inspectionReleased = new Promise<void>((resolve) => { releaseInspection = resolve; });
  const interruptedResumeRuntime = runtimeForTest({
    root,
    state: localState,
    store,
    transport,
    artifacts,
    completionHandoffs,
    inspectCompletionState: async () => {
      markInspectionStarted();
      await inspectionReleased;
      return {
        pathKey: completionPathKey,
        known: true,
        fingerprint: "d".repeat(64),
        excludedStateFingerprint: "0".repeat(64),
        hasConflicts: false,
        changedPaths: [],
        outOfScopePaths: [],
        gitStatusSummary: "clean",
      };
    },
  });
  const interruptedResumeRun = interruptedResumeRuntime.run();
  await inspectionStarted;
  await interruptedResumeRuntime.requestPause("pause before handoff revalidation");
  releaseInspection();
  const interruptedResume = await interruptedResumeRun;
  assert.equal(interruptedResume.status, "paused");
  assert.equal(interruptedResume.completion, undefined);
  assert.deepEqual(localState.completionHandoff, pausedReference);
  assert.equal(completionHandoffs.saveCalls, 1);

  const resumed = await runtimeForTest({
    root,
    state: localState,
    store,
    transport,
    artifacts,
    completionHandoffs,
  }).run();
  assert.equal(resumed.status, "completed", resumed.reason);
  assert.equal(completionHandoffs.saveCalls, 1, "resume must not overwrite the referenced handoff");
  assert.deepEqual(localState.completionHandoff, pausedReference);
  await completionHandoffs.read(pausedReference);
});

test("resume fails closed when accepted completion evidence changed after handoff save", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-stale-completion-handoff-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new QueueTransport([JSON.stringify([{
    type: "complete_task",
    operationId: "op_complete",
    claim: {
      summary: "Completion evidence must describe the current repository.",
      acceptanceCriteria: [],
      validation: [],
      skippedValidation: [],
      remainingRisks: [],
      recommendedFollowUp: [],
    },
  }])]);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  const completionHandoffs = new CompletionHandoffSaveGateStore(
    path.join(root, "handoff"),
    localState.sessionId,
    new SecretScanner(Buffer.alloc(32, 10)),
  );
  const runtime = runtimeForTest({
    root,
    state: localState,
    store,
    transport,
    artifacts,
    completionHandoffs,
  });

  const run = runtime.run();
  await completionHandoffs.firstSaveCompleted;
  await runtime.requestPause("pause after completion handoff save");
  completionHandoffs.releaseFirstSave();
  const paused = await run;
  assert.equal(paused.status, "paused");
  const pausedReference = localState.completionHandoff;
  assert.notEqual(pausedReference, undefined);

  const resumed = await runtimeForTest({
    root,
    state: localState,
    store,
    transport,
    artifacts,
    completionHandoffs,
    inspectCompletionState: async () => ({
      pathKey: completionPathKey,
      known: true,
      fingerprint: "d".repeat(64),
      excludedStateFingerprint: "0".repeat(64),
      hasConflicts: false,
      changedPaths: ["src/new-state.ts"],
      outOfScopePaths: [],
      gitStatusSummary: " M src/new-state.ts",
    }),
  }).run();
  assert.equal(resumed.status, "failed", resumed.reason);
  assert.match(
    resumed.reason ?? "",
    /Completion handoff does not match the current accepted completion evidence/u,
  );
  assert.equal(resumed.completion, undefined, "rejected handoff evidence must not be reported as accepted");
  assert.equal(completionHandoffs.saveCalls, 1, "mismatched evidence must not overwrite the handoff");
  assert.equal(localState.completionHandoff, undefined, "terminal failure must drop the stale handoff reference");
  await assert.rejects(
    () => completionHandoffs.read(),
    /Completion handoff is unavailable/u,
    "terminal cleanup must leave no separately readable stale handoff",
  );

  const repeated = await runtimeForTest({
    root,
    state: localState,
    store,
    transport,
    artifacts,
    completionHandoffs,
  }).run();
  assert.equal(repeated.status, "failed");
  assert.equal(completionHandoffs.saveCalls, 1, "a stale handoff cannot become fresh on another resume");
});

test("abort cannot be downgraded by a racing pause request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-abort-priority-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new CancelledOnStopTransport();
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  await artifacts.put("decision", "sentinel", "must be cleared after abort");
  const runtime = runtimeForTest({ root, state: localState, store, transport, artifacts });

  const run = runtime.run();
  await transport.receiveStarted;
  await Promise.all([
    runtime.emergencyStop("operator kill switch"),
    runtime.requestPause("late pause"),
  ]);
  const result = await run;
  assert.equal(result.status, "aborted");
  assert.equal(result.reason, "operator kill switch");
  assert.equal(await artifacts.getOptional("outbox", "submission_1"), undefined);
  assert.equal(await artifacts.getOptional("decision", "sentinel"), undefined);
});

test("abort during policy authorization cannot start a repository mutation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-abort-policy-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  let markAuthorizationStarted!: () => void;
  let releaseAuthorization!: () => void;
  const authorizationStarted = new Promise<void>((resolve) => { markAuthorizationStarted = resolve; });
  const authorizationReleased = new Promise<void>((resolve) => { releaseAuthorization = resolve; });
  let expansions = 0;
  let executions = 0;
  const runtime = runtimeForTest({
    root,
    state: localState,
    store,
    transport: new QueueTransport([JSON.stringify([{
      type: "tool_request",
      calls: [{ operationId: "op_abort_policy", name: "apply_patch", arguments: { changes: [] } }],
    }])]),
    policy: {
      summarize: () => ({}),
      authorize: async () => {
        markAuthorizationStarted();
        await authorizationReleased;
        return {
          outcome: "ask",
          reasonCode: "ASK_WRITE",
          explanation: "Approve repository mutation",
          capability: { kind: "path", access: "write", paths: ["src/new.ts"] },
        };
      },
      expandSessionGrant: async () => { expansions += 1; return true; },
    },
    execute: async (call) => {
      executions += 1;
      return {
        operationId: call.operationId,
        tool: call.name,
        status: "success",
        data: {},
        safeMetadata: {},
      };
    },
  });

  const run = runtime.run();
  await authorizationStarted;
  await runtime.emergencyStop("abort while policy is pending");
  releaseAuthorization();
  const result = await run;
  assert.equal(result.status, "aborted");
  assert.equal(result.reason, "abort while policy is pending");
  assert.equal(expansions, 0);
  assert.equal(executions, 0);
  const journal = new OperationJournal(path.join(root, "operations"), localState.sessionId);
  assert.equal((await journal.read("op_abort_policy")).status, "accepted");
});

test("abort cancels a standalone capability prompt before grant expansion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-abort-capability-prompt-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  let markPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
  let promptSignal: AbortSignal | undefined;
  let expansions = 0;
  let executions = 0;
  const runtime = runtimeForTest({
    root,
    state: localState,
    store,
    transport: new QueueTransport([JSON.stringify([{
      type: "request_capability",
      requestId: "cap_abort_prompt",
      capability: { kind: "path", access: "write", paths: ["src/new.ts"] },
      reason: "Need repository write access",
    }])]),
    policy: {
      summarize: () => ({}),
      authorize: () => ({ outcome: "allow", reasonCode: "OK", explanation: "ok" }),
      expandSessionGrant: async () => { expansions += 1; return true; },
    },
    user: {
      requestInput: async () => ({}),
      requestCapability: async (request) => {
        promptSignal = request.signal;
        markPromptStarted();
        return new Promise((_, reject) => {
          const rejectForAbort = (): void => reject(new Error("capability prompt aborted"));
          if (request.signal.aborted) rejectForAbort();
          else request.signal.addEventListener("abort", rejectForAbort, { once: true });
        });
      },
    },
    execute: async (call) => {
      executions += 1;
      return {
        operationId: call.operationId,
        tool: call.name,
        status: "success",
        data: {},
        safeMetadata: {},
      };
    },
  });

  const run = runtime.run();
  await promptStarted;
  await runtime.emergencyStop("abort capability prompt");
  const result = await run;
  assert.equal(result.status, "aborted");
  assert.equal(result.reason, "abort capability prompt");
  assert.equal(promptSignal?.aborted, true);
  assert.equal(expansions, 0);
  assert.equal(executions, 0);
});

test("abort during pre-execution persistence restores a retry-safe journal without invoking the tool", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-abort-execution-persist-"));
  const localState = state(root);
  const store = new ToolExecutionWriteGateStore(path.join(root, "state"));
  await store.create(localState);
  let executions = 0;
  const runtime = runtimeForTest({
    root,
    state: localState,
    store,
    transport: new QueueTransport([JSON.stringify([{
      type: "tool_request",
      calls: [{ operationId: "op_abort_persist", name: "apply_patch", arguments: { changes: [] } }],
    }])]),
    execute: async (call) => {
      executions += 1;
      return {
        operationId: call.operationId,
        tool: call.name,
        status: "success",
        data: {},
        safeMetadata: {},
      };
    },
  });

  const run = runtime.run();
  await store.executingWriteStarted;
  await runtime.emergencyStop("abort during pre-execution persistence");
  store.releaseExecutingWrite();
  const result = await run;
  assert.equal(result.status, "aborted");
  assert.equal(result.reason, "abort during pre-execution persistence");
  assert.equal(executions, 0);
  const journal = new OperationJournal(path.join(root, "operations"), localState.sessionId);
  assert.equal((await journal.read("op_abort_persist")).status, "accepted");
  assert.equal(localState.pendingOperations[0]?.status, "accepted");
});

test("paused pre-execution command resumes once without double charging its limit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-pause-command-budget-"));
  const localState = state(root);
  localState.budgetLimits = { ...localState.budgetLimits, maxCommands: 1 };
  const store = new ToolExecutionWriteGateStore(path.join(root, "state"));
  await store.create(localState);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  const transport = new QueueTransport([
    JSON.stringify([{
      type: "tool_request",
      calls: [{
        operationId: "op_pause_command",
        name: "run_command",
        arguments: { command_id: "validate" },
      }],
    }]),
    JSON.stringify([{
      type: "complete_task",
      operationId: "op_complete_after_command",
      claim: {
        summary: "Command resumed exactly once.",
        acceptanceCriteria: [],
        validation: [{
          commandId: "validate",
          status: "passed",
          summary: "Validation passed after the resumed command.",
        }],
        skippedValidation: [],
        remainingRisks: [],
        recommendedFollowUp: [],
      },
    }]),
  ]);
  let executions = 0;
  const execute: ToolExecutor["execute"] = async (call) => {
    executions += 1;
    return {
      operationId: call.operationId,
      tool: call.name,
      status: "success",
      data: {},
      safeMetadata: {
        commandId: "validate",
        outcome: "success",
        exitCode: 0,
        outputBytes: 0,
        repositoryFingerprint: "d".repeat(64),
      },
    };
  };
  const firstRuntime = runtimeForTest({
    root,
    state: localState,
    store,
    transport,
    artifacts,
    execute,
  });

  const firstRun = firstRuntime.run();
  await store.executingWriteStarted;
  await firstRuntime.requestPause("pause during pre-execution command persistence");
  store.releaseExecutingWrite();
  const paused = await firstRun;
  assert.equal(paused.status, "paused");
  assert.equal(executions, 0);
  assert.equal(localState.budgetUsage.commands, 0);
  assert.equal(localState.pendingOperations[0]?.status, "accepted");

  const completed = await runtimeForTest({
    root,
    state: localState,
    store,
    transport,
    artifacts,
    execute,
  }).run();
  assert.equal(completed.status, "completed", completed.reason);
  assert.equal(executions, 1);
  assert.equal(localState.budgetUsage.commands, 1);
});

test("recovery finishes a refund interrupted after the journal became retry-safe", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-command-refund-recovery-"));
  const localState = state(root);
  localState.status = "executing_tools";
  localState.turnSequence = 1;
  localState.budgetLimits = { ...localState.budgetLimits, maxCommands: 1 };
  localState.budgetUsage = { ...localState.budgetUsage, operations: 1, commands: 1 };
  localState.submission = {
    submissionId: "submission_1",
    turnId: "turn_0001",
    messageHash: "a".repeat(64),
    marker: "marker",
    state: "answered",
    preparedAt: "2026-01-01T00:00:00.000Z",
    answeredAt: "2026-01-01T00:00:01.000Z",
  };
  const call = {
    operationId: "op_refund_recovery",
    name: "run_command" as const,
    arguments: { command_id: "validate" },
  };
  const journal = new OperationJournal(path.join(root, "operations"), localState.sessionId);
  const registration = await journal.register(
    call.operationId,
    call.name,
    true,
    call,
    "2026-01-01T00:00:00.000Z",
  );
  localState.pendingOperations = [{
    operationId: call.operationId,
    tool: call.name,
    mutating: true,
    requestHash: registration.record.requestHash,
    status: "executing",
    acceptedAt: registration.record.acceptedAt,
  }];
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  await artifacts.put("response", "turn_0001", JSON.stringify([{ type: "tool_request", calls: [call] }]));
  const transport = new QueueTransport([JSON.stringify([{
    type: "complete_task",
    operationId: "op_complete_after_refund",
    claim: {
      summary: "Recovered the interrupted refund.",
      acceptanceCriteria: [],
      validation: [{
        commandId: "validate",
        status: "passed",
        summary: "Validation passed once.",
      }],
      skippedValidation: [],
      remainingRisks: [],
      recommendedFollowUp: [],
    },
  }])]);
  let executions = 0;

  const result = await runtimeForTest({
    root,
    state: localState,
    store,
    transport,
    artifacts,
    execute: async (requested) => {
      executions += 1;
      return {
        operationId: requested.operationId,
        tool: requested.name,
        status: "success",
        data: {},
        safeMetadata: {
          commandId: "validate",
          outcome: "success",
          exitCode: 0,
          outputBytes: 0,
          repositoryFingerprint: "d".repeat(64),
        },
      };
    },
  }).run();

  assert.equal(result.status, "completed", result.reason);
  assert.equal(executions, 1);
  assert.equal(localState.budgetUsage.commands, 1);
  assert.equal(localState.pendingOperations.length, 0);
});

test("read-only recovery retries once without recharging its persisted specialized budget", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-read-recovery-budget-"));
  const localState = state(root);
  localState.status = "executing_tools";
  localState.turnSequence = 1;
  localState.budgetLimits = { ...localState.budgetLimits, maxReadFiles: 1 };
  localState.budgetUsage = { ...localState.budgetUsage, operations: 1, readFiles: 1 };
  localState.submission = {
    submissionId: "submission_1",
    turnId: "turn_0001",
    messageHash: "a".repeat(64),
    marker: "marker",
    state: "answered",
    preparedAt: "2026-01-01T00:00:00.000Z",
    answeredAt: "2026-01-01T00:00:01.000Z",
  };
  const call = {
    operationId: "op_read_recovery",
    name: "read_file" as const,
    arguments: { path: "README.md" },
  };
  const journal = new OperationJournal(path.join(root, "operations"), localState.sessionId);
  const registration = await journal.register(
    call.operationId,
    call.name,
    false,
    call,
    "2026-01-01T00:00:00.000Z",
  );
  const executing = await journal.markExecuting(registration.record, "2026-01-01T00:00:01.000Z");
  localState.pendingOperations = [{
    operationId: call.operationId,
    tool: call.name,
    mutating: false,
    requestHash: executing.requestHash,
    status: "executing",
    acceptedAt: executing.acceptedAt,
  }];
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  await artifacts.put("response", "turn_0001", JSON.stringify([{ type: "tool_request", calls: [call] }]));
  const transport = new QueueTransport([JSON.stringify([{
    type: "complete_task",
    operationId: "op_complete_after_read_recovery",
    claim: {
      summary: "Recovered the interrupted file read.",
      acceptanceCriteria: [],
      validation: [],
      skippedValidation: [],
      remainingRisks: [],
      recommendedFollowUp: [],
    },
  }])]);
  let executions = 0;

  const result = await runtimeForTest({
    root,
    state: localState,
    store,
    transport,
    artifacts,
    execute: async (requested) => {
      executions += 1;
      return {
        operationId: requested.operationId,
        tool: requested.name,
        status: "success",
        data: { content: "read once" },
        safeMetadata: {
          path: "README.md",
          sha256: "d".repeat(64),
          bytes: 9,
        },
      };
    },
  }).run();

  assert.equal(result.status, "completed", result.reason);
  assert.equal(executions, 1);
  assert.equal(localState.budgetUsage.readFiles, 1);
  assert.equal(localState.pendingOperations.length, 0);
  assert.equal((await journal.read(call.operationId)).status, "completed");
});

test("recovery retries a mutation whose journal advanced before accepted session state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-predispatch-journal-recovery-"));
  const localState = state(root);
  localState.status = "executing_tools";
  localState.turnSequence = 1;
  localState.budgetLimits = { ...localState.budgetLimits, maxCommands: 1 };
  localState.budgetUsage = { ...localState.budgetUsage, operations: 1, commands: 0 };
  localState.submission = {
    submissionId: "submission_1",
    turnId: "turn_0001",
    messageHash: "a".repeat(64),
    marker: "marker",
    state: "answered",
    preparedAt: "2026-01-01T00:00:00.000Z",
    answeredAt: "2026-01-01T00:00:01.000Z",
  };
  const call = {
    operationId: "op_predispatch_recovery",
    name: "run_command" as const,
    arguments: { command_id: "validate" },
  };
  const journal = new OperationJournal(path.join(root, "operations"), localState.sessionId);
  const registration = await journal.register(
    call.operationId,
    call.name,
    true,
    call,
    "2026-01-01T00:00:00.000Z",
  );
  await journal.markExecuting(registration.record, "2026-01-01T00:00:01.000Z");
  localState.pendingOperations = [{
    operationId: call.operationId,
    tool: call.name,
    mutating: true,
    requestHash: registration.record.requestHash,
    status: "accepted",
    acceptedAt: registration.record.acceptedAt,
  }];
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  await artifacts.put("response", "turn_0001", JSON.stringify([{ type: "tool_request", calls: [call] }]));
  const transport = new QueueTransport([JSON.stringify([{
    type: "complete_task",
    operationId: "op_complete_after_predispatch",
    claim: {
      summary: "Recovered the pre-dispatch journal window.",
      acceptanceCriteria: [],
      validation: [{
        commandId: "validate",
        status: "passed",
        summary: "Validation passed once.",
      }],
      skippedValidation: [],
      remainingRisks: [],
      recommendedFollowUp: [],
    },
  }])]);
  let executions = 0;

  const result = await runtimeForTest({
    root,
    state: localState,
    store,
    transport,
    artifacts,
    execute: async (requested) => {
      executions += 1;
      return {
        operationId: requested.operationId,
        tool: requested.name,
        status: "success",
        data: {},
        safeMetadata: {
          commandId: "validate",
          outcome: "success",
          exitCode: 0,
          outputBytes: 0,
          repositoryFingerprint: "d".repeat(64),
        },
      };
    },
  }).run();

  assert.equal(result.status, "completed", result.reason);
  assert.equal(executions, 1);
  assert.equal(localState.budgetUsage.commands, 1);
  assert.equal(localState.pendingOperations.length, 0);
  assert.equal((await journal.read(call.operationId)).status, "completed");
});

test("cancelled user prompt resumes once without double charging its operation limit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-pause-user-budget-"));
  const localState = state(root);
  localState.budgetLimits = { ...localState.budgetLimits, maxOperations: 1 };
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  const transport = new QueueTransport([
    JSON.stringify([{
      type: "request_user_input",
      requestId: "request_pause_budget",
      question: "Continue after pause?",
    }]),
    JSON.stringify([{
      type: "complete_task",
      operationId: "op_complete_after_prompt",
      claim: {
        summary: "User prompt resumed exactly once.",
        acceptanceCriteria: [],
        validation: [],
        skippedValidation: [],
        remainingRisks: [],
        recommendedFollowUp: [],
      },
    }]),
  ]);
  let markPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
  let startedPrompts = 0;
  let completedPrompts = 0;
  const firstRuntime = runtimeForTest({
    root,
    state: localState,
    store,
    transport,
    artifacts,
    user: {
      requestInput: async (request) => {
        startedPrompts += 1;
        markPromptStarted();
        return new Promise((_, reject) => {
          const rejectForPause = (): void => reject(new Error("user prompt paused"));
          if (request.signal.aborted) rejectForPause();
          else request.signal.addEventListener("abort", rejectForPause, { once: true });
        });
      },
      requestCapability: async () => ({ decision: "deny" }),
    },
  });

  const firstRun = firstRuntime.run();
  await promptStarted;
  await firstRuntime.requestPause("pause outstanding user prompt");
  const paused = await firstRun;
  assert.equal(paused.status, "paused");
  assert.equal(localState.budgetUsage.operations, 1);
  assert.equal(localState.pendingOperations[0]?.operationId, "request_pause_budget");

  const completed = await runtimeForTest({
    root,
    state: localState,
    store,
    transport,
    artifacts,
    user: {
      requestInput: async () => {
        startedPrompts += 1;
        completedPrompts += 1;
        return { answer: "yes" };
      },
      requestCapability: async () => ({ decision: "deny" }),
    },
  }).run();
  assert.equal(completed.status, "completed", completed.reason);
  assert.equal(startedPrompts, 2);
  assert.equal(completedPrompts, 1);
  assert.equal(localState.budgetUsage.operations, 1);
  assert.equal(localState.pendingOperations.length, 0);
  assert.deepEqual(localState.completedOperationIds, ["request_pause_budget"]);
});

test("abort clears a completed response received during transport shutdown", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-abort-completed-race-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new CompletedOnStopTransport("completed response during abort");
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  await artifacts.put("decision", "sentinel", "must be cleared after abort");
  const runtime = runtimeForTest({ root, state: localState, store, transport, artifacts });

  const run = runtime.run();
  await transport.receiveStarted;
  await runtime.emergencyStop("operator kill switch");
  const result = await run;
  assert.equal(result.status, "aborted");
  assert.equal(result.reason, "operator kill switch");
  assert.equal(localState.submission?.state, "answered");
  assert.equal(await artifacts.getOptional("response", "turn_0001"), undefined);
  assert.equal(await artifacts.getOptional("outbox", "submission_1"), undefined);
  assert.equal(await artifacts.getOptional("decision", "sentinel"), undefined);
});

test("terminal transport blocking clears source artifacts when retention is disabled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-terminal-transport-block-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  await artifacts.put("decision", "sentinel", "must be cleared after terminal block");
  const runtime = runtimeForTest({
    root,
    state: localState,
    store,
    transport: new TerminalBlockedTransport([]),
    artifacts,
  });

  const result = await runtime.run();
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "service-error");
  assert.deepEqual(localState.terminalCleanup, { sourceArtifacts: "remove" });
  assert.equal(await artifacts.getOptional("outbox", "submission_1"), undefined);
  assert.equal(await artifacts.getOptional("decision", "sentinel"), undefined);
});

test("failed terminal artifact cleanup is retried from durable state on a later load", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-terminal-cleanup-retry-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  class RejectingClearArtifactStore extends SessionArtifactStore {
    public override async clear(): Promise<void> {
      throw new Error("transient artifact cleanup failure");
    }
  }
  const artifactRoot = path.join(store.sessionDirectory(localState.sessionId), "artifacts");
  const artifacts = new RejectingClearArtifactStore(artifactRoot);
  await artifacts.put("decision", "sentinel", "retry cleanup after terminal commit");
  const runtime = runtimeForTest({
    root,
    state: localState,
    store,
    transport: new TerminalBlockedTransport([]),
    artifacts,
  });

  await assert.rejects(() => runtime.run(), /transient artifact cleanup failure/u);
  const persisted = JSON.parse(
    await readFile(path.join(store.sessionDirectory(localState.sessionId), "session.json"), "utf8"),
  ) as SessionState;
  assert.equal(persisted.status, "blocked");
  assert.deepEqual(persisted.terminalCleanup, { sourceArtifacts: "remove" });
  assert.equal(await artifacts.get("decision", "sentinel"), "retry cleanup after terminal commit");

  const recovered = await store.read(localState.sessionId);
  assert.equal(recovered.status, "blocked");
  assert.deepEqual(recovered.terminalCleanup, { sourceArtifacts: "remove" });
  assert.equal(await artifacts.getOptional("decision", "sentinel"), undefined);
});

test("terminal cleanup preserves source artifacts when retention is enabled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-terminal-retention-enabled-"));
  const localState = state(root);
  localState.sourceArtifactRetention = "retain";
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  await artifacts.put("decision", "sentinel", "retained terminal evidence");
  const runtime = runtimeForTest({
    root,
    state: localState,
    store,
    transport: new TerminalBlockedTransport([]),
    artifacts,
  });

  const result = await runtime.run();
  assert.equal(result.status, "blocked");
  assert.deepEqual(localState.terminalCleanup, { sourceArtifacts: "retain" });
  assert.equal(await artifacts.get("outbox", "submission_1"), "bootstrap");
  assert.equal(await artifacts.get("decision", "sentinel"), "retained terminal evidence");
});

test("abort upgrades a pause while the paused state is being persisted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-abort-during-pause-persist-"));
  const localState = state(root);
  const store = new PauseWriteGateStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new CancelledOnStopTransport();
  const runtime = runtimeForTest({ root, state: localState, store, transport });

  const run = runtime.run();
  await transport.receiveStarted;
  await runtime.requestPause("initial operator pause");
  await store.pauseWriteStarted;
  await runtime.emergencyStop("operator kill switch");
  store.releasePauseWrite();
  const result = await run;
  assert.equal(result.status, "aborted");
  assert.equal(result.reason, "operator kill switch");
  assert.equal(localState.status, "aborted");
});

test("abort upgrades a recovery-error pause while the paused state is being persisted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-abort-during-recovery-pause-"));
  const localState = state(root);
  const store = new PauseWriteGateStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new MismatchedReceiptTransport(["unused"]);
  const runtime = runtimeForTest({ root, state: localState, store, transport });

  const run = runtime.run();
  await store.pauseWriteStarted;
  await runtime.emergencyStop("operator kill switch");
  store.releasePauseWrite();
  const result = await run;
  assert.equal(result.status, "aborted");
  assert.equal(result.reason, "operator kill switch");
  assert.equal(localState.status, "aborted");
  assert.equal(transport.receiveCalls, 0);
});

test("runtime pauses on a mismatched submission receipt without attempting receive", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-receipt-correlation-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new MismatchedReceiptTransport(["unused"]);
  const runtime = runtimeForTest({ root, state: localState, store, transport });

  const result = await runtime.run();
  assert.equal(result.status, "paused");
  assert.match(result.reason ?? "", /submission receipt correlation mismatch/u);
  assert.equal(transport.receiveCalls, 0);
  assert.equal(localState.submission?.state, "prepared");
});

test("runtime pauses on a mismatched receive result without parsing or marking it answered", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-result-correlation-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new MismatchedResultTransport([JSON.stringify([{
    type: "complete_task",
    operationId: "op_complete",
    claim: {
      summary: "Mismatched result must not be processed.",
      acceptanceCriteria: [],
      validation: [],
      skippedValidation: [],
      remainingRisks: [],
      recommendedFollowUp: [],
    },
  }])]);
  const runtime = runtimeForTest({ root, state: localState, store, transport });

  const result = await runtime.run();
  assert.equal(result.status, "paused");
  assert.match(result.reason ?? "", /receive result correlation mismatch/u);
  assert.equal(localState.submission?.state, "submitted");
  assert.equal(localState.lastModelSummaryHash, undefined);
});

test("runtime does not pin a conversation from an indeterminate receive result", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-untrusted-result-conversation-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new UntrustedConversationResultTransport([]);
  const runtime = runtimeForTest({ root, state: localState, store, transport });

  const result = await runtime.run();
  assert.equal(result.status, "paused");
  assert.equal(result.reason, "CONVERSATION_CHANGED_DURING_RESPONSE");
  assert.equal(localState.transportConversationId, undefined);
  assert.equal(localState.submission?.state, "submitted");
});

test("runtime establishes an initial conversation only from a completed result", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-stale-receipt-conversation-"));
  const localState = state(root);
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new StaleReceiptConversationTransport([JSON.stringify([{
    type: "complete_task",
    operationId: "op_complete",
    claim: {
      summary: "The completed result establishes the conversation.",
      acceptanceCriteria: [],
      validation: [],
      skippedValidation: [],
      remainingRisks: [],
      recommendedFollowUp: [],
    },
  }])]);
  const runtime = runtimeForTest({ root, state: localState, store, transport });

  const result = await runtime.run();
  assert.equal(result.status, "completed", result.reason);
  assert.deepEqual(transport.receiveExpectedConversationIds, [undefined]);
  assert.equal(localState.transportConversationId, "conversation_1");
});

test("recovery does not pin an initial conversation from submission resolution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-stale-resolution-conversation-"));
  const localState = state(root);
  localState.status = "paused";
  localState.pauseReason = "process restarted";
  localState.turnSequence = 1;
  localState.submission = {
    submissionId: "submission_1",
    turnId: "turn_0001",
    messageHash: sha256("bootstrap"),
    marker: "marker",
    state: "prepared",
    preparedAt: "2026-01-01T00:00:00.000Z",
  };
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  await artifacts.put("outbox", "submission_1", "bootstrap");
  const transport = new StaleReceiptConversationTransport([JSON.stringify([{
    type: "complete_task",
    operationId: "op_complete",
    claim: {
      summary: "The recovered completed result establishes the conversation.",
      acceptanceCriteria: [],
      validation: [],
      skippedValidation: [],
      remainingRisks: [],
      recommendedFollowUp: [],
    },
  }])]);
  const runtime = runtimeForTest({ root, state: localState, store, transport, artifacts });

  const result = await runtime.run();
  assert.equal(result.status, "completed", result.reason);
  assert.equal(transport.resolveCalls, 1);
  assert.deepEqual(transport.receiveExpectedConversationIds, [undefined]);
  assert.equal(localState.transportConversationId, "conversation_1");
});

test("runtime rejects a submitted receipt that omits the pinned conversation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-receipt-conversation-omitted-"));
  const localState = state(root);
  localState.transportConversationId = "conversation_1";
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new MissingConversationReceiptTransport(["unused"]);
  const runtime = runtimeForTest({ root, state: localState, store, transport });

  const result = await runtime.run();
  assert.equal(result.status, "paused");
  assert.match(result.reason ?? "", /submission receipt correlation mismatch/u);
  assert.equal(transport.receiveCalls, 0);
  assert.equal(localState.submission?.state, "prepared");
});

test("runtime rejects a completed result that omits the pinned conversation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-result-conversation-omitted-"));
  const localState = state(root);
  localState.transportConversationId = "conversation_1";
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const transport = new MissingConversationResultTransport([JSON.stringify([{
    type: "complete_task",
    operationId: "op_complete",
    claim: {
      summary: "Missing conversation must not be processed.",
      acceptanceCriteria: [],
      validation: [],
      skippedValidation: [],
      remainingRisks: [],
      recommendedFollowUp: [],
    },
  }])]);
  const runtime = runtimeForTest({ root, state: localState, store, transport });

  const result = await runtime.run();
  assert.equal(result.status, "paused");
  assert.match(result.reason ?? "", /receive result correlation mismatch/u);
  assert.equal(localState.submission?.state, "submitted");
  assert.equal(localState.lastModelSummaryHash, undefined);
});

test("recovery refuses an integrity-valid outbox that does not match the durable submission hash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-runtime-recovery-message-hash-"));
  const localState = state(root);
  localState.status = "paused";
  localState.pauseReason = "process restarted";
  localState.turnSequence = 1;
  localState.submission = {
    submissionId: "submission_1",
    turnId: "turn_0001",
    messageHash: sha256("expected exact outbound"),
    marker: "marker",
    state: "prepared",
    preparedAt: "2026-01-01T00:00:00.000Z",
  };
  const store = new SessionStore(path.join(root, "state"));
  await store.create(localState);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(localState.sessionId), "artifacts"));
  await artifacts.put("outbox", "submission_1", "different integrity-valid outbound");
  const transport = new RecoveryProbeTransport([]);
  const runtime = runtimeForTest({ root, state: localState, store, transport, artifacts });

  const result = await runtime.run();
  assert.equal(result.status, "paused");
  assert.match(result.reason ?? "", /does not match the durable submission intent/u);
  assert.equal(transport.resolveCalls, 0, "transport must not observe mismatched recovery bytes");
  assert.equal(localState.submission.state, "prepared");
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
