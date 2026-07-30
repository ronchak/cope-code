import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  TERMINAL_EXEC_CONTRACT,
  TERMINAL_EXEC_RESULT_CONTRACT,
  type TerminalExecResult,
} from "../../src/protocol/terminal-exec.js";
import {
  WORKSPACE_OBSERVATION_CONTRACT,
  type WorkspaceObservation,
} from "../../src/repository/workspace-observer.js";
import { SessionArtifactStore } from "../../src/session/artifact-store.js";
import {
  TerminalArtifactPersistence,
  isTerminalJournalResultMetadata,
  isTerminalPrelaunchFailureMetadata,
  terminalEvidenceProvesNoLaunch,
} from "../../src/session/terminal-artifacts.js";
import { sha256, stableJson } from "../../src/shared/crypto.js";

const OPERATION_ID = "op_terminal_123";
const REQUEST_HASH = sha256(stableJson({
  contract: TERMINAL_EXEC_CONTRACT,
  mode: "shell",
  command: "printf super-secret-output",
  cwd: ".",
}));

test("terminal artifacts persist an integrity-bound chain and replay exact result data", async () => {
  const fixture = await createCompleteFixture();
  const replay = await fixture.persistence.recoverCompleted({
    operationId: OPERATION_ID,
    tool: "terminal_exec",
    requestHash: REQUEST_HASH,
  });
  assert.deepEqual(replay, { ...fixture.result, replayed: true });
  assert.equal(replay?.outcome, "completed_nonzero");
  assert.equal(replay?.stdout.head, "super-secret-output");
  assert.equal(fixture.safeMetadata.outcome, "completed_nonzero");
  assert.equal(isTerminalJournalResultMetadata(fixture.safeMetadata), true);
  const evidence = await fixture.persistence.recoverCompletedEvidence({
    operationId: OPERATION_ID,
    tool: "terminal_exec",
    requestHash: REQUEST_HASH,
  });
  assert.deepEqual(evidence?.safeMetadata, fixture.safeMetadata);
  assert.deepEqual(evidence?.reference, fixture.safeMetadata.terminal_result);

  const journalJson = stableJson(fixture.safeMetadata);
  assert.doesNotMatch(journalJson, /super-secret-output|printf|command|head|tail/u);
  assert.match(journalJson, /terminal-result/u);
});

test("terminal recovery rejects tampered artifact bytes", async () => {
  const fixture = await createCompleteFixture();
  await writeFile(
    path.join(
      fixture.root,
      "terminal-result",
      `${OPERATION_ID}.txt`,
    ),
    "tampered",
    "utf8",
  );
  await assert.rejects(
    () =>
      fixture.persistence.recoverCompleted({
        operationId: OPERATION_ID,
        tool: "terminal_exec",
        requestHash: REQUEST_HASH,
      }),
    (error: { code?: string }) => error.code === "RECOVERY_REQUIRED",
  );
});

test("terminal recovery rejects a partial result manifest", async () => {
  const fixture = await createCompleteFixture();
  await writeFile(
    path.join(
      fixture.root,
      "terminal-result",
      `${OPERATION_ID}.manifest.json`,
    ),
    '{"schemaVersion":1}',
    "utf8",
  );
  await assert.rejects(
    () =>
      fixture.persistence.recoverCompleted({
        operationId: OPERATION_ID,
        tool: "terminal_exec",
        requestHash: REQUEST_HASH,
      }),
    (error: { code?: string }) => error.code === "RECOVERY_REQUIRED",
  );
});

test("terminal recovery rejects request-hash and complete-result mismatches", async () => {
  const fixture = await createCompleteFixture();
  await assert.rejects(
    () =>
      fixture.persistence.recoverCompleted({
        operationId: OPERATION_ID,
        tool: "terminal_exec",
        requestHash: "f".repeat(64),
      }),
    /request hash/u,
  );

  const resultFilename = path.join(
    fixture.root,
    "terminal-result",
    `${OPERATION_ID}.txt`,
  );
  const envelope = JSON.parse(
    await readFile(resultFilename, "utf8"),
  ) as {
    result: {
      stdout: { bytes: number };
    };
  };
  envelope.result.stdout.bytes += 1;
  await fixture.artifacts.put(
    "terminal-result",
    OPERATION_ID,
    stableJson(envelope),
  );
  await assert.rejects(
    () =>
      fixture.persistence.recoverCompleted({
        operationId: OPERATION_ID,
        tool: "terminal_exec",
        requestHash: REQUEST_HASH,
      }),
    /does not bind/u,
  );
});

test("terminal recovery returns undefined for valid incomplete evidence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cope-terminal-partial-"));
  const artifacts = new SessionArtifactStore(path.join(directory, "artifacts"));
  const persistence = new TerminalArtifactPersistence(artifacts);
  await persistRequestAndPre(persistence);

  assert.equal(
    await persistence.recoverCompleted({
      operationId: OPERATION_ID,
      tool: "terminal_exec",
      requestHash: REQUEST_HASH,
    }),
    undefined,
  );

  await persistence.persistExitReceipt(exitReceipt());
  assert.equal(
    await persistence.recoverCompleted({
      operationId: OPERATION_ID,
      tool: "terminal_exec",
      requestHash: REQUEST_HASH,
    }),
    undefined,
  );
});

