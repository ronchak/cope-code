import assert from "node:assert/strict";
import test from "node:test";
import { CbaProtocolAdapter } from "../../src/orchestrator/cba-protocol-adapter.js";
import {
  MODEL_FACING_PROTOCOL_VERSION,
  ORCHESTRATOR_TOOL_NAMES,
  ProtocolParseError,
  TOOL_REGISTRY,
  parseProtocolEnvelope,
  serializeProtocolEnvelope,
} from "../../src/protocol/index.js";

test("CBA adapter renders bootstrap and normalizes a typed tool request", () => {
  const adapter = new CbaProtocolAdapter();
  const bootstrap = adapter.renderBootstrap({
    sessionId: "session_12345678",
    taskId: "task_12345678",
    objective: "Inspect the repository",
    acceptanceCriteria: ["Report status"],
    policySummary: {
      mode: "inspect",
      tools: ["list_files", "complete_task"],
      readable_paths: ["**"],
      writable_paths: [],
      command_ids: [],
      disclosure_classifications: ["internal"],
      network: "deny",
      budget_recovery: {
        disclosed_bytes: {
          current_limit: 2_000_000,
          available: true,
          higher_layer_ceiling: 8_000_000,
          blocking_layer: "organization",
        },
      },
    },
    budgetSummary: { limits: { maxTurns: 10, maxOperations: 20 } },
  });
  assert.match(bootstrap, /only software-engineering reasoning component/);
  assert.match(bootstrap, /"iterations"|"turns"/);
  assert.match(bootstrap, new RegExp(MODEL_FACING_PROTOCOL_VERSION.replace("/", "\\/"), "u"));
  assert.doesNotMatch(bootstrap, /Use task_id|operation_id values/u);
  assert.match(
    bootstrap,
    /"budget_recovery":\{"disclosed_bytes":\{"available":true,"blocking_layer":"organization","current_limit":2000000,"higher_layer_ceiling":8000000\}\}/u,
  );

  const response = `\`\`\`${MODEL_FACING_PROTOCOL_VERSION}
{"kind":"agent_intent","intent":"list_files","arguments":{"path":"."},"reason":"Inspect the bounded repository root."}
\`\`\``;
  const parsed = adapter.parseModelTurn(response, { taskId: "task_12345678", turnId: "turn_0001" });
  assert.equal(parsed.messages[0]?.type, "tool_request");
  if (parsed.messages[0]?.type === "tool_request") {
    assert.match(parsed.messages[0].calls[0]?.operationId ?? "", /^op_1_1_[a-f0-9]{20}$/u);
    assert.equal(parsed.messages[0].calls[0]?.name, "list_files");
    assert.deepEqual(parsed.messages[0].calls[0]?.arguments, { path: "." });
  }
});

test("CBA adapter ignores unknown policy-summary tools and scopes bootstrap guidance to active tools", () => {
  const bootstrap = new CbaProtocolAdapter().renderBootstrap({
    sessionId: "session_12345678",
    taskId: "task_12345678",
    objective: "Inspect the repository",
    acceptanceCriteria: [],
    policySummary: {
      mode: "inspect",
      tools: ["git_status", "forged_tool", 42],
      readable_paths: ["**"],
      writable_paths: [],
      command_ids: [],
      disclosure_classifications: ["internal"],
      network: "deny",
    },
    budgetSummary: {},
  });
  assert.match(bootstrap, /active batchable catalog \(git_status\)/u);
  assert.match(bootstrap, /"intent":"git_status"/u);
  assert.doesNotMatch(bootstrap, /forged_tool/u);
  assert.doesNotMatch(bootstrap, /active tool catalog \([^)]*list_files/u);
  assert.doesNotMatch(bootstrap, /budget_recovery/u);
});

test("CBA adapter routes every registry orchestrator tool outside ToolHost calls", () => {
  const expectedTypes = {
    request_user_input: "request_user_input",
    request_capability: "request_capability",
    complete_task: "complete_task",
  } as const;
  for (const tool of ORCHESTRATOR_TOOL_NAMES) {
    const response = serializeProtocolEnvelope({
      protocol: "cba/1",
      message_type: "tool_request",
      message_id: `message_${tool}`,
      task_id: "task_12345678",
      turn_id: 1,
      operations: [{
        operation_id: `operation_${tool}`,
        tool,
        arguments: TOOL_REGISTRY[tool].bootstrap_example,
      }] as never,
    });
    const parsed = new CbaProtocolAdapter().parseModelTurn(response, {
      taskId: "task_12345678",
      turnId: "turn_0001",
    });
    assert.equal(parsed.messages[0]?.type, expectedTypes[tool], `${tool} must route as an orchestrator action`);
  }
});

