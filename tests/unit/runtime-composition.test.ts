import assert from "node:assert/strict";
import test from "node:test";

import {
  earliestSessionBaselineMutation,
  isReconstructibleSessionBaseline,
  sessionMutationDiffRecord,
} from "../../src/cli/runtime-composition.js";
import type {
  FullTerminalMutationRecord,
  MutationRecord,
  TerminalMutationRecord,
} from "../../src/session/types.js";

const fingerprint = "a".repeat(64);
const completedAt = "2026-01-01T00:00:00.000Z";
const pathKey = (value: string): string => value;

test("session baseline availability remains tri-state at the observer boundary", () => {
  assert.equal(isReconstructibleSessionBaseline(undefined), false);
  assert.equal(
    isReconstructibleSessionBaseline({ available: false }),
    false,
  );
  assert.equal(
    isReconstructibleSessionBaseline({
      baselineId: "checkpoint_original_user_bytes",
    }),
    true,
  );
});

test("session diff adapter preserves pathless non-clean terminal evidence", () => {
  for (const outcome of [
    "unknown",
    "protected_or_hidden_changed",
  ] as const) {
    const record = sessionMutationDiffRecord(
      emptyNonCleanTerminalMutation(
        `op_terminal_${outcome}`,
        outcome,
      ),
    );
    assert.equal(record.kind, "terminal");
    if (record.kind !== "terminal") {
      assert.fail("expected terminal session diff record");
    }
    assert.equal(record.observationOutcome, outcome);
    assert.deepEqual(record.changedPaths, []);
  }
});

test("earliest session baseline stops at an unavailable terminal touch", () => {
  const mutations: MutationRecord[] = [
    legacyTerminalMutation("op_terminal_legacy", "src/value.ts"),
    patchMutation("op_patch_later", "src/value.ts"),
    fullTerminalMutation(
      "op_terminal_target",
      "src/value.ts",
      false,
    ),
  ];

  const selected = earliestSessionBaselineMutation(
    mutations,
    "op_terminal_target",
    "src/value.ts",
    pathKey,
  );

  assert.equal(selected?.operationId, "op_terminal_legacy");
});

test("truncated terminal path facts conservatively precede a later checkpoint", () => {
  const mutations: MutationRecord[] = [
    fullTerminalMutation(
      "op_terminal_truncated",
      "src/retained-other.ts",
      true,
    ),
    patchMutation("op_patch_later", "src/value.ts"),
    fullTerminalMutation(
      "op_terminal_target",
      "src/value.ts",
      false,
    ),
  ];

  const selected = earliestSessionBaselineMutation(
    mutations,
    "op_terminal_target",
    "src/value.ts",
    pathKey,
  );

  assert.equal(selected?.operationId, "op_terminal_truncated");
});

test("truncated pre-existing-touch duplicates do not hide an exhaustive changed-path list", () => {
  const prior = fullTerminalMutation(
    "op_terminal_preexisting_truncated",
    "src/other.ts",
    false,
  );
  const mutations: MutationRecord[] = [
    {
      ...prior,
      preExistingTouchedTotal: 1,
      pathEndpointTotal: 2,
      omittedPathEndpointTotal: 1,
      pathFactsTruncated: true,
    },
    patchMutation("op_patch_later", "src/value.ts"),
    fullTerminalMutation(
      "op_terminal_target",
      "src/value.ts",
      false,
    ),
  ];

  const selected = earliestSessionBaselineMutation(
    mutations,
    "op_terminal_target",
    "src/value.ts",
    pathKey,
  );

  assert.equal(selected?.operationId, "op_patch_later");
});

for (const outcome of [
  "unknown",
  "protected_or_hidden_changed",
] as const) {
  test(`${outcome} terminal evidence without path facts conservatively precedes a later checkpoint`, () => {
    const mutations: MutationRecord[] = [
      emptyNonCleanTerminalMutation(
        `op_terminal_${outcome}`,
        outcome,
      ),
      patchMutation("op_patch_later", "src/value.ts"),
      fullTerminalMutation(
        "op_terminal_target",
        "src/value.ts",
        false,
      ),
    ];

    const selected = earliestSessionBaselineMutation(
      mutations,
      "op_terminal_target",
      "src/value.ts",
      pathKey,
    );

    assert.equal(
      selected?.operationId,
      `op_terminal_${outcome}`,
    );
  });
}