test("full terminal evidence binds launch, observations, result, and hidden control facts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cope-terminal-full-"));
  const artifacts = new SessionArtifactStore(path.join(directory, "artifacts"));
  const persistence = new TerminalArtifactPersistence(artifacts);
  const request = await persistRequest(persistence);
  const pre = await persistence.persistWorkspaceObservation({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    observation: workspaceObservation("pre", "a".repeat(64)),
  });
  const launch = await persistence.persistLaunchReceipt({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    request,
    preObservation: pre,
    recordedAt: "2026-07-29T00:00:00.500Z",
  });
  assert.equal(
    (await persistence.inspectIncompleteEvidence({
      operationId: OPERATION_ID,
      requestHash: REQUEST_HASH,
      recoveryContext: "ordinary_process_crash",
      journalStatus: "executing",
    })).state,
    "launch_without_exit",
  );

  const exit = await persistence.persistExitReceipt(exitReceipt());
  assert.equal(
    (await persistence.inspectIncompleteEvidence({
      operationId: OPERATION_ID,
      requestHash: REQUEST_HASH,
      recoveryContext: "ordinary_process_crash",
      journalStatus: "executing",
    })).state,
    "exit_without_result",
  );
  const repositoryFingerprint = "9".repeat(64);
  const post = await persistence.persistWorkspaceObservation({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    observation: workspaceObservation("post", repositoryFingerprint),
  });
  const result: TerminalExecResult = {
    ...terminalResult(),
    mutation: {
      outcome: "observed",
      created: ["src/generated.ts"],
      updated: [],
      deleted: [],
      renamed: [],
      pre_existing_touched: [],
      changed_files: 1,
      changed_lines: 12,
      binary_files: 0,
      ignored_summary: "",
      repository_fingerprint: repositoryFingerprint,
      created_total: 1,
      updated_total: 0,
      deleted_total: 0,
      renamed_total: 0,
      pre_existing_touched_total: 0,
      path_endpoint_total: 1,
      path_endpoint_omitted: 0,
      path_facts_truncated: false,
      path_facts_sha256: "e".repeat(64),
      unavailable_baseline_count: 0,
    },
  };
  const control = {
    branch: "main",
    head: "b".repeat(40),
    excludedStateFingerprint: "3".repeat(64),
  } as const;
  await assert.rejects(
    () => persistence.persistResult({
      operationId: OPERATION_ID,
      requestHash: REQUEST_HASH,
      request,
      preObservation: pre,
      exitReceipt: exit,
      postObservation: post,
      result,
    }),
    /legacy placeholder observations/u,
  );
  await assert.rejects(
    () => persistence.persistFullResult({
      operationId: OPERATION_ID,
      requestHash: REQUEST_HASH,
      request,
      preObservation: pre,
      launchReceipt: launch,
      exitReceipt: exit,
      postObservation: post,
      result,
      postObservationControl: {
        ...control,
        excludedStateFingerprint: "4".repeat(64),
      },
    }),
    /control anchor/u,
  );
  await assert.rejects(
    () => persistence.persistFullResult({
      operationId: OPERATION_ID,
      requestHash: REQUEST_HASH,
      request,
      preObservation: pre,
      launchReceipt: launch,
      exitReceipt: exit,
      postObservation: post,
      result: {
        ...result,
        mutation: {
          ...result.mutation,
          created_total: 0,
          updated_total: 1,
        },
      },
      postObservationControl: control,
    }),
    /bounded path-summary facts/u,
  );
  const persisted = await persistence.persistFullResult({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    request,
    preObservation: pre,
    launchReceipt: launch,
    exitReceipt: exit,
    postObservation: post,
    result,
    postObservationControl: control,
  });
  const recovered = await persistence.recoverCompletedEvidence({
    operationId: OPERATION_ID,
    tool: "terminal_exec",
    requestHash: REQUEST_HASH,
  });
  assert.equal(recovered?.result.replayed, true);
  assert.deepEqual(recovered?.safeMetadata, persisted.safeMetadata);
  assert.doesNotMatch(
    stableJson(recovered?.result),
    /excludedStateFingerprint|post_observation_control/u,
  );
  assert.doesNotMatch(
    stableJson(recovered?.safeMetadata),
    /excludedStateFingerprint|post_observation_control/u,
  );
});

test("incomplete terminal reader recognizes only exact prelaunch failure metadata", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cope-terminal-prelaunch-"));
  const persistence = new TerminalArtifactPersistence(
    new SessionArtifactStore(path.join(directory, "artifacts")),
  );
  const metadata = {
    reasonCode: "PRE_OBSERVATION_UNAVAILABLE",
    outcome: "spawn_failed",
    mutation_outcome: "none",
    plannedDisclosureBytes: 4096,
  } as const;
  assert.equal(isTerminalPrelaunchFailureMetadata(metadata), true);
  const ordinary = await persistence.inspectIncompleteEvidence({
      operationId: OPERATION_ID,
      requestHash: REQUEST_HASH,
      recoveryContext: "ordinary_process_crash",
      journalStatus: "failed",
      journalSafeResult: metadata,
    });
  assert.equal(ordinary.state, "completed_prelaunch_failure");
  assert.equal(terminalEvidenceProvesNoLaunch(ordinary), true);
  assert.equal(isTerminalPrelaunchFailureMetadata({
    ...metadata,
    extra: true,
  }), false);
  const powerLoss = await persistence.inspectIncompleteEvidence({
      operationId: OPERATION_ID,
      requestHash: REQUEST_HASH,
      recoveryContext: "known_power_or_storage_loss",
      journalStatus: "failed",
      journalSafeResult: metadata,
    });
  assert.equal(powerLoss.state, "completed_prelaunch_failure");
  assert.equal(terminalEvidenceProvesNoLaunch(powerLoss), false);
  const malformed = await persistence.inspectIncompleteEvidence({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    recoveryContext: "known_power_or_storage_loss",
    journalStatus: "failed",
    journalSafeResult: { ...metadata, extra: true },
  });
  assert.equal(malformed.state, "completed_unproven_without_result");
  assert.equal(terminalEvidenceProvesNoLaunch(malformed), false);
});

