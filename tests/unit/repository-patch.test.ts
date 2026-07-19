import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentError } from "../../src/shared/errors.js";
import { sha256 } from "../../src/shared/crypto.js";
import { RepositoryBoundary } from "../../src/repository/boundary.js";
import {
  CheckpointStore,
  checkpointMutationArtifactPaths,
} from "../../src/repository/checkpoint.js";
import { PatchEngine } from "../../src/repository/patch-engine.js";
import { ProtectedPathPolicy } from "../../src/security/protected-paths.js";

test("full-text patch transaction updates, creates, deletes, verifies, and rolls back", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-patch-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  const checkpointRoot = path.join(temporary, "checkpoints");
  await mkdir(root);
  await writeFile(path.join(root, "update.txt"), "old\n");
  await writeFile(path.join(root, "delete.txt"), "remove\n");

  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, checkpointRoot);
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy(), {
    allowCreate: true,
    allowDelete: true,
  });
  const result = await engine.applyPatch({
    operationId: "op_patch",
    changes: [
      {
        kind: "update",
        path: "update.txt",
        base_sha256: sha256("old\n"),
        content: "new\n",
      },
      { kind: "create", path: "created.txt", content: "created\n" },
      {
        kind: "delete",
        path: "delete.txt",
        base_sha256: sha256("remove\n"),
      },
    ],
  });
  assert.deepEqual(
    result.changedPaths.map((entry) => [entry.path, entry.kind]),
    [
      ["update.txt", "update"],
      ["created.txt", "create"],
      ["delete.txt", "delete"],
    ],
  );
  assert.equal(await readFile(path.join(root, "update.txt"), "utf8"), "new\n");
  assert.equal(await readFile(path.join(root, "created.txt"), "utf8"), "created\n");
  await assert.rejects(readFile(path.join(root, "delete.txt")));
  assert.equal((await checkpoints.verify(result.checkpointId)).paths.length, 3);
  assert.equal((await checkpoints.verify(result.checkpointId)).sealed, true);
  assert.equal((await checkpoints.latest())?.id, result.checkpointId);
  assert.equal((await checkpoints.latest("op_patch"))?.id, result.checkpointId);
  assert.equal((await checkpoints.latest("op_other")), undefined);
  assert.equal((await checkpoints.verify(result.checkpointId)).operationId, "op_patch");

  await checkpoints.rollback(result.checkpointId);
  assert.equal(await readFile(path.join(root, "update.txt"), "utf8"), "old\n");
  assert.equal(await readFile(path.join(root, "delete.txt"), "utf8"), "remove\n");
  await assert.rejects(readFile(path.join(root, "created.txt")));
});

test("patch validation is all-before-write, detects stale state, budgets, duplicates, and protected paths", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-patch-validation-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  await writeFile(path.join(root, "one.txt"), "one\n");
  await writeFile(path.join(root, "two.txt"), "two\n");
  await writeFile(path.join(root, ".env"), "PASSWORD=not-for-model\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy(), {
    maxChangedLines: 4,
    allowDelete: true,
  });

  await assert.rejects(
    engine.applyPatch({
      changes: [
        {
          kind: "update",
          path: "one.txt",
          base_sha256: sha256("one\n"),
          content: "changed\n",
        },
        {
          kind: "update",
          path: "two.txt",
          base_sha256: "0".repeat(64),
          content: "bad\n",
        },
      ],
    }),
    (error: unknown) => error instanceof AgentError && error.code === "STALE_STATE",
  );
  assert.equal(await readFile(path.join(root, "one.txt"), "utf8"), "one\n");

  await assert.rejects(
    engine.applyPatch({ changes: [{ kind: "create", path: ".env", content: "safe=false\n" }] }),
    (error: unknown) => error instanceof AgentError && error.code === "PATH_PROTECTED",
  );
  await assert.rejects(
    engine.applyPatch({
      changes: [
        { kind: "create", path: "same.txt", content: "a" },
        { kind: "create", path: "same.txt", content: "b" },
      ],
    }),
    (error: unknown) => error instanceof AgentError && error.code === "PROTOCOL_INVALID",
  );
  await assert.rejects(
    engine.applyPatch({ changes: [{ kind: "create", path: "many.txt", content: "1\n2\n3\n4\n5\n" }] }),
    (error: unknown) => error instanceof AgentError && error.code === "BUDGET_EXCEEDED",
  );
});

