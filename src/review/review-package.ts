import { AUDIT_EVENT_TYPES, AUDIT_SCHEMA_VERSION, type AuditEvent } from "../audit/types.js";
import {
  DISCLOSURE_LEDGER_VERSION,
  type DisclosureRecord,
} from "../security/disclosure-ledger.js";
import { sha256, stableJson } from "../shared/crypto.js";
import { AgentError } from "../shared/errors.js";
import { isJournalOperationId, isOperationId } from "../shared/operation-id.js";
import { SESSION_SCHEMA_VERSION, type BudgetLimits, type BudgetUsage, type SessionState } from "../session/types.js";

export const REVIEW_PACKAGE_VERSION = "cba-review-package/1" as const;

const AUDIT_GENESIS_HASH = "0".repeat(64);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SECRET_KINDS = [
  "private-key",
  "aws-access-key",
  "github-token",
  "jwt",
  "bearer-token",
  "credential-assignment",
  "connection-string-password",
] as const;
const DISCLOSURE_SOURCES = [
  "repository-file",
  "repository-search",
  "command-output",
  "tool-result",
] as const;

type DisclosureSource = DisclosureRecord["source"];

export interface ReviewPackageInput {
  /** A SessionState already loaded through SessionStore's validation boundary. */
  readonly state: SessionState;
  /** Audit events returned by AuditLog.verify. Integrity is rechecked here. */
  readonly auditEvents: readonly AuditEvent[];
  /** Disclosure records from a verified DisclosureLedger. Integrity is rechecked here. */
  readonly disclosureRecords: readonly DisclosureRecord[];
}

export interface ReviewPackageBudgetRemaining {
  readonly turns: number;
  readonly operations: number;
  readonly elapsedMs: number;
  readonly readFiles: number;
  readonly disclosedBytes: number;
  readonly changedFiles: number;
  readonly changedLines: number;
  readonly commands: number;
  readonly commandOutputBytes: number;
  readonly protocolRepairs: number;
}

export interface ReviewPackageBody {
  readonly session: {
    readonly sessionId: string;
    readonly taskId: string;
    readonly status: SessionState["status"];
    readonly mode: SessionState["mode"];
    readonly completionAuthority: "frozen" | "observed";
    readonly createdAt: string;
    readonly startedAt: string;
    readonly updatedAt: string;
    readonly completedAt?: string;
  };
  readonly repository: {
    /** SHA-256 repository-state fingerprint. The repository root is never exported. */
    readonly fingerprintSha256: string;
  };
  readonly policyHashes: SessionState["policyHashes"];
  readonly budgets: {
    readonly limits: BudgetLimits;
    readonly usage: BudgetUsage;
    readonly remaining: ReviewPackageBudgetRemaining;
  };
  readonly counts: {
    readonly acceptanceCriteria: number;
    readonly preExistingChanges: number;
    readonly completedOperations: number;
    readonly pendingOperations: number;
    readonly mutations: number;
    readonly patchMutations: number;
    readonly terminalMutations: number;
    readonly validations: number;
    readonly pendingTerminalEffects: number;
  };
  readonly mutations: readonly {
    readonly operationId: string;
    readonly kind: "patch" | "terminal";
    readonly checkpointId?: string;
    readonly observationOutcome?:
      | "none"
      | "observed"
      | "protected_or_hidden_changed"
      | "unknown";
    readonly changedFileCount: number;
    readonly changedLines: number;
    readonly terminal?: {
      readonly processOutcome:
        | "completed"
        | "completed_nonzero"
        | "spawn_failed"
        | "timed_out"
        | "cancelled"
        | "persistence_failed"
        | "indeterminate"
        | "unavailable";
      readonly createdCount: number;
      readonly updatedCount: number;
      readonly deletedCount: number;
      readonly renamedCount: number;
      readonly preExistingTouchedCount: number;
      readonly changedPathCount: number;
      readonly pathEndpointCount: number;
      readonly omittedPathEndpointCount: number;
      readonly unavailableBaselineCount: number;
      readonly pathFactsTruncated: boolean;
      readonly legacyEvidence: boolean;
      readonly limitationCodes: readonly (
        | "legacy_evidence"
        | "non_clean_observation"
        | "path_facts_truncated"
        | "unavailable_baselines"
        | "process_outcome_unavailable"
      )[];
    };
  }[];
  readonly validations: readonly {
    readonly operationId: string;
    readonly commandId: string;
    readonly outcome: SessionState["validations"][number]["outcome"];
    readonly exitCode?: number;
    readonly completedAt: string;
    readonly mutationSequence: number;
  }[];
  readonly pendingOperations: readonly {
    readonly operationId: string;
    readonly tool: string;
    readonly mutating: boolean;
    readonly requestHash: string;
    readonly status: SessionState["pendingOperations"][number]["status"];
    readonly acceptedAt: string;
  }[];
  readonly audit: {
    readonly eventCount: number;
    readonly finalHash: string;
  };
  readonly disclosures: {
    readonly recordCount: number;
    readonly disclosedRecordCount: number;
    readonly withheldRecordCount: number;
    readonly originalByteCount: number;
    readonly disclosedByteCount: number;
    readonly redactionCount: number;
    readonly bySource: Readonly<Record<DisclosureSource, number>>;
    readonly finalRecordHash: string | null;
    readonly findings: readonly {
      readonly operationId: string;
      readonly kind: DisclosureRecord["redactions"][number]["kind"];
      readonly severity: DisclosureRecord["redactions"][number]["severity"];
      readonly line: number;
      readonly column: number;
      readonly fingerprint: string;
    }[];
  };
}