test("receipt absence proves no launch only for no-pre or full receipt-era pre evidence", async () => {
  const noPreDirectory = await mkdtemp(
    path.join(tmpdir(), "cope-terminal-no-pre-"),
  );
  const noPre = new TerminalArtifactPersistence(
    new SessionArtifactStore(path.join(noPreDirectory, "artifacts")),
  );
  await persistRequest(noPre);
  const noPreEvidence = await noPre.inspectIncompleteEvidence({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    recoveryContext: "ordinary_process_crash",
  });
  assert.deepEqual(noPreEvidence, {
    state: "request_without_launch",
    recoveryContext: "ordinary_process_crash",
    preEvidence: "none",
  });
  assert.equal(terminalEvidenceProvesNoLaunch(noPreEvidence), true);

  const legacyDirectory = await mkdtemp(
    path.join(tmpdir(), "cope-terminal-legacy-pre-"),
  );
  const legacy = new TerminalArtifactPersistence(
    new SessionArtifactStore(path.join(legacyDirectory, "artifacts")),
  );
  await persistRequestAndPre(legacy);
  const legacyEvidence = await legacy.inspectIncompleteEvidence({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    recoveryContext: "ordinary_process_crash",
  });
  assert.deepEqual(legacyEvidence, {
    state: "request_without_launch",
    recoveryContext: "ordinary_process_crash",
    preEvidence: "legacy_placeholder",
  });
  assert.equal(terminalEvidenceProvesNoLaunch(legacyEvidence), false);
  const legacyCompletedEvidence = await legacy.inspectIncompleteEvidence({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    recoveryContext: "ordinary_process_crash",
    journalStatus: "failed",
    journalSafeResult: {
      reasonCode: "PRE_OBSERVATION_UNAVAILABLE",
      outcome: "spawn_failed",
      mutation_outcome: "none",
    },
  });
  assert.equal(
    legacyCompletedEvidence.state,
    "completed_unproven_without_result",
  );
  assert.equal(
    terminalEvidenceProvesNoLaunch(legacyCompletedEvidence),
    false,
  );

  const fullDirectory = await mkdtemp(
    path.join(tmpdir(), "cope-terminal-full-pre-"),
  );
  const full = new TerminalArtifactPersistence(
    new SessionArtifactStore(path.join(fullDirectory, "artifacts")),
  );
  await persistRequest(full);
  await full.persistWorkspaceObservation({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    observation: workspaceObservation("pre", "a".repeat(64)),
  });
  const fullEvidence = await full.inspectIncompleteEvidence({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    recoveryContext: "ordinary_process_crash",
  });
  assert.deepEqual(fullEvidence, {
    state: "request_without_launch",
    recoveryContext: "ordinary_process_crash",
    preEvidence: "full_workspace_observation",
  });
  assert.equal(terminalEvidenceProvesNoLaunch(fullEvidence), true);
});

test("a full no-effect result binds every canonical Git component", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cope-terminal-none-"));
  const persistence = new TerminalArtifactPersistence(
    new SessionArtifactStore(path.join(directory, "artifacts")),
  );
  const request = await persistRequest(persistence);
  const fingerprint = "a".repeat(64);
  const preObservation = workspaceObservation("pre", fingerprint);
  if (preObservation.state !== "complete") {
    throw new Error("expected complete fixture observation");
  }
  const pre = await persistence.persistWorkspaceObservation({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    observation: preObservation,
  });
  const launch = await persistence.persistLaunchReceipt({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    request,
    preObservation: pre,
    recordedAt: "2026-07-29T00:00:00.500Z",
  });
  const exit = await persistence.persistExitReceipt(exitReceipt());
  const changedPost = await persistence.persistWorkspaceObservation({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    observation: {
      ...workspaceObservation("post", fingerprint),
      components: {
        ...preObservation.components,
        gitTransitions: "f".repeat(64),
      },
    },
  });
  const result: TerminalExecResult = {
    ...terminalResult(),
    mutation: {
      outcome: "none",
      created: [],
      updated: [],
      deleted: [],
      renamed: [],
      pre_existing_touched: [],
      changed_files: 0,
      changed_lines: 0,
      binary_files: 0,
      ignored_summary: "",
      repository_fingerprint: fingerprint,
      created_total: 0,
      updated_total: 0,
      deleted_total: 0,
      renamed_total: 0,
      pre_existing_touched_total: 0,
      path_endpoint_total: 0,
      path_endpoint_omitted: 0,
      path_facts_truncated: false,
      path_facts_sha256: "e".repeat(64),
      unavailable_baseline_count: 0,
    },
  };
  await assert.rejects(
    () => persistence.persistFullResult({
      operationId: OPERATION_ID,
      requestHash: REQUEST_HASH,
      request,
      preObservation: pre,
      launchReceipt: launch,
      exitReceipt: exit,
      postObservation: changedPost,
      result,
    }),
    /no-effect terminal result/u,
  );
  const unchangedPost = await persistence.persistWorkspaceObservation({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    observation: {
      ...preObservation,
      phase: "post",
      observedAt: "2026-07-29T00:00:02.000Z",
    },
  });
  await persistence.persistFullResult({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    request,
    preObservation: pre,
    launchReceipt: launch,
    exitReceipt: exit,
    postObservation: unchangedPost,
    result,
  });
});

test("launch and attribution refuse insufficient pre-observation evidence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cope-terminal-limited-"));
  const persistence = new TerminalArtifactPersistence(
    new SessionArtifactStore(path.join(directory, "artifacts")),
  );
  const request = await persistRequest(persistence);
  const unknown = await persistence.persistWorkspaceObservation({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    observation: {
      contract: WORKSPACE_OBSERVATION_CONTRACT,
      phase: "pre",
      observedAt: "2026-07-29T00:00:00.000Z",
      durationMs: 20_000,
      state: "unknown",
      limitationCodes: ["PRE_OBSERVATION_TIMEOUT"],
    },
  });
  await assert.rejects(
    () => persistence.persistLaunchReceipt({
      operationId: OPERATION_ID,
      requestHash: REQUEST_HASH,
      request,
      preObservation: unknown,
      recordedAt: "2026-07-29T00:00:00.500Z",
    }),
    /complete or metadata-limited/u,
  );

  const completePre = workspaceObservation("pre", "a".repeat(64));
  if (completePre.state !== "complete") {
    throw new Error("expected complete fixture observation");
  }
  const {
    repositoryFingerprint: _repositoryFingerprint,
    ...preFacts
  } = completePre;
  const limited = await persistence.persistWorkspaceObservation({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    observation: {
      ...preFacts,
      state: "metadata_limited",
      nestedRepository: "unknown",
      limitationCodes: ["NESTED_REPOSITORY_SCAN_BOUND_EXCEEDED"],
    },
  });
  const launch = await persistence.persistLaunchReceipt({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    request,
    preObservation: limited,
    recordedAt: "2026-07-29T00:00:00.500Z",
  });
  const exit = await persistence.persistExitReceipt(exitReceipt());
  const postFingerprint = "9".repeat(64);
  const post = await persistence.persistWorkspaceObservation({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    observation: workspaceObservation("post", postFingerprint),
  });
  const result: TerminalExecResult = {
    ...terminalResult(),
    mutation: {
      outcome: "observed",
      created: [],
      updated: [],
      deleted: [],
      renamed: [],
      pre_existing_touched: [],
      changed_files: 0,
      changed_lines: 0,
      binary_files: 0,
      ignored_summary: "",
      repository_fingerprint: postFingerprint,
      created_total: 0,
      updated_total: 0,
      deleted_total: 0,
      renamed_total: 0,
      pre_existing_touched_total: 0,
      path_endpoint_total: 0,
      path_endpoint_omitted: 0,
      path_facts_truncated: false,
      path_facts_sha256: "e".repeat(64),
      unavailable_baseline_count: 0,
    },
  };
  await assert.rejects(
    () => persistence.persistFullResult({
      operationId: OPERATION_ID,
      requestHash: REQUEST_HASH,
      request,
      preObservation: limited,
      launchReceipt: launch,
      exitReceipt: exit,
      postObservation: post,
      result,
      postObservationControl: {
        branch: "main",
        head: "b".repeat(40),
        excludedStateFingerprint: "3".repeat(64),
      },
    }),
    /only produce unknown attribution/u,
  );
});

