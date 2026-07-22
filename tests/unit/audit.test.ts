import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AuditLog } from "../../src/audit/audit-log.js";

test("audit log forms a verifiable append-only hash chain", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-audit-"));
  const filename = path.join(root, "audit.jsonl");
  const clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };
  const log = new AuditLog(filename, "session_12345678", clock);
  await log.append({ type: "session.created", taskId: "task_1", data: { mode: "auto" } });
  await log.append({ type: "session.transition", taskId: "task_1", data: { to: "preflight" } });

  const events = await AuditLog.verify(filename, "session_12345678");
  assert.equal(events.length, 2);
  assert.equal(events[1]?.previousHash, events[0]?.eventHash);
});

test("audit verification detects tampering and partial records", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-audit-"));
  const filename = path.join(root, "audit.jsonl");
  const log = new AuditLog(filename, "session_12345678");
  await log.append({ type: "session.created", taskId: "task_1", data: { value: "original" } });
  const raw = await readFile(filename, "utf8");
  await writeFile(filename, raw.replace("original", "tampered"), "utf8");
  await assert.rejects(() => AuditLog.verify(filename, "session_12345678"), /integrity/);
  await writeFile(filename, raw.trimEnd(), "utf8");
  await assert.rejects(() => AuditLog.verify(filename, "session_12345678"), /partial/);
});

test("concurrent appends remain a valid ordered hash chain", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-audit-concurrent-"));
  const filename = path.join(root, "audit.jsonl");
  const log = new AuditLog(filename, "session_12345678");

  await Promise.all(Array.from({ length: 16 }, (_, index) => log.append({
    type: "tool.requested",
    taskId: "task_12345678",
    operationId: `op_${index}`,
    data: { index },
  })));

  const events = await AuditLog.verify(filename, "session_12345678");
  assert.equal(events.length, 16);
  assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: 16 }, (_, index) => index + 1));
});
