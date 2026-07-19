import type { SessionState, ValidationRecord } from "../session/types.js";

export interface CompletionClaim {
  readonly summary: string;
  readonly acceptanceCriteria: readonly {
    readonly criterion: string;
    readonly status: "satisfied" | "not_satisfied" | "unknown";
    readonly evidence?: string;
  }[];
  readonly validation: readonly {
    readonly commandId: string;
    readonly status: "passed" | "failed" | "not_run";
    readonly summary: string;
  }[];
  readonly skippedValidation: readonly string[];
  readonly remainingRisks: readonly string[];
  readonly recommendedFollowUp: readonly string[];
}

export interface RepositoryCompletionState {
  readonly pathKey: (value: string) => string;
  readonly known: boolean;
  readonly fingerprint: string;
  readonly excludedStateFingerprint: string;
  readonly hasConflicts: boolean;
  readonly branch?: string | null;
  readonly head?: string | null;
  readonly pathStateFingerprints?: Readonly<Record<string, string>>;
  readonly changedPaths: readonly string[];
  readonly outOfScopePaths: readonly string[];
  readonly gitStatusSummary: string;
}

export interface CompletionRequirements {
  readonly requiredCommandIds: readonly string[];
  readonly requireValidationAfterLastMutation: boolean;
  readonly requireCleanPendingOperations: boolean;
}

export interface CompletionVerification {
  readonly accepted: boolean;
  readonly reasons: readonly string[];
  readonly actual: {
    readonly changedPaths: readonly string[];
    readonly agentChangedPaths: readonly string[];
    readonly preExistingPaths: readonly string[];
    readonly successfulCommands: readonly string[];
    readonly failedCommands: readonly string[];
    readonly checkpointId?: string;
    readonly gitStatusSummary: string;
    readonly repositoryFingerprint: string;
  };
}

