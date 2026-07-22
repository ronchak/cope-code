import assert from "node:assert/strict";
import test from "node:test";

import { COPE_EVENTS_VERSION, CopeEventStream } from "../../src/cli/event-stream.js";

test("cope-events/1 is ordered JSONL and projects only source-free runtime fields", () => {
  let output = "";
  const stream = new CopeEventStream({ write: (value) => { output += value; } });
  stream.runtimeProgress({
    kind: "tool",
    timestamp: "2026-07-21T12:00:00.000Z",
    status: "executing_tools",
    turnId: "turn_0001",
    operationId: "op_read",
    detail: {
      tool: "read_file",
      outcome: "success",
      content: "TOP SECRET SOURCE",
      stdout: "must not escape",
      path: "secret.txt",
    },
  });
  stream.runtimeProgress({
    kind: "state",
    timestamp: "2026-07-21T12:00:01.000Z",
    status: "paused",
    detail: { from: "running", to: "paused", reason: "sensitive human text" },
  });

  const lines = output.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(lines.map((line) => line.sequence), [1, 2, 3]);
  assert.equal(lines.every((line) => line.schema_version === COPE_EVENTS_VERSION), true);
  assert.equal(lines[0]?.event, "stream.started");
  assert.equal((lines[0]?.capabilities as Record<string, unknown>).source_free, true);
  assert.equal(lines[1]?.event, "runtime.progress");
  assert.equal(output.includes("TOP SECRET SOURCE"), false);
  assert.equal(output.includes("must not escape"), false);
  assert.equal(output.includes("secret.txt"), false);
  assert.equal(output.includes("sensitive human text"), false);
  assert.equal((lines[2]?.data as Record<string, unknown>).has_reason, true);
});
