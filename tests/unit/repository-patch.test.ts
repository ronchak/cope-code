import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AgentError } from "../../src/shared/errors.js";
import { sha256, stableJson } from "../../src/shared/crypto.js";
import { RepositoryBoundary } from "../../src/repository/boundary.js";
import {
  CheckpointStore,
  checkpointMutationArtifactPaths,
} from "../../src/repository/checkpoint.js";
import { PatchEngine } from "../../src/repository/patch-engine.js";
import { ProtectedPathPolicy } from "../../src/security/protected-paths.js";
import { CURRENT_HOST_PLATFORM } from "../../src/platform/index.js";
import {
  MAX_PINNED_FILE_BYTES,
  isPinnedIdentity,
  pinnedIdentityFromBigInts,
  runPinnedMutation,
} from "../../src/repository/pinned-mutation-fs.js";
import { readRegularFile } from "../../src/repository/text-file.js";

async function pinnedIdentityAt(filename: string) {
  const state = await stat(filename, { bigint: true });
  return pinnedIdentityFromBigInts(state.dev, state.ino);
}

test("pinned filesystem identities preserve integers above JavaScript's safe range", () => {
  const first = pinnedIdentityFromBigInts(9_007_199_254_740_993n, 18_446_744_073_709_551_615n);
  const adjacent = pinnedIdentityFromBigInts(9_007_199_254_740_994n, 18_446_744_073_709_551_614n);
  assert.deepEqual(first, {
    device: "9007199254740993",
    inode: "18446744073709551615",
  });
  assert.notDeepEqual(first, adjacent);
  assert.ok(isPinnedIdentity(first));
  assert.equal(isPinnedIdentity({ device: 9_007_199_254_740_993, inode: "1" }), false);
  assert.equal(isPinnedIdentity({ device: "01", inode: "1" }), false);
});

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

test("targeted edit and rollback preserve a UTF-8 BOM with CRLF bytes", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-edit-bom-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const target = path.join(root, "file.txt");
  const before = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("alpha\r\nsecond alpha\r\n", "utf8"),
  ]);
  await writeFile(target, before);
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());
  const result = await engine.editText({
    path: "file.txt",
    base_sha256: sha256(before),
    old_text: "alpha",
    new_text: "β",
    expected_occurrences: 2,
  });
  const expected = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("β\r\nsecond β\r\n", "utf8"),
  ]);
  assert.deepEqual(await readFile(target), expected);
  assert.equal(result.totalBytes, expected.length);
  assert.equal(result.changedLines, 4);
  await checkpoints.rollback(result.checkpointId);
  assert.deepEqual(await readFile(target), before);
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

test("mutation and checkpoint reads reject growth after preliminary size checks", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-bounded-read-race-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const target = path.join(root, "file.txt");
  const before = "before\n";
  await writeFile(target, before);
  const boundary = await RepositoryBoundary.create(root);
  const checkpointRoot = path.join(temporary, "checkpoints");
  const checkpoints = await CheckpointStore.create(boundary, checkpointRoot);
  const engine = new PatchEngine(
    boundary,
    checkpoints,
    new ProtectedPathPolicy(),
    { maxFileBytes: 16 },
    { beforeSourceRead: async () => writeFile(target, "x".repeat(17)) },
  );

  await assert.rejects(
    engine.editText({
      path: "file.txt",
      base_sha256: sha256(before),
      old_text: "before",
      new_text: "after",
      expected_occurrences: 1,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "BUDGET_EXCEEDED",
  );
  assert.equal((await readFile(target)).length, 17);
  assert.equal(await checkpoints.latest(), undefined);

  await writeFile(target, "small\n");
  const racingCheckpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "racing-checkpoints"),
    {
      hooks: {
        beforeCheckpointFileRead: async () =>
          writeFile(target, Buffer.alloc(MAX_PINNED_FILE_BYTES + 1, 0x61)),
      },
    },
  );
  await assert.rejects(
    racingCheckpoints.createCheckpoint(["file.txt"]),
    (error: unknown) => error instanceof AgentError && error.code === "BUDGET_EXCEEDED",
  );
  assert.equal(await racingCheckpoints.latest(), undefined);
});

test("descriptor readers reject raced FIFOs without blocking", {
  skip: process.platform === "win32",
}, async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-fifo-read-race-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const probe = path.join(temporary, "probe-fifo");
  const available = spawnSync("mkfifo", [probe], { encoding: "utf8", timeout: 2_000 });
  if (available.error !== undefined || available.status !== 0) {
    context.skip("mkfifo is unavailable on this POSIX host");
    return;
  }
  await unlink(probe);

  const raced = path.join(temporary, "raced.txt");
  await writeFile(raced, "regular\n");
  const startedAt = Date.now();
  await assert.rejects(
    readRegularFile(raced, "raced.txt", 1024, {
      testAfterStat: async () => {
        await unlink(raced);
        const created = spawnSync("mkfifo", [raced], { encoding: "utf8", timeout: 2_000 });
        assert.equal(created.status, 0, created.stderr);
      },
    }),
    (error: unknown) => error instanceof AgentError && error.code === "STALE_STATE",
  );
  assert.ok(Date.now() - startedAt < 2_000);

  const directory = await pinnedIdentityAt(temporary);
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `
      const { runPinnedMutation } = await import(process.env.CBA_PINNED_URL);
      try {
        runPinnedMutation(
          process.env.CBA_DIRECTORY,
          JSON.parse(process.env.CBA_IDENTITY),
          { kind: "read", name: "raced.txt" },
        );
        process.stdout.write("unexpected");
      } catch {
        process.stdout.write("rejected");
      }
    `],
    {
      encoding: "utf8",
      timeout: 2_000,
      env: {
        ...process.env,
        CBA_PINNED_URL: new URL(
          "../../src/repository/pinned-mutation-fs.js",
          import.meta.url,
        ).href,
        CBA_DIRECTORY: temporary,
        CBA_IDENTITY: JSON.stringify(directory),
      },
    },
  );
  assert.notEqual((child.error as NodeJS.ErrnoException | undefined)?.code, "ETIMEDOUT");
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "rejected");
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

