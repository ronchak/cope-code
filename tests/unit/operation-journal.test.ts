import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { OperationJournal } from "../../src/session/operation-journal.js";
import { sha256, stableJson } from "../../src/shared/crypto.js";

test("operation journal safely replays completed operations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-op-"));
  const journal = new OperationJournal(root, "session_12345678");
  const request = { path: "src/a.ts" };
  const registered = await journal.register("op_123", "read_file", false, request, "2026-01-01T00:00:00Z");
  assert.equal(registered.kind, "new");
  const executing = await journal.markExecuting(registered.record, "2026-01-01T00:00:01Z");
  await journal.markCompleted(executing, "2026-01-01T00:00:02Z", "success", { sha256: "abc" });
  const replay = await journal.register("op_123", "read_file", false, request, "2026-01-01T00:00:03Z");
  assert.equal(replay.kind, "replay_completed");
  assert.deepEqual(replay.record.safeResult, { sha256: "abc" });
});

test("operation journal rejects identifier reuse with a different request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-op-"));
  const journal = new OperationJournal(root, "session_12345678");
  await journal.register("op_123", "apply_patch", true, { content: "a" }, "2026-01-01T00:00:00Z");
  await assert.rejects(
    () => journal.register("op_123", "apply_patch", true, { content: "b" }, "2026-01-01T00:00:01Z"),
    /reused/,
  );
});

test("unfinished mutation becomes indeterminate instead of replaying", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-op-"));
  const journal = new OperationJournal(root, "session_12345678");
  const request = { content: "a" };
  const registered = await journal.register("op_123", "apply_patch", true, request, "2026-01-01T00:00:00Z");
  await journal.markExecuting(registered.record, "2026-01-01T00:00:01Z");
  const recovered = await journal.register("op_123", "apply_patch", true, request, "2026-01-01T00:00:02Z");
  assert.equal(recovered.kind, "indeterminate_mutation");
  assert.equal(recovered.record.status, "indeterminate");
});

test("accepted but never-started mutation is safely retryable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-op-"));
  const journal = new OperationJournal(root, "session_12345678");
  const request = { content: "a" };
  await journal.register("op_123", "apply_patch", true, request, "2026-01-01T00:00:00Z");
  const recovered = await journal.register("op_123", "apply_patch", true, request, "2026-01-01T00:00:01Z");
  assert.equal(recovered.kind, "retry_safe");
  assert.equal(recovered.record.status, "accepted");
});

test("operation journal persists an explicitly indeterminate execution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-op-"));
  const journal = new OperationJournal(root, "session_12345678");
  const registered = await journal.register("op_123", "run_command", true, {}, "2026-01-01T00:00:00Z");
  const executing = await journal.markExecuting(registered.record, "2026-01-01T00:00:01Z");
  const uncertain = await journal.markIndeterminate(
    executing,
    "2026-01-01T00:00:02Z",
    "process_tree_unknown",
    { diagnosticCode: "PROCESS_TREE_UNKNOWN" },
  );
  assert.equal(uncertain.status, "indeterminate");
  const recovered = await journal.register("op_123", "run_command", true, {}, "2026-01-01T00:00:03Z");
  assert.equal(recovered.kind, "indeterminate_mutation");
});

test("operation journal rejects unknown fields even with a recomputed digest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-op-strict-"));
  const journal = new OperationJournal(root, "session_12345678");
  await journal.register("op_123", "read_file", false, {}, "2026-01-01T00:00:00Z");
  const filename = path.join(root, "op_123.json");
  const parsed = JSON.parse(await readFile(filename, "utf8")) as Record<string, unknown>;
  delete parsed.integrityHash;
  parsed.unversionedField = true;
  parsed.integrityHash = sha256(stableJson(parsed));
  await writeFile(filename, `${stableJson(parsed)}\n`, "utf8");
  await assert.rejects(() => journal.read("op_123"), /invalid schema/u);
});
