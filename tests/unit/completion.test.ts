import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveCompletionAuthority,
  verifyCompletion,
  type CompletionClaim,
} from "../../src/orchestrator/completion.js";
import {
  DEFAULT_BUDGET_LIMITS,
  SESSION_SCHEMA_VERSION,
  type FullTerminalMutationRecord,
  type SessionState,
  zeroBudgetUsage,
} from "../../src/session/types.js";
import { createFilesystemIdentity } from "../../src/shared/filesystem-identity.js";

const claim: CompletionClaim = {
  summary: "Implemented the requested behavior.",
  acceptanceCriteria: [{ criterion: "Tests pass", status: "satisfied", evidence: "Latest test passed" }],
  validation: [{ commandId: "test", status: "passed", summary: "Latest test passed" }],
  skippedValidation: [],
  remainingRisks: [],
  recommendedFollowUp: ["Review the diff"],
};
const currentFingerprint = "d".repeat(64);
const driftFingerprint = "e".repeat(64);
const excludedFingerprint = "0".repeat(64);
const completionPathKey = (value: string): string => value.replaceAll("\\", "/");

function fullTerminalMutation(
  overrides: Partial<FullTerminalMutationRecord> = {},
): FullTerminalMutationRecord {
  const operationId = overrides.operationId ?? "op_terminal_observed";
  const changedPaths = overrides.changedPaths ?? ["src/terminal.ts"];
  const createdPaths = overrides.createdPaths ?? [];
  const updatedPaths = overrides.updatedPaths ?? changedPaths;
  const deletedPaths = overrides.deletedPaths ?? [];
  const renamedPaths = overrides.renamedPaths ?? [];
  const preExistingTouchedPaths =
    overrides.preExistingTouchedPaths ?? [];
  const createdTotal = overrides.createdTotal ?? createdPaths.length;
  const updatedTotal = overrides.updatedTotal ?? updatedPaths.length;
  const deletedTotal = overrides.deletedTotal ?? deletedPaths.length;
  const renamedTotal = overrides.renamedTotal ?? renamedPaths.length;
  const preExistingTouchedTotal =
    overrides.preExistingTouchedTotal ?? preExistingTouchedPaths.length;
  const pathEndpointTotal =
    overrides.pathEndpointTotal ??
    createdTotal +
      updatedTotal +
      deletedTotal +
      renamedTotal * 2 +
      preExistingTouchedTotal;
  const retainedEndpointTotal =
    createdPaths.length +
    updatedPaths.length +
    deletedPaths.length +
    renamedPaths.length * 2 +
    preExistingTouchedPaths.length;
  const observationOutcome =
    overrides.observationOutcome ?? "observed";
  const common = {
    kind: "terminal" as const,
    recordContract: "terminal-mutation/2" as const,
    operationId,
    changedPaths,
    changedLines: overrides.changedLines ?? 3,
    createdPaths,
    updatedPaths,
    deletedPaths,
    renamedPaths,
    preExistingTouchedPaths,
    processOutcome: overrides.processOutcome ?? "completed",
    createdTotal,
    updatedTotal,
    deletedTotal,
    renamedTotal,
    preExistingTouchedTotal,
    changedPathCount:
      overrides.changedPathCount ?? changedPaths.length,
    pathEndpointTotal,
    omittedPathEndpointTotal:
      overrides.omittedPathEndpointTotal ??
      pathEndpointTotal - retainedEndpointTotal,
    pathFactsTruncated:
      overrides.pathFactsTruncated ??
      pathEndpointTotal > retainedEndpointTotal,
    pathFactsSha256: overrides.pathFactsSha256 ?? "4".repeat(64),
    unavailableBaselineCount:
      overrides.unavailableBaselineCount ?? 0,
    completedAt:
      overrides.completedAt ?? "2026-01-01T00:00:30.000Z",
    preObservation: overrides.preObservation ?? {
      kind: "terminal-pre-observation" as const,
      id: operationId,
      bytes: 10,
      sha256: "1".repeat(64),
    },
    postObservation: overrides.postObservation ?? {
      kind: "terminal-post-observation" as const,
      id: operationId,
      bytes: 10,
      sha256: "2".repeat(64),
    },
    terminalResult: overrides.terminalResult ?? {
      kind: "terminal-result" as const,
      id: operationId,
      bytes: 10,
      sha256: "3".repeat(64),
    },
  };
  if (observationOutcome === "observed") {
    return {
      ...common,
      observationOutcome,
      repositoryFingerprint:
        overrides.repositoryFingerprint ?? currentFingerprint,
      postObservationControl: overrides.postObservationControl ?? {
        branch: "feature",
        head: "a".repeat(40),
        excludedStateFingerprint: excludedFingerprint,
      },
    };
  }
  return {
    ...common,
    observationOutcome,
  };
}