test("targeted edit reports a deleted target as stale state", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-edit-deleted-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());

  await assert.rejects(
    engine.editText({
      path: "deleted.txt",
      base_sha256: sha256("before\n"),
      old_text: "before",
      new_text: "after",
      expected_occurrences: 1,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "STALE_STATE",
  );
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

test("pinned leaf operations preserve concurrent replacements at validation boundaries", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-patch-leaf-race-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, "source.txt");
  const parked = path.join(temporary, "parked.txt");
  const destination = path.join(temporary, "destination.txt");
  await writeFile(source, "original\n");
  const directoryIdentity = await pinnedIdentityAt(temporary);
  const sourceIdentity = await pinnedIdentityAt(source);
  const quarantineIdentity = runPinnedMutation(temporary, directoryIdentity, {
    kind: "create_quarantine",
    name: ".test-private",
  });
  assert.ok(isPinnedIdentity(quarantineIdentity));
  const quarantine = {
    name: ".test-private",
    identity: quarantineIdentity,
  };

  assert.throws(
    () => runPinnedMutation(temporary, directoryIdentity, {
      kind: "remove",
      name: path.basename(source),
      identity: sourceIdentity,
      quarantine,
      testReplaceAfterValidation: {
        parked: path.basename(parked),
        bytes: Buffer.from("concurrent\n").toString("base64"),
        mode: 0o600,
      },
    }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  assert.equal(await readFile(source, "utf8"), "concurrent\n");
  assert.equal(await readFile(parked, "utf8"), "original\n");
  const concurrentMode = (await stat(source)).mode & 0o777;
  const concurrentIdentity = await pinnedIdentityAt(source);

  const lateSource = path.join(temporary, "late-source.txt");
  const lateParked = path.join(temporary, "late-parked.txt");
  await writeFile(lateSource, "late original\n");
  const lateIdentity = await pinnedIdentityAt(lateSource);
  const lateMode = (await stat(lateSource)).mode & 0o777;
  assert.throws(
    () => runPinnedMutation(temporary, directoryIdentity, {
      kind: "remove",
      name: path.basename(lateSource),
      identity: lateIdentity,
      expectedSha256: sha256("late original\n"),
      expectedMode: lateMode,
      quarantine,
      testReplaceBeforeRemoval: {
        parked: path.basename(lateParked),
        bytes: Buffer.from("late concurrent\n").toString("base64"),
        mode: 0o600,
      },
    }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  assert.equal(await readFile(lateSource, "utf8"), "late concurrent\n");
  assert.equal(await readFile(lateParked, "utf8"), "late original\n");
  assert.deepEqual(
    await readdir(path.join(temporary, quarantine.name)),
    [],
  );

  assert.throws(
    () => runPinnedMutation(temporary, directoryIdentity, {
      kind: "capture",
      source: path.basename(source),
      destination: path.basename(destination),
      sourceIdentity: concurrentIdentity,
      expectedSha256: sha256("concurrent\n"),
      expectedMode: concurrentMode,
      quarantine,
      testCreateDestinationAfterValidation: Buffer.from("destination race\n").toString("base64"),
    }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  assert.equal(await readFile(source, "utf8"), "concurrent\n");
  assert.equal(await readFile(destination, "utf8"), "destination race\n");

  await unlink(destination);
  assert.throws(
    () => runPinnedMutation(temporary, directoryIdentity, {
      kind: "capture",
      source: path.basename(source),
      destination: path.basename(destination),
      sourceIdentity: concurrentIdentity,
      expectedSha256: sha256("concurrent\n"),
      expectedMode: concurrentMode,
      quarantine,
      testWriteAfterCaptureValidation: Buffer.from("tail race\n").toString("base64"),
    }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  assert.equal(await readFile(source, "utf8"), "tail race\n");
  assert.equal(await readFile(destination, "utf8"), "tail race\n");

  const identitySource = path.join(temporary, "identity-source.txt");
  const identityParked = path.join(temporary, "identity-parked.txt");
  const identityDestination = path.join(temporary, "identity-destination.txt");
  await writeFile(identitySource, "same bytes\n", { mode: 0o600 });
  const exactIdentity = await pinnedIdentityAt(identitySource);
  const exactMode = (await stat(identitySource)).mode & 0o777;
  assert.throws(
    () => runPinnedMutation(temporary, directoryIdentity, {
      kind: "capture",
      source: path.basename(identitySource),
      destination: path.basename(identityDestination),
      sourceIdentity: exactIdentity,
      expectedSha256: sha256("same bytes\n"),
      expectedMode: exactMode,
      quarantine,
      testReplaceSourceAfterValidation: {
        parked: path.basename(identityParked),
        bytes: Buffer.from("same bytes\n").toString("base64"),
        mode: 0o600,
      },
    }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  assert.equal(await readFile(identitySource, "utf8"), "same bytes\n");
  assert.equal(await readFile(identityParked, "utf8"), "same bytes\n");
  await assert.rejects(readFile(identityDestination));

  const captureRaceSource = path.join(temporary, "capture-race-source.txt");
  const captureRaceParked = path.join(temporary, "capture-race-parked.txt");
  const captureRaceDestination = path.join(temporary, "capture-race-destination.txt");
  await writeFile(captureRaceSource, "capture original\n", { mode: 0o600 });
  const captureRaceIdentity = await pinnedIdentityAt(captureRaceSource);
  const captureRaceMode = (await stat(captureRaceSource)).mode & 0o777;
  assert.throws(
    () => runPinnedMutation(temporary, directoryIdentity, {
      kind: "capture",
      source: path.basename(captureRaceSource),
      destination: path.basename(captureRaceDestination),
      sourceIdentity: captureRaceIdentity,
      expectedSha256: sha256("capture original\n"),
      expectedMode: captureRaceMode,
      quarantine,
      testReplaceBeforeRemoval: {
        parked: path.basename(captureRaceParked),
        bytes: Buffer.from("capture replacement\n").toString("base64"),
        mode: 0o600,
      },
    }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  assert.equal(await readFile(captureRaceSource, "utf8"), "capture replacement\n");
  assert.equal(await readFile(captureRaceParked, "utf8"), "capture original\n");
  assert.equal(await readFile(captureRaceDestination, "utf8"), "capture original\n");
  assert.deepEqual(await readdir(path.join(temporary, quarantine.name)), []);

  const linkCrashSource = path.join(temporary, "link-crash-source.txt");
  const linkCrashDestination = path.join(temporary, "link-crash-destination.txt");
  await writeFile(linkCrashSource, "link crash\n", { mode: 0o600 });
  const linkCrashIdentity = await pinnedIdentityAt(linkCrashSource);
  const linkCrashMode = (await stat(linkCrashSource)).mode & 0o777;
  assert.throws(
    () => runPinnedMutation(temporary, directoryIdentity, {
      kind: "capture",
      source: path.basename(linkCrashSource),
      destination: path.basename(linkCrashDestination),
      sourceIdentity: linkCrashIdentity,
      expectedSha256: sha256("link crash\n"),
      expectedMode: linkCrashMode,
      quarantine,
      testFailAfterLink: true,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  assert.equal((await stat(linkCrashSource)).nlink, 2);
  assert.equal(await readFile(linkCrashDestination, "utf8"), "link crash\n");
  runPinnedMutation(temporary, directoryIdentity, {
    kind: "remove",
    name: path.basename(linkCrashSource),
    identity: linkCrashIdentity,
    expectedSha256: sha256("link crash\n"),
    expectedMode: linkCrashMode,
    quarantine,
  });
  await assert.rejects(readFile(linkCrashSource));
  assert.equal(await readFile(linkCrashDestination, "utf8"), "link crash\n");

  const crashSource = path.join(temporary, "crash-source.txt");
  const crashDestination = path.join(temporary, "crash-destination.txt");
  await writeFile(crashSource, "crash exact\n", { mode: 0o600 });
  const crashIdentity = await pinnedIdentityAt(crashSource);
  const crashMode = (await stat(crashSource)).mode & 0o777;
  assert.throws(
    () => runPinnedMutation(temporary, directoryIdentity, {
      kind: "capture",
      source: path.basename(crashSource),
      destination: path.basename(crashDestination),
      sourceIdentity: crashIdentity,
      expectedSha256: sha256("crash exact\n"),
      expectedMode: crashMode,
      quarantine,
      testFailAfterQuarantineMove: true,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  await assert.rejects(readFile(crashSource));
  assert.equal(await readFile(crashDestination, "utf8"), "crash exact\n");
  assert.equal((await readdir(path.join(temporary, quarantine.name))).length, 1);
  runPinnedMutation(temporary, directoryIdentity, {
    kind: "reconcile_quarantine",
    name: path.basename(crashSource),
    identity: crashIdentity,
    expectedSha256: sha256("crash exact\n"),
    expectedMode: crashMode,
    quarantine,
  });
  assert.deepEqual(await readdir(path.join(temporary, quarantine.name)), []);

  assert.throws(
    () => runPinnedMutation(temporary, directoryIdentity, {
      kind: "remove",
      name: path.basename(crashDestination),
      identity: crashIdentity,
      expectedSha256: sha256("crash exact\n"),
      expectedMode: crashMode,
      quarantine,
      testFailAfterQuarantineMove: true,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  runPinnedMutation(temporary, directoryIdentity, {
    kind: "reconcile_quarantine",
    name: path.basename(crashDestination),
    identity: crashIdentity,
    expectedSha256: sha256("crash exact\n"),
    expectedMode: crashMode,
    quarantine,
  });
  await assert.rejects(readFile(crashDestination));

  const unexpectedQuarantineLeaf = path.join(temporary, quarantine.name, "unexpected");
  await writeFile(unexpectedQuarantineLeaf, "preserve\n");
  assert.throws(
    () => runPinnedMutation(temporary, directoryIdentity, {
      kind: "remove_quarantine",
      quarantine,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  assert.equal(await readFile(unexpectedQuarantineLeaf, "utf8"), "preserve\n");
  await unlink(unexpectedQuarantineLeaf);

  const parkedQuarantine = path.join(temporary, ".test-private-parked");
  await rename(path.join(temporary, quarantine.name), parkedQuarantine);
  await mkdir(path.join(temporary, quarantine.name), { mode: 0o700 });
  assert.throws(
    () => runPinnedMutation(temporary, directoryIdentity, {
      kind: "verify_quarantine",
      quarantine,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  await rm(path.join(temporary, quarantine.name), { recursive: true });
  await rename(parkedQuarantine, path.join(temporary, quarantine.name));
  runPinnedMutation(temporary, directoryIdentity, {
    kind: "remove_quarantine",
    quarantine,
  });
});

test("pinned workers execute the payload captured before helper-path replacement", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-patch-worker-trust-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const workerPath = fileURLToPath(
    new URL("../../src/repository/pinned-mutation-worker.js", import.meta.url),
  );
  const workerBytes = await readFile(workerPath);
  context.after(async () => writeFile(workerPath, workerBytes));
  await writeFile(workerPath, "throw new Error('replaced worker must not execute');\n");
  runPinnedMutation(
    temporary,
    await pinnedIdentityAt(temporary),
    {
      kind: "write",
      name: "result.txt",
      bytes: Buffer.from("trusted\n").toString("base64"),
      mode: 0o600,
    },
  );
  assert.equal(await readFile(path.join(temporary, "result.txt"), "utf8"), "trusted\n");
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

test("recovery preserves a deletion before the install worker acknowledges", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-patch-unacked-delete-"));
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
    { deleteAfterLinkBeforeResponse: () => true },
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

test("pinned install exposes deterministic deletion-before-ack evidence", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-worker-unacked-delete-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const directory = await pinnedIdentityAt(temporary);
  const staged = runPinnedMutation(temporary, directory, {
    kind: "write",
    name: "staged",
    bytes: Buffer.from("after\n").toString("base64"),
    mode: 0o600,
  });
  assert.ok(isPinnedIdentity(staged));

  assert.throws(
    () => runPinnedMutation(temporary, directory, {
      kind: "install",
      source: "staged",
      destination: "target",
      sourceIdentity: staged,
      sourceSha256: sha256("after\n"),
      sourceMode: 0o600,
      testDeleteDestinationAfterLink: true,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  await assert.rejects(readFile(path.join(temporary, "target")));
  assert.equal(await readFile(path.join(temporary, "staged"), "utf8"), "after\n");
});

test("pinned reads reject a file that grows after descriptor stat", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-worker-read-growth-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const target = path.join(temporary, "target");
  await writeFile(target, "before");
  const directory = await pinnedIdentityAt(temporary);

  assert.throws(
    () => runPinnedMutation(
      temporary,
      directory,
      {
        kind: "read",
        name: "target",
        testAppendAfterStat: "!",
      },
    ),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  assert.equal(await readFile(target, "utf8"), "before!");
});

test("forward mutation hard-link preflight fails before capture and cleans reserved leaves", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-patch-link-preflight-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const target = path.join(root, "file.txt");
  const before = "before\n";
  await writeFile(target, before, { mode: 0o640 });
  const modeBefore = (await stat(target)).mode & 0o777;
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const engine = new PatchEngine(
    boundary,
    checkpoints,
    new ProtectedPathPolicy(),
    {},
    { failHardLinkProbe: () => true },
  );

  await assert.rejects(
    engine.editText({
      path: "file.txt",
      base_sha256: sha256(before),
      old_text: "before",
      new_text: "after",
      expected_occurrences: 1,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "UNSUPPORTED_FILE",
  );
  assert.equal(await readFile(target, "utf8"), before);
  assert.equal((await stat(target)).mode & 0o777, modeBefore);
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".cba-")), []);
});

test("rollback hard-link preflight covers every target before capture", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-rollback-link-preflight-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const first = path.join(root, "first.txt");
  const second = path.join(root, "second.txt");
  await writeFile(first, "first before\n", { mode: 0o640 });
  await writeFile(second, "second before\n", { mode: 0o600 });
  const boundary = await RepositoryBoundary.create(root);
  const checkpointRoot = path.join(temporary, "checkpoints");
  const checkpoints = await CheckpointStore.create(boundary, checkpointRoot);
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());
  const result = await engine.applyPatch({
    changes: [
      {
        kind: "update",
        path: "first.txt",
        base_sha256: sha256("first before\n"),
        content: "first after\n",
      },
      {
        kind: "update",
        path: "second.txt",
        base_sha256: sha256("second before\n"),
        content: "second after\n",
      },
    ],
  });
  const firstMode = (await stat(first)).mode & 0o777;
  const secondMode = (await stat(second)).mode & 0o777;
  const unsupported = await CheckpointStore.create(boundary, checkpointRoot, {
    hooks: { failRollbackHardLinkProbe: (candidate) => candidate === "second.txt" },
  });

  await assert.rejects(
    unsupported.rollback(result.checkpointId),
    (error: unknown) => error instanceof AgentError && error.code === "UNSUPPORTED_FILE",
  );
  assert.equal(await readFile(first, "utf8"), "first after\n");
  assert.equal(await readFile(second, "utf8"), "second after\n");
  assert.equal((await stat(first)).mode & 0o777, firstMode);
  assert.equal((await stat(second)).mode & 0o777, secondMode);
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".cba-")), []);
});

test("rollback authenticates and cleans an interrupted forward delete probe", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-delete-probe-recovery-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const target = path.join(root, "delete.txt");
  const before = "before delete\n";
  await writeFile(target, before, { mode: 0o640 });
  const boundary = await RepositoryBoundary.create(root);
  const checkpointRoot = path.join(temporary, "checkpoints");
  const checkpoints = await CheckpointStore.create(boundary, checkpointRoot);
  const checkpoint = await checkpoints.createCheckpoint(["delete.txt"]);
  const targetIdentity = await pinnedIdentityAt(target);
  const directory = await pinnedIdentityAt(root);
  const targetMode = (await stat(target)).mode & 0o777;
  const artifactPaths = checkpointMutationArtifactPaths(
    target,
    "delete.txt",
    checkpoint.id,
  );
  await mkdir(artifactPaths.quarantinePath, { mode: 0o700 });
  await checkpoints.recordMutationArtifacts(checkpoint.id, [{
    path: "delete.txt",
    directory,
    quarantine: await pinnedIdentityAt(artifactPaths.quarantinePath),
    probe: {
      ...targetIdentity,
      sha256: sha256(before),
      mode: targetMode,
    },
  }]);
  const probe = artifactPaths.probePath;
  await link(target, probe);

  assert.equal((await stat(target)).nlink, 2);
  await checkpoints.verify(checkpoint.id);
  await checkpoints.rollback(checkpoint.id, { force: true });
  assert.equal(await readFile(target, "utf8"), before);
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".cba-")), []);
});

test("rollback resumes an exact created-target probe and rejects a different-inode probe", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-rollback-probe-recovery-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));

  async function seedProbe(caseName: string, exactProbe: boolean) {
    const root = path.join(temporary, caseName);
    const checkpointRoot = path.join(temporary, `${caseName}-checkpoints`);
    await mkdir(root);
    const boundary = await RepositoryBoundary.create(root);
    const checkpoints = await CheckpointStore.create(boundary, checkpointRoot);
    const checkpoint = await checkpoints.createCheckpoint(["created.txt"]);
    const target = path.join(root, "created.txt");
    const content = "created later\n";
    await writeFile(target, content, { mode: 0o640 });
    const targetState = await stat(target, { bigint: true });
    await checkpoints.seal(checkpoint.id, [{
      path: "created.txt",
      sha256: sha256(content),
      mode: Number(targetState.mode & 0o777n),
    }]);
    const rollbackProbe = `${checkpointMutationArtifactPaths(
      target,
      "created.txt",
      checkpoint.id,
    ).probePath}.rollback`;
    const rollbackQuarantine = `${
      checkpointMutationArtifactPaths(target, "created.txt", checkpoint.id).quarantinePath
    }.rollback`;
    await mkdir(rollbackQuarantine, { mode: 0o700 });
    if (exactProbe) {
      await link(target, rollbackProbe);
    } else {
      await link(target, path.join(root, "unrelated-hard-link"));
      await writeFile(rollbackProbe, content, { mode: 0o640 });
    }
    const manifestPath = path.join(checkpointRoot, checkpoint.id, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      integrity: string;
      rollback?: unknown;
      [key: string]: unknown;
    };
    manifest.rollback = {
      startedAt: "2026-07-25T00:00:00.000Z",
      forced: false,
      phase: "applying",
      entries: [{
        path: "created.txt",
        directory: await pinnedIdentityAt(root),
        current: {
          ...pinnedIdentityFromBigInts(targetState.dev, targetState.ino),
          sha256: sha256(content),
          mode: Number(targetState.mode & 0o777n),
        },
        temporary: null,
        backup: null,
        installed: null,
        quarantine: await pinnedIdentityAt(rollbackQuarantine),
      }],
    };
    const { integrity: _integrity, ...body } = manifest;
    await writeFile(
      manifestPath,
      `${stableJson({ ...body, integrity: sha256(stableJson(body)) })}\n`,
    );
    return { checkpoints, checkpoint, root, target };
  }

  const exact = await seedProbe("exact", true);
  await exact.checkpoints.verify(exact.checkpoint.id);
  await exact.checkpoints.rollback(exact.checkpoint.id);
  await assert.rejects(readFile(exact.target));
  assert.deepEqual(
    (await readdir(exact.root)).filter((name) => name.startsWith(".cba-")),
    [],
  );

  const inauthentic = await seedProbe("inauthentic", false);
  await assert.rejects(
    inauthentic.checkpoints.verify(inauthentic.checkpoint.id),
    (error: unknown) => error instanceof AgentError && error.code === "UNSUPPORTED_FILE",
  );
  assert.equal(await readFile(inauthentic.target, "utf8"), "created later\n");
});

test("create recovery removes an installed result when failure follows the final link", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-patch-create-link-failure-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const target = path.join(root, "created.txt");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const engine = new PatchEngine(
    boundary,
    checkpoints,
    new ProtectedPathPolicy(),
    { allowCreate: true },
    { failAfterLink: () => true },
  );

  await assert.rejects(
    engine.applyPatch({
      changes: [{ kind: "create", path: "created.txt", content: "created\n" }],
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

test("post-install chmod race is detected before mutation success is sealed", async (context) => {
  if (!CURRENT_HOST_PLATFORM.supportsPosixModes) return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-patch-mode-race-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const target = path.join(root, "file.txt");
  await writeFile(target, "before\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const engine = new PatchEngine(
    boundary,
    checkpoints,
    new ProtectedPathPolicy(),
    {},
    { afterInstall: async () => chmod(target, 0o755) },
  );
  await assert.rejects(
    engine.editText({
      path: "file.txt",
      base_sha256: sha256("before\n"),
      old_text: "before",
      new_text: "after",
      expected_occurrences: 1,
    }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  assert.equal((await stat(target)).mode & 0o777, 0o755);
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

test("checkpoint manifest reads enforce the descriptor allocation cap", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-checkpoint-manifest-cap-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  const checkpointRoot = path.join(temporary, "checkpoints");
  await mkdir(root);
  await writeFile(path.join(root, "file.txt"), "original\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, checkpointRoot);
  const checkpoint = await checkpoints.createCheckpoint(["file.txt"]);
  await writeFile(
    path.join(checkpointRoot, checkpoint.id, "manifest.json"),
    Buffer.alloc(1024 * 1024 + 1, 0x20),
  );

  await assert.rejects(
    checkpoints.verify(checkpoint.id),
    (error: unknown) => error instanceof AgentError && error.code === "CHECKPOINT_CORRUPT",
  );
});

test("rollback revalidates a checkpoint blob immediately before staging it", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-checkpoint-blob-race-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  const checkpointRoot = path.join(temporary, "checkpoints");
  await mkdir(root);
  const target = path.join(root, "file.txt");
  await writeFile(target, "before\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, checkpointRoot);
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());
  const result = await engine.editText({
    path: "file.txt",
    base_sha256: sha256("before\n"),
    old_text: "before",
    new_text: "after",
    expected_occurrences: 1,
  });
  const manifest = JSON.parse(
    await readFile(
      path.join(checkpointRoot, result.checkpointId, "manifest.json"),
      "utf8",
    ),
  ) as { entries: Array<{ blob: string | null }> };
  const blob = manifest.entries[0]?.blob;
  assert.ok(blob);
  const racingStore = await CheckpointStore.create(boundary, checkpointRoot, {
    hooks: {
      beforeRestoreTarget: async () => {
        await writeFile(
          path.join(checkpointRoot, result.checkpointId, "blobs", blob),
          Buffer.alloc(MAX_PINNED_FILE_BYTES + 1, 0x61),
        );
      },
    },
  });

  await assert.rejects(
    racingStore.rollback(result.checkpointId),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  assert.equal(await readFile(target, "utf8"), "after\n");
});

test("checkpoint manifest rejects malformed post-state mode evidence", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-checkpoint-mode-shape-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  const checkpointRoot = path.join(temporary, "checkpoints");
  await mkdir(root);
  await writeFile(path.join(root, "file.txt"), "before\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, checkpointRoot);
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());
  const result = await engine.editText({
    path: "file.txt",
    base_sha256: sha256("before\n"),
    old_text: "before",
    new_text: "after",
    expected_occurrences: 1,
  });
  const manifestPath = path.join(checkpointRoot, result.checkpointId, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    integrity: string;
    entries: Array<{ expectedAfter?: { existed: boolean; sha256: string | null; mode?: unknown } }>;
    [key: string]: unknown;
  };
  if (manifest.entries[0]?.expectedAfter !== undefined) {
    manifest.entries[0].expectedAfter.mode = "0755";
  }
  const { integrity: _integrity, ...body } = manifest;
  await writeFile(
    manifestPath,
    `${stableJson({ ...body, integrity: sha256(stableJson(body)) })}\n`,
  );
  await assert.rejects(
    checkpoints.verify(result.checkpointId),
    (error: unknown) => error instanceof AgentError && error.code === "CHECKPOINT_CORRUPT",
  );
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

test("checkpoint rollback removes identity-bound artifacts left by an interrupted mutation", async (context) => {
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
  await mkdir(artifacts.quarantinePath, { mode: 0o700 });
  const temporaryState = await stat(artifacts.temporaryPath);
  const backupState = await stat(artifacts.backupPath);
  await checkpoints.recordMutationArtifacts(checkpoint.id, [{
    path: "file.txt",
    directory: await pinnedIdentityAt(root),
    quarantine: await pinnedIdentityAt(artifacts.quarantinePath),
    temporary: {
      ...await pinnedIdentityAt(artifacts.temporaryPath),
      sha256: sha256("staged\n"), mode: temporaryState.mode & 0o777,
    },
    backup: {
      ...await pinnedIdentityAt(artifacts.backupPath),
      sha256: sha256("original\n"), mode: backupState.mode & 0o777,
    },
  }]);
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

test("checkpoint cleanup refuses a symlink replacement before touching its target", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-checkpoint-artifact-race-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  const outside = path.join(temporary, "outside");
  await mkdir(root);
  await mkdir(outside);
  const target = path.join(root, "file.txt");
  await writeFile(target, "original\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const checkpoint = await checkpoints.createCheckpoint(["file.txt"]);
  const artifacts = checkpointMutationArtifactPaths(target, "file.txt", checkpoint.id);
  await writeFile(artifacts.temporaryPath, "staged\n");
  const temporaryState = await stat(artifacts.temporaryPath);
  await checkpoints.recordMutationArtifacts(checkpoint.id, [{
    path: "file.txt",
    directory: await pinnedIdentityAt(root),
    temporary: {
      ...await pinnedIdentityAt(artifacts.temporaryPath),
      sha256: sha256("staged\n"), mode: temporaryState.mode & 0o777,
    },
  }]);
  const parkedArtifact = `${artifacts.temporaryPath}.parked`;
  await rename(artifacts.temporaryPath, parkedArtifact);
  await writeFile(target, "partial\n");
  const outsideArtifact = path.join(outside, "outside-new");
  await writeFile(outsideArtifact, "outside new\n");
  await symlink(outsideArtifact, artifacts.temporaryPath);

  await assert.rejects(
    checkpoints.rollback(checkpoint.id, { force: true }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  assert.equal(await readFile(target, "utf8"), "partial\n");
  assert.equal(await readFile(outsideArtifact, "utf8"), "outside new\n");
  await unlink(artifacts.temporaryPath);
  await rename(parkedArtifact, artifacts.temporaryPath);
});

test("checkpoint cleanup refuses an ordinary artifact replacement", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-checkpoint-artifact-identity-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const target = path.join(root, "file.txt");
  await writeFile(target, "original\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const checkpoint = await checkpoints.createCheckpoint(["file.txt"]);
  const artifacts = checkpointMutationArtifactPaths(target, "file.txt", checkpoint.id);
  await writeFile(artifacts.temporaryPath, "staged\n");
  const temporaryState = await stat(artifacts.temporaryPath);
  await checkpoints.recordMutationArtifacts(checkpoint.id, [{
    path: "file.txt",
    directory: await pinnedIdentityAt(root),
    temporary: {
      ...await pinnedIdentityAt(artifacts.temporaryPath),
      sha256: sha256("staged\n"), mode: temporaryState.mode & 0o777,
    },
  }]);
  const parkedArtifact = `${artifacts.temporaryPath}.parked`;
  await rename(artifacts.temporaryPath, parkedArtifact);
  await writeFile(artifacts.temporaryPath, "replacement new\n");
  await writeFile(target, "partial\n");

  await assert.rejects(
    checkpoints.rollback(checkpoint.id, { force: true }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  assert.equal(await readFile(target, "utf8"), "partial\n");
  assert.equal(await readFile(artifacts.temporaryPath, "utf8"), "replacement new\n");
});

test("checkpoint rollback pins the target parent before restoring", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-checkpoint-parent-race-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  const sourceDirectory = path.join(root, "src");
  const parkedDirectory = path.join(root, "src-parked");
  const outside = path.join(temporary, "outside");
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(outside);
  const target = path.join(sourceDirectory, "file.txt");
  const outsideTarget = path.join(outside, "file.txt");
  await writeFile(target, "original\n");
  await writeFile(outsideTarget, "outside\n");
  const boundary = await RepositoryBoundary.create(root);
  let swapped = false;
  const checkpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "checkpoints"),
    {
      hooks: {
        beforeRestoreTarget: async () => {
          if (swapped) return;
          swapped = true;
          await rename(sourceDirectory, parkedDirectory);
          await symlink(outside, sourceDirectory, "dir");
        },
      },
    },
  );
  const checkpoint = await checkpoints.createCheckpoint(["src/file.txt"]);
  await checkpoints.recordMutationArtifacts(checkpoint.id, [{
    path: "src/file.txt",
    directory: await pinnedIdentityAt(sourceDirectory),
  }]);
  await writeFile(target, "partial\n");

  await assert.rejects(
    checkpoints.rollback(checkpoint.id, { force: true }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  assert.equal(await readFile(outsideTarget, "utf8"), "outside\n");
  await unlink(sourceDirectory);
  await rename(parkedDirectory, sourceDirectory);
  assert.equal(await readFile(target, "utf8"), "partial\n");
});

test("rollback preflights every artifact before changing a target", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-checkpoint-snapshot-race-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  const sourceDirectory = path.join(root, "src");
  await mkdir(sourceDirectory, { recursive: true });
  const target = path.join(sourceDirectory, "file.txt");
  await writeFile(target, "original\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "checkpoints"),
  );
  const checkpoint = await checkpoints.createCheckpoint(["src/file.txt"]);
  const artifacts = checkpointMutationArtifactPaths(target, "src/file.txt", checkpoint.id);
  await writeFile(artifacts.temporaryPath, "staged\n");
  const temporaryState = await stat(artifacts.temporaryPath);
  await checkpoints.recordMutationArtifacts(checkpoint.id, [{
    path: "src/file.txt",
    directory: await pinnedIdentityAt(sourceDirectory),
    temporary: {
      ...await pinnedIdentityAt(artifacts.temporaryPath),
      sha256: sha256("staged\n"), mode: temporaryState.mode & 0o777,
    },
  }]);
  const parkedArtifact = `${artifacts.temporaryPath}.parked`;
  await rename(artifacts.temporaryPath, parkedArtifact);
  await writeFile(artifacts.temporaryPath, "replacement artifact\n");
  await writeFile(target, "partial\n");

  await assert.rejects(
    checkpoints.rollback(checkpoint.id, { force: true }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  assert.equal(await readFile(target, "utf8"), "partial\n");
  assert.equal(await readFile(artifacts.temporaryPath, "utf8"), "replacement artifact\n");
});

test("rollback preflights reserved rollback artifacts for every file", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-checkpoint-rollback-artifact-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const first = path.join(root, "a.txt");
  const second = path.join(root, "b.txt");
  await writeFile(first, "a before\n");
  await writeFile(second, "b before\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());
  const result = await engine.applyPatch({
    changes: [
      { kind: "update", path: "a.txt", base_sha256: sha256("a before\n"), content: "a after\n" },
      { kind: "update", path: "b.txt", base_sha256: sha256("b before\n"), content: "b after\n" },
    ],
  });
  const secondArtifacts = checkpointMutationArtifactPaths(second, "b.txt", result.checkpointId);
  await writeFile(`${secondArtifacts.temporaryPath}.rollback`, "unexpected\n");
  await assert.rejects(
    checkpoints.rollback(result.checkpointId),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  assert.equal(await readFile(first, "utf8"), "a after\n");
  assert.equal(await readFile(second, "utf8"), "b after\n");
});

test("rollback-of-rollback pins an earlier target after a later restore fails", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-checkpoint-fallback-parent-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  const firstDirectory = path.join(root, "a");
  const parkedDirectory = path.join(root, "a-parked");
  const secondDirectory = path.join(root, "b");
  const outside = path.join(temporary, "outside");
  await mkdir(firstDirectory, { recursive: true });
  await mkdir(secondDirectory);
  await mkdir(outside);
  const first = path.join(firstDirectory, "file.txt");
  const second = path.join(secondDirectory, "file.txt");
  const outsideTarget = path.join(outside, "file.txt");
  await writeFile(first, "first original\n");
  await writeFile(second, "second original\n");
  await writeFile(outsideTarget, "outside\n");
  const boundary = await RepositoryBoundary.create(root);
  let swapFallback = false;
  const checkpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "checkpoints"),
    {
      hooks: {
        afterRollbackCapture: async (candidate) => {
          if (candidate === "b/file.txt") throw new Error("injected later restore failure");
        },
        beforeRestoreSnapshot: async (candidate) => {
          if (candidate !== "a/file.txt" || swapFallback) return;
          swapFallback = true;
          await rename(firstDirectory, parkedDirectory);
          await symlink(outside, firstDirectory, "dir");
        },
      },
    },
  );
  const checkpoint = await checkpoints.createCheckpoint(["a/file.txt", "b/file.txt"]);
  await checkpoints.recordMutationArtifacts(checkpoint.id, [
    {
      path: "a/file.txt",
      directory: await pinnedIdentityAt(firstDirectory),
    },
    {
      path: "b/file.txt",
      directory: await pinnedIdentityAt(secondDirectory),
    },
  ]);
  await writeFile(first, "first partial\n");
  await writeFile(second, "second partial\n");

  await assert.rejects(
    checkpoints.rollback(checkpoint.id, { force: true }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  assert.equal(await readFile(outsideTarget, "utf8"), "outside\n");
  await unlink(firstDirectory);
  await rename(parkedDirectory, firstDirectory);
  assert.equal(await readFile(first, "utf8"), "first original\n");
  assert.equal(await readFile(second, "utf8"), "second partial\n");
});

test("sealed rollback preserves leaf replacements made after exact preflight", async (context) => {
  for (const raceKind of ["new-inode", "same-inode"] as const) {
    await context.test(raceKind, async () => {
      const temporary = await mkdtemp(path.join(os.tmpdir(), `cba-checkpoint-leaf-${raceKind}-`));
      context.after(async () => rm(temporary, { recursive: true, force: true }));
      const root = path.join(temporary, "repo");
      await mkdir(root);
      const target = path.join(root, "file.txt");
      await writeFile(target, "before\n");
      const boundary = await RepositoryBoundary.create(root);
      let inject = false;
      const checkpoints = await CheckpointStore.create(
        boundary,
        path.join(temporary, "checkpoints"),
        {
          hooks: {
            beforeRestoreTarget: async () => {
              if (!inject) return;
              if (raceKind === "new-inode") {
                await rename(target, `${target}.agent`);
              }
              await writeFile(target, "concurrent\n");
            },
          },
        },
      );
      const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());
      const result = await engine.editText({
        path: "file.txt",
        base_sha256: sha256("before\n"),
        old_text: "before",
        new_text: "after",
        expected_occurrences: 1,
      });
      inject = true;

      await assert.rejects(
        checkpoints.rollback(result.checkpointId),
        (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
      );
      assert.equal(await readFile(target, "utf8"), "concurrent\n");
    });
  }
});

test("rollback verifies same-inode and replacement races after install", async (context) => {
  for (const raceKind of ["same-inode", "new-inode"] as const) {
    await context.test(raceKind, async () => {
      const temporary = await mkdtemp(path.join(os.tmpdir(), `cba-rollback-post-${raceKind}-`));
      context.after(async () => rm(temporary, { recursive: true, force: true }));
      const root = path.join(temporary, "repo");
      await mkdir(root);
      const target = path.join(root, "file.txt");
      await writeFile(target, "before\n");
      const boundary = await RepositoryBoundary.create(root);
      let inject = false;
      const checkpoints = await CheckpointStore.create(
        boundary,
        path.join(temporary, "checkpoints"),
        {
          hooks: {
            afterRollbackInstall: async () => {
              if (!inject) return;
              if (raceKind === "new-inode") await rename(target, `${target}.rollback`);
              await writeFile(target, "concurrent\n");
            },
          },
        },
      );
      const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());
      const result = await engine.editText({
        path: "file.txt",
        base_sha256: sha256("before\n"),
        old_text: "before",
        new_text: "after",
        expected_occurrences: 1,
      });
      inject = true;
      await assert.rejects(
        checkpoints.rollback(result.checkpointId),
        (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
      );
      assert.equal(await readFile(target, "utf8"), "concurrent\n");
    });
  }
});

test("legacy v1 checkpoints roll back safely and refuse unauthenticated artifacts", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-checkpoint-legacy-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const target = path.join(root, "file.txt");
  await writeFile(target, "before\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpointRoot = path.join(temporary, "checkpoints");
  const checkpoints = await CheckpointStore.create(boundary, checkpointRoot);
  const sealed = await checkpoints.createCheckpoint(["file.txt"]);
  await writeFile(target, "after\n");
  await checkpoints.seal(sealed.id, [{
    path: "file.txt",
    sha256: sha256("after\n"),
    mode: 0o644,
  }]);
  const manifestPath = path.join(checkpointRoot, sealed.id, "manifest.json");
  const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as {
    integrity: string;
    entries: Array<{ expectedAfter?: { mode?: number } }>;
    [key: string]: unknown;
  };
  if (parsed.entries[0]?.expectedAfter !== undefined) {
    delete parsed.entries[0].expectedAfter.mode;
  }
  const { integrity: _integrity, ...legacyBody } = parsed;
  await writeFile(
    manifestPath,
    `${stableJson({ ...legacyBody, integrity: sha256(stableJson(legacyBody)) })}\n`,
  );
  await assert.rejects(
    checkpoints.rollback(sealed.id),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  await checkpoints.rollback(sealed.id, { force: true });
  assert.equal(await readFile(target, "utf8"), "before\n");

  await writeFile(target, "legacy before\n");
  const interrupted = await checkpoints.createCheckpoint(["file.txt"]);
  const artifacts = checkpointMutationArtifactPaths(target, "file.txt", interrupted.id);
  await writeFile(artifacts.temporaryPath, "unauthenticated\n");
  await writeFile(target, "legacy partial\n");
  await assert.rejects(
    checkpoints.rollback(interrupted.id, { force: true }),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  assert.equal(await readFile(target, "utf8"), "legacy partial\n");
  assert.equal(await readFile(artifacts.temporaryPath, "utf8"), "unauthenticated\n");
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

test("sealed rollback treats chmod-only changes as stale and returns current integrity", async (context) => {
  if (!CURRENT_HOST_PLATFORM.supportsPosixModes) return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-checkpoint-mode-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const target = path.join(root, "file.txt");
  await writeFile(target, "before\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());
  const result = await engine.editText({
    path: "file.txt",
    base_sha256: sha256("before\n"),
    old_text: "before",
    new_text: "after",
    expected_occurrences: 1,
  });
  await chmod(target, 0o600);
  await assert.rejects(
    checkpoints.rollback(result.checkpointId),
    (error: unknown) => error instanceof AgentError && error.code === "STALE_STATE",
  );
  await chmod(target, 0o644);
  const rolledBack = await checkpoints.rollback(result.checkpointId);
  const verified = await checkpoints.verify(result.checkpointId);
  assert.equal(rolledBack.integrity, verified.integrity);
  assert.equal(await readFile(target, "utf8"), "before\n");
});

test("persisted rollback resumes after process loss at each target phase", async (context) => {
  for (const hook of [
    "afterRollbackStage",
    "afterRollbackCapture",
    "afterRollbackInstall",
  ] as const) {
    await context.test(hook, async () => {
      const temporary = await mkdtemp(path.join(os.tmpdir(), `cba-rollback-crash-${hook}-`));
      context.after(async () => rm(temporary, { recursive: true, force: true }));
      const root = path.join(temporary, "repo");
      const checkpointRoot = path.join(temporary, "checkpoints");
      await mkdir(root);
      const target = path.join(root, "file.txt");
      await writeFile(target, "before\n");
      const boundary = await RepositoryBoundary.create(root);
      const checkpoints = await CheckpointStore.create(boundary, checkpointRoot);
      const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());
      const result = await engine.editText({
        path: "file.txt",
        base_sha256: sha256("before\n"),
        old_text: "before",
        new_text: "after",
        expected_occurrences: 1,
      });

      const child = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", `
          const { RepositoryBoundary } = await import(process.env.CBA_BOUNDARY_URL);
          const { CheckpointStore } = await import(process.env.CBA_CHECKPOINT_URL);
          const boundary = await RepositoryBoundary.create(process.env.CBA_REPOSITORY_ROOT);
          const hooks = {
            [process.env.CBA_ROLLBACK_HOOK]: async () => process.exit(73),
          };
          const store = await CheckpointStore.create(
            boundary,
            process.env.CBA_CHECKPOINT_ROOT,
            { hooks },
          );
          await store.rollback(process.env.CBA_CHECKPOINT_ID);
        `],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CBA_BOUNDARY_URL: new URL("../../src/repository/boundary.js", import.meta.url).href,
            CBA_CHECKPOINT_URL: new URL("../../src/repository/checkpoint.js", import.meta.url).href,
            CBA_REPOSITORY_ROOT: root,
            CBA_CHECKPOINT_ROOT: checkpointRoot,
            CBA_CHECKPOINT_ID: result.checkpointId,
            CBA_ROLLBACK_HOOK: hook,
          },
        },
      );
      assert.equal(child.status, 73, child.stderr);

      const reopenedBoundary = await RepositoryBoundary.create(root);
      const reopened = await CheckpointStore.create(reopenedBoundary, checkpointRoot);
      await reopened.rollback(result.checkpointId);
      assert.equal(await readFile(target, "utf8"), "before\n");
      assert.deepEqual(
        (await readdir(root)).filter((entry) => entry.endsWith(".rollback")),
        [],
      );
    });
  }
});

test("rollback resumes write-ahead captures across link boundaries", async (context) => {
  async function storedState(filename: string, content: string) {
    const state = await stat(filename, { bigint: true });
    return {
      ...pinnedIdentityFromBigInts(state.dev, state.ino),
      sha256: sha256(content),
      mode: Number(state.mode & 0o777n),
    };
  }

  for (const phase of ["applying", "reverting"] as const) {
    for (const capturePoint of ["before-link", "after-link"] as const) {
      await context.test(`${phase}/${capturePoint}`, async () => {
        const temporary = await mkdtemp(
          path.join(
            os.tmpdir(),
            `cba-rollback-capture-${phase}-${capturePoint}-`,
          ),
        );
        context.after(async () => rm(temporary, { recursive: true, force: true }));
        const root = path.join(temporary, "repo");
        const checkpointRoot = path.join(temporary, "checkpoints");
        await mkdir(root);
        const target = path.join(root, "file.txt");
        await writeFile(target, "before\n");
        const boundary = await RepositoryBoundary.create(root);
        const checkpoints = await CheckpointStore.create(boundary, checkpointRoot);
        const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());
        const result = await engine.editText({
          path: "file.txt",
          base_sha256: sha256("before\n"),
          old_text: "before",
          new_text: "after",
          expected_occurrences: 1,
        });
        const artifacts = checkpointMutationArtifactPaths(
          target,
          "file.txt",
          result.checkpointId,
        );
        const rollbackTemporary = `${artifacts.temporaryPath}.rollback`;
        const rollbackBackup = `${artifacts.backupPath}.rollback`;
        const rollbackQuarantine = `${artifacts.quarantinePath}.rollback`;
        await mkdir(rollbackQuarantine, { mode: 0o700 });

        let current;
        let staged;
        let backup;
        let installed = null;
        if (phase === "applying") {
          await writeFile(rollbackTemporary, "before\n");
          current = await storedState(target, "after\n");
          staged = await storedState(rollbackTemporary, "before\n");
          if (capturePoint === "after-link") {
            await link(target, rollbackBackup);
            backup = await storedState(rollbackBackup, "after\n");
          } else {
            backup = current;
          }
        } else {
          await rename(target, rollbackBackup);
          await writeFile(target, "before\n");
          current = await storedState(rollbackBackup, "after\n");
          backup = current;
          installed = await storedState(target, "before\n");
          if (capturePoint === "after-link") {
            await link(target, rollbackTemporary);
            staged = await storedState(rollbackTemporary, "before\n");
          } else {
            staged = installed;
          }
        }
        assert.equal(
          (await stat(target)).nlink,
          capturePoint === "after-link" ? 2 : 1,
        );

        const manifestPath = path.join(
          checkpointRoot,
          result.checkpointId,
          "manifest.json",
        );
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          integrity: string;
          rollback?: unknown;
          [key: string]: unknown;
        };
        manifest.rollback = {
          startedAt: "2026-07-25T00:00:00.000Z",
          forced: false,
          phase,
          entries: [{
            path: "file.txt",
            directory: await pinnedIdentityAt(root),
            current,
            temporary: staged,
            backup,
            installed,
            quarantine: await pinnedIdentityAt(rollbackQuarantine),
          }],
        };
        const { integrity: _integrity, ...body } = manifest;
        await writeFile(
          manifestPath,
          `${stableJson({ ...body, integrity: sha256(stableJson(body)) })}\n`,
        );

        if (phase === "applying") {
          await checkpoints.rollback(result.checkpointId);
          assert.equal(await readFile(target, "utf8"), "before\n");
        } else {
          await assert.rejects(
            checkpoints.rollback(result.checkpointId),
            (error: unknown) =>
              error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
          );
          assert.equal(await readFile(target, "utf8"), "after\n");
        }
        assert.deepEqual(
          (await readdir(root)).filter((name) => name.startsWith(".cba-")),
          [],
        );
      });
    }
  }
});

test("restored terminal marker survives cleanup and makes rollback idempotent", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-rollback-created-cleanup-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  const checkpointRoot = path.join(temporary, "checkpoints");
  await mkdir(root);
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, checkpointRoot);
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());
  const result = await engine.applyPatch({
    changes: [{ kind: "create", path: "created.txt", content: "created\n" }],
  });
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `
      const { RepositoryBoundary } = await import(process.env.CBA_BOUNDARY_URL);
      const { CheckpointStore } = await import(process.env.CBA_CHECKPOINT_URL);
      const boundary = await RepositoryBoundary.create(process.env.CBA_REPOSITORY_ROOT);
      const store = await CheckpointStore.create(
        boundary,
        process.env.CBA_CHECKPOINT_ROOT,
        { hooks: { afterRollbackCleanup: async () => process.exit(76) } },
      );
      await store.rollback(process.env.CBA_CHECKPOINT_ID);
    `],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CBA_BOUNDARY_URL: new URL("../../src/repository/boundary.js", import.meta.url).href,
        CBA_CHECKPOINT_URL: new URL("../../src/repository/checkpoint.js", import.meta.url).href,
        CBA_REPOSITORY_ROOT: root,
        CBA_CHECKPOINT_ROOT: checkpointRoot,
        CBA_CHECKPOINT_ID: result.checkpointId,
      },
    },
  );
  assert.equal(child.status, 76, child.stderr);

  const reopenedBoundary = await RepositoryBoundary.create(root);
  const reopened = await CheckpointStore.create(reopenedBoundary, checkpointRoot);
  const firstRetry = await reopened.rollback(result.checkpointId);
  const secondRetry = await reopened.rollback(result.checkpointId);
  assert.equal(secondRetry.integrity, firstRetry.integrity);
  await assert.rejects(readFile(path.join(root, "created.txt")));
});

test("rollback preserves a deletion before its install worker acknowledges", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-rollback-unacked-delete-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  const checkpointRoot = path.join(temporary, "checkpoints");
  await mkdir(root);
  const target = path.join(root, "file.txt");
  await writeFile(target, "before\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, checkpointRoot);
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());
  const result = await engine.editText({
    path: "file.txt",
    base_sha256: sha256("before\n"),
    old_text: "before",
    new_text: "after",
    expected_occurrences: 1,
  });
  const racingStore = await CheckpointStore.create(boundary, checkpointRoot, {
    hooks: { deleteRollbackInstallBeforeResponse: () => true },
  });

  await assert.rejects(
    racingStore.rollback(result.checkpointId),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  await assert.rejects(readFile(target));
  const reopened = await CheckpointStore.create(boundary, checkpointRoot);
  await assert.rejects(
    reopened.rollback(result.checkpointId),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  await assert.rejects(readFile(target));
});

test("force recovery reopens interrupted patch and artifact-consumption phases", async (context) => {
  for (const hook of [
    "afterStage",
    "afterCapture",
    "afterInstall",
    "afterTemporaryCleanup",
    "afterBackupCleanup",
  ] as const) {
    await context.test(hook, async () => {
      const temporary = await mkdtemp(path.join(os.tmpdir(), `cba-patch-crash-${hook}-`));
      context.after(async () => rm(temporary, { recursive: true, force: true }));
      const root = path.join(temporary, "repo");
      const checkpointRoot = path.join(temporary, "checkpoints");
      await mkdir(root);
      const target = path.join(root, "file.txt");
      await writeFile(target, "before\n");
      const child = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", `
          const { RepositoryBoundary } = await import(process.env.CBA_BOUNDARY_URL);
          const { CheckpointStore } = await import(process.env.CBA_CHECKPOINT_URL);
          const { PatchEngine } = await import(process.env.CBA_PATCH_URL);
          const { ProtectedPathPolicy } = await import(process.env.CBA_PROTECTED_URL);
          const { sha256 } = await import(process.env.CBA_CRYPTO_URL);
          const boundary = await RepositoryBoundary.create(process.env.CBA_REPOSITORY_ROOT);
          const store = await CheckpointStore.create(boundary, process.env.CBA_CHECKPOINT_ROOT);
          const hooks = {
            [process.env.CBA_PATCH_HOOK]: async () => process.exit(74),
          };
          const engine = new PatchEngine(boundary, store, new ProtectedPathPolicy(), {}, hooks);
          await engine.editText({
            path: "file.txt",
            base_sha256: sha256("before\\n"),
            old_text: "before",
            new_text: "after",
            expected_occurrences: 1,
            operationId: "op_patch_crash",
          });
        `],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CBA_BOUNDARY_URL: new URL("../../src/repository/boundary.js", import.meta.url).href,
            CBA_CHECKPOINT_URL: new URL("../../src/repository/checkpoint.js", import.meta.url).href,
            CBA_PATCH_URL: new URL("../../src/repository/patch-engine.js", import.meta.url).href,
            CBA_PROTECTED_URL: new URL("../../src/security/protected-paths.js", import.meta.url).href,
            CBA_CRYPTO_URL: new URL("../../src/shared/crypto.js", import.meta.url).href,
            CBA_REPOSITORY_ROOT: root,
            CBA_CHECKPOINT_ROOT: checkpointRoot,
            CBA_PATCH_HOOK: hook,
          },
        },
      );
      assert.equal(child.status, 74, child.stderr);

      const boundary = await RepositoryBoundary.create(root);
      const checkpoints = await CheckpointStore.create(boundary, checkpointRoot);
      const interrupted = await checkpoints.latest("op_patch_crash");
      assert.ok(interrupted);
      await checkpoints.rollback(interrupted.id, { force: true });
      assert.equal(await readFile(target, "utf8"), "before\n");
    });
  }
});

test("persisted reverting phase resumes after process loss following fallback install", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-rollback-revert-crash-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  const checkpointRoot = path.join(temporary, "checkpoints");
  await mkdir(root);
  await writeFile(path.join(root, "a.txt"), "a before\n");
  await writeFile(path.join(root, "b.txt"), "b before\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, checkpointRoot);
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());
  const result = await engine.applyPatch({
    changes: [
      {
        kind: "update",
        path: "a.txt",
        base_sha256: sha256("a before\n"),
        content: "a after\n",
      },
      {
        kind: "update",
        path: "b.txt",
        base_sha256: sha256("b before\n"),
        content: "b after\n",
      },
    ],
  });
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `
      const { RepositoryBoundary } = await import(process.env.CBA_BOUNDARY_URL);
      const { CheckpointStore } = await import(process.env.CBA_CHECKPOINT_URL);
      const boundary = await RepositoryBoundary.create(process.env.CBA_REPOSITORY_ROOT);
      const store = await CheckpointStore.create(
        boundary,
        process.env.CBA_CHECKPOINT_ROOT,
        {
          hooks: {
            afterRollbackCapture: async (candidate) => {
              if (candidate === "b.txt") throw new Error("injected later rollback failure");
            },
            afterRollbackRevertInstall: async (candidate) => {
              if (candidate === "a.txt") process.exit(75);
            },
          },
        },
      );
      await store.rollback(process.env.CBA_CHECKPOINT_ID);
    `],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CBA_BOUNDARY_URL: new URL("../../src/repository/boundary.js", import.meta.url).href,
        CBA_CHECKPOINT_URL: new URL("../../src/repository/checkpoint.js", import.meta.url).href,
        CBA_REPOSITORY_ROOT: root,
        CBA_CHECKPOINT_ROOT: checkpointRoot,
        CBA_CHECKPOINT_ID: result.checkpointId,
      },
    },
  );
  assert.equal(child.status, 75, child.stderr);

  const reopenedBoundary = await RepositoryBoundary.create(root);
  const reopened = await CheckpointStore.create(reopenedBoundary, checkpointRoot);
  await assert.rejects(
    reopened.rollback(result.checkpointId),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "a after\n");
  assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "b after\n");
  await reopened.rollback(result.checkpointId);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "a before\n");
  assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "b before\n");
});

test("rollback fallback preserves a deletion before recovery install acknowledgment", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-rollback-revert-unacked-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  const checkpointRoot = path.join(temporary, "checkpoints");
  await mkdir(root);
  await writeFile(path.join(root, "a.txt"), "a before\n");
  await writeFile(path.join(root, "b.txt"), "b before\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, checkpointRoot);
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());
  const result = await engine.applyPatch({
    changes: [
      {
        kind: "update",
        path: "a.txt",
        base_sha256: sha256("a before\n"),
        content: "a after\n",
      },
      {
        kind: "update",
        path: "b.txt",
        base_sha256: sha256("b before\n"),
        content: "b after\n",
      },
    ],
  });
  const racingStore = await CheckpointStore.create(boundary, checkpointRoot, {
    hooks: {
      afterRollbackCapture: async (candidate) => {
        if (candidate === "b.txt") throw new Error("injected later rollback failure");
      },
      deleteRollbackRevertInstallBeforeResponse: (candidate) => candidate === "a.txt",
    },
  });

  await assert.rejects(
    racingStore.rollback(result.checkpointId),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  await assert.rejects(readFile(path.join(root, "a.txt")));
  assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "b after\n");
  const reopened = await CheckpointStore.create(boundary, checkpointRoot);
  await assert.rejects(
    reopened.rollback(result.checkpointId),
    (error: unknown) => error instanceof AgentError && error.code === "RECOVERY_REQUIRED",
  );
  await assert.rejects(readFile(path.join(root, "a.txt")));
});

test("pinned rollback protocol supports a seven MiB deleted text file", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-checkpoint-large-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const target = path.join(root, "large.txt");
  const before = `${"a".repeat(7 * 1024 * 1024 - 1)}\n`;
  await writeFile(target, before);
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const engine = new PatchEngine(
    boundary,
    checkpoints,
    new ProtectedPathPolicy(),
    {
      maxFileBytes: 8 * 1024 * 1024,
      maxTotalBytes: 8 * 1024 * 1024,
      maxChangedLines: 2,
      allowDelete: true,
    },
  );
  const result = await engine.applyPatch({
    changes: [{
      kind: "delete",
      path: "large.txt",
      base_sha256: sha256(before),
    }],
  });
  await assert.rejects(readFile(target));
  await checkpoints.rollback(result.checkpointId);
  assert.equal((await readFile(target)).length, Buffer.byteLength(before));
  assert.equal(sha256(await readFile(target)), sha256(before));
});

test("checkpoint.v1 fails closed before rolling back an oversized legacy entry", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-checkpoint-legacy-oversized-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const target = path.join(root, "large.txt");
  const before = Buffer.alloc(MAX_PINNED_FILE_BYTES + 1, 0x61);
  await writeFile(target, "small before\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpointRoot = path.join(temporary, "checkpoints");
  const checkpoints = await CheckpointStore.create(
    boundary,
    checkpointRoot,
    { maxCheckpointBytes: before.length + 1024 },
  );
  const checkpoint = await checkpoints.createCheckpoint(["large.txt"]);
  const manifestPath = path.join(checkpointRoot, checkpoint.id, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    integrity: string;
    entries: Array<{
      blob: string | null;
      sizeBytes: number;
      sha256: string | null;
    }>;
    totalBytes: number;
    [key: string]: unknown;
  };
  const entry = manifest.entries[0];
  assert.ok(entry?.blob);
  await writeFile(path.join(checkpointRoot, checkpoint.id, "blobs", entry.blob), before);
  entry.sizeBytes = before.length;
  entry.sha256 = sha256(before);
  manifest.totalBytes = before.length;
  const { integrity: _integrity, ...legacyBody } = manifest;
  await writeFile(
    manifestPath,
    `${stableJson({ ...legacyBody, integrity: sha256(stableJson(legacyBody)) })}\n`,
  );
  const after = Buffer.from("after\n");
  await writeFile(target, after);
  await checkpoints.seal(checkpoint.id, [{
    path: "large.txt",
    sha256: sha256(after),
    mode: (await stat(target)).mode & 0o777,
  }]);

  await assert.rejects(
    checkpoints.rollback(checkpoint.id),
    (error: unknown) =>
      error instanceof AgentError &&
      error.code === "RECOVERY_REQUIRED" &&
      error.details.protocolLimit === MAX_PINNED_FILE_BYTES,
  );
  assert.equal(await readFile(target, "utf8"), "after\n");
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
