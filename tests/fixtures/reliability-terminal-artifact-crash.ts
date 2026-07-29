import path from "node:path";

import {
  TERMINAL_EXEC_CONTRACT,
  TERMINAL_EXEC_RESULT_CONTRACT,
  type TerminalExecResult,
} from "../../src/protocol/terminal-exec.js";
import { SessionArtifactStore } from "../../src/session/artifact-store.js";
import { TerminalArtifactPersistence } from "../../src/session/terminal-artifacts.js";
import { sha256, stableJson } from "../../src/shared/crypto.js";

const root = process.argv[2];
const boundary = process.argv[3];
if (root === undefined || boundary === undefined) process.exit(2);

const operationId = "op_terminal_crash";
const invocation = {
  contract: TERMINAL_EXEC_CONTRACT,
  mode: "argv" as const,
  executable: "node",
  arguments: ["script.js"],
  cwd: ".",
};
const requestHash = sha256(stableJson(invocation));
const persistence = new TerminalArtifactPersistence(
  new SessionArtifactStore(path.join(root, "artifacts")),
);

const request = await persistence.persistRequest({
  operation_id: operationId,
  request_hash: requestHash,
  invocation,
  execution: {
    cwd: root,
    executable: process.execPath,
    arguments: ["script.js"],
    timeout_ms: 30_000,
    max_output_bytes: 4_096,
    inherited_environment_keys: ["PATH"],
    removed_environment_keys: [],
    environment_keys_hash: "a".repeat(64),
  },
});
crashAt("request");

const pre = await persistence.persistObservation({
  operation_id: operationId,
  request_hash: requestHash,
  phase: "pre",
  observed_at: "2026-07-29T00:00:00.000Z",
});
crashAt("pre");

const exit = await persistence.persistExitReceipt({
  operation_id: operationId,
  request_hash: requestHash,
  outcome: "completed",
  exit_code: 0,
  signal: null,
  started_at: "2026-07-29T00:00:00.000Z",
  completed_at: "2026-07-29T00:00:01.000Z",
  duration_ms: 1_000,
  timeout_attributed: false,
  cancellation_attributed: false,
  stdout_bytes: 5,
  stderr_bytes: 0,
});
crashAt("exit");

const post = await persistence.persistObservation({
  operation_id: operationId,
  request_hash: requestHash,
  phase: "post",
  observed_at: "2026-07-29T00:00:02.000Z",
});
crashAt("post");

const result: TerminalExecResult = {
  contract: TERMINAL_EXEC_RESULT_CONTRACT,
  operation_id: operationId,
  invocation,
  outcome: "completed",
  exit_code: 0,
  signal: null,
  started_at: "2026-07-29T00:00:00.000Z",
  completed_at: "2026-07-29T00:00:01.000Z",
  duration_ms: 1_000,
  timeout_attributed: false,
  cancellation_attributed: false,
  stdout: {
    bytes: 5,
    head: "exact",
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
await persistence.persistResult({
  operationId,
  requestHash,
  request,
  preObservation: pre,
  exitReceipt: exit,
  postObservation: post,
  result,
});
crashAt("result");
process.exit(3);

function crashAt(expected: string): void {
  if (boundary === expected) process.exit(86);
}