export interface ReviewPackage {
  readonly version: typeof REVIEW_PACKAGE_VERSION;
  readonly body: ReviewPackageBody;
  readonly integrity: {
    readonly algorithm: "sha256";
    readonly bodySha256: string;
  };
}

/**
 * Produces a deterministic, source-free review artifact. This function never
 * copies the repository root, objective, criteria text, changed paths, model
 * report, audit data, disclosure paths, browser URL, or browser identity.
 */
export function createReviewPackage(input: ReviewPackageInput): ReviewPackage {
  assertSafeSessionState(input.state);
  const auditFinalHash = verifyAuditEvents(input.auditEvents, input.state);
  const disclosureFinalHash = verifyDisclosureRecords(input.disclosureRecords, input.state);

  const sourceCounts = Object.fromEntries(DISCLOSURE_SOURCES.map((source) => [source, 0])) as Record<
    DisclosureSource,
    number
  >;
  let originalByteCount = 0;
  let disclosedByteCount = 0;
  let disclosedRecordCount = 0;
  const findings: ReviewPackageBody["disclosures"]["findings"][number][] = [];
  for (const record of input.disclosureRecords) {
    sourceCounts[record.source] += 1;
    originalByteCount = safeAdd(originalByteCount, record.originalByteCount, "disclosure original bytes");
    disclosedByteCount = safeAdd(disclosedByteCount, record.disclosedByteCount, "disclosure bytes");
    if (record.disclosed) disclosedRecordCount += 1;
    for (const finding of record.redactions) {
      findings.push({
        operationId: record.operationId,
        kind: finding.kind,
        severity: finding.severity,
        line: finding.line,
        column: finding.column,
        fingerprint: finding.fingerprint,
      });
    }
  }

  const state = input.state;
  const body: ReviewPackageBody = {
    session: {
      sessionId: state.sessionId,
      taskId: state.taskId,
      status: state.status,
      mode: state.mode,
      completionAuthority: state.completionAuthority ?? "frozen",
      createdAt: state.createdAt,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      ...(state.completedAt === undefined ? {} : { completedAt: state.completedAt }),
    },
    repository: {
      fingerprintSha256: HASH_PATTERN.test(state.repositoryFingerprintAtStart)
        ? state.repositoryFingerprintAtStart
        : sha256(state.repositoryFingerprintAtStart),
    },
    policyHashes: { ...state.policyHashes },
    budgets: {
      limits: { ...state.budgetLimits },
      usage: { ...state.budgetUsage },
      remaining: remainingBudgets(
        state.budgetLimits,
        state.budgetUsage,
        Math.max(0, Date.parse(state.updatedAt) - Date.parse(state.startedAt)),
      ),
    },
    counts: {
      acceptanceCriteria: state.acceptanceCriteria.length,
      preExistingChanges: state.preExistingChanges.length,
      completedOperations: state.completedOperationIds.length,
      pendingOperations: state.pendingOperations.length,
      mutations: state.mutations.length,
      patchMutations: state.mutations.filter(
        (mutation) => mutation.kind !== "terminal",
      ).length,
      terminalMutations: state.mutations.filter(
        (mutation) => mutation.kind === "terminal",
      ).length,
      validations: state.validations.length,
      pendingTerminalEffects:
        state.pendingTerminalEffectOperationIds?.length ?? 0,
    },
    mutations: state.mutations.map((mutation) => {
      const terminal =
        mutation.kind === "terminal"
          ? terminalReviewFacts(mutation)
          : undefined;
      return {
        operationId: mutation.operationId,
        kind: mutation.kind ?? "patch",
        ...(mutation.checkpointId === undefined
          ? {}
          : { checkpointId: mutation.checkpointId }),
        ...(mutation.kind === "terminal"
          ? { observationOutcome: mutation.observationOutcome }
          : {}),
        changedFileCount:
          terminal === undefined
            ? new Set(mutation.changedPaths).size
            : terminal.createdCount +
              terminal.updatedCount +
              terminal.deletedCount +
              terminal.renamedCount,
        changedLines: mutation.changedLines,
        ...(terminal === undefined ? {} : { terminal }),
      };
    }),
    validations: state.validations.map((validation) => ({
      operationId: validation.operationId,
      commandId: validation.commandId,
      outcome: validation.outcome,
      ...(validation.exitCode === undefined ? {} : { exitCode: validation.exitCode }),
      completedAt: validation.completedAt,
      mutationSequence: validation.mutationSequence,
    })),
    pendingOperations: state.pendingOperations.map((operation) => ({
      operationId: operation.operationId,
      tool: operation.tool,
      mutating: operation.mutating,
      requestHash: operation.requestHash,
      status: operation.status,
      acceptedAt: operation.acceptedAt,
    })),
    audit: {
      eventCount: input.auditEvents.length,
      finalHash: auditFinalHash,
    },
    disclosures: {
      recordCount: input.disclosureRecords.length,
      disclosedRecordCount,
      withheldRecordCount: input.disclosureRecords.length - disclosedRecordCount,
      originalByteCount,
      disclosedByteCount,
      redactionCount: findings.length,
      bySource: sourceCounts,
      finalRecordHash: disclosureFinalHash,
      findings,
    },
  };

  return {
    version: REVIEW_PACKAGE_VERSION,
    body,
    integrity: {
      algorithm: "sha256",
      bodySha256: sha256(stableJson(body)),
    },
  };
}