function completionRepository(
  overrides: Partial<Parameters<typeof verifyCompletion>[2]> = {},
): Parameters<typeof verifyCompletion>[2] {
  return {
    pathKey: completionPathKey,
    known: true,
    fingerprint: currentFingerprint,
    excludedStateFingerprint: excludedFingerprint,
    hasConflicts: false,
    branch: "feature",
    head: "a".repeat(40),
    changedPaths: ["src/a.ts"],
    outOfScopePaths: [],
    gitStatusSummary: "M src/a.ts",
    ...overrides,
  };
}

const completionRequirements = {
  requiredCommandIds: ["test"],
  requireValidationAfterLastMutation: true,
  requireCleanPendingOperations: true,
} as const;

function state(): SessionState {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    protocolVersion: "cba/1",
    sessionId: "session_12345678",
    taskId: "task_12345678",
    repositoryRoot: "/repo",
    repositoryFingerprintAtStart: "abc",
    repositoryExcludedStateAtStart: excludedFingerprint,
    preExistingChanges: [],
    objective: "Fix",
    acceptanceCriteria: ["Tests pass"],
    mode: "auto",
    status: "validating_completion",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    policyHashes: { organization: "a".repeat(64), repository: "b".repeat(64), grant: "c".repeat(64) },
    budgetLimits: DEFAULT_BUDGET_LIMITS,
    budgetUsage: zeroBudgetUsage(),
    turnSequence: 4,
    mutationSequence: 1,
    pendingOperations: [],
    completedOperationIds: [],
    mutations: [],
    validations: [
      {
        operationId: "op_test",
        commandId: "test",
        outcome: "success",
        exitCode: 0,
        completedAt: "2026-01-01T00:01:00.000Z",
        mutationSequence: 1,
        repositoryFingerprint: currentFingerprint,
      },
    ],
    protocolRepairStreak: 0,
  };
}

test("completion authority defaults legacy sessions to frozen", () => {
  assert.equal(effectiveCompletionAuthority({}), "frozen");
  assert.equal(
    effectiveCompletionAuthority({ completionAuthority: "observed" }),
    "observed",
  );
});

test("completion verifier accepts known, in-scope, freshly validated state", () => {
  const result = verifyCompletion(
    state(),
    claim,
    { pathKey: completionPathKey, known: true, fingerprint: currentFingerprint, excludedStateFingerprint: excludedFingerprint, hasConflicts: false, changedPaths: ["src/a.ts"], outOfScopePaths: [], gitStatusSummary: "M src/a.ts" },
    { requiredCommandIds: ["test"], requireValidationAfterLastMutation: true, requireCleanPendingOperations: true },
  );
  assert.equal(result.accepted, true);
  assert.deepEqual(result.actual.successfulCommands, ["test"]);
  assert.equal(result.actual.work, undefined);
  assert.equal(result.actual.terminal, undefined);
});