test("bound before-image resolver validates the result chain and reconstructs every supported source", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cope-terminal-resolver-"));
  const persistence = new TerminalArtifactPersistence(
    new SessionArtifactStore(path.join(directory, "artifacts")),
  );
  const request = await persistRequest(persistence);
  const retainedBytes = Buffer.from("retained before\n");
  const blobBytes = Buffer.from("blob before\n");
  const blob256Bytes = Buffer.from("sha256 blob before\n");
  const priorBytes = Buffer.from("prior before\n");
  const blobObjectId = gitBlobObjectId(blobBytes);
  const blob256ObjectId = gitBlobObjectId(blob256Bytes, "sha256");
  const headBytes = Buffer.from("clean HEAD\n");
  const headObjectId = gitBlobObjectId(headBytes);
  const preObservation = {
    ...workspaceObservation("pre", "a".repeat(64)),
    beforeImages: [
      {
        kind: "retained" as const,
        exists: true as const,
        identity: {
          path: "retained.txt",
          mode: 0o100644,
          size: retainedBytes.length,
        },
        sha256: sha256(retainedBytes),
        binary: false,
        contentBase64: retainedBytes.toString("base64"),
      },
      {
        kind: "git_blob" as const,
        exists: true as const,
        identity: {
          path: "blob.txt",
          mode: 0o100644,
          size: blobBytes.length,
        },
        sha256: sha256(blobBytes),
        binary: false,
        blob: blobObjectId,
        blobRole: "index" as const,
      },
      {
        kind: "git_blob" as const,
        exists: true as const,
        identity: {
          path: "blob256.txt",
          mode: 0o100644,
          size: blob256Bytes.length,
        },
        sha256: sha256(blob256Bytes),
        binary: false,
        blob: blob256ObjectId,
        blobRole: "head" as const,
      },
      {
        kind: "identity_only" as const,
        exists: true as const,
        identity: {
          path: "prior.txt",
          mode: 0o100644,
          size: priorBytes.length,
        },
        sha256: sha256(priorBytes),
        binary: false,
      },
      {
        kind: "identity_only" as const,
        exists: true as const,
        identity: {
          path: "bounded.txt",
          mode: 0o100644,
          size: 2_000_000,
        },
        sha256: "2".repeat(64),
        binary: false,
      },
      {
        kind: "absent" as const,
        exists: false as const,
        path: "explicit-created.txt",
      },
    ],
  } satisfies WorkspaceObservation;
  const pre = await persistence.persistWorkspaceObservation({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    observation: preObservation,
  });
  const launch = await persistence.persistLaunchReceipt({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    request,
    preObservation: pre,
    recordedAt: "2026-07-29T00:00:00.500Z",
  });
  const exit = await persistence.persistExitReceipt(exitReceipt());
  const repositoryFingerprint = "9".repeat(64);
  const post = await persistence.persistWorkspaceObservation({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    observation: workspaceObservation("post", repositoryFingerprint),
  });
  const changed = [
    "blob.txt",
    "blob256.txt",
    "bounded.txt",
    "clean.txt",
    "explicit-created.txt",
    "implicit-created.txt",
    "prior.txt",
    "retained.txt",
  ];
  const result: TerminalExecResult = {
    ...terminalResult(),
    mutation: {
      outcome: "observed",
      created: ["explicit-created.txt", "implicit-created.txt"],
      updated: [
        "blob.txt",
        "blob256.txt",
        "bounded.txt",
        "clean.txt",
        "prior.txt",
        "retained.txt",
      ],
      deleted: [],
      renamed: [],
      pre_existing_touched: [],
      changed_files: changed.length,
      changed_lines: 1,
      binary_files: 0,
      ignored_summary: "",
      repository_fingerprint: repositoryFingerprint,
      created_total: 2,
      updated_total: 6,
      deleted_total: 0,
      renamed_total: 0,
      pre_existing_touched_total: 0,
      path_endpoint_total: 8,
      path_endpoint_omitted: 0,
      path_facts_truncated: false,
      path_facts_sha256: "e".repeat(64),
      unavailable_baseline_count: 1,
    },
  };
  const persisted = await persistence.persistFullResult({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    request,
    preObservation: pre,
    launchReceipt: launch,
    exitReceipt: exit,
    postObservation: post,
    result,
    postObservationControl: {
      branch: "main",
      head: "b".repeat(40),
      excludedStateFingerprint: "3".repeat(64),
    },
  });
  const resolver = persistence.createBeforeImageResolver({
    resolveReferences: async () => ({
      terminalResult: persisted.reference,
      preObservation: pre,
    }),
    readGitBlob: async (objectId) =>
      objectId === blobObjectId
        ? blobBytes
        : objectId === blob256ObjectId
          ? blob256Bytes
          : undefined,
    readHeadPath: async (head, repositoryRelativePath) =>
      head === "b".repeat(40) && repositoryRelativePath === "clean.txt"
        ? {
            objectId: headObjectId,
            mode: 0o100644,
            bytes: headBytes,
          }
        : undefined,
    resolvePriorBaseline: async (_mutation, repositoryRelativePath) =>
      repositoryRelativePath === "prior.txt"
        ? {
            baselineId: "verified:session-start",
            entry: {
              path: "prior.txt",
              existed: true,
              bytes: priorBytes,
              mode: 0o100644,
              sha256: sha256(priorBytes),
            },
          }
        : undefined,
  });
  const mutation = {
    kind: "terminal" as const,
    operationId: OPERATION_ID,
    changedPaths: changed,
  };
  assert.deepEqual(
    (await resolver(mutation, "retained.txt"))?.available,
    true,
  );
  assert.deepEqual(
    (await resolver(mutation, "blob.txt"))?.available,
    true,
  );
  assert.deepEqual(
    (await resolver(mutation, "blob256.txt"))?.available,
    true,
  );
  assert.equal(
    (await resolver(mutation, "prior.txt")).available,
    true,
  );
  assert.deepEqual(await resolver(mutation, "bounded.txt"), {
    available: false,
    reason: "bounded_out",
  });
  assert.equal(
    (await resolver(mutation, "explicit-created.txt")).available,
    true,
  );
  assert.equal(
    (await resolver(mutation, "implicit-created.txt")).available,
    true,
  );
  const clean = await resolver(mutation, "clean.txt");
  assert.equal(clean.available, true);
  if (clean.available) {
    assert.equal(clean.entry.bytes?.toString("utf8"), "clean HEAD\n");
  }

  const unavailablePriorResolver =
    persistence.createBeforeImageResolver({
      resolveReferences: async () => ({
        terminalResult: persisted.reference,
        preObservation: pre,
      }),
      resolvePriorBaseline: async (
        _mutation,
        repositoryRelativePath,
      ) =>
        repositoryRelativePath === "retained.txt"
          ? {
              available: false,
              reason: "bounded_out",
            }
          : undefined,
    });
  assert.deepEqual(
    await unavailablePriorResolver(
      mutation,
      "retained.txt",
    ),
    {
      available: false,
      reason: "bounded_out",
    },
    "an unavailable earlier baseline must not fall through to the current terminal before-image",
  );

  const corruptBlobResolver = persistence.createBeforeImageResolver({
    resolveReferences: async () => ({
      terminalResult: persisted.reference,
      preObservation: pre,
    }),
    readGitBlob: async () => Buffer.from("wrong blob"),
  });
  await assert.rejects(
    () => corruptBlobResolver(mutation, "blob.txt"),
    (error: { code?: string }) => error.code === "RECOVERY_REQUIRED",
  );
  const mismatchedReferenceResolver = persistence.createBeforeImageResolver({
    resolveReferences: async () => ({
      terminalResult: persisted.reference,
      preObservation: { ...pre, sha256: "f".repeat(64) },
    }),
  });
  await assert.rejects(
    () => mismatchedReferenceResolver(mutation, "retained.txt"),
    (error: { code?: string }) => error.code === "RECOVERY_REQUIRED",
  );
  const conflictingAbsentPriorResolver = persistence.createBeforeImageResolver({
    resolveReferences: async () => ({
      terminalResult: persisted.reference,
      preObservation: pre,
    }),
    resolvePriorBaseline: async (_mutation, repositoryRelativePath) =>
      repositoryRelativePath === "explicit-created.txt"
        ? {
            baselineId: "verified:conflicting",
            entry: {
              path: repositoryRelativePath,
              existed: true,
              bytes: Buffer.from("not absent"),
              mode: 0o100644,
              sha256: sha256("not absent"),
            },
          }
        : undefined,
  });
  await assert.rejects(
    () => conflictingAbsentPriorResolver(
      mutation,
      "explicit-created.txt",
    ),
    (error: { code?: string }) => error.code === "RECOVERY_REQUIRED",
  );
  for (const invalidPrior of [
    {
      baselineId: "",
      entry: {
        path: "retained.txt",
        existed: true,
        bytes: retainedBytes,
        mode: 0o100644,
        sha256: sha256(retainedBytes),
      },
    },
    {
      baselineId: "verified:invalid-bytes",
      entry: {
        path: "retained.txt",
        existed: true,
        bytes: new Uint8Array(retainedBytes),
        mode: 0o100644,
        sha256: sha256(retainedBytes),
      },
    },
    {
      baselineId: "verified:invalid-mode",
      entry: {
        path: "retained.txt",
        existed: true,
        bytes: retainedBytes,
        mode: 0o200000,
        sha256: sha256(retainedBytes),
      },
    },
  ]) {
    const invalidPriorResolver = persistence.createBeforeImageResolver({
      resolveReferences: async () => ({
        terminalResult: persisted.reference,
        preObservation: pre,
      }),
      resolvePriorBaseline: async () => invalidPrior as never,
    });
    await assert.rejects(
      () => invalidPriorResolver(mutation, "retained.txt"),
      (error: { code?: string }) => error.code === "RECOVERY_REQUIRED",
    );
  }
  const unauthenticatedHeadResolver = persistence.createBeforeImageResolver({
    resolveReferences: async () => ({
      terminalResult: persisted.reference,
      preObservation: pre,
    }),
    readHeadPath: async () => ({
      objectId: "3".repeat(40),
      mode: 0o100644,
      bytes: headBytes,
    }),
  });
  await assert.rejects(
    () => unauthenticatedHeadResolver(mutation, "clean.txt"),
    (error: { code?: string }) => error.code === "RECOVERY_REQUIRED",
  );

  const firstRecord = {
    ...mutation,
    changedPaths: ["retained.txt"],
  };
  const secondRecordWithoutReferences = {
    ...mutation,
    changedPaths: ["retained.txt", "second-record"],
  };
  const perRecordResolver = persistence.createBeforeImageResolver({
    resolveReferences: async (candidate) =>
      candidate.changedPaths.includes("second-record")
        ? undefined
        : {
            terminalResult: persisted.reference,
            preObservation: pre,
          },
  });
  assert.equal(
    (await perRecordResolver(firstRecord, "retained.txt")).available,
    true,
  );
  assert.deepEqual(
    await perRecordResolver(
      secondRecordWithoutReferences,
      "retained.txt",
    ),
    { available: false, reason: "missing_evidence" },
  );

  const secondRecordWithMismatch = {
    ...mutation,
    changedPaths: ["retained.txt", "mismatched-record"],
  };
  const perTupleResolver = persistence.createBeforeImageResolver({
    resolveReferences: async (candidate) =>
      candidate.changedPaths.includes("mismatched-record")
        ? {
            terminalResult: persisted.reference,
            preObservation: { ...pre, sha256: "f".repeat(64) },
          }
        : {
            terminalResult: persisted.reference,
            preObservation: pre,
          },
  });
  assert.equal(
    (await perTupleResolver(firstRecord, "retained.txt")).available,
    true,
  );
  await assert.rejects(
    () => perTupleResolver(secondRecordWithMismatch, "retained.txt"),
    (error: { code?: string }) => error.code === "RECOVERY_REQUIRED",
  );
});

