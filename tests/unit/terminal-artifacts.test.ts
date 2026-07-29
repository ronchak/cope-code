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
import { SessionArtifactStore } from "../../src/session/artifact-store.js";
import {
  TerminalArtifactPersistence,
  isTerminalJournalResultMetadata,
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
  const request = await persistence.persistRequest({
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
  const pre = await persistence.persistObservation({
    operation_id: OPERATION_ID,
    request_hash: REQUEST_HASH,
    phase: "pre",
    observed_at: "2026-07-29T00:00:00.000Z",
  });
  return { request, pre };
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