test("CBA adapter maps completion claims and emits structured rejection results", () => {
  const adapter = new CbaProtocolAdapter();
  const response = serializeProtocolEnvelope({
    protocol: "cba/1",
    message_type: "completion",
    message_id: "msg_complete",
    task_id: "task_12345678",
    turn_id: 2,
    operation_id: "op_complete",
    verified: false,
    report: {
      summary: "Done",
      acceptance_criteria: [{ criterion: "Tests pass", status: "satisfied", evidence: "test command" }],
      validation: [{ command_id: "test", status: "passed", summary: "All pass" }],
      skipped_validation: [],
      remaining_risks: [],
      follow_up: ["Review diff"],
    },
  });
  const parsed = adapter.parseModelTurn(response, { taskId: "task_12345678", turnId: "turn_0002" });
  assert.equal(parsed.messages[0]?.type, "complete_task");

  const rejection = adapter.renderCompletionRejected({
    taskId: "task_12345678",
    priorTurnId: "turn_0002",
    operationId: "op_complete",
    verification: {
      accepted: false,
      reasons: ["Required validation is stale."],
      actual: {
        changedPaths: [],
        agentChangedPaths: [],
        preExistingPaths: [],
        successfulCommands: [],
        failedCommands: [],
        gitStatusSummary: "clean",
        repositoryFingerprint: "0".repeat(64),
      },
    },
  });
  assert.match(rejection, /"kind":"harness_completion_rejected"/u);
  assert.match(rejection, /COMPLETION_NOT_VERIFIED/u);
  assert.doesNotMatch(rejection, /"task_id"|"message_id"/u);
});

test("CBA adapter enforces prior operation IDs through the protocol parser", () => {
  const adapter = new CbaProtocolAdapter({ seenOperationIds: () => new Set(["op_used"]) });
  const response = serializeProtocolEnvelope({
    protocol: "cba/1",
    message_type: "tool_request",
    message_id: "msg_3",
    task_id: "task_12345678",
    turn_id: 3,
    operations: [{ operation_id: "op_used", tool: "git_status", arguments: {} }],
  });
  assert.throws(
    () => adapter.parseModelTurn(response, { taskId: "task_12345678", turnId: "turn_0003" }),
    /already been used/,
  );
  assert.doesNotThrow(() => adapter.parseModelTurn(response, {
    taskId: "task_12345678",
    turnId: "turn_0003",
    recoveryReplay: true,
  }));
});

test("CBA adapter repairs only parser failures explicitly marked repairable", () => {
  const adapter = new CbaProtocolAdapter({ seenOperationIds: () => new Set(["op_used"]) });

  const capture = (
    raw: string,
    expected: { readonly taskId: string; readonly turnId: string },
  ): ProtocolParseError => {
    try {
      adapter.parseModelTurn(raw, expected);
    } catch (error) {
      assert.ok(error instanceof ProtocolParseError);
      return error;
    }
    throw new Error("expected parse failure");
  };

  const malformed = capture("not a protocol envelope", {
    taskId: "task_12345678",
    turnId: "turn_0001",
  });
  assert.equal(adapter.isRepairableParseError(malformed), true);

  const correlated = serializeProtocolEnvelope({
    protocol: "cba/1",
    message_type: "tool_request",
    message_id: "msg_correlation",
    task_id: "task_other",
    turn_id: 9,
    operations: [{ operation_id: "op_new", tool: "git_status", arguments: {} }],
  });
  for (const [error, code] of [
    [
      capture(correlated, { taskId: "task_12345678", turnId: "turn_0009" }),
      "TASK_MISMATCH",
    ],
    [
      capture(correlated, { taskId: "task_other", turnId: "turn_0008" }),
      "TURN_MISMATCH",
    ],
    [
      capture("x".repeat(1_048_577), { taskId: "task_12345678", turnId: "turn_0001" }),
      "INPUT_TOO_LARGE",
    ],
  ] as const) {
    assert.equal(error.protocolCode, code);
    assert.equal(adapter.isRepairableParseError(error), false);
  }

  const cases = [
    new ProtocolParseError("DUPLICATE_OPERATION_ID", "duplicate operation", {}, false),
    new Error("unexpected adapter failure"),
  ];
  for (const error of cases) {
    assert.equal(adapter.isRepairableParseError(error), false);
  }
});

