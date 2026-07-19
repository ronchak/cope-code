import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadCliFixture } from "../../src/cli/fixture-loader.js";

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
