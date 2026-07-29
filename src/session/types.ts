import type { ArtifactReference } from "./artifact-store.js";

export const SESSION_SCHEMA_VERSION = 1 as const;

export type AutonomyMode = "inspect" | "edit" | "auto";
export type CompletionAuthority = "frozen" | "observed";

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
  readonly disclosure?: {
    readonly kind: "tool_result" | "decision";
    readonly disclosedBytes: number;
    readonly sha256: string;
  };
}

export interface PatchMutationRecord {
  readonly kind?: "patch";
  readonly operationId: string;
  readonly checkpointId: string;
  readonly changedPaths: readonly string[];
  readonly changedLines: number;
  readonly completedAt: string;
  readonly repositoryFingerprint: string;
}

export interface LegacyTerminalMutationRecord {
  readonly kind: "terminal";
  readonly operationId: string;
  readonly checkpointId?: never;
  readonly changedPaths: readonly string[];
  readonly changedLines: number;
  readonly createdPaths: readonly string[];
  readonly updatedPaths: readonly string[];
  readonly deletedPaths: readonly string[];
  readonly renamedPaths: readonly {
    readonly from: string;
    readonly to: string;
  }[];
  readonly preExistingTouchedPaths: readonly string[];
  readonly completedAt: string;
  readonly observationOutcome:
    | "none"
    | "observed"
    | "protected_or_hidden_changed"
    | "unknown";
  readonly preObservation?: ArtifactReference;
  readonly postObservation?: ArtifactReference;
  readonly terminalResult: ArtifactReference;
  readonly repositoryFingerprint?: string;
}

export interface TerminalPostObservationControl {
  readonly branch: string | null;
  readonly head: string | null;
  readonly excludedStateFingerprint: string;
}

interface FullTerminalMutationRecordBase {
  readonly kind: "terminal";
  readonly recordContract: "terminal-mutation/2";
  readonly operationId: string;
  readonly checkpointId?: never;
  readonly changedPaths: readonly string[];
  readonly changedLines: number;
  readonly createdPaths: readonly string[];
  readonly updatedPaths: readonly string[];
  readonly deletedPaths: readonly string[];
  readonly renamedPaths: readonly {
    readonly from: string;
    readonly to: string;
  }[];
  readonly preExistingTouchedPaths: readonly string[];
  readonly processOutcome?:
    | "completed"
    | "completed_nonzero"
    | "spawn_failed"
    | "timed_out"
    | "cancelled"
    | "persistence_failed"
    | "indeterminate";
  readonly createdTotal: number;
  readonly updatedTotal: number;
  readonly deletedTotal: number;
  readonly renamedTotal: number;
  readonly preExistingTouchedTotal: number;
  readonly changedPathCount: number;
  readonly pathEndpointTotal: number;
  readonly omittedPathEndpointTotal: number;
  readonly pathFactsTruncated: boolean;
  readonly pathFactsSha256: string;
  readonly unavailableBaselineCount: number;
  readonly completedAt: string;
  readonly preObservation: ArtifactReference;
  readonly postObservation: ArtifactReference;
  readonly terminalResult: ArtifactReference;
}

export type FullTerminalMutationRecord = FullTerminalMutationRecordBase & (
  | {
      readonly observationOutcome: "observed";
      readonly repositoryFingerprint: string;
      readonly postObservationControl: TerminalPostObservationControl;
    }
  | {
      readonly observationOutcome:
        | "protected_or_hidden_changed"
        | "unknown";
      readonly repositoryFingerprint?: never;
      readonly postObservationControl?: never;
    }
);

export type TerminalMutationRecord =
  | LegacyTerminalMutationRecord
  | FullTerminalMutationRecord;

export type MutationRecord = PatchMutationRecord | TerminalMutationRecord;

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
  /**
   * Creation-time completion semantics. Absent is byte-compatible and means
   * frozen for legacy sessions.
   */
  readonly completionAuthority?: CompletionAuthority;
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
  /**
   * Session-effective retention policy pinned when the original repository
   * policy is accepted. Legacy 0.1.6 sessions may omit it until safely resumed
   * under their original policy hashes.
   */
  sourceArtifactRetention?: "remove" | "retain";
  budgetLimits: BudgetLimits;
  budgetUsage: BudgetUsage;
  turnSequence: number;
  mutationSequence: number;
  pendingOperations: PendingOperation[];
  completedOperationIds: string[];
  /**
   * Completed local operations whose results are not yet represented by a
   * durable queued outbound artifact. Optional for legacy session records.
   */
  unreturnedOperationIds?: string[];
  /**
   * Completed terminal operations whose project effects still need durable
   * attribution. Optional for legacy session records.
   */
  pendingTerminalEffectOperationIds?: string[];
  submission?: SubmissionIntent;
  transportConversationId?: string;
  queuedOutbound?: QueuedOutbound;
  mutations: MutationRecord[];
  validations: ValidationRecord[];
  lastCheckpointId?: string;
  lastModelSummaryHash?: string;
  completionHandoff?: import("./completion-handoff-store.js").CompletionHandoffReference;
  terminalCleanup?: {
    readonly sourceArtifacts: "remove" | "retain";
  };
  protocolRepairStreak: number;
  /** Consecutive budget pauses without a successfully returned data result. */
  budgetPauseStreak?: number;
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
