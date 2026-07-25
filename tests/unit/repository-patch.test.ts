import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
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
import { CURRENT_HOST_PLATFORM } from "../../src/platform/index.js";

test("targeted edit is hash- and occurrence-guarded and uses atomic checkpoints", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-edit-text-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const before = "alpha beta alpha\n";
  await writeFile(path.join(root, "file.txt"), before);
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());

  await assert.rejects(
    engine.editText({
      path: "file.txt", base_sha256: sha256(before), old_text: "alpha", new_text: "gamma",
      expected_occurrences: 1,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "STALE_STATE",
  );
  assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), before);

  const result = await engine.editText({
    path: "file.txt", base_sha256: sha256(before), old_text: "alpha", new_text: "gamma",
    expected_occurrences: 2, operationId: "op_edit",
  });
  assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "gamma beta gamma\n");
  assert.equal((await checkpoints.verify(result.checkpointId)).operationId, "op_edit");
  assert.equal((await checkpoints.verify(result.checkpointId)).sealed, true);
  await checkpoints.rollback(result.checkpointId);
  assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), before);
});

test("targeted edit preserves exact Unicode and CRLF bytes while supporting deletion", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-edit-unicode-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const target = path.join(root, "file.txt");
  const before = "😀 alpha\r\nsecond alpha\r\n";
  await writeFile(target, before);
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());

  const result = await engine.editText({
    path: "file.txt",
    base_sha256: sha256(before).toUpperCase(),
    old_text: "alpha",
    new_text: "",
    expected_occurrences: 2,
  });
  assert.equal(await readFile(target, "utf8"), "😀 \r\nsecond \r\n");
  assert.equal(result.changedLines, 4);

  const astralBefore = await readFile(target, "utf8");
  await engine.editText({
    path: "file.txt",
    base_sha256: sha256(astralBefore),
    old_text: "😀",
    new_text: "🐙",
    expected_occurrences: 1,
  });
  assert.equal(await readFile(target, "utf8"), "🐙 \r\nsecond \r\n");
});

test("targeted edit occurrence guards use deterministic non-overlapping matches", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-edit-occurrences-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const target = path.join(root, "file.txt");
  const before = "aaaa";
  await writeFile(target, before);
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());

  await assert.rejects(
    engine.editText({
      path: "file.txt",
      base_sha256: sha256(before),
      old_text: "aa",
      new_text: "aaa",
      expected_occurrences: 3,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "STALE_STATE",
  );
  await engine.editText({
    path: "file.txt",
    base_sha256: sha256(before),
    old_text: "aa",
    new_text: "aaa",
    expected_occurrences: 2,
  });
  assert.equal(await readFile(target, "utf8"), "aaaaaa");
});