test("informational answers complete only when the session has not mutated project files", () => {
  const answerState = state();
  answerState.mutationSequence = 0;
  answerState.validations = [];
  const answerClaim: CompletionClaim = {
    ...claim,
    kind: "answer",
    basis: {
      observedFiles: ["README.md"],
      toolResultRefs: ["op_read_readme"],
    },
    validation: [],
  };
  answerState.completedOperationIds.push("op_read_readme");
  const repository = {
    pathKey: completionPathKey,
    known: true,
    fingerprint: currentFingerprint,
    excludedStateFingerprint: excludedFingerprint,
    hasConflicts: false,
    changedPaths: [],
    outOfScopePaths: [],
    gitStatusSummary: "clean",
  };
  const requirements = {
    requiredCommandIds: [],
    requireValidationAfterLastMutation: true,
    requireCleanPendingOperations: true,
  };

  const accepted = verifyCompletion(answerState, answerClaim, repository, requirements);
  assert.equal(accepted.accepted, true);

  const unsupported = verifyCompletion(answerState, {
    ...answerClaim,
    basis: { toolResultRefs: ["op_invented"] },
  }, repository, requirements);
  assert.equal(unsupported.accepted, false);
  assert.match(unsupported.reasons.join(" "), /unknown tool result/iu);

  const unprovenObservation = verifyCompletion(answerState, {
    ...answerClaim,
    basis: { observedFiles: ["invented.md"] },
  }, repository, requirements);
  assert.equal(unprovenObservation.accepted, false);
  assert.match(unprovenObservation.reasons.join(" "), /cite a completed tool result/iu);

  const userContextOnly = verifyCompletion(answerState, {
    ...answerClaim,
    basis: { userProvidedContext: true },
  }, repository, requirements);
  assert.equal(userContextOnly.accepted, true);

  answerState.mutations.push({
    operationId: "op_patch",
    checkpointId: "checkpoint_1",
    changedPaths: ["src/a.ts"],
    changedLines: 1,
    completedAt: "2026-01-01T00:01:00.000Z",
    repositoryFingerprint: currentFingerprint,
  });
  const rejected = verifyCompletion(answerState, answerClaim, repository, requirements);
  assert.equal(rejected.accepted, false);
  assert.match(rejected.reasons.join(" "), /informational answer.*mutated/iu);
});

test("completion verifier rejects stale validation and unresolved work", () => {
  const current = state();
  current.mutationSequence = 2;
  current.pendingOperations.push({
    operationId: "op_pending",
    tool: "apply_patch",
    mutating: true,
    requestHash: "a".repeat(64),
    status: "indeterminate",
    acceptedAt: "2026-01-01T00:02:00.000Z",
  });
  const result = verifyCompletion(
    current,
    claim,
    { pathKey: completionPathKey, known: true, fingerprint: currentFingerprint, excludedStateFingerprint: excludedFingerprint, hasConflicts: false, changedPaths: [], outOfScopePaths: [], gitStatusSummary: "clean" },
    { requiredCommandIds: ["test"], requireValidationAfterLastMutation: true, requireCleanPendingOperations: true },
  );
  assert.equal(result.accepted, false);
  assert.match(result.reasons.join(" "), /unresolved/);
  assert.match(result.reasons.join(" "), /stale/);
});

test("completion rejects terminal effects until project attribution is durable", () => {
  const current = state();
  current.pendingTerminalEffectOperationIds = ["op_terminal_pending"];
  const result = verifyCompletion(
    current,
    claim,
    {
      pathKey: completionPathKey,
      known: true,
      fingerprint: currentFingerprint,
      excludedStateFingerprint: excludedFingerprint,
      hasConflicts: false,
      changedPaths: [],
      outOfScopePaths: [],
      gitStatusSummary: "clean",
    },
    {
      requiredCommandIds: ["test"],
      requireValidationAfterLastMutation: true,
      requireCleanPendingOperations: true,
    },
  );
  assert.equal(result.accepted, false);
  assert.match(
    result.reasons.join(" "),
    /terminal operation.*require project-effect attribution/iu,
  );
});

test("completion verifier rejects repository fingerprint drift and merge conflicts", () => {
  const fingerprintDrift = verifyCompletion(
    state(),
    claim,
    {
      pathKey: completionPathKey,
      known: true,
      fingerprint: driftFingerprint,
      excludedStateFingerprint: excludedFingerprint,
      hasConflicts: false,
      changedPaths: ["src/a.ts"],
      outOfScopePaths: [],
      gitStatusSummary: "M src/a.ts",
    },
    { requiredCommandIds: ["test"], requireValidationAfterLastMutation: true, requireCleanPendingOperations: true },
  );
  assert.equal(fingerprintDrift.accepted, false);
  assert.match(fingerprintDrift.reasons.join(" "), /current repository state/);

  const conflict = verifyCompletion(
    state(),
    claim,
    {
      pathKey: completionPathKey,
      known: true,
      fingerprint: currentFingerprint,
      excludedStateFingerprint: excludedFingerprint,
      hasConflicts: true,
      changedPaths: ["src/a.ts"],
      outOfScopePaths: [],
      gitStatusSummary: "conflicts present",
    },
    { requiredCommandIds: ["test"], requireValidationAfterLastMutation: true, requireCleanPendingOperations: true },
  );
  assert.equal(conflict.accepted, false);
  assert.match(conflict.reasons.join(" "), /merge conflicts/);
});