function terminalReviewFacts(
  mutation: Extract<
    SessionState["mutations"][number],
    { readonly kind: "terminal" }
  >,
): NonNullable<ReviewPackageBody["mutations"][number]["terminal"]> {
  const full =
    "recordContract" in mutation &&
    mutation.recordContract === "terminal-mutation/2"
      ? mutation
      : undefined;
  const processOutcome = full?.processOutcome ?? "unavailable";
  const createdCount = full?.createdTotal ?? mutation.createdPaths.length;
  const updatedCount = full?.updatedTotal ?? mutation.updatedPaths.length;
  const deletedCount = full?.deletedTotal ?? mutation.deletedPaths.length;
  const renamedCount = full?.renamedTotal ?? mutation.renamedPaths.length;
  const preExistingTouchedCount =
    full?.preExistingTouchedTotal ??
    mutation.preExistingTouchedPaths.length;
  const changedPathCount =
    full?.changedPathCount ?? new Set(mutation.changedPaths).size;
  const pathEndpointCount =
    full?.pathEndpointTotal ??
    createdCount +
      updatedCount +
      deletedCount +
      renamedCount * 2 +
      preExistingTouchedCount;
  const omittedPathEndpointCount =
    full?.omittedPathEndpointTotal ?? 0;
  const unavailableBaselineCount =
    full?.unavailableBaselineCount ?? 0;
  const pathFactsTruncated = full?.pathFactsTruncated ?? false;
  const legacyEvidence = full === undefined;
  const counts = [
    createdCount,
    updatedCount,
    deletedCount,
    renamedCount,
    preExistingTouchedCount,
    changedPathCount,
    pathEndpointCount,
    omittedPathEndpointCount,
    unavailableBaselineCount,
  ];
  if (!counts.every(isNonNegativeInteger)) {
    throw new AgentError(
      "RECOVERY_REQUIRED",
      "Review-package terminal totals are unsafe",
    );
  }
  const limitationCodes: NonNullable<
    ReviewPackageBody["mutations"][number]["terminal"]
  >["limitationCodes"][number][] = [];
  if (legacyEvidence) limitationCodes.push("legacy_evidence");
  if (
    mutation.observationOutcome === "unknown" ||
    mutation.observationOutcome === "protected_or_hidden_changed"
  ) {
    limitationCodes.push("non_clean_observation");
  }
  if (pathFactsTruncated) {
    limitationCodes.push("path_facts_truncated");
  }
  if (unavailableBaselineCount > 0) {
    limitationCodes.push("unavailable_baselines");
  }
  if (processOutcome === "unavailable") {
    limitationCodes.push("process_outcome_unavailable");
  }
  return {
    processOutcome,
    createdCount,
    updatedCount,
    deletedCount,
    renamedCount,
    preExistingTouchedCount,
    changedPathCount,
    pathEndpointCount,
    omittedPathEndpointCount,
    unavailableBaselineCount,
    pathFactsTruncated,
    legacyEvidence,
    limitationCodes,
  };
}

