import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_ARTIFACT_BYTES,
  SessionArtifactStore,
  isArtifactReference,
} from "../../src/session/artifact-store.js";

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

test("terminal artifacts return integrity-bound references", async () => {
  const session = await mkdtemp(path.join(tmpdir(), "cba-terminal-artifact-"));
  const store = new SessionArtifactStore(path.join(session, "artifacts"));
  const reference = await store.putReferenced(
    "terminal-result",
    "terminal_operation_1",
    "{\"contract\":\"terminal-exec-result/1\"}",
  );
  assert.equal(reference.kind, "terminal-result");
  assert.equal(reference.id, "terminal_operation_1");
  assert.equal(reference.bytes, Buffer.byteLength("{\"contract\":\"terminal-exec-result/1\"}"));
  assert.match(reference.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(
    await store.get(reference.kind, reference.id),
    "{\"contract\":\"terminal-exec-result/1\"}",
  );
  await assert.rejects(
    () => store.getReferenced({ ...reference, bytes: reference.bytes + 1 }),
    /does not match its durable reference/u,
  );
  await assert.rejects(
    () => store.getOptionalReferenced({
      ...reference,
      sha256: "f".repeat(64),
    }),
    /does not match its durable reference/u,
  );
  await store.remove(reference.kind, reference.id);
  assert.equal(await store.getOptionalReferenced(reference), undefined);
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

test("artifact preflight and references recognize the launch-receipt contract", async () => {
  const session = await mkdtemp(path.join(tmpdir(), "cba-launch-artifact-"));
  const root = path.join(session, "artifacts");
  const synchronized: string[] = [];
  const store = new SessionArtifactStore(root, {
    syncDirectory: async (directory) => {
      synchronized.push(directory);
    },
  });
  assert.deepEqual(store.preflightWrite("abc"), {
    fits: true,
    bytes: 3,
    maxBytes: MAX_ARTIFACT_BYTES,
  });
  assert.equal(store.preflightWrite("x".repeat(MAX_ARTIFACT_BYTES + 1)).fits, false);

  const reference = await store.putReferencedDurable(
    "terminal-launch-receipt",
    "terminal_operation_1",
    "{}",
    { syncDirectories: true },
  );
  assert.equal(isArtifactReference(reference), true);
  assert.equal(reference.kind, "terminal-launch-receipt");
  assert.equal(await store.getReferenced(reference), "{}");
  assert.deepEqual(synchronized, [
    session,
    root,
    path.join(root, "terminal-launch-receipt"),
    path.join(root, "terminal-launch-receipt"),
  ]);
});

test("durable publication syncs the kind directory after each ordered rename", async () => {
  const session = await mkdtemp(path.join(tmpdir(), "cba-launch-order-"));
  const root = path.join(session, "artifacts");
  const observedNames: string[][] = [];
  const store = new SessionArtifactStore(root, {
    syncDirectory: async (directory) => {
      if (directory !== path.join(root, "terminal-launch-receipt")) return;
      const { readdir } = await import("node:fs/promises");
      observedNames.push((await readdir(directory)).sort());
    },
  });
  await store.putReferencedDurable(
    "terminal-launch-receipt",
    "terminal_operation_1",
    "{}",
    { syncDirectories: true },
  );
  assert.deepEqual(observedNames, [
    ["terminal_operation_1.txt"],
    [
      "terminal_operation_1.manifest.json",
      "terminal_operation_1.txt",
    ],
  ]);
});

test("a directory-sync failure refuses durable launch-receipt publication", async () => {
  const session = await mkdtemp(path.join(tmpdir(), "cba-launch-sync-failure-"));
  const root = path.join(session, "artifacts");
  const store = new SessionArtifactStore(root, {
    syncDirectory: async () => {
      throw new Error("injected directory sync failure");
    },
  });
  await assert.rejects(
    () => store.putReferencedDurable(
      "terminal-launch-receipt",
      "terminal_operation_1",
      "{}",
      { syncDirectories: true },
    ),
    /injected directory sync failure/u,
  );
  assert.equal(
    await store.getOptional(
      "terminal-launch-receipt",
      "terminal_operation_1",
    ),
    undefined,
  );
});

test("failure of either receipt-kind barrier refuses durable publication", async () => {
  for (const failingBarrier of [1, 2]) {
    const session = await mkdtemp(
      path.join(tmpdir(), `cba-launch-sync-${failingBarrier}-`),
    );
    const root = path.join(session, "artifacts");
    const directory = path.join(root, "terminal-launch-receipt");
    await mkdir(directory, { recursive: true });
    let barrier = 0;
    const store = new SessionArtifactStore(root, {
      syncDirectory: async (candidate) => {
        if (candidate !== directory) return;
        barrier += 1;
        if (barrier === failingBarrier) {
          throw new Error(`injected barrier ${failingBarrier} failure`);
        }
      },
    });
    await assert.rejects(
      () => store.putReferencedDurable(
        "terminal-launch-receipt",
        `terminal_operation_${failingBarrier}`,
        "{}",
        { syncDirectories: true },
      ),
      new RegExp(`injected barrier ${failingBarrier} failure`, "u"),
    );
    assert.equal(barrier, failingBarrier);
    await assert.rejects(
      () => store.getOptional(
        "terminal-launch-receipt",
        `terminal_operation_${failingBarrier}`,
      ),
      /incomplete/u,
    );
  }
});
