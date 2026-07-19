import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OPERATION_ID_MAX_LENGTH,
  ProtocolParseError,
  ProtocolParser,
  isOperationId,
  parseProtocolEnvelope,
} from "../../src/protocol/index.js";
import { OperationJournal } from "../../src/session/operation-journal.js";

function envelope(operationId: string): string {
  return [
    "```cba/1",
    JSON.stringify({
      protocol: "cba/1",
      message_type: "tool_request",
      message_id: "msg.contract:v1",
      task_id: "task.contract:v1",
      turn_id: 1,
      operations: [{ operation_id: operationId, tool: "git_status", arguments: {} }],
    }),
    "```",
  ].join("\n");
}

function parserAccepts(operationId: string): boolean {
  try {
    parseProtocolEnvelope(envelope(operationId), {
      expected_task_id: "task.contract:v1",
      expected_turn_id: 1,
    });
    return true;
  } catch (error) {
    assert.ok(error instanceof ProtocolParseError);
    assert.equal(error.protocolCode, "SCHEMA_INVALID");
    return false;
  }
}

async function journalAccepts(operationId: string): Promise<boolean> {
  const root = await mkdtemp(path.join(tmpdir(), "cba-operation-id-"));
  const journal = new OperationJournal(root, "session_12345678");
  try {
    await journal.register(operationId, "git_status", false, {}, "2026-01-01T00:00:00.000Z");
    return true;
  } catch (error) {
    assert.match(String(error), /Unsafe operation identifier/u);
    return false;
  }
}

test("parser, journal, and shared cba/1 validator enforce the same operation-ID boundaries", async () => {
  const maxLengthId = `a${"_-".repeat(63)}_`;
  assert.equal(maxLengthId.length, OPERATION_ID_MAX_LENGTH);

  const cases: readonly { readonly id: string; readonly accepted: boolean; readonly label: string }[] = [
    { id: "abc", accepted: true, label: "minimum length" },
    { id: "A_-", accepted: true, label: "allowed punctuation" },
    { id: maxLengthId, accepted: true, label: "maximum length" },
    { id: "a", accepted: false, label: "one character" },
    { id: "ab", accepted: false, label: "too short" },
    { id: `${maxLengthId}x`, accepted: false, label: "too long" },
    { id: "op:1", accepted: false, label: "colon" },
    { id: "op.1", accepted: false, label: "dot" },
    { id: "op/1", accepted: false, label: "forward separator" },
    { id: "op\\1", accepted: false, label: "back separator" },
    { id: "_op", accepted: false, label: "non-alphanumeric prefix" },
  ];

  for (const entry of cases) {
    assert.equal(isOperationId(entry.id), entry.accepted, `shared validator: ${entry.label}`);
    assert.equal(parserAccepts(entry.id), entry.accepted, `protocol parser: ${entry.label}`);
    assert.equal(await journalAccepts(entry.id), entry.accepted, `operation journal: ${entry.label}`);
  }
});

test("stateful replay restoration rejects operation IDs that cannot be journal filenames", () => {
  const parser = new ProtocolParser();
  parser.restoreOperationIds(["op_valid"]);
  assert.deepEqual(parser.snapshotOperationIds(), ["op_valid"]);
  assert.throws(
    () => parser.restoreOperationIds(["op.invalid"]),
    (error: unknown) =>
      error instanceof ProtocolParseError && error.protocolCode === "SCHEMA_INVALID" && !error.repairable,
  );
});

test("broader task and message identifiers remain independent from operation IDs", () => {
  const parsed = parseProtocolEnvelope(envelope("op_valid"), {
    expected_task_id: "task.contract:v1",
    expected_turn_id: 1,
  });
  assert.equal(parsed.task_id, "task.contract:v1");
  assert.equal(parsed.message_id, "msg.contract:v1");
});
