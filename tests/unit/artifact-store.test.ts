import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionArtifactStore } from "../../src/session/artifact-store.js";

test("source-bearing recovery artifacts are isolated and integrity checked", async () => {
  const session = await mkdtemp(path.join(tmpdir(), "cba-artifact-"));
  const root = path.join(session, "artifacts");
  const store = new SessionArtifactStore(root);
  await store.put("outbox", "submission_1", "sensitive tool result");
  assert.equal(await store.get("outbox", "submission_1"), "sensitive tool result");
  await writeFile(path.join(root, "outbox", "submission_1.txt"), "tampered", "utf8");
  await assert.rejects(() => store.get("outbox", "submission_1"), /integrity/);
  await store.clear();
  await assert.rejects(() => store.get("outbox", "submission_1"));
});

test("source-bearing recovery artifacts reject oversized writes and partial manifests", async () => {
  const session = await mkdtemp(path.join(tmpdir(), "cba-artifact-bounds-"));
  const root = path.join(session, "artifacts");
  const store = new SessionArtifactStore(root);
  await assert.rejects(
    () => store.put("response", "turn_0001", "x".repeat(8 * 1024 * 1024 + 1)),
    /storage bound/u,
  );
  await store.put("decision", "decision_1", "{}");
  await writeFile(
    path.join(root, "decision", "decision_1.manifest.json"),
    '{"schemaVersion":1}',
    "utf8",
  );
  await assert.rejects(() => store.get("decision", "decision_1"), /unreadable/u);
});