test("CBA adapter rejects an unowned captured fence when the runtime gate is bypassed", () => {
  const adapter = new CbaProtocolAdapter();
  const body =
    '{"kind":"agent_progress","phase":"discovering","summary":"Parser-valid bytes without widget ownership."}';
  const fence = [
    "```cba-agent/1",
    body,
    "```",
  ].join("\n");
  const unownedCaptureEvidence = {
    contractVersion: "response-capture/v2",
    status: "model_protocol_malformed",
    reasonCode: "MODEL_PROTOCOL_UNOWNED_FENCE",
    protocolErrorCode: "MISSING_ENVELOPE",
    codeBlockCount: 1,
    protocolBlockCount: 0,
    editorCount: 1,
    bannerCount: 0,
    lineCount: 0,
    contentBytes: 50,
  } as const;
  const expected = {
    taskId: "task_12345678",
    turnId: "turn_0001",
  } as const;

  assert.throws(
    () => adapter.parseModelTurn(fence, {
      ...expected,
      captureEvidence: unownedCaptureEvidence,
    }),
    (error: unknown) =>
      error instanceof ProtocolParseError &&
      error.protocolCode === "MISSING_ENVELOPE" &&
      error.repairable === true &&
      error.details.stage === "model_response_capture",
  );

  const withoutEvidence = adapter.parseModelTurn(fence, expected);
  assert.equal(withoutEvidence.messages.length, 1);
  assert.equal(withoutEvidence.messages[0]?.type, "progress");

  const reconstructedCaptureEvidence = {
    contractVersion: "response-capture/v2",
    status: "protocol_reconstructed",
    protocolVersion: "cba-agent/1",
    codeBlockCount: 1,
    protocolBlockCount: 1,
    editorCount: 1,
    bannerCount: 1,
    lineCount: 1,
    contentBytes: Buffer.byteLength(body),
    bannerContract: "supported",
    bannerTokenCount: 1,
    bannerMatchesBaseline: false,
    bannerVariant: "deadbeef",
  } as const;
  const withReconstructedEvidence = adapter.parseModelTurn(fence, {
    ...expected,
    captureEvidence: reconstructedCaptureEvidence,
  });
  assert.equal(withReconstructedEvidence.messages.length, 1);
  assert.equal(withReconstructedEvidence.messages[0]?.type, "progress");
});

test("CBA adapter preserves runtime semantics for every capture evidence status", () => {
  const adapter = new CbaProtocolAdapter();
  const expected = {
    taskId: "task_12345678",
    turnId: "turn_0001",
  } as const;
  const plainProse = "This is ordinary rendered prose.";
  const progressBody =
    '{"kind":"agent_progress","phase":"discovering","summary":"Progress update."}';
  const progressFence = [
    "```cba-agent/1",
    progressBody,
    "```",
  ].join("\n");
  const evidence = (
    status: string,
    raw: string,
    extra: Readonly<Record<string, unknown>> = {},
  ): Readonly<Record<string, unknown>> => ({
    contractVersion: "response-capture/v2",
    status,
    codeBlockCount: 0,
    protocolBlockCount: 0,
    editorCount: 0,
    bannerCount: 0,
    lineCount: 0,
    contentBytes: Buffer.byteLength(raw, "utf8"),
    ...extra,
  });
  const parseError = (
    raw: string,
    captureEvidence?: Readonly<Record<string, unknown>>,
  ): ProtocolParseError => {
    try {
      adapter.parseModelTurn(raw, {
        ...expected,
        ...(captureEvidence === undefined ? {} : { captureEvidence }),
      });
    } catch (error) {
      assert.ok(error instanceof ProtocolParseError);
      return error;
    }
    assert.fail("expected a protocol parse failure");
  };

  const withoutEvidence = parseError(plainProse);
  assert.equal(withoutEvidence.protocolCode, "MISSING_ENVELOPE");
  assert.equal(withoutEvidence.repairable, true);

  const renderedText = parseError(
    plainProse,
    evidence("rendered_text", plainProse),
  );
  assert.equal(renderedText.protocolCode, "MISSING_ENVELOPE");
  assert.equal(renderedText.repairable, true);

  const reconstructed = adapter.parseModelTurn(progressFence, {
    ...expected,
    captureEvidence: evidence("protocol_reconstructed", progressFence, {
      protocolVersion: "cba-agent/1",
      codeBlockCount: 1,
      protocolBlockCount: 1,
      editorCount: 1,
      bannerCount: 1,
      lineCount: 1,
      contentBytes: Buffer.byteLength(progressBody, "utf8"),
    }),
  });
  assert.equal(reconstructed.messages.length, 1);
  assert.equal(reconstructed.messages[0]?.type, "progress");

  const malformed = parseError(
    progressFence,
    evidence("model_protocol_malformed", progressFence, {
      protocolErrorCode: "MISSING_ENVELOPE",
      codeBlockCount: 1,
      editorCount: 1,
    }),
  );
  assert.equal(malformed.protocolCode, "MISSING_ENVELOPE");
  assert.equal(malformed.repairable, true);
  assert.equal(malformed.details.stage, "model_response_capture");
  assert.equal(malformed.details.capture_evidence, undefined);

  const renderedFence = parseError(
    progressFence,
    evidence("rendered_text", progressFence),
  );
  assert.equal(renderedFence.protocolCode, "INVALID_MESSAGE");
  assert.equal(renderedFence.repairable, false);
  assert.equal(renderedFence.details.capture_ownership_failed, true);

  for (const status of [
    "protocol_widget_incomplete",
    "protocol_widget_ambiguous",
    "protocol_widget_capture_failed",
    "unsupported_capture_contract",
  ]) {
    const error = parseError(progressFence, evidence(status, progressFence));
    assert.equal(error.protocolCode, "INVALID_MESSAGE", status);
    assert.equal(error.repairable, false, status);
    assert.equal(error.details.capture_ownership_failed, true, status);
  }

  const invalidEvidence = parseError(progressFence, {
    contractVersion: "response-capture/v2",
    status: "protocol_reconstructed",
  });
  assert.equal(invalidEvidence.protocolCode, "INVALID_MESSAGE");
  assert.equal(invalidEvidence.repairable, false);
  assert.equal(invalidEvidence.details.capture_evidence_invalid, true);
});