export function verifyReviewPackage(reviewPackage: ReviewPackage): boolean {
  return reviewPackage.version === REVIEW_PACKAGE_VERSION &&
    reviewPackage.integrity.algorithm === "sha256" &&
    HASH_PATTERN.test(reviewPackage.integrity.bodySha256) &&
    sha256(stableJson(reviewPackage.body)) === reviewPackage.integrity.bodySha256;
}

function verifyAuditEvents(events: readonly AuditEvent[], state: SessionState): string {
  let previousHash = AUDIT_GENESIS_HASH;
  let expectedSequence = 1;
  for (const event of events) {
    if (
      event.schemaVersion !== AUDIT_SCHEMA_VERSION ||
      event.sessionId !== state.sessionId ||
      event.taskId !== state.taskId ||
      event.sequence !== expectedSequence ||
      event.previousHash !== previousHash ||
      !(AUDIT_EVENT_TYPES as readonly string[]).includes(event.type) ||
      !isIsoTimestamp(event.timestamp) ||
      (event.operationId !== undefined && !isJournalOperationId(event.operationId)) ||
      !HASH_PATTERN.test(event.eventHash)
    ) {
      throw new AgentError("RECOVERY_REQUIRED", "Review-package audit metadata is inconsistent");
    }
    const { eventHash, ...body } = event;
    if (sha256(stableJson(body)) !== eventHash) {
      throw new AgentError("RECOVERY_REQUIRED", "Review-package audit integrity check failed", {
        sequence: event.sequence,
      });
    }
    previousHash = eventHash;
    expectedSequence += 1;
  }
  return previousHash;
}