test("completion verifier binds the start baseline and pre-existing out-of-scope state", () => {
  const noEffects = state();
  noEffects.mutationSequence = 0;
  noEffects.validations = [];
  noEffects.repositoryFingerprintAtStart = currentFingerprint;
  const externalDrift = verifyCompletion(
    noEffects,
    { ...claim, validation: [] },
    {
      pathKey: completionPathKey,
      known: true,
      fingerprint: driftFingerprint,
      excludedStateFingerprint: excludedFingerprint,
      hasConflicts: false,
      changedPaths: [],
      outOfScopePaths: [],
      gitStatusSummary: "clean",
    },
    { requiredCommandIds: [], requireValidationAfterLastMutation: true, requireCleanPendingOperations: true },
  );
  assert.equal(externalDrift.accepted, false);
  assert.match(externalDrift.reasons.join(" "), /most recent recorded tool effect/);

  const preExisting = state();
  preExisting.preExistingChanges = ["outside.txt"];
  preExisting.preExistingChangeStates = { "outside.txt": "a".repeat(64) };
  const modifiedPreExisting = verifyCompletion(
    preExisting,
    claim,
    {
      pathKey: completionPathKey,
      known: true,
      fingerprint: currentFingerprint,
      excludedStateFingerprint: excludedFingerprint,
      hasConflicts: false,
      changedPaths: ["outside.txt"],
      outOfScopePaths: ["outside.txt"],
      pathStateFingerprints: { "outside.txt": "b".repeat(64) },
      gitStatusSummary: "M outside.txt",
    },
    { requiredCommandIds: ["test"], requireValidationAfterLastMutation: true, requireCleanPendingOperations: true },
  );
  assert.equal(modifiedPreExisting.accepted, false);
  assert.match(modifiedPreExisting.reasons.join(" "), /Pre-existing out-of-scope/);
});

test("completion verifier rejects branch or HEAD drift even when content validation is fresh", () => {
  const current = state();
  current.repositoryBranchAtStart = "main";
  current.repositoryHeadAtStart = "a".repeat(40);
  const result = verifyCompletion(
    current,
    claim,
    {
      pathKey: completionPathKey,
      known: true,
      fingerprint: currentFingerprint,
      excludedStateFingerprint: excludedFingerprint,
      hasConflicts: false,
      branch: "feature",
      head: "b".repeat(40),
      changedPaths: [],
      outOfScopePaths: [],
      gitStatusSummary: "clean",
    },
    { requiredCommandIds: ["test"], requireValidationAfterLastMutation: true, requireCleanPendingOperations: true },
  );
  assert.equal(result.accepted, false);
  assert.match(result.reasons.join(" "), /branch changed/);
  assert.match(result.reasons.join(" "), /HEAD changed/);
});

test("completion verifier requires every criterion and an explicit passed validation claim", () => {
  const current: SessionState = { ...state(), acceptanceCriteria: ["Tests pass", "No regression"] };
  const result = verifyCompletion(
    current,
    { ...claim, validation: [{ commandId: "test", status: "failed", summary: "model misreported it" }] },
    { pathKey: completionPathKey, known: true, fingerprint: currentFingerprint, excludedStateFingerprint: excludedFingerprint, hasConflicts: false, changedPaths: [], outOfScopePaths: [], gitStatusSummary: "clean" },
    { requiredCommandIds: ["test"], requireValidationAfterLastMutation: true, requireCleanPendingOperations: true },
  );
  assert.equal(result.accepted, false);
  assert.match(result.reasons.join(" "), /No regression/);
  assert.match(result.reasons.join(" "), /does not identify required validation/);
});

