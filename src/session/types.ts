export const SESSION_SCHEMA_VERSION = 1 as const;

export type AutonomyMode = "inspect" | "edit" | "auto";

export type SessionStatus =
  | "created"
  | "preflight"
  | "grant_pending"
  | "transport_starting"
  | "initializing_model"
  | "awaiting_model"
  | "executing_tools"
  | "returning_results"
  | "awaiting_user"
  | "paused"
  | "validating_completion"
  | "recovering"
  | "completed"
  | "rolled_back"
  | "blocked"
  | "aborted"
  | "failed";

export type TerminalSessionStatus = "completed" | "rolled_back" | "blocked" | "aborted" | "failed";

export interface BudgetLimits {
  readonly maxTurns: number;
  readonly maxOperations: number;
  readonly maxElapsedMs: number;
  readonly maxReadFiles: number;
  readonly maxDisclosedBytes: number;
  readonly maxChangedFiles: number;
  readonly maxChangedLines: number;
  readonly maxCommands: number;
  readonly maxCommandOutputBytes: number;
  readonly maxProtocolRepairs: number;
}

export interface BudgetUsage {
  turns: number;
  operations: number;
  readFiles: number;
  disclosedBytes: number;
  changedFiles: number;
  changedLines: number;
  commands: number;
  commandOutputBytes: number;
  protocolRepairs: number;
}

export type BudgetCounter = keyof BudgetUsage;

export interface PendingOperation {
  readonly operationId: string;
  readonly tool: string;
  readonly mutating: boolean;
  readonly requestHash: string;
  readonly status: "accepted" | "executing" | "indeterminate";
  readonly acceptedAt: string;
}

export interface SubmissionIntent {
  readonly submissionId: string;
  readonly turnId: string;
  readonly messageHash: string;
  readonly marker: string;
  readonly state: "prepared" | "submitted" | "indeterminate" | "answered";
  readonly preparedAt: string;
  readonly submittedAt?: string;
  readonly answeredAt?: string;
}

export interface QueuedOutbound {
  readonly turnId: string;
  readonly artifactId: string;
  readonly messageHash: string;
  readonly createdAt: string;
}

export interface MutationRecord {
  readonly operationId: string;
  readonly checkpointId: string;
  readonly changedPaths: readonly string[];
  readonly changedLines: number;
  readonly completedAt: string;
  readonly repositoryFingerprint: string;
}

export interface ValidationRecord {
  readonly operationId: string;
  readonly commandId: string;
  readonly outcome: "success" | "failure" | "timeout" | "cancelled" | "policy_denied" | "indeterminate";
  readonly exitCode?: number;
  readonly completedAt: string;
  readonly mutationSequence: number;
  /** Opaque repository state observed immediately after the command exited. */
  readonly repositoryFingerprint?: string;
}

export interface SessionPlan {
  readonly planId: string;
  readonly summary: string;
  readonly steps: readonly string[];
  readonly anticipatedMutations: readonly string[];
  readonly validation: readonly string[];
  readonly planHash: string;
  readonly status: "approved" | "rejected";
  readonly submittedAt: string;
  readonly decidedAt: string;
}

export interface SessionState {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly protocolVersion: "cba/1";
  readonly sessionId: string;
  readonly taskId: string;
  readonly repositoryRoot: string;
  repositoryFingerprintAtStart: string;
  /** Keyed aggregate of policy-hidden Git state at grant establishment. */
  repositoryExcludedStateAtStart: string;
  repositoryBranchAtStart?: string | null;
  repositoryHeadAtStart?: string | null;
  preExistingChanges: readonly string[];
  preExistingChangeStates?: Readonly<Record<string, string>>;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly mode: AutonomyMode;
  status: SessionStatus;
  readonly createdAt: string;
  updatedAt: string;
  readonly startedAt: string;
  completedAt?: string;
  pauseReason?: string;
  failure?: { readonly code: string; readonly message: string };
  readonly policyHashes: {
    readonly organization: string;
    readonly repository: string;
    grant: string;
  };
  budgetLimits: BudgetLimits;
  budgetUsage: BudgetUsage;
  turnSequence: number;
  mutationSequence: number;
  pendingOperations: PendingOperation[];
  completedOperationIds: string[];
  submission?: SubmissionIntent;
  transportConversationId?: string;
  queuedOutbound?: QueuedOutbound;
  mutations: MutationRecord[];
  validations: ValidationRecord[];
  lastCheckpointId?: string;
  lastModelSummaryHash?: string;
  /** The exact model-authored plan most recently reviewed by the user. */
  plan?: SessionPlan;
  completionHandoff?: import("./completion-handoff-store.js").CompletionHandoffReference;
  protocolRepairStreak: number;
}

export const zeroBudgetUsage = (): BudgetUsage => ({
  turns: 0,
  operations: 0,
  readFiles: 0,
  disclosedBytes: 0,
  changedFiles: 0,
  changedLines: 0,
  commands: 0,
  commandOutputBytes: 0,
  protocolRepairs: 0,
});

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  maxTurns: 40,
  maxOperations: 160,
  maxElapsedMs: 60 * 60 * 1_000,
  maxReadFiles: 80,
  maxDisclosedBytes: 2_000_000,
  maxChangedFiles: 30,
  maxChangedLines: 2_000,
  maxCommands: 30,
  maxCommandOutputBytes: 1_000_000,
  maxProtocolRepairs: 4,
};