test("persisted alias renames resolve origin and destination baselines by exact spelling", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cope-terminal-alias-"));
  const persistence = new TerminalArtifactPersistence(
    new SessionArtifactStore(path.join(directory, "artifacts")),
  );
  const request = await persistRequest(persistence);
  const dirtyBytes = Buffer.from("dirty origin\n");
  const priorBytes = Buffer.from("prior origin\n");
  const unicodeBytes = Buffer.from("unicode origin\n");
  const cleanBytes = Buffer.from("clean origin\n");
  const cleanObjectId = gitBlobObjectId(cleanBytes);
  const unicodeOrigin = "Café.md";
  const unicodeDestination = "Cafe\u0301.md";
  const retainedImage = (repositoryRelativePath: string, bytes: Buffer) => ({
    kind: "retained" as const,
    exists: true as const,
    identity: {
      path: repositoryRelativePath,
      mode: 0o100644,
      size: bytes.length,
    },
    sha256: sha256(bytes),
    binary: false,
    contentBase64: bytes.toString("base64"),
  });
  const preObservation = {
    ...workspaceObservation("pre", "a".repeat(64)),
    entries: [{
      path: "Dirty.md",
      kind: "ordinary" as const,
      indexStatus: ".",
      worktreeStatus: "M",
      stateSha256: "d".repeat(64),
      headMode: "100644",
      indexMode: "100644",
      worktreeMode: "100644",
      headObject: "1".repeat(40),
      indexObject: "1".repeat(40),
      worktreeIdentity: {
        mode: 0o100644,
        size: dirtyBytes.length,
        contentSha256: sha256(dirtyBytes),
      },
    }],
    beforeImages: [
      retainedImage("Dirty.md", dirtyBytes),
      {
        kind: "identity_only" as const,
        exists: true as const,
        identity: {
          path: "Prior.md",
          mode: 0o100644,
          size: priorBytes.length,
        },
        sha256: sha256(priorBytes),
        binary: false,
      },
      retainedImage(unicodeOrigin, unicodeBytes),
      {
        kind: "identity_only" as const,
        exists: true as const,
        identity: {
          path: "Bounded.md",
          mode: 0o100644,
          size: 2_000_000,
        },
        sha256: "2".repeat(64),
        binary: false,
      },
    ],
  } satisfies WorkspaceObservation;
  const pre = await persistence.persistWorkspaceObservation({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    observation: preObservation,
  });
  const launch = await persistence.persistLaunchReceipt({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    request,
    preObservation: pre,
    recordedAt: "2026-07-29T00:00:00.500Z",
  });
  const exit = await persistence.persistExitReceipt(exitReceipt());
  const repositoryFingerprint = "9".repeat(64);
  const post = await persistence.persistWorkspaceObservation({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    observation: workspaceObservation("post", repositoryFingerprint),
  });
  const renamed = [
    { from: "README.md", to: "readme.md" },
    { from: "Dirty.md", to: "dirty.md" },
    { from: "Prior.md", to: "prior.md" },
    { from: unicodeOrigin, to: unicodeDestination },
    { from: "Bounded.md", to: "bounded.md" },
    { from: "Chain.md", to: "chain.md" },
    { from: "chain.md", to: "CHAIN.md" },
  ];
  const result: TerminalExecResult = {
    ...terminalResult(),
    mutation: {
      outcome: "observed",
      created: [],
      updated: [],
      deleted: [],
      renamed,
      pre_existing_touched: [],
      changed_files: renamed.length,
      changed_lines: 1,
      binary_files: 0,
      ignored_summary: "",
      repository_fingerprint: repositoryFingerprint,
      created_total: 0,
      updated_total: 0,
      deleted_total: 0,
      renamed_total: renamed.length,
      pre_existing_touched_total: 0,
      path_endpoint_total: renamed.length * 2,
      path_endpoint_omitted: 0,
      path_facts_truncated: false,
      path_facts_sha256: "e".repeat(64),
      unavailable_baseline_count: 1,
    },
  };
  const persisted = await persistence.persistFullResult({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    request,
    preObservation: pre,
    launchReceipt: launch,
    exitReceipt: exit,
    postObservation: post,
    result,
    postObservationControl: {
      branch: "main",
      head: "b".repeat(40),
      excludedStateFingerprint: "3".repeat(64),
    },
  });
  const headRequests: string[] = [];
  const priorRequests: string[] = [];
  const pathKey = (value: string) => value.normalize("NFC").toLowerCase();
  const resolver = persistence.createBeforeImageResolver({
    resolveReferences: async () => ({
      terminalResult: persisted.reference,
      preObservation: pre,
    }),
    pathKey,
    readHeadPath: async (head, repositoryRelativePath) => {
      headRequests.push(repositoryRelativePath);
      return head === "b".repeat(40) &&
        repositoryRelativePath === "README.md"
        ? {
            objectId: cleanObjectId,
            mode: 0o100644,
            bytes: cleanBytes,
          }
        : undefined;
    },
    resolvePriorBaseline: async (_mutation, repositoryRelativePath) => {
      priorRequests.push(repositoryRelativePath);
      return repositoryRelativePath === "Prior.md"
        ? {
            baselineId: "verified:prior-origin",
            entry: {
              path: "Prior.md",
              existed: true,
              bytes: priorBytes,
              mode: 0o100644,
              sha256: sha256(priorBytes),
            },
          }
        : undefined;
    },
  });
  const mutation = {
    kind: "terminal" as const,
    operationId: OPERATION_ID,
    changedPaths: renamed.flatMap(({ from, to }) => [from, to]),
  };
  const assertPresent = async (
    repositoryRelativePath: string,
    expected: Buffer,
  ) => {
    const resolved = await resolver(mutation, repositoryRelativePath);
    assert.equal(resolved.available, true);
    if (resolved.available) {
      assert.equal(resolved.entry.path, repositoryRelativePath);
      assert.deepEqual(resolved.entry.bytes, expected);
    }
  };
  const assertAbsent = async (repositoryRelativePath: string) => {
    const resolved = await resolver(mutation, repositoryRelativePath);
    assert.equal(resolved.available, true);
    if (resolved.available) {
      assert.deepEqual(resolved.entry, {
        path: repositoryRelativePath,
        existed: false,
        bytes: null,
        mode: null,
        sha256: null,
      });
    }
  };

  await assertPresent("README.md", cleanBytes);
  await assertAbsent("readme.md");
  await assertPresent("Dirty.md", dirtyBytes);
  await assertAbsent("dirty.md");
  await assertPresent("Prior.md", priorBytes);
  await assertAbsent("prior.md");
  await assertPresent(unicodeOrigin, unicodeBytes);
  await assertAbsent(unicodeDestination);
  assert.deepEqual(await resolver(mutation, "Bounded.md"), {
    available: false,
    reason: "bounded_out",
  });
  await assertAbsent("bounded.md");
  assert.deepEqual(headRequests, ["README.md"]);
  assert.equal(priorRequests.includes("prior.md"), false);
  assert.equal(priorRequests.includes(unicodeDestination), false);
  const mismatchedPriorResolver = persistence.createBeforeImageResolver({
    resolveReferences: async () => ({
      terminalResult: persisted.reference,
      preObservation: pre,
    }),
    pathKey,
    resolvePriorBaseline: async () => ({
      baselineId: "verified:wrong-alias-spelling",
      entry: {
        path: "prior.md",
        existed: true,
        bytes: priorBytes,
        mode: 0o100644,
        sha256: sha256(priorBytes),
      },
    }),
  });
  await assert.rejects(
    () => mismatchedPriorResolver(mutation, "Prior.md"),
    (error: { code?: string }) => error.code === "RECOVERY_REQUIRED",
  );
  await assert.rejects(
    () => resolver(mutation, "ReAdMe.md"),
    (error: { code?: string }) => error.code === "RECOVERY_REQUIRED",
  );
  await assert.rejects(
    () => resolver(mutation, "chain.md"),
    (error: { code?: string }) => error.code === "RECOVERY_REQUIRED",
  );
});

