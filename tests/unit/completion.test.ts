import assert from "node:assert/strict";
import test from "node:test";
import { verifyCompletion, type CompletionClaim } from "../../src/orchestrator/completion.js";
import {
  DEFAULT_BUDGET_LIMITS,
  SESSION_SCHEMA_VERSION,
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

test("completion verifier accepts known, in-scope, freshly validated state", () => {
  const result = verifyCompletion(
    state(),
    claim,
    { pathKey: completionPathKey, known: true, fingerprint: currentFingerprint, excludedStateFingerprint: excludedFingerprint, hasConflicts: false, changedPaths: ["src/a.ts"], outOfScopePaths: [], gitStatusSummary: "M src/a.ts" },
    { requiredCommandIds: ["test"], requireValidationAfterLastMutation: true, requireCleanPendingOperations: true },
  );
  assert.equal(result.accepted, true);
  assert.deepEqual(result.actual.successfulCommands, ["test"]);
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