test("completion verifier reconciles every latest command outcome and rejects invented claims", () => {
  const current = state();
  current.validations.push({
    operationId: "op_optional",
    commandId: "optional-check",
    outcome: "failure",
    exitCode: 1,
    completedAt: "2026-01-01T00:02:00.000Z",
    mutationSequence: 1,
    repositoryFingerprint: currentFingerprint,
  });
  const omitted = verifyCompletion(
    current,
    claim,
    { pathKey: completionPathKey, known: true, fingerprint: currentFingerprint, excludedStateFingerprint: excludedFingerprint, hasConflicts: false, changedPaths: [], outOfScopePaths: [], gitStatusSummary: "clean" },
    { requiredCommandIds: ["test"], requireValidationAfterLastMutation: true, requireCleanPendingOperations: true },
  );
  assert.equal(omitted.accepted, false);
  assert.match(omitted.reasons.join(" "), /omitted.*optional-check/iu);

  const falsePass = verifyCompletion(
    current,
    {
      ...claim,
      validation: [
        ...claim.validation,
        { commandId: "optional-check", status: "passed", summary: "claimed success" },
        { commandId: "never-ran", status: "passed", summary: "invented" },
      ],
    },
    { pathKey: completionPathKey, known: true, fingerprint: currentFingerprint, excludedStateFingerprint: excludedFingerprint, hasConflicts: false, changedPaths: [], outOfScopePaths: [], gitStatusSummary: "clean" },
    { requiredCommandIds: ["test"], requireValidationAfterLastMutation: true, requireCleanPendingOperations: true },
  );
  assert.equal(falsePass.accepted, false);
  assert.match(falsePass.reasons.join(" "), /requires failed/iu);
  assert.match(falsePass.reasons.join(" "), /did not run/iu);
  assert.deepEqual(falsePass.actual.successfulCommands, ["test"]);
  assert.deepEqual(falsePass.actual.failedCommands, ["optional-check"]);
});

test("completion verifier rejects policy-hidden state drift without disclosing a path", () => {
  const result = verifyCompletion(
    state(),
    claim,
    {
      pathKey: completionPathKey,
      known: true,
      fingerprint: currentFingerprint,
      excludedStateFingerprint: "9".repeat(64),
      hasConflicts: false,
      changedPaths: [],
      outOfScopePaths: [],
      gitStatusSummary: "policy-visible tree clean; hidden changes present",
    },
    { requiredCommandIds: ["test"], requireValidationAfterLastMutation: true, requireCleanPendingOperations: true },
  );
  assert.equal(result.accepted, false);
  assert.match(result.reasons.join(" "), /Policy-hidden repository state changed/);
  assert.equal(result.reasons.join(" ").includes(".cba"), false);
});

test("completion verifier does not attribute pre-existing out-of-scope changes to the agent", () => {
  const unchangedState = "f".repeat(64);
  const current: SessionState = {
    ...state(),
    preExistingChanges: ["notes/local.txt"],
    preExistingChangeStates: { "notes/local.txt": unchangedState },
  };
  const result = verifyCompletion(
    current,
    claim,
    {
      pathKey: completionPathKey,
      known: true,
      fingerprint: currentFingerprint,
      excludedStateFingerprint: excludedFingerprint,
      hasConflicts: false,
      changedPaths: ["notes/local.txt", "src/a.ts"],
      outOfScopePaths: ["notes/local.txt"],
      pathStateFingerprints: { "notes/local.txt": unchangedState },
      gitStatusSummary: "dirty",
    },
    { requiredCommandIds: ["test"], requireValidationAfterLastMutation: true, requireCleanPendingOperations: true },
  );
  assert.equal(result.accepted, true);
  assert.deepEqual(result.actual.preExistingPaths, ["notes/local.txt"]);
});

test("completion verifier cannot bypass pre-existing state through case or Unicode aliases", () => {
  const identity = createFilesystemIdentity({
    device: 1,
    caseSensitive: false,
    unicodeNormalizationAliases: true,
  });
  const unchangedState = "a".repeat(64);
  const original = "Notes/CAFÉ.txt";
  const alias = "notes/cafe\u0301.txt";
  const current: SessionState = {
    ...state(),
    preExistingChanges: [original],
    preExistingChangeStates: { [identity.pathKey(original)]: unchangedState },
  };
  const result = verifyCompletion(
    current,
    claim,
    {
      pathKey: identity.pathKey,
      known: true,
      fingerprint: currentFingerprint,
      excludedStateFingerprint: excludedFingerprint,
      hasConflicts: false,
      changedPaths: [alias],
      outOfScopePaths: [alias],
      pathStateFingerprints: { [identity.pathKey(alias)]: unchangedState },
      gitStatusSummary: "dirty",
    },
    { requiredCommandIds: ["test"], requireValidationAfterLastMutation: true, requireCleanPendingOperations: true },
  );
  assert.equal(result.accepted, true);
});