test("incomplete evidence rejects impossible full chains and keeps Slice 1 exit evidence readable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cope-terminal-chain-"));
  const persistence = new TerminalArtifactPersistence(
    new SessionArtifactStore(path.join(directory, "artifacts")),
  );
  await persistence.persistExitReceipt(exitReceipt());
  await assert.rejects(
    () => persistence.inspectIncompleteEvidence({
      operationId: OPERATION_ID,
      requestHash: REQUEST_HASH,
      recoveryContext: "ordinary_process_crash",
    }),
    (error: { code?: string }) => error.code === "RECOVERY_REQUIRED",
  );

  const legacyDirectory = await mkdtemp(
    path.join(tmpdir(), "cope-terminal-legacy-exit-"),
  );
  const legacy = new TerminalArtifactPersistence(
    new SessionArtifactStore(path.join(legacyDirectory, "artifacts")),
  );
  await persistRequestAndPre(legacy);
  await legacy.persistExitReceipt(exitReceipt());
  assert.equal(
    (await legacy.inspectIncompleteEvidence({
      operationId: OPERATION_ID,
      requestHash: REQUEST_HASH,
      recoveryContext: "ordinary_process_crash",
    })).state,
    "exit_without_result",
  );

  const fullDirectory = await mkdtemp(
    path.join(tmpdir(), "cope-terminal-full-exit-"),
  );
  const full = new TerminalArtifactPersistence(
    new SessionArtifactStore(path.join(fullDirectory, "artifacts")),
  );
  await persistRequest(full);
  await full.persistWorkspaceObservation({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    observation: workspaceObservation("pre", "a".repeat(64)),
  });
  await full.persistExitReceipt(exitReceipt());
  await assert.rejects(
    () => full.inspectIncompleteEvidence({
      operationId: OPERATION_ID,
      requestHash: REQUEST_HASH,
      recoveryContext: "ordinary_process_crash",
    }),
    /no launch receipt/u,
  );
});

