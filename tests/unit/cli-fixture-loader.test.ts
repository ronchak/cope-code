import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadCliFixture } from "../../src/cli/fixture-loader.js";
import { CbaProtocolAdapter } from "../../src/orchestrator/cba-protocol-adapter.js";

test("CLI fixture loader materializes correlation placeholders deterministically", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cba-cli-fixture-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "fixture.json");
  await writeFile(filename, JSON.stringify({
    schema_version: "cba-scripted-fixture/1",
    turns: [{
      expected_content_contains: "task={{TASK_ID}}",
      conversation_id: "conversation-fixture",
      response: {
        status: "completed",
        response_id: "response-{{TURN_ID}}",
        content: "reply {{TASK_ID}} {{SUBMISSION_ID}}",
      },
    }],
  }));

  const fixture = await loadCliFixture(filename, { taskId: "task_fixture_1" });
  const submissionId = fixture.idFactory("submission");
  assert.equal(submissionId, "submission_fixture_0001");
  const receipt = await fixture.transport.submit({
    taskId: "task_fixture_1",
    turnId: "turn_0001",
    submissionId,
    content: "prefix task=task_fixture_1 suffix",
  });
  assert.equal(receipt.status, "submitted");
  const response = await fixture.transport.receive({
    taskId: "task_fixture_1",
    turnId: "turn_0001",
    submissionId,
  });
  assert.equal(response.status, "completed");
  if (response.status === "completed") {
    assert.equal(response.content, "reply task_fixture_1 submission_fixture_0001");
  }
});

test("CLI fixture loader fails closed on unknown fields", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cba-cli-fixture-invalid-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "fixture.json");
  await writeFile(filename, JSON.stringify({
    schema_version: "cba-scripted-fixture/1",
    turns: [{ response: { status: "completed", content: "ok" }, unsafe: true }],
  }));
  await assert.rejects(() => loadCliFixture(filename, { taskId: "task_fixture_1" }), /unknown fields/);
});

test("bundled discovery fixture cites the harness-generated successful operation", async () => {
  const taskId = "task_fixture_discovery";
  const fixture = await loadCliFixture(
    path.resolve(process.cwd(), "fixtures/model/example-discovery-session.json"),
    { taskId },
  );
  const adapter = new CbaProtocolAdapter();

  const firstSubmissionId = fixture.idFactory("submission");
  const firstRequest = {
    taskId,
    turnId: "turn_0001",
    submissionId: firstSubmissionId,
    content: "COPILOT BROWSER AGENT CONTRACT",
  } as const;
  await fixture.transport.submit(firstRequest);
  const firstResponse = await fixture.transport.receive(firstRequest);
  assert.equal(firstResponse.status, "completed");
  if (firstResponse.status !== "completed") return;
  const firstTurn = adapter.parseModelTurn(firstResponse.content, {
    taskId,
    turnId: "turn_0001",
  });
  assert.equal(firstTurn.messages[0]?.type, "tool_request");
  if (firstTurn.messages[0]?.type !== "tool_request") return;
  const operationRef = firstTurn.messages[0].calls[0]?.operationId;
  assert.ok(operationRef);

  const secondSubmissionId = fixture.idFactory("submission");
  const secondRequest = {
    taskId,
    turnId: "turn_0002",
    submissionId: secondSubmissionId,
    content: [
      "COPE HARNESS MESSAGE — cba-agent/1",
      "<authoritative_harness_message_json>",
      JSON.stringify({
        kind: "harness_tool_results",
        results: [{
          operation_ref: operationRef,
          tool: "list_files",
          status: "success",
          output: { entries: ["README.md"] },
        }],
      }),
      "</authoritative_harness_message_json>",
    ].join("\n"),
  } as const;
  await fixture.transport.submit(secondRequest);
  const secondResponse = await fixture.transport.receive(secondRequest);
  assert.equal(secondResponse.status, "completed");
  if (secondResponse.status !== "completed") return;
  const secondTurn = adapter.parseModelTurn(secondResponse.content, {
    taskId,
    turnId: "turn_0002",
  });
  assert.equal(secondTurn.messages[0]?.type, "complete_task");
  if (secondTurn.messages[0]?.type === "complete_task") {
    assert.deepEqual(secondTurn.messages[0].claim.basis?.toolResultRefs, [operationRef]);
  }
});
