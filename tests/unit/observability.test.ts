import assert from "node:assert/strict";
import test from "node:test";

import {
  ObservabilityReporter,
  recordsForProgress,
  type ObservabilityRecord,
} from "../../src/observability/index.js";

test("observability projection is OpenTelemetry-shaped and rejects source, task text, paths, and secrets", () => {
  const records = recordsForProgress({
    kind: "tool",
    timestamp: "2026-07-21T12:00:00.123Z",
    status: "executing_tools",
    turnId: "turn_with_sensitive_task_text",
    operationId: "op_secret",
    detail: {
      tool: "ghp_abcdefghijklmnopqrstuvwxyz123456",
      outcome: "success",
      content: "private source body",
      path: ".env",
      objective: "confidential task text",
      stdout: "PASSWORD=hunter2",
    },
  });
  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes("private source body"), false);
  assert.equal(serialized.includes("confidential task text"), false);
  assert.equal(serialized.includes("PASSWORD"), false);
  assert.equal(serialized.includes("hunter2"), false);
  assert.equal(serialized.includes(".env"), false);
  assert.equal(serialized.includes("ghp_"), false);
  assert.equal(serialized.includes("turn_with"), false);
  assert.equal(serialized.includes("op_secret"), false);
  assert.equal(records[0]?.name, "cope.runtime.tool");
  assert.equal(records[0]?.timestampUnixNano, "1784635200123000000");
  assert.equal(records[1]?.name, "cope.runtime.events");
});

test("reporter bounds queues and isolates exporter failure and timeout", async () => {
  const attempted: ObservabilityRecord[][] = [];
  const reporter = new ObservabilityReporter({
    export: async (records) => {
      attempted.push([...records]);
      throw new Error("collector unavailable");
    },
  }, { maxQueueRecords: 4, maxBatchRecords: 2, exportTimeoutMs: 50 });
  for (let index = 0; index < 10; index += 1) {
    assert.doesNotThrow(() => reporter.observe({
      kind: "model",
      timestamp: `2026-07-21T12:00:${String(index).padStart(2, "0")}.000Z`,
      status: "awaiting_model",
      detail: { status: "received", responseBytes: index },
    }));
  }
  await assert.doesNotReject(reporter.flush());
  assert.equal(attempted.length > 0, true);
  assert.equal(reporter.stats().failedBatches > 0, true);
  assert.equal(reporter.stats().droppedRecords > 0, true);

  const hanging = new ObservabilityReporter({
    export: async (_records, signal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }),
  }, { exportTimeoutMs: 10 });
  hanging.observe({
    kind: "state",
    timestamp: "2026-07-21T12:00:00.000Z",
    status: "paused",
    detail: { from: "awaiting_model", to: "paused", reason: "private reason" },
  });
  await assert.doesNotReject(hanging.flush());
  assert.equal(hanging.stats().failedBatches, 1);
});

test("successful exporter receives bounded batches and aggregate metrics", async () => {
  const batches: readonly ObservabilityRecord[][] = [];
  const mutable = batches as ObservabilityRecord[][];
  const reporter = new ObservabilityReporter({
    export: async (records) => { mutable.push([...records]); },
  }, { maxBatchRecords: 2 });
  reporter.observe({
    kind: "completion",
    timestamp: "2026-07-21T12:00:00.000Z",
    status: "validating_completion",
    detail: { accepted: true, changedFileCount: 2, successfulCommandCount: 1, failedCommandCount: 0 },
  });
  await reporter.flush();
  assert.equal(batches.every((batch) => batch.length <= 2), true);
  const names = batches.flat().map((record) => record.name);
  assert.equal(names.includes("cope.completion.changed_files"), true);
  assert.equal(names.includes("cope.completion.successful_commands"), true);
  assert.equal(reporter.stats().exportedBatches >= 1, true);
});