test("observed authority completes terminal then patch after fresh validation against the terminal control anchor", () => {
  const current: SessionState = {
    ...state(),
    completionAuthority: "observed",
    repositoryBranchAtStart: "main",
    repositoryHeadAtStart: "0".repeat(40),
    mutationSequence: 2,
    mutations: [
      fullTerminalMutation({
        preExistingTouchedPaths: ["notes/user.txt"],
        preExistingTouchedTotal: 1,
        pathEndpointTotal: 2,
      }),
      {
        operationId: "op_patch_after_terminal",
        checkpointId: "checkpoint_after_terminal",
        changedPaths: ["src/a.ts"],
        changedLines: 1,
        completedAt: "2026-01-01T00:00:45.000Z",
        repositoryFingerprint: currentFingerprint,
      },
    ],
    validations: [{
      ...state().validations[0]!,
      mutationSequence: 2,
      repositoryFingerprint: currentFingerprint,
    }],
  };

  const result = verifyCompletion(
    current,
    claim,
    completionRepository(),
    completionRequirements,
  );

  assert.equal(result.accepted, true);
  assert.deepEqual(result.actual.work, {
    patchChangedPaths: ["src/a.ts"],
    terminalChangedPaths: ["src/terminal.ts"],
    terminalPreExistingTouchedPaths: ["notes/user.txt"],
  });
  assert.deepEqual(result.actual.terminal?.processOutcomes, [{
    operationId: "op_terminal_observed",
    outcome: "completed",
  }]);
  assert.deepEqual(result.actual.terminal?.limitations, []);
});

test("observed authority cannot launder terminal control drift through a later passing validation", () => {
  const current: SessionState = {
    ...state(),
    completionAuthority: "observed",
    mutationSequence: 1,
    mutations: [fullTerminalMutation()],
    validations: [{
      ...state().validations[0]!,
      mutationSequence: 1,
      repositoryFingerprint: currentFingerprint,
    }],
  };
  const result = verifyCompletion(
    current,
    claim,
    completionRepository({
      branch: "manual-branch",
      head: "b".repeat(40),
      excludedStateFingerprint: "9".repeat(64),
    }),
    completionRequirements,
  );

  assert.equal(result.accepted, false);
  assert.match(result.reasons.join(" "), /branch changed.*latest observed/iu);
  assert.match(result.reasons.join(" "), /HEAD changed.*latest observed/iu);
  assert.match(
    result.reasons.join(" "),
    /Policy-hidden repository state changed.*latest observed/iu,
  );
});

test("repeated observed terminals use the latest complete control anchor", () => {
  const current: SessionState = {
    ...state(),
    completionAuthority: "observed",
    mutationSequence: 2,
    mutations: [
      fullTerminalMutation({
        operationId: "op_terminal_first",
        postObservationControl: {
          branch: "first",
          head: "1".repeat(40),
          excludedStateFingerprint: "1".repeat(64),
        },
      }),
      fullTerminalMutation({
        operationId: "op_terminal_latest",
        repositoryFingerprint: currentFingerprint,
        postObservationControl: {
          branch: "latest",
          head: "2".repeat(40),
          excludedStateFingerprint: "2".repeat(64),
        },
      }),
    ],
    validations: [{
      ...state().validations[0]!,
      mutationSequence: 2,
      repositoryFingerprint: currentFingerprint,
    }],
  };

  const result = verifyCompletion(
    current,
    claim,
    completionRepository({
      branch: "latest",
      head: "2".repeat(40),
      excludedStateFingerprint: "2".repeat(64),
    }),
    completionRequirements,
  );
  assert.equal(result.accepted, true);
});