test("before-image resolver classifies validated legacy and wholly missing evidence", async () => {
  const legacy = await createCompleteFixture();
  const mutation = {
    kind: "terminal" as const,
    operationId: OPERATION_ID,
    changedPaths: ["legacy.txt"],
  };
  const legacyResolver = legacy.persistence.createBeforeImageResolver({
    resolveReferences: async () => ({
      terminalResult: legacy.resultReference,
      preObservation: legacy.preReference,
    }),
  });
  assert.deepEqual(await legacyResolver(mutation, "legacy.txt"), {
    available: false,
    reason: "legacy_placeholder",
  });
  const legacyOmissionResolver = legacy.persistence.createBeforeImageResolver({
    resolveReferences: async () => ({
      terminalResult: legacy.resultReference,
    }),
  });
  assert.deepEqual(await legacyOmissionResolver(mutation, "legacy.txt"), {
    available: false,
    reason: "legacy_placeholder",
  });
  const legacyMismatchResolver = legacy.persistence.createBeforeImageResolver({
    resolveReferences: async () => ({
      terminalResult: legacy.resultReference,
      preObservation: {
        ...legacy.preReference,
        sha256: "f".repeat(64),
      },
    }),
  });
  await assert.rejects(
    () => legacyMismatchResolver(mutation, "legacy.txt"),
    (error: { code?: string }) => error.code === "RECOVERY_REQUIRED",
  );
  const missingResolver = legacy.persistence.createBeforeImageResolver({
    resolveReferences: async () => undefined,
  });
  assert.deepEqual(await missingResolver(mutation, "missing.txt"), {
    available: false,
    reason: "missing_evidence",
  });
  await legacy.artifacts.remove(
    legacy.preReference.kind,
    legacy.preReference.id,
  );
  const cleanedSourceResolver = legacy.persistence.createBeforeImageResolver({
    resolveReferences: async () => ({
      terminalResult: legacy.resultReference,
      preObservation: legacy.preReference,
    }),
  });
  assert.deepEqual(await cleanedSourceResolver(mutation, "legacy.txt"), {
    available: false,
    reason: "missing_evidence",
  });
});