test("targeted edit rejects no-ops, invalid UTF-8, non-scalar input, and expansion before allocation", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-edit-validation-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const target = path.join(root, "file.txt");
  const before = "xxxxxxxxxx";
  await writeFile(target, before);
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy(), {
    maxFileBytes: 32,
    maxTotalBytes: 32,
  });

  await assert.rejects(
    engine.editText({
      path: "file.txt", base_sha256: sha256(before), old_text: "x", new_text: "x",
      expected_occurrences: 10,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "PROTOCOL_INVALID",
  );
  await assert.rejects(
    engine.editText({
      path: "file.txt", base_sha256: sha256(before), old_text: "x", new_text: "\ud800",
      expected_occurrences: 10,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "PROTOCOL_INVALID",
  );
  await assert.rejects(
    engine.editText({
      path: "file.txt", base_sha256: sha256(before), old_text: "x", new_text: "0123456789",
      expected_occurrences: 10,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "BUDGET_EXCEEDED",
  );
  assert.equal(await readFile(target, "utf8"), before);
  assert.equal(await checkpoints.latest(), undefined);

  await writeFile(target, Buffer.from([0xc3, 0x28]));
  await assert.rejects(
    engine.editText({
      path: "file.txt",
      base_sha256: sha256(Buffer.from([0xc3, 0x28])),
      old_text: "(",
      new_text: ")",
      expected_occurrences: 1,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "UNSUPPORTED_FILE",
  );
});

test("targeted edit charges line-ending-only changes against changed-line budgets", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-edit-line-endings-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const before = "one\r\ntwo\r\n";
  const target = path.join(root, "file.txt");
  await writeFile(target, before);
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy(), {
    maxChangedLines: 3,
  });

  await assert.rejects(
    engine.editText({
      path: "file.txt", base_sha256: sha256(before), old_text: "\r\n", new_text: "\n",
      expected_occurrences: 2,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "BUDGET_EXCEEDED",
  );
  assert.equal(await readFile(target, "utf8"), before);
});

test("targeted edit rejects protected, binary, packaged, and executable files", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-edit-file-types-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  await writeFile(path.join(root, ".env"), "KEY=value\n");
  await writeFile(path.join(root, "binary.txt"), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, "archive.zip"), "plain text");
  await writeFile(path.join(root, "script.txt"), "echo hello\n");
  if (CURRENT_HOST_PLATFORM.supportsPosixModes) await chmod(path.join(root, "script.txt"), 0o755);
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());

  for (const [candidate, expectedCode] of [
    [".env", "PATH_PROTECTED"],
    ["binary.txt", "UNSUPPORTED_FILE"],
    ["archive.zip", "UNSUPPORTED_FILE"],
    ...(CURRENT_HOST_PLATFORM.supportsPosixModes
      ? [["script.txt", "UNSUPPORTED_FILE"] as const]
      : []),
  ] as const) {
    const bytes = await readFile(path.join(root, candidate));
    await assert.rejects(
      engine.editText({
        path: candidate,
        base_sha256: sha256(bytes),
        old_text: "e",
        new_text: "E",
        expected_occurrences: 1,
      }),
      (error: unknown) => error instanceof AgentError && error.code === expectedCode,
      candidate,
    );
  }
});

test("patch commit captures concurrent writes and never overwrites them during recovery", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-patch-race-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const target = path.join(root, "file.txt");
  const before = "before\n";
  await writeFile(target, before);
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  let injected = false;
  const engine = new PatchEngine(
    boundary,
    checkpoints,
    new ProtectedPathPolicy(),
    {},
    {
      beforeCapture: async () => {
        if (!injected) {
          injected = true;
          await writeFile(target, "concurrent\n");
        }
      },
    },
  );

  await assert.rejects(
    engine.editText({
      path: "file.txt",
      base_sha256: sha256(before),
      old_text: "before",
      new_text: "after",
      expected_occurrences: 1,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "STALE_STATE",
  );
  assert.equal(await readFile(target, "utf8"), "concurrent\n");
});

test("checkpoint ABA races cannot seal a before-image that differs from the mutation plan", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-patch-checkpoint-aba-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const target = path.join(root, "file.txt");
  const before = "before\n";
  await writeFile(target, before);
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const engine = new PatchEngine(
    boundary,
    checkpoints,
    new ProtectedPathPolicy(),
    {},
    {
      beforeCheckpoint: async () => writeFile(target, "intermediate\n").then(() => undefined),
      afterCheckpoint: async () => writeFile(target, before).then(() => undefined),
    },
  );

  await assert.rejects(
    engine.editText({
      path: "file.txt",
      base_sha256: sha256(before),
      old_text: "before",
      new_text: "after",
      expected_occurrences: 1,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "STALE_STATE",
  );
  assert.equal(await readFile(target, "utf8"), before);
  const checkpoint = await checkpoints.latest();
  assert.ok(checkpoint);
  assert.equal(checkpoint.sealed, false);
  assert.equal((await checkpoints.snapshot(checkpoint.id)).entries[0]?.sha256, sha256("intermediate\n"));
  await assert.rejects(
    checkpoints.rollback(checkpoint.id),
    (error: unknown) => error instanceof AgentError && error.code === "STALE_STATE",
  );
  assert.equal(await readFile(target, "utf8"), before);
});

test("ancestor-directory replacement is detected before mutation syscalls reach the replacement", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-patch-parent-race-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  const sourceDirectory = path.join(root, "src");
  const parkedDirectory = path.join(root, "src-parked");
  const outside = path.join(temporary, "outside");
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(outside);
  const before = "before\n";
  await writeFile(path.join(sourceDirectory, "file.txt"), before);
  await writeFile(path.join(outside, "file.txt"), "outside\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  let swapped = false;
  const engine = new PatchEngine(
    boundary,
    checkpoints,
    new ProtectedPathPolicy(),
    {},
    {
      beforeCapture: async () => {
        if (swapped) return;
        swapped = true;
        await rename(sourceDirectory, parkedDirectory);
        await symlink(outside, sourceDirectory, "dir");
      },
    },
  );

  await assert.rejects(
    engine.editText({
      path: "src/file.txt",
      base_sha256: sha256(before),
      old_text: "before",
      new_text: "after",
      expected_occurrences: 1,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  assert.equal(await readFile(path.join(outside, "file.txt"), "utf8"), "outside\n");
  assert.deepEqual(await readdir(outside), ["file.txt"]);

  await unlink(sourceDirectory);
  await rename(parkedDirectory, sourceDirectory);
  assert.equal(await readFile(path.join(sourceDirectory, "file.txt"), "utf8"), before);
});

test("recovery preserves a concurrent deletion of an installed result", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-patch-delete-race-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const target = path.join(root, "file.txt");
  const before = "before\n";
  await writeFile(target, before);
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const engine = new PatchEngine(
    boundary,
    checkpoints,
    new ProtectedPathPolicy(),
    {},
    { afterInstall: async () => unlink(target) },
  );

  await assert.rejects(
    engine.editText({
      path: "file.txt",
      base_sha256: sha256(before),
      old_text: "before",
      new_text: "after",
      expected_occurrences: 1,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  await assert.rejects(readFile(target), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("patch recovery fails closed when a concurrent path appears after capture", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-patch-race-install-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const target = path.join(root, "file.txt");
  const before = "before\n";
  await writeFile(target, before);
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const engine = new PatchEngine(
    boundary,
    checkpoints,
    new ProtectedPathPolicy(),
    {},
    { afterCapture: async () => writeFile(target, "concurrent\n").then(() => undefined) },
  );

  await assert.rejects(
    engine.editText({
      path: "file.txt",
      base_sha256: sha256(before),
      old_text: "before",
      new_text: "after",
      expected_occurrences: 1,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  assert.equal(await readFile(target, "utf8"), "concurrent\n");
});

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
  const legacyPrefix = `.cba-${checkpoint.id}-${sha256("file.txt").slice(0, 20)}`;
  const legacyTemporary = path.join(root, `${legacyPrefix}.new`);
  const legacyBackup = path.join(root, `${legacyPrefix}.old`);
  await mkdir(artifacts.transactionDirectory);
  await writeFile(target, "partially updated\n");
  await writeFile(artifacts.temporaryPath, "staged\n");
  await writeFile(artifacts.backupPath, "original\n");
  await writeFile(legacyTemporary, "legacy staged\n");
  await writeFile(legacyBackup, "legacy original\n");
  await assert.rejects(
    checkpoints.rollback(checkpoint.id),
    (error: unknown) => error instanceof AgentError && error.code === "STALE_STATE",
  );
  assert.equal(await readFile(target, "utf8"), "partially updated\n");
  await checkpoints.rollback(checkpoint.id, { force: true });
  assert.equal(await readFile(target, "utf8"), "original\n");
  await assert.rejects(readFile(artifacts.temporaryPath));
  await assert.rejects(readFile(artifacts.backupPath));
  await assert.rejects(readFile(legacyTemporary));
  await assert.rejects(readFile(legacyBackup));
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
