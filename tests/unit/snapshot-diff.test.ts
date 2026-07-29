import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RepositoryBoundary } from "../../src/repository/boundary.js";
import { CheckpointStore } from "../../src/repository/checkpoint.js";
import { PatchEngine } from "../../src/repository/patch-engine.js";
import { SnapshotDiffInspector } from "../../src/repository/snapshot-diff.js";
import { ProtectedPathPolicy } from "../../src/security/protected-paths.js";
import { sha256 } from "../../src/shared/crypto.js";

test("checkpoint diff is bounded and filters concrete hidden paths without naming them", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-checkpoint-diff-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  await writeFile(path.join(root, "visible.txt"), "before visible\n");
  await writeFile(path.join(root, "delete.txt"), "delete me\n");
  await writeFile(path.join(root, "hidden.txt"), "before hidden secret\n");
  await writeFile(path.join(root, "line-ending.txt"), "same text\r\n");

  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const checkpoint = await checkpoints.createCheckpoint([
    "visible.txt",
    "delete.txt",
    "created.txt",
    "hidden.txt",
    "line-ending.txt",
  ]);
  await writeFile(path.join(root, "visible.txt"), "after visible\n");
  await rm(path.join(root, "delete.txt"));
  await writeFile(path.join(root, "created.txt"), "created now\n");
  await writeFile(path.join(root, "hidden.txt"), "after hidden secret\n");
  await writeFile(path.join(root, "line-ending.txt"), "same text\n");

  const inspector = new SnapshotDiffInspector(boundary, checkpoints, {
    maxDiffBytes: 16 * 1024,
    isPathAllowed: (candidate) => candidate !== "hidden.txt",
  });
  const result = await inspector.diffCheckpoint(checkpoint.id);
  assert.equal(result.scope, "checkpoint");
  assert.equal(result.baseline, checkpoint.id);
  assert.equal(result.excludedCount, 1);
  assert.equal(result.comparedFileCount, 4);
  assert.equal(result.changedFileCount, 4);
  assert.match(result.diff, /-before visible/u);
  assert.match(result.diff, /\+after visible/u);
  assert.match(result.diff, /new file mode/u);
  assert.match(result.diff, /deleted file mode/u);
  assert.match(result.diff, /line-ending\.txt/u);
  assert.equal(result.diff.includes("hidden.txt"), false);
  assert.equal(result.diff.includes("hidden secret"), false);

  const selected = await inspector.diffCheckpoint(checkpoint.id, { paths: ["visible.txt"] });
  assert.equal(selected.excludedCount, 0);
  assert.equal(selected.comparedFileCount, 1);
  assert.equal(selected.diff.includes("created.txt"), false);

  const bounded = await inspector.diffCheckpoint(checkpoint.id, { maxBytes: 48 });
  assert.equal(bounded.outputBytes <= 48, true);
  assert.equal(bounded.truncated, true);
  assert.equal(Buffer.byteLength(bounded.diff), bounded.outputBytes);
});

test("session diff uses the earliest checkpoint for each agent-mutated path", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-session-diff-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  await writeFile(path.join(root, "a.txt"), "session base a\n");
  await writeFile(path.join(root, "b.txt"), "session base b\n");

  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const patches = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy(), {
    allowCreate: true,
    allowDelete: true,
  });
  const first = await patches.applyPatch({
    operationId: "op_first",
    changes: [{
      kind: "update",
      path: "a.txt",
      base_sha256: sha256("session base a\n"),
      content: "intermediate a\n",
    }],
  });
  const second = await patches.applyPatch({
    operationId: "op_second",
    changes: [
      {
        kind: "update",
        path: "a.txt",
        base_sha256: sha256("intermediate a\n"),
        content: "final a\n",
      },
      {
        kind: "update",
        path: "b.txt",
        base_sha256: sha256("session base b\n"),
        content: "final b\n",
      },
    ],
  });

  const inspector = new SnapshotDiffInspector(boundary, checkpoints);
  const result = await inspector.diffSession([
    { checkpointId: first.checkpointId, changedPaths: ["a.txt"] },
    { checkpointId: second.checkpointId, changedPaths: ["a.txt", "b.txt"] },
  ]);
  assert.equal(result.scope, "session");
  assert.equal(result.baseline, "earliest-agent-checkpoint");
  assert.equal(result.comparedFileCount, 2);
  assert.equal(result.changedFileCount, 2);
  assert.match(result.diff, /-session base a/u);
  assert.match(result.diff, /\+final a/u);
  assert.doesNotMatch(result.diff, /intermediate a/u);
  assert.match(result.diff, /-session base b/u);
  assert.match(result.diff, /\+final b/u);

  const onlyA = await inspector.diffSession(
    [
      { checkpointId: first.checkpointId, changedPaths: ["a.txt"] },
      { checkpointId: second.checkpointId, changedPaths: ["a.txt", "b.txt"] },
    ],
    { paths: ["a.txt"] },
  );
  assert.equal(onlyA.comparedFileCount, 1);
  assert.equal(onlyA.diff.includes("b.txt"), false);
});