export function verifyCompletion(
  state: SessionState,
  claim: CompletionClaim,
  repository: RepositoryCompletionState,
  requirements: CompletionRequirements,
): CompletionVerification {
  const reasons: string[] = [];
  const pathKey = repository.pathKey;
  if (!repository.known) reasons.push("Repository state could not be established.");
  if (repository.hasConflicts) reasons.push("Repository contains unresolved merge conflicts.");
  if (repository.excludedStateFingerprint !== state.repositoryExcludedStateAtStart) {
    reasons.push("Policy-hidden repository state changed after the session grant was established.");
  }
  if (state.repositoryBranchAtStart !== undefined && repository.branch !== state.repositoryBranchAtStart) {
    reasons.push("Repository branch changed after the session grant was established.");
  }
  if (state.repositoryHeadAtStart !== undefined && repository.head !== state.repositoryHeadAtStart) {
    reasons.push("Repository HEAD changed after the session grant was established.");
  }
  const preExisting = new Set(state.preExistingChanges.map(pathKey));
  const newOutOfScopePaths = repository.outOfScopePaths.filter((candidate) => !preExisting.has(pathKey(candidate)));
  if (newOutOfScopePaths.length > 0) {
    reasons.push(`Changes made after session start exist outside the grant: ${newOutOfScopePaths.join(", ")}.`);
  }
  const changedPreExistingOutOfScopePaths = repository.outOfScopePaths.filter((candidate) => {
    const key = pathKey(candidate);
    if (!preExisting.has(key)) return false;
    const before = state.preExistingChangeStates?.[key];
    const current = repository.pathStateFingerprints?.[key];
    return before === undefined || current === undefined || before !== current;
  });
  if (changedPreExistingOutOfScopePaths.length > 0) {
    reasons.push(
      `Pre-existing out-of-scope changes were modified during the session: ${changedPreExistingOutOfScopePaths.join(", ")}.`,
    );
  }
  if (requirements.requireCleanPendingOperations && state.pendingOperations.length > 0) {
    reasons.push(`${state.pendingOperations.length} tool operation(s) remain unresolved.`);
  }
  if (state.submission?.state === "indeterminate") {
    reasons.push("The most recent browser submission has indeterminate delivery state.");
  }

  const latestValidation = state.validations.at(-1);
  const latestMutation = state.mutations.at(-1);
  const expectedRepositoryFingerprint =
    latestValidation !== undefined && latestValidation.mutationSequence === state.mutationSequence
      ? latestValidation.repositoryFingerprint
      : latestMutation?.repositoryFingerprint ?? state.repositoryFingerprintAtStart;
  const hasRecordedEffect = latestValidation !== undefined || latestMutation !== undefined;
  const hasAuthoritativeFingerprint =
    expectedRepositoryFingerprint !== undefined && /^[a-f0-9]{64}$/u.test(expectedRepositoryFingerprint);
  if (
    (hasRecordedEffect && !hasAuthoritativeFingerprint) ||
    (hasAuthoritativeFingerprint && expectedRepositoryFingerprint !== repository.fingerprint)
  ) {
    reasons.push("Repository state changed after the most recent recorded tool effect.");
  }

  const latestByCommand = newestValidationByCommand(state.validations);
  const claimedValidation = new Map<string, CompletionClaim["validation"][number]>();
  for (const entry of claim.validation) {
    if (claimedValidation.has(entry.commandId)) {
      reasons.push(`Copilot reported validation '${entry.commandId}' more than once.`);
      continue;
    }
    claimedValidation.set(entry.commandId, entry);
  }
  for (const [commandId, record] of latestByCommand) {
    const reported = claimedValidation.get(commandId);
    if (reported === undefined) {
      reasons.push(`Copilot omitted the latest outcome for executed command '${commandId}'.`);
      continue;
    }
    const expectedStatus = record.outcome === "success" ? "passed" : "failed";
    if (reported.status !== expectedStatus) {
      reasons.push(
        `Copilot reported command '${commandId}' as ${reported.status}, but its latest local outcome requires ${expectedStatus}.`,
      );
    }
  }
  for (const commandId of claimedValidation.keys()) {
    if (!latestByCommand.has(commandId)) {
      reasons.push(`Copilot reported validation '${commandId}' although that command did not run.`);
    }
  }
  for (const commandId of requirements.requiredCommandIds) {
    const record = latestByCommand.get(commandId);
    if (!record) {
      reasons.push(`Required validation '${commandId}' has not run.`);
      continue;
    }
    if (record.outcome !== "success") {
      reasons.push(`Required validation '${commandId}' most recently ended with ${record.outcome}.`);
    }
    if (requirements.requireValidationAfterLastMutation && record.mutationSequence < state.mutationSequence) {
      reasons.push(`Required validation '${commandId}' is stale relative to the latest mutation.`);
    }
    if (record.repositoryFingerprint !== repository.fingerprint) {
      reasons.push(`Required validation '${commandId}' is stale relative to the current repository state.`);
    }
    const claimRecord = claimedValidation.get(commandId);
    if (claimRecord === undefined || claimRecord.status !== "passed") {
      reasons.push(`Copilot's completion report does not identify required validation '${commandId}' as passed.`);
    }
  }

  if (claim.summary.trim().length === 0) reasons.push("Copilot supplied an empty completion summary.");
  const claimedCriteria = new Map<string, CompletionClaim["acceptanceCriteria"][number]>();
  for (const entry of claim.acceptanceCriteria) {
    if (claimedCriteria.has(entry.criterion)) {
      reasons.push(`Copilot reported acceptance criterion '${entry.criterion}' more than once.`);
      continue;
    }
    claimedCriteria.set(entry.criterion, entry);
  }
  for (const criterion of state.acceptanceCriteria) {
    const reported = claimedCriteria.get(criterion);
    if (reported === undefined || reported.status !== "satisfied") {
      reasons.push(`Copilot did not identify acceptance criterion '${criterion}' as satisfied.`);
    }
  }

  const successfulCommands = [...latestByCommand]
    .filter(([, record]) => record.outcome === "success")
    .map(([commandId]) => commandId);
  const failedCommands = [...latestByCommand]
    .filter(([, record]) => record.outcome !== "success")
    .map(([commandId]) => commandId);

  const agentChangedPaths = [...new Set(state.mutations.flatMap((mutation) => mutation.changedPaths))];

  return {
    accepted: reasons.length === 0,
    reasons,
    actual: {
      changedPaths: [...repository.changedPaths],
      agentChangedPaths,
      preExistingPaths: [...state.preExistingChanges],
      successfulCommands: [...new Set(successfulCommands)],
      failedCommands: [...new Set(failedCommands)],
      ...(state.lastCheckpointId === undefined ? {} : { checkpointId: state.lastCheckpointId }),
      gitStatusSummary: repository.gitStatusSummary,
      repositoryFingerprint: repository.fingerprint,
    },
  };
}

function newestValidationByCommand(records: readonly ValidationRecord[]): ReadonlyMap<string, ValidationRecord> {
  const map = new Map<string, ValidationRecord>();
  for (const record of records) {
    map.set(record.commandId, record);
  }
  return map;
}