test("legacy task and turn identity are rebound only for marker-proven live turns", () => {
  const legacy = serializeProtocolEnvelope({
    protocol: "cba/1",
    message_type: "tool_request",
    message_id: "msg_stale",
    task_id: "task_stale",
    turn_id: 99,
    operations: [{ operation_id: "op_legacy_read", tool: "git_status", arguments: {} }],
  });
  const live = new CbaProtocolAdapter({ allowLegacyCorrelationRebind: true });
  const rebound = live.parseModelTurn(legacy, {
    taskId: "task_active",
    turnId: "turn_0004",
  });
  assert.equal(rebound.messages[0]?.type, "tool_request");
  assert.deepEqual(rebound.normalizations, [{
    kind: "legacy_correlation_rebound",
    receivedTaskId: "task_stale",
    expectedTaskId: "task_active",
    receivedTurnId: 99,
    expectedTurnId: 4,
  }]);

  assert.throws(
    () => new CbaProtocolAdapter().parseModelTurn(legacy, {
      taskId: "task_active",
      turnId: "turn_0004",
    }),
    /does not match active task/u,
  );
  assert.throws(
    () => live.parseModelTurn(legacy, {
      taskId: "task_active",
      turnId: "turn_0004",
      recoveryReplay: true,
    }),
    /does not match active task/u,
  );
});

test("CBA adapter selects the parser from the executable envelope instead of surrounding prose", () => {
  const legacy = serializeProtocolEnvelope({
    protocol: "cba/1",
    message_type: "tool_request",
    message_id: "msg_legacy_with_migration_note",
    task_id: "task_12345678",
    turn_id: 5,
    operations: [{ operation_id: "op_legacy_status", tool: "git_status", arguments: {} }],
  });
  const response = [
    "Migration note: future responses should use ```cba-agent/1 after this legacy turn.",
    legacy,
  ].join("\n\n");

  const parsed = new CbaProtocolAdapter().parseModelTurn(response, {
    taskId: "task_12345678",
    turnId: "turn_0005",
  });
  assert.equal(parsed.messages[0]?.type, "tool_request");
  if (parsed.messages[0]?.type === "tool_request") {
    assert.equal(parsed.messages[0].calls[0]?.operationId, "op_legacy_status");
    assert.equal(parsed.messages[0].calls[0]?.name, "git_status");
  }
});

test("generic Copilot fallback is a repairable typed diagnostic", () => {
  const adapter = new CbaProtocolAdapter();
  assert.throws(
    () => adapter.parseModelTurn(
      "Sorry, I wasn't able to respond to that. Is there something else I can help with?",
      { taskId: "task_active", turnId: "turn_0001" },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProtocolParseError);
      assert.equal(error.repairable, true);
      assert.equal(error.details.diagnostic_code, "COPILOT_GENERIC_FALLBACK");
      return true;
    },
  );
});

test("model-facing harness results expose operation references without transport correlation", () => {
  const rendered = new CbaProtocolAdapter().renderToolOutcomes({
    taskId: "task_private",
    priorTurnId: "turn_0003",
    outcomes: [{
      operationId: "op_generated",
      tool: "list_files",
      status: "denied",
      data: {
        code: "DISCLOSURE_OPERATION_LIMIT_EXCEEDED",
        message: "Reduce max_results.",
        details: { retry_with: { max_results: 20 } },
      },
      safeMetadata: {},
    }],
  });
  assert.match(rendered, /"kind":"harness_tool_results"/u);
  assert.match(rendered, /"retry_allowed":true/u);
  assert.match(rendered, /"max_results":20/u);
  assert.doesNotMatch(rendered, /task_private|"task_id"|"turn_id"|"message_id"/u);
});