function verifyDisclosureRecords(records: readonly DisclosureRecord[], state: SessionState): string | null {
  let previousHash: string | null = null;
  for (const record of records) {
    if (
      record.version !== DISCLOSURE_LEDGER_VERSION ||
      record.sessionId !== state.sessionId ||
      !isSafeId(record.id) ||
      !isSafeId(record.operationId) ||
      !isIsoTimestamp(record.timestamp) ||
      !(DISCLOSURE_SOURCES as readonly string[]).includes(record.source) ||
      typeof record.disclosed !== "boolean" ||
      !isNonNegativeInteger(record.originalByteCount) ||
      !isNonNegativeInteger(record.disclosedByteCount) ||
      !HASH_PATTERN.test(record.disclosedSha256) ||
      record.previousRecordHash !== previousHash ||
      !HASH_PATTERN.test(record.recordHash) ||
      !Array.isArray(record.redactions) ||
      !record.redactions.every(isSafeRedaction)
    ) {
      throw new AgentError("RECOVERY_REQUIRED", "Review-package disclosure metadata is inconsistent");
    }
    const { recordHash, ...body } = record;
    if (sha256(stableJson(body)) !== recordHash) {
      throw new AgentError("RECOVERY_REQUIRED", "Review-package disclosure integrity check failed", {
        recordId: record.id,
      });
    }
    previousHash = record.recordHash;
  }
  return previousHash;
}

function assertSafeSessionState(state: SessionState): void {
  const statuses: readonly SessionState["status"][] = [
    "created",
    "preflight",
    "grant_pending",
    "transport_starting",
    "initializing_model",
    "awaiting_model",
    "executing_tools",
    "returning_results",
    "awaiting_user",
    "paused",
    "validating_completion",
    "recovering",
    "completed",
    "rolled_back",
    "blocked",
    "aborted",
    "failed",
  ];
  if (
    state.schemaVersion !== SESSION_SCHEMA_VERSION ||
    state.protocolVersion !== "cba/1" ||
    !isSafeId(state.sessionId) ||
    !isSafeId(state.taskId) ||
    !statuses.includes(state.status) ||
    !(["inspect", "edit", "auto"] as const).includes(state.mode) ||
    !isIsoTimestamp(state.createdAt) ||
    !isIsoTimestamp(state.startedAt) ||
    !isIsoTimestamp(state.updatedAt) ||
    (state.completedAt !== undefined && !isIsoTimestamp(state.completedAt)) ||
    typeof state.repositoryFingerprintAtStart !== "string" ||
    state.repositoryFingerprintAtStart.length === 0 ||
    state.repositoryFingerprintAtStart.length > 1024 ||
    !HASH_PATTERN.test(state.repositoryExcludedStateAtStart) ||
    (state.repositoryBranchAtStart !== undefined &&
      state.repositoryBranchAtStart !== null &&
      typeof state.repositoryBranchAtStart !== "string") ||
    (state.repositoryHeadAtStart !== undefined &&
      state.repositoryHeadAtStart !== null &&
      typeof state.repositoryHeadAtStart !== "string") ||
    (state.preExistingChangeStates !== undefined &&
      !Object.entries(state.preExistingChangeStates).every(([key, value]) =>
        key.length > 0 && key.length <= 32_767 && HASH_PATTERN.test(value))) ||
    !Array.isArray(state.acceptanceCriteria) ||
    !Array.isArray(state.preExistingChanges) ||
    !Array.isArray(state.completedOperationIds) ||
    (state.unreturnedOperationIds !== undefined &&
      !Array.isArray(state.unreturnedOperationIds)) ||
    !Array.isArray(state.pendingOperations) ||
    !Array.isArray(state.mutations) ||
    !Array.isArray(state.validations)
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Review-package session state is invalid");
  }
  if (!state.completedOperationIds.every(isJournalOperationId)) {
    throw new AgentError("RECOVERY_REQUIRED", "Review-package completed-operation metadata is unsafe");
  }
  if (
    state.unreturnedOperationIds !== undefined &&
    (
      !state.unreturnedOperationIds.every(isJournalOperationId) ||
      state.unreturnedOperationIds.some(
        (operationId) => !state.completedOperationIds.includes(operationId),
      )
    )
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Review-package unreturned-operation metadata is unsafe");
  }
  if (!Object.values(state.policyHashes).every((value) => HASH_PATTERN.test(value))) {
    throw new AgentError("RECOVERY_REQUIRED", "Review-package policy hashes are invalid");
  }
  if (
    !Object.values(state.budgetLimits).every(isNonNegativeInteger) ||
    !Object.values(state.budgetUsage).every(isNonNegativeInteger)
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Review-package budgets are invalid");
  }
  for (const mutation of state.mutations) {
    if (
      !isOperationId(mutation.operationId) ||
      !["patch", "terminal"].includes(mutation.kind ?? "patch") ||
      (mutation.kind === "terminal"
        ? mutation.checkpointId !== undefined ||
          ![
            "none",
            "observed",
            "protected_or_hidden_changed",
            "unknown",
          ].includes(mutation.observationOutcome)
        : !isSafeId(mutation.checkpointId)) ||
      !Array.isArray(mutation.changedPaths) ||
      !isNonNegativeInteger(mutation.changedLines)
    ) {
      throw new AgentError("RECOVERY_REQUIRED", "Review-package mutation metadata is unsafe");
    }
  }
  for (const validation of state.validations) {
    if (
      !isOperationId(validation.operationId) ||
      !isSafeId(validation.commandId) ||
      !isIsoTimestamp(validation.completedAt) ||
      !isNonNegativeInteger(validation.mutationSequence) ||
      (validation.exitCode !== undefined && !Number.isSafeInteger(validation.exitCode))
    ) {
      throw new AgentError("RECOVERY_REQUIRED", "Review-package validation metadata is unsafe");
    }
  }
  for (const operation of state.pendingOperations) {
    if (
      !isJournalOperationId(operation.operationId) ||
      !isSafeId(operation.tool) ||
      !HASH_PATTERN.test(operation.requestHash) ||
      !isIsoTimestamp(operation.acceptedAt)
    ) {
      throw new AgentError("RECOVERY_REQUIRED", "Review-package pending-operation metadata is unsafe");
    }
  }
}