test("checkpoint verification detects manifest corruption before rollback", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-checkpoint-corrupt-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  const checkpointRoot = path.join(temporary, "checkpoints");
  await mkdir(root);
  await writeFile(path.join(root, "file.txt"), "original\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, checkpointRoot);
  const checkpoint = await checkpoints.createCheckpoint(["file.txt"]);
  const manifest = path.join(checkpointRoot, checkpoint.id, "manifest.json");
  const raw = await readFile(manifest, "utf8");
  await writeFile(manifest, raw.replace("original", "tampered"));
  // The replacement may not occur in a source-free manifest, so force malformed JSON as well.
  await writeFile(manifest, "{not-json\n");
  await assert.rejects(
    checkpoints.rollback(checkpoint.id),
    (error: unknown) => error instanceof AgentError && error.code === "CHECKPOINT_CORRUPT",
  );
  assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "original\n");
});

test("mutation engine rejects executable and packaged file types even when their bytes look textual", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-patch-types-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());
  for (const candidate of ["program.exe", "script.cmd", "archive.zip", "state.sqlite"] as const) {
    await assert.rejects(
      engine.applyPatch({ changes: [{ kind: "create", path: candidate, content: "looks like text" }] }),
      (error: unknown) => error instanceof AgentError && error.code === "UNSUPPORTED_FILE",
      candidate,
    );
  }
});

test("checkpoint rollback removes deterministic transaction artifacts left by an interrupted mutation", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-checkpoint-artifacts-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const target = path.join(root, "file.txt");
  await writeFile(target, "original\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const checkpoint = await checkpoints.createCheckpoint(["file.txt"]);
  const artifacts = checkpointMutationArtifactPaths(target, "file.txt", checkpoint.id);
  await writeFile(target, "partially updated\n");
  await writeFile(artifacts.temporaryPath, "staged\n");
  await writeFile(artifacts.backupPath, "original\n");
  await assert.rejects(
    checkpoints.rollback(checkpoint.id),
    (error: unknown) => error instanceof AgentError && error.code === "STALE_STATE",
  );
  assert.equal(await readFile(target, "utf8"), "partially updated\n");
  await checkpoints.rollback(checkpoint.id, { force: true });
  assert.equal(await readFile(target, "utf8"), "original\n");
  await assert.rejects(readFile(artifacts.temporaryPath));
  await assert.rejects(readFile(artifacts.backupPath));
});

test("sealed checkpoint rollback refuses to overwrite later user edits", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-checkpoint-stale-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const target = path.join(root, "file.txt");
  await writeFile(target, "before\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());
  const result = await engine.applyPatch({
    operationId: "op_patch",
    changes: [{
      kind: "update",
      path: "file.txt",
      base_sha256: sha256("before\n"),
      content: "agent change\n",
    }],
  });
  await writeFile(target, "later user change\n");

  await assert.rejects(
    checkpoints.rollback(result.checkpointId),
    (error: unknown) => error instanceof AgentError && error.code === "STALE_STATE",
  );
  assert.equal(await readFile(target, "utf8"), "later user change\n");

  await checkpoints.rollback(result.checkpointId, { force: true });
  assert.equal(await readFile(target, "utf8"), "before\n");
});

test("checkpoint storage is outside the working tree by default", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-checkpoint-location-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const boundary = await RepositoryBoundary.create(root);
  const inside = path.join(root, ".cba", "checkpoints");
  await assert.rejects(
    CheckpointStore.create(boundary, inside),
    (error: unknown) => error instanceof AgentError && error.code === "CONFIG_INVALID",
  );
  await assert.rejects(access(inside));
});
