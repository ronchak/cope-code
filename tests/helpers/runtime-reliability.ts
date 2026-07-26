import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { AuditLog } from "../../src/audit/audit-log.js";
import { AgentRuntime } from "../../src/orchestrator/agent-runtime.js";
import type {
  NormalizedModelMessage,
  ParsedModelTurn,
  ProtocolAdapter,
  ToolExecutor,
} from "../../src/orchestrator/contracts.js";
import { SessionArtifactStore } from "../../src/session/artifact-store.js";
import { OperationJournal } from "../../src/session/operation-journal.js";
import { SessionStore } from "../../src/session/store.js";
import {
  DEFAULT_BUDGET_LIMITS,
  SESSION_SCHEMA_VERSION,
  type SessionState,
  zeroBudgetUsage,
} from "../../src/session/types.js";
import {
  MODEL_TRANSPORT_CONTRACT_VERSION,
  type ModelTransport,
  type ReceiveRequest,
  type SubmissionRequest,
  type SubmissionResolutionRequest,
} from "../../src/transport/model-transport.js";

export const CRASH_EXIT_CODE = 86;
export const SESSION_ID = "session_reliability";
export const OPERATION_ID = "op_reliability_patch";
export const REPOSITORY_FINGERPRINT = "e".repeat(64);

const TOOL_RESPONSE = JSON.stringify([{
  type: "tool_request",
  calls: [{
    operationId: OPERATION_ID,
    name: "apply_patch",
    arguments: { changes: [{ kind: "create", path: "effect.txt", content: "committed\n" }] },
  }],
}]);
const COMPLETION_RESPONSE = JSON.stringify([{
  type: "complete_task",
  operationId: "op_reliability_complete",
  claim: {
    summary: "Recovered without duplicating the mutation.",
    acceptanceCriteria: [],
    validation: [],
    skippedValidation: [],
    remainingRisks: [],
    recommendedFollowUp: [],
  },
}]);

export const reliabilityProtocol: ProtocolAdapter = {
  renderBootstrap: () => "bootstrap",
  parseModelTurn: (raw, expected): ParsedModelTurn => ({
    protocolVersion: "cba/1",
    ...expected,
    messages: JSON.parse(raw) as NormalizedModelMessage[],
  }),
  isRepairableParseError: () => false,
  renderToolOutcomes: ({ outcomes }) => JSON.stringify(outcomes),
  renderProtocolError: (input) => JSON.stringify(input),
  renderUserDecision: (input) => JSON.stringify(input),
  renderCompletionRejected: (input) => JSON.stringify(input),
};

export function createReliabilityState(repositoryRoot: string): SessionState {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    protocolVersion: "cba/1",
    sessionId: SESSION_ID,
    taskId: "task_reliability",
    repositoryRoot,
    repositoryFingerprintAtStart: "d".repeat(64),
    repositoryExcludedStateAtStart: "0".repeat(64),
    preExistingChanges: [],
    objective: "Exercise crash recovery",
    acceptanceCriteria: [],
    mode: "auto",
    status: "grant_pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    policyHashes: { organization: "a".repeat(64), repository: "b".repeat(64), grant: "c".repeat(64) },
    sourceArtifactRetention: "remove",
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

export class PersistentTransport implements ModelTransport {
  public readonly transportKind = "reliability";
  public submitCount = 0;
  public resolveCount = 0;
  public receiveCount = 0;

  public constructor(
    private readonly root: string,
    private readonly afterSubmit?: () => never,
  ) {}

  public async submit(request: SubmissionRequest) {
    const filename = this.submissionPath(request.submissionId);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, `${request.submissionId}\n`, { flag: "wx", mode: 0o600, flush: true });
    await recordTransportCall(this.root, "submit", request.submissionId);
    this.submitCount += 1;
    this.afterSubmit?.();
    return receipt(request, "submitted");
  }

  public async resolveSubmission(request: SubmissionResolutionRequest) {
    this.resolveCount += 1;
    return receipt(request, await exists(this.submissionPath(request.submissionId)) ? "submitted" : "not-submitted");
  }

  public async receive(request: ReceiveRequest) {
    await recordTransportCall(this.root, "receive", request.submissionId);
    this.receiveCount += 1;
    return {
      contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
      taskId: request.taskId,
      turnId: request.turnId,
      submissionId: request.submissionId,
      observedAt: "2026-01-01T00:00:02.000Z",
      conversationId: "conversation_reliability",
      status: "completed" as const,
      responseId: `response_${request.turnId}`,
      content: request.turnId === "turn_0001" ? TOOL_RESPONSE : COMPLETION_RESPONSE,
    };
  }

  public async emergencyStop(): Promise<void> {}
  public async close(): Promise<void> {}

  private submissionPath(submissionId: string): string {
    return path.join(this.root, "transport", `${submissionId}.txt`);
  }
}