test("terminal session diff resolves healthy baselines and reports unavailable evidence", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-terminal-diff-resolver-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  await writeFile(path.join(root, "patch.txt"), "patch before\n");
  await writeFile(path.join(root, "generated.txt"), "generated after\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "checkpoints"),
  );
  const checkpoint = await checkpoints.createCheckpoint(["patch.txt"]);
  await writeFile(path.join(root, "patch.txt"), "patch after\n");
  const mutation = {
    kind: "terminal" as const,
    operationId: "op_terminal_1",
    changedPaths: ["generated.txt", "missing.txt"],
  };
  await assert.rejects(
    () => new SnapshotDiffInspector(boundary, checkpoints).diffSession([mutation]),
    /verified before-image resolver/u,
  );

  const resolvedPaths: string[] = [];
  const result = await new SnapshotDiffInspector(boundary, checkpoints, {
    resolveTerminalBeforeImage: async (_terminal, repositoryRelativePath) => {
      resolvedPaths.push(repositoryRelativePath);
      if (repositoryRelativePath === "missing.txt") {
        return {
          available: false,
          reason: "missing_evidence",
        };
      }
      return {
        available: true,
        baselineId: "terminal:op_terminal_1",
        entry: {
          path: repositoryRelativePath,
          existed: false,
          bytes: null,
          mode: null,
          sha256: null,
        },
      };
    },
  }).diffSession([
    {
      checkpointId: checkpoint.id,
      changedPaths: ["patch.txt"],
    },
    mutation,
  ]);

  assert.deepEqual(resolvedPaths, ["generated.txt", "missing.txt"]);
  assert.equal(result.comparedFileCount, 2);
  assert.equal(result.changedFileCount, 2);
  assert.match(result.diff, /patch\.txt/u);
  assert.match(result.diff, /-patch before/u);
  assert.match(result.diff, /\+patch after/u);
  assert.match(result.diff, /generated\.txt/u);
  assert.deepEqual(result.unavailableTerminalPaths, [{
    path: "missing.txt",
    reason: "missing_evidence",
  }]);
  assert.equal(result.unavailableTerminalPathCount, 1);
  assert.equal(result.omittedTerminalPathCount, 0);
});

test("terminal session diff preserves patch paths before omitting bounded terminal paths", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-terminal-diff-bound-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  await writeFile(path.join(root, "patch.txt"), "before\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "checkpoints"),
  );
  const checkpoint = await checkpoints.createCheckpoint(["patch.txt"]);
  await writeFile(path.join(root, "patch.txt"), "after\n");
  let resolverCalled = false;
  const result = await new SnapshotDiffInspector(boundary, checkpoints, {
    maxFiles: 1,
    resolveTerminalBeforeImage: async () => {
      resolverCalled = true;
      return {
        available: false,
        reason: "bounded_out",
      };
    },
  }).diffSession([
    { checkpointId: checkpoint.id, changedPaths: ["patch.txt"] },
    {
      kind: "terminal",
      operationId: "op_terminal_2",
      changedPaths: ["terminal.txt"],
    },
  ]);

  assert.equal(resolverCalled, false);
  assert.equal(result.comparedFileCount, 1);
  assert.match(result.diff, /patch\.txt/u);
  assert.deepEqual(result.unavailableTerminalPaths, []);
  assert.equal(result.unavailableTerminalPathCount, 0);
  assert.equal(result.omittedTerminalPathCount, 1);
});
