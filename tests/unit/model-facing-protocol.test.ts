import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_FACING_PROTOCOL_VERSION,
  ProtocolParseError,
  normalizeModelFacingMessage,
  parseModelFacingEnvelope,
  parseProtocolEnvelope,
  serializeProtocolEnvelope,
} from "../../src/protocol/index.js";

function envelope(value: unknown): string {
  return `\`\`\`${MODEL_FACING_PROTOCOL_VERSION}\n${JSON.stringify(value)}\n\`\`\``;
}

test("model-facing tool intents normalize to harness-owned cba/1 identity", () => {
  const raw = envelope({
    kind: "agent_intent",
    intent: "read_file",
    arguments: { path: "README.md", max_bytes: 12_000 },
    reason: "Need the project overview.",
  });
  const parsed = parseModelFacingEnvelope(raw);
  const first = normalizeModelFacingMessage(parsed, {
    taskId: "task_active",
    turnId: 7,
    rawResponse: raw,
  });
  const second = normalizeModelFacingMessage(parsed, {
    taskId: "task_active",
    turnId: 7,
    rawResponse: raw,
  });
  assert.deepEqual(second, first);
  assert.equal(first.task_id, "task_active");
  assert.equal(first.turn_id, 7);
  assert.match(first.message_id, /^msg_7_[a-f0-9]{16}$/u);
  assert.equal(first.message_type, "tool_request");
  if (first.message_type !== "tool_request") return;
  assert.match(first.operations[0]?.operation_id ?? "", /^op_7_1_[a-f0-9]{20}$/u);
  assert.equal(first.operations[0]?.tool, "read_file");

  assert.doesNotThrow(() => parseProtocolEnvelope(serializeProtocolEnvelope(first), {
    expected_task_id: "task_active",
    expected_turn_id: 7,
  }));
});

test("model-facing observation batches accept only independent read tools", () => {
  const parsed = parseModelFacingEnvelope(envelope({
    kind: "agent_intent",
    intent: "observe",
    observations: [
      { tool: "git_status", arguments: {} },
      { tool: "read_file", arguments: { path: "README.md" } },
    ],
    reason: "Need independent repository facts.",
  }));
  const normalized = normalizeModelFacingMessage(parsed, {
    taskId: "task_batch",
    turnId: 2,
    rawResponse: "batch",
  });
  assert.equal(normalized.message_type, "tool_request");
  if (normalized.message_type === "tool_request") {
    assert.equal(normalized.operations.length, 2);
    assert.notEqual(normalized.operations[0]?.operation_id, normalized.operations[1]?.operation_id);
  }

  assert.throws(
    () => parseModelFacingEnvelope(envelope({
      kind: "agent_intent",
      intent: "observe",
      observations: [{ tool: "apply_patch", arguments: { changes: [] } }],
      reason: "Invalid batch.",
    })),
    (error: unknown) =>
      error instanceof ProtocolParseError &&
      error.protocolCode === "SCHEMA_INVALID",
  );
  assert.throws(
    () => parseModelFacingEnvelope(envelope({
      kind: "agent_intent",
      intent: "observe",
      observations: [{
        tool: "terminal_exec",
        arguments: {
          contract: "terminal-exec/1",
          mode: "shell",
          command: "npm test",
        },
      }],
      reason: "Terminal execution cannot be batched as observation.",
    })),
    (error: unknown) =>
      error instanceof ProtocolParseError &&
      error.protocolCode === "SCHEMA_INVALID",
  );
});

test("agent answers, blocked states, and progress omit transport identity", () => {
  const answer = parseModelFacingEnvelope(envelope({
    kind: "agent_answer",
    content_markdown: "The repository is a local browser harness.",
    basis: {
      observed_files: ["README.md"],
      tool_result_refs: ["read_readme"],
      user_provided_context: true,
    },
    limitations: ["No live browser pilot was run."],
  }));
  assert.equal(answer.kind, "agent_answer");
  if (answer.kind === "agent_answer") {
    assert.equal(answer.report.kind, "answer");
    assert.deepEqual(answer.report.basis?.observed_files, ["README.md"]);
  }

  const blocked = parseModelFacingEnvelope(envelope({
    kind: "agent_blocked",
    reason: "No readable documentation is available.",
    needed: "Read access to docs.",
    recoverable: true,
  }));
  assert.deepEqual(blocked, {
    kind: "agent_blocked",
    reason: "No readable documentation is available.",
    needed: ["Read access to docs."],
    recoverable: true,
  });

  const progress = parseModelFacingEnvelope(envelope({
    kind: "agent_progress",
    phase: "discovering",
    summary: "Inspecting project documentation.",
  }));
  assert.equal(progress.kind, "agent_progress");

  assert.throws(
    () => parseModelFacingEnvelope(envelope({
      kind: "agent_answer",
      content_markdown: "Unsupported answer.",
      limitations: [],
    })),
    /missing or unknown fields/u,
  );
});

test("model-facing parser rejects malformed, oversized, and multiple CBA-family envelopes", () => {
  assert.throws(
    () => parseModelFacingEnvelope(envelope({
      kind: "agent_intent",
      intent: "read_file",
      arguments: { path: "README.md", surprise: true },
      reason: "Invalid arguments.",
    })),
    /Arguments for 'read_file' are invalid/u,
  );
  assert.throws(
    () => parseModelFacingEnvelope(
      `${envelope({
        kind: "agent_progress",
        phase: "planning",
        summary: "one",
      })}\n${serializeProtocolEnvelope({
        protocol: "cba/1",
        message_type: "progress_update",
        message_id: "legacy_message",
        task_id: "task_legacy",
        turn_id: 1,
        phase: "planning",
        summary: "two",
      })}`,
    ),
    (error: unknown) =>
      error instanceof ProtocolParseError &&
      error.protocolCode === "MULTIPLE_ENVELOPES",
  );
  assert.throws(
    () => parseModelFacingEnvelope("x".repeat(1_048_577)),
    (error: unknown) =>
      error instanceof ProtocolParseError &&
      error.protocolCode === "INPUT_TOO_LARGE" &&
      error.repairable === false,
  );
});