async function createCompleteFixture(): Promise<{
  readonly root: string;
  readonly artifacts: SessionArtifactStore;
  readonly persistence: TerminalArtifactPersistence;
  readonly result: TerminalExecResult;
  readonly preReference: Awaited<
    ReturnType<TerminalArtifactPersistence["persistObservation"]>
  >;
  readonly resultReference: Awaited<
    ReturnType<TerminalArtifactPersistence["persistResult"]>
  >["reference"];
  readonly safeMetadata: Awaited<
    ReturnType<TerminalArtifactPersistence["persistResult"]>
  >["safeMetadata"];
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "cope-terminal-complete-"));
  const root = path.join(directory, "artifacts");
  const artifacts = new SessionArtifactStore(root);
  const persistence = new TerminalArtifactPersistence(artifacts);
  const { request, pre } = await persistRequestAndPre(persistence);
  const exit = await persistence.persistExitReceipt(exitReceipt());
  const post = await persistence.persistObservation({
    operation_id: OPERATION_ID,
    request_hash: REQUEST_HASH,
    phase: "post",
    observed_at: "2026-07-29T00:00:02.000Z",
  });
  const result = terminalResult();
  const persisted = await persistence.persistResult({
    operationId: OPERATION_ID,
    requestHash: REQUEST_HASH,
    request,
    preObservation: pre,
    exitReceipt: exit,
    postObservation: post,
    result,
  });
  return {
    root,
    artifacts,
    persistence,
    result,
    preReference: pre,
    resultReference: persisted.reference,
    safeMetadata: persisted.safeMetadata,
  };
}

async function persistRequestAndPre(
  persistence: TerminalArtifactPersistence,
): Promise<{
  readonly request: Awaited<
    ReturnType<TerminalArtifactPersistence["persistRequest"]>
  >;
  readonly pre: Awaited<
    ReturnType<TerminalArtifactPersistence["persistObservation"]>
  >;
}> {
  const request = await persistRequest(persistence);
  const pre = await persistence.persistObservation({
    operation_id: OPERATION_ID,
    request_hash: REQUEST_HASH,
    phase: "pre",
    observed_at: "2026-07-29T00:00:00.000Z",
  });
  return { request, pre };
}

async function persistRequest(
  persistence: TerminalArtifactPersistence,
): Promise<Awaited<ReturnType<TerminalArtifactPersistence["persistRequest"]>>> {
  return persistence.persistRequest({
    operation_id: OPERATION_ID,
    request_hash: REQUEST_HASH,
    invocation: invocation(),
    execution: {
      cwd: "/project",
      executable: "/bin/sh",
      arguments: ["-c", "printf super-secret-output"],
      timeout_ms: 30_000,
      max_output_bytes: 4_096,
      inherited_environment_keys: ["PATH"],
      removed_environment_keys: ["COPE_INTERNAL_TOKEN"],
      environment_keys_hash: "a".repeat(64),
    },
  });
}

function invocation(): TerminalExecResult["invocation"] {
  return {
    contract: TERMINAL_EXEC_CONTRACT,
    mode: "shell",
    command: "printf super-secret-output",
    cwd: ".",
  };
}

function exitReceipt(): Parameters<
  TerminalArtifactPersistence["persistExitReceipt"]
>[0] {
  return {
    operation_id: OPERATION_ID,
    request_hash: REQUEST_HASH,
    outcome: "completed_nonzero",
    exit_code: 7,
    signal: null,
    started_at: "2026-07-29T00:00:00.000Z",
    completed_at: "2026-07-29T00:00:01.000Z",
    duration_ms: 1_000,
    timeout_attributed: false,
    cancellation_attributed: false,
    stdout_bytes: Buffer.byteLength("super-secret-output"),
    stderr_bytes: 0,
  };
}

function terminalResult(): TerminalExecResult {
  return {
    contract: TERMINAL_EXEC_RESULT_CONTRACT,
    operation_id: OPERATION_ID,
    invocation: invocation(),
    outcome: "completed_nonzero",
    exit_code: 7,
    signal: null,
    started_at: "2026-07-29T00:00:00.000Z",
    completed_at: "2026-07-29T00:00:01.000Z",
    duration_ms: 1_000,
    timeout_attributed: false,
    cancellation_attributed: false,
    stdout: {
      bytes: Buffer.byteLength("super-secret-output"),
      head: "super-secret-output",
      tail: "",
      truncated: false,
    },
    stderr: {
      bytes: 0,
      head: "",
      tail: "",
      truncated: false,
    },
    redaction_count: 0,
    disclosure: "complete",
    mutation: {
      outcome: "unknown",
      created: [],
      updated: [],
      deleted: [],
      renamed: [],
      pre_existing_touched: [],
      changed_files: 0,
      changed_lines: 0,
      binary_files: 0,
      ignored_summary: "",
    },
    replayed: false,
  };
}

function workspaceObservation(
  phase: WorkspaceObservation["phase"],
  repositoryFingerprint: string,
): WorkspaceObservation {
  return {
    contract: WORKSPACE_OBSERVATION_CONTRACT,
    phase,
    observedAt:
      phase === "pre"
        ? "2026-07-29T00:00:00.000Z"
        : "2026-07-29T00:00:02.000Z",
    durationMs: 20,
    state: "complete",
    branch: "main",
    head: "b".repeat(40),
    repositoryFingerprint,
    components: {
      index: "1".repeat(64),
      visible: "2".repeat(64),
      excluded: "3".repeat(64),
      protectedWorktree: "4".repeat(64),
      gitTransitions: "5".repeat(64),
      gitControls: "6".repeat(64),
    },
    entries: [],
    beforeImages: [],
    transitionPaths: {
      paths: [],
      total: 0,
      omitted: 0,
      truncated: false,
      completeFactsSha256: "7".repeat(64),
    },
    ignoredCount: 0,
    ignoredSummarySha256: "8".repeat(64),
    ignoredSummaryTruncated: false,
    nestedRepository: "none",
    limitationCodes: [],
  };
}

function gitBlobObjectId(
  bytes: Buffer,
  algorithm: "sha1" | "sha256" = "sha1",
): string {
  return createHash(algorithm)
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}
