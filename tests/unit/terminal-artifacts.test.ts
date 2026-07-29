import assert from "node:assert/strict";
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
  assert.equal(
    (await persistence.inspectIncompleteEvidence({
      operationId: OPERATION_ID,
      requestHash: REQUEST_HASH,
      recoveryContext: "ordinary_process_crash",
      journalStatus: "failed",
      journalSafeResult: metadata,
    })).state,
    "completed_prelaunch_failure",
  );
  assert.equal(isTerminalPrelaunchFailureMetadata({
    ...metadata,
    extra: true,
  }), false);
  assert.equal(
    (await persistence.inspectIncompleteEvidence({
      operationId: OPERATION_ID,
      requestHash: REQUEST_HASH,
      recoveryContext: "known_power_or_storage_loss",
      journalStatus: "failed",
      journalSafeResult: { ...metadata, extra: true },
    })).state,
    "completed_unproven_without_result",
  );
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
      limitationCodes: ["VISIBLE_STATE_BOUND_EXCEEDED"],
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

async function createCompleteFixture(): Promise<{
  readonly root: string;
  readonly artifacts: SessionArtifactStore;
  readonly persistence: TerminalArtifactPersistence;
  readonly result: TerminalExecResult;
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