function patchMutation(
  operationId: string,
  repositoryRelativePath: string,
): MutationRecord {
  return {
    kind: "patch",
    operationId,
    checkpointId: `checkpoint_${operationId}`,
    changedPaths: [repositoryRelativePath],
    changedLines: 1,
    completedAt,
    repositoryFingerprint: fingerprint,
  };
}

function emptyNonCleanTerminalMutation(
  operationId: string,
  observationOutcome: "unknown" | "protected_or_hidden_changed",
): FullTerminalMutationRecord {
  return {
    kind: "terminal",
    recordContract: "terminal-mutation/2",
    operationId,
    changedPaths: [],
    changedLines: 0,
    createdPaths: [],
    updatedPaths: [],
    deletedPaths: [],
    renamedPaths: [],
    preExistingTouchedPaths: [],
    processOutcome: "indeterminate",
    createdTotal: 0,
    updatedTotal: 0,
    deletedTotal: 0,
    renamedTotal: 0,
    preExistingTouchedTotal: 0,
    changedPathCount: 0,
    pathEndpointTotal: 0,
    omittedPathEndpointTotal: 0,
    pathFactsTruncated: false,
    pathFactsSha256: fingerprint,
    unavailableBaselineCount: 0,
    completedAt,
    preObservation: artifactReference(
      "terminal-pre-observation",
      operationId,
    ),
    postObservation: artifactReference(
      "terminal-post-observation",
      operationId,
    ),
    terminalResult: artifactReference(
      "terminal-result",
      operationId,
    ),
    observationOutcome,
  };
}

function legacyTerminalMutation(
  operationId: string,
  repositoryRelativePath: string,
): TerminalMutationRecord {
  return {
    kind: "terminal",
    operationId,
    changedPaths: [repositoryRelativePath],
    changedLines: 1,
    createdPaths: [],
    updatedPaths: [repositoryRelativePath],
    deletedPaths: [],
    renamedPaths: [],
    preExistingTouchedPaths: [],
    completedAt,
    observationOutcome: "unknown",
    terminalResult: artifactReference(
      "terminal-result",
      operationId,
    ),
  };
}

function fullTerminalMutation(
  operationId: string,
  retainedPath: string,
  truncated: boolean,
): FullTerminalMutationRecord {
  const changedPathCount = truncated ? 2 : 1;
  return {
    kind: "terminal",
    recordContract: "terminal-mutation/2",
    operationId,
    changedPaths: [retainedPath],
    changedLines: 1,
    createdPaths: [],
    updatedPaths: [retainedPath],
    deletedPaths: [],
    renamedPaths: [],
    preExistingTouchedPaths: [],
    processOutcome: "completed",
    createdTotal: 0,
    updatedTotal: changedPathCount,
    deletedTotal: 0,
    renamedTotal: 0,
    preExistingTouchedTotal: 0,
    changedPathCount,
    pathEndpointTotal: changedPathCount,
    omittedPathEndpointTotal: truncated ? 1 : 0,
    pathFactsTruncated: truncated,
    pathFactsSha256: fingerprint,
    unavailableBaselineCount: truncated ? 1 : 0,
    completedAt,
    preObservation: artifactReference(
      "terminal-pre-observation",
      operationId,
    ),
    postObservation: artifactReference(
      "terminal-post-observation",
      operationId,
    ),
    terminalResult: artifactReference(
      "terminal-result",
      operationId,
    ),
    observationOutcome: "unknown",
  };
}

function artifactReference(
  kind:
    | "terminal-pre-observation"
    | "terminal-post-observation"
    | "terminal-result",
  id: string,
) {
  return {
    kind,
    id,
    bytes: 1,
    sha256: fingerprint,
  } as const;
}