export class PersistentToolExecutor implements ToolExecutor {
  public executeCount = 0;

  public constructor(
    private readonly root: string,
    private readonly afterEffect?: () => never,
  ) {}

  public async execute(call: Parameters<ToolExecutor["execute"]>[0]) {
    this.executeCount += 1;
    const filename = path.join(this.root, "repository", "effect.txt");
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, "committed\n", { flag: "wx", mode: 0o600, flush: true });
    this.afterEffect?.();
    return {
      operationId: call.operationId,
      tool: call.name,
      status: "success" as const,
      data: { changed: true },
      safeMetadata: {
        checkpointId: "checkpoint_reliability",
        changedFileCount: 1,
        changedLines: 1,
        changedPaths: ["effect.txt"],
        repositoryFingerprint: REPOSITORY_FINGERPRINT,
      },
    };
  }

  public async inspectCompletionState() {
    return {
      pathKey: (value: string) => value.replaceAll("\\", "/"),
      known: true,
      fingerprint: await exists(path.join(this.root, "repository", "effect.txt"))
        ? REPOSITORY_FINGERPRINT
        : "d".repeat(64),
      excludedStateFingerprint: "0".repeat(64),
      hasConflicts: false,
      changedPaths: ["effect.txt"],
      outOfScopePaths: [],
      gitStatusSummary: "effect.txt",
    };
  }
}

export function createReliabilityRuntime(input: {
  readonly root: string;
  readonly state: SessionState;
  readonly store: SessionStore;
  readonly journal: OperationJournal;
  readonly transport: ModelTransport;
  readonly tools: ToolExecutor;
}): AgentRuntime {
  return new AgentRuntime({
    state: input.state,
    store: input.store,
    journal: input.journal,
    audit: new AuditLog(path.join(input.root, "audit.jsonl"), SESSION_ID, {
      now: () => new Date("2026-01-01T00:01:00.000Z"),
    }),
    protocol: reliabilityProtocol,
    policy: {
      summarize: () => ({ mode: "auto" }),
      authorize: () => ({ outcome: "allow", reasonCode: "IN_GRANT", explanation: "Allowed" }),
      expandSessionGrant: async () => false,
    },
    tools: input.tools,
    transport: input.transport,
    disclosure: { inspectAndSerialize: async (message) => message },
    user: {
      requestInput: async () => ({ answer: "unused" }),
      requestCapability: async () => ({ decision: "deny" }),
    },
    completionRequirements: {
      requiredCommandIds: [],
      requireValidationAfterLastMutation: false,
      requireCleanPendingOperations: true,
    },
    clock: { now: () => new Date("2026-01-01T00:01:00.000Z") },
    idFactory: (prefix) => `${prefix}_${input.state.turnSequence + 1}`,
    artifacts: new SessionArtifactStore(path.join(input.store.sessionDirectory(SESSION_ID), "artifacts")),
  });
}

export function crashNow(): never {
  process.exit(CRASH_EXIT_CODE);
}

export async function readTransportCallIds(root: string, operation: "submit" | "receive"): Promise<string[]> {
  try {
    return (await readdir(path.join(root, "transport-calls", operation))).toSorted();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function recordTransportCall(root: string, operation: "submit" | "receive", submissionId: string): Promise<void> {
  const directory = path.join(root, "transport-calls", operation);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, `${submissionId}.txt`), `${submissionId}\n`, {
    flag: "wx",
    mode: 0o600,
    flush: true,
  });
}

async function exists(filename: string): Promise<boolean> {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

function receipt(
  request: SubmissionRequest | SubmissionResolutionRequest,
  status: "submitted" | "not-submitted",
) {
  return {
    contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
    taskId: request.taskId,
    turnId: request.turnId,
    submissionId: request.submissionId,
    status,
    observedAt: "2026-01-01T00:00:01.000Z",
    conversationId: "conversation_reliability",
  };
}