function isSafeRedaction(redaction: DisclosureRecord["redactions"][number]): boolean {
  return (SECRET_KINDS as readonly string[]).includes(redaction.kind) &&
    (redaction.severity === "high" || redaction.severity === "medium") &&
    isPositiveInteger(redaction.line) &&
    isPositiveInteger(redaction.column) &&
    /^[a-f0-9]{16}$/u.test(redaction.fingerprint);
}

function remainingBudgets(
  limits: BudgetLimits,
  usage: BudgetUsage,
  observedElapsedMs: number,
): ReviewPackageBudgetRemaining {
  return {
    turns: remaining(limits.maxTurns, usage.turns),
    operations: remaining(limits.maxOperations, usage.operations),
    elapsedMs: remaining(limits.maxElapsedMs, observedElapsedMs),
    readFiles: remaining(limits.maxReadFiles, usage.readFiles),
    disclosedBytes: remaining(limits.maxDisclosedBytes, usage.disclosedBytes),
    changedFiles: remaining(limits.maxChangedFiles, usage.changedFiles),
    changedLines: remaining(limits.maxChangedLines, usage.changedLines),
    commands: remaining(limits.maxCommands, usage.commands),
    commandOutputBytes: remaining(limits.maxCommandOutputBytes, usage.commandOutputBytes),
    protocolRepairs: remaining(limits.maxProtocolRepairs, usage.protocolRepairs),
  };
}

function remaining(limit: number, used: number): number {
  return Math.max(0, limit - used);
}

function safeAdd(left: number, right: number, label: string): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) {
    throw new AgentError("RECOVERY_REQUIRED", `Review-package ${label} overflow`);
  }
  return total;
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}
