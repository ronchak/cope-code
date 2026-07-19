import assert from "node:assert/strict";
import test from "node:test";
import { CbaProtocolAdapter } from "../../src/orchestrator/cba-protocol-adapter.js";
import { parseProtocolEnvelope, serializeProtocolEnvelope } from "../../src/protocol/index.js";

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
    },
    budgetSummary: { limits: { maxTurns: 10, maxOperations: 20 } },
  });
  assert.match(bootstrap, /only software-engineering reasoning component/);
  assert.match(bootstrap, /"iterations"|"turns"/);

  const response = serializeProtocolEnvelope({
    protocol: "cba/1",
    message_type: "tool_request",
    message_id: "msg_1",
    task_id: "task_12345678",
    turn_id: 1,
    operations: [{ operation_id: "op_1", tool: "list_files", arguments: { path: "." } }],
  });
  const parsed = adapter.parseModelTurn(response, { taskId: "task_12345678", turnId: "turn_0001" });
  assert.deepEqual(parsed.messages, [
    {
      type: "tool_request",
      calls: [{ operationId: "op_1", name: "list_files", arguments: { path: "." } }],
    },
  ]);
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
  const wire = parseProtocolEnvelope(rejection, {
    expected_task_id: "task_12345678",
    expected_turn_id: 2,
  });
  assert.equal(wire.message_type, "tool_result");
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