test("observed authority rejects legacy observed evidence without a control anchor", () => {
  const current: SessionState = {
    ...state(),
    completionAuthority: "observed",
    mutations: [{
      kind: "terminal",
      operationId: "op_terminal_legacy",
      changedPaths: ["src/legacy.ts"],
      changedLines: 1,
      createdPaths: [],
      updatedPaths: ["src/legacy.ts"],
      deletedPaths: [],
      renamedPaths: [],
      preExistingTouchedPaths: [],
      completedAt: "2026-01-01T00:00:30.000Z",
      observationOutcome: "observed",
      terminalResult: {
        kind: "terminal-result",
        id: "op_terminal_legacy",
        bytes: 10,
        sha256: "3".repeat(64),
      },
      repositoryFingerprint: currentFingerprint,
    }],
  };

  const result = verifyCompletion(
    current,
    claim,
    completionRepository(),
    completionRequirements,
  );
  assert.equal(result.accepted, false);
  assert.match(result.reasons.join(" "), /lacks a complete authoritative control anchor/iu);
});

test("observed authority fails closed on a partial terminal control anchor", () => {
  const mutation = fullTerminalMutation() as unknown as {
    postObservationControl: unknown;
  };
  mutation.postObservationControl = { branch: "feature" };
  const current: SessionState = {
    ...state(),
    completionAuthority: "observed",
    mutations: [
      mutation as SessionState["mutations"][number],
    ],
  };

  const result = verifyCompletion(
    current,
    claim,
    completionRepository(),
    completionRequirements,
  );
  assert.equal(result.accepted, false);
  assert.match(result.reasons.join(" "), /lacks a complete authoritative control anchor/iu);
});

test("non-clean terminal evidence remains authority-independent and cannot fall back through a later patch", () => {
  for (const completionAuthority of ["frozen", "observed"] as const) {
    for (
      const observationOutcome of [
        "unknown",
        "protected_or_hidden_changed",
      ] as const
    ) {
      const current: SessionState = {
        ...state(),
        completionAuthority,
        mutationSequence: 2,
        mutations: [
          fullTerminalMutation({
            observationOutcome,
            unavailableBaselineCount: 1,
          }),
          {
            operationId: "op_patch_after_non_clean",
            checkpointId: "checkpoint_after_non_clean",
            changedPaths: ["src/a.ts"],
            changedLines: 1,
            completedAt: "2026-01-01T00:00:45.000Z",
            repositoryFingerprint: currentFingerprint,
          },
        ],
        validations: [{
          ...state().validations[0]!,
          mutationSequence: 2,
          repositoryFingerprint: currentFingerprint,
        }],
      };

      const result = verifyCompletion(
        current,
        claim,
        completionRepository(),
        completionRequirements,
      );
      assert.equal(
        result.accepted,
        false,
        `${completionAuthority}:${observationOutcome}`,
      );
      assert.match(result.reasons.join(" "), /non-clean project-effect/iu);
      assert.match(
        result.reasons.join(" "),
        /latest terminal mutation lacks an authoritative repository fingerprint/iu,
      );
    }
  }
});

test("observed authority always requires clean journal state and fresh configured validation", () => {
  const current: SessionState = {
    ...state(),
    completionAuthority: "observed",
    mutationSequence: 1,
    mutations: [fullTerminalMutation()],
    pendingOperations: [{
      operationId: "op_pending_observed",
      tool: "read_file",
      mutating: false,
      requestHash: "a".repeat(64),
      status: "accepted",
      acceptedAt: "2026-01-01T00:00:40.000Z",
    }],
    validations: [{
      ...state().validations[0]!,
      mutationSequence: 0,
      repositoryFingerprint: currentFingerprint,
    }],
  };

  const result = verifyCompletion(
    current,
    claim,
    completionRepository(),
    {
      ...completionRequirements,
      requireValidationAfterLastMutation: false,
      requireCleanPendingOperations: false,
    },
  );
  assert.equal(result.accepted, false);
  assert.match(result.reasons.join(" "), /remain unresolved/iu);
  assert.match(result.reasons.join(" "), /stale relative to the latest mutation/iu);
});

test("observed terminal authority preserves the effective write-scope gate", () => {
  const current: SessionState = {
    ...state(),
    completionAuthority: "observed",
    mutationSequence: 1,
    mutations: [fullTerminalMutation()],
  };
  const result = verifyCompletion(
    current,
    claim,
    completionRepository({
      changedPaths: ["src/terminal.ts"],
      outOfScopePaths: ["src/terminal.ts"],
    }),
    completionRequirements,
  );
  assert.equal(result.accepted, false);
  assert.match(result.reasons.join(" "), /outside the grant/iu);
});
