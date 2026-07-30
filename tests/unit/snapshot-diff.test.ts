import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RepositoryBoundary } from "../../src/repository/boundary.js";
import { CheckpointStore } from "../../src/repository/checkpoint.js";
import { PatchEngine } from "../../src/repository/patch-engine.js";
import { SnapshotDiffInspector } from "../../src/repository/snapshot-diff.js";
import { ProtectedPathPolicy } from "../../src/security/protected-paths.js";
import { sha256 } from "../../src/shared/crypto.js";
import { createFilesystemIdentity } from "../../src/shared/filesystem-identity.js";

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
  assert.deepEqual(result.unavailableTerminalPaths, [{
    path: "terminal.txt",
    reason: "bounded_out",
  }]);
  assert.equal(result.unavailableTerminalPathCount, 1);
  assert.equal(result.omittedTerminalPathCount, 1);
  assert.equal(result.artifactOmittedTerminalPathCount, 0);
});

test("mixed session diff keeps the earliest trustworthy baseline across mutation orderings", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-mixed-session-diff-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  await writeFile(path.join(root, "patch-first.txt"), "patch first base\n");
  await writeFile(path.join(root, "terminal-first.txt"), "terminal first base\n");
  await writeFile(path.join(root, "repeat.txt"), "repeat base\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "checkpoints"),
  );

  const patchFirst = await checkpoints.createCheckpoint(["patch-first.txt"]);
  await writeFile(path.join(root, "patch-first.txt"), "patch intermediate\n");
  await writeFile(path.join(root, "patch-first.txt"), "patch then terminal final\n");

  await writeFile(path.join(root, "terminal-first.txt"), "terminal intermediate\n");
  const terminalFirstPatch = await checkpoints.createCheckpoint(["terminal-first.txt"]);
  await writeFile(path.join(root, "terminal-first.txt"), "terminal then patch final\n");

  await writeFile(path.join(root, "repeat.txt"), "repeat intermediate\n");
  await writeFile(path.join(root, "repeat.txt"), "repeat final\n");
  await writeFile(path.join(root, "created.txt"), "created final\n");

  const resolverCalls: string[] = [];
  const inspector = new SnapshotDiffInspector(boundary, checkpoints, {
    resolveTerminalBeforeImage: async (mutation, repositoryRelativePath) => {
      resolverCalls.push(`${mutation.operationId}:${repositoryRelativePath}`);
      if (mutation.operationId === "op_created") {
        return absentBaseline(mutation.operationId, repositoryRelativePath);
      }
      const content =
        mutation.operationId === "op_terminal_first"
          ? "terminal first base\n"
          : "repeat base\n";
      return presentBaseline(
        mutation.operationId,
        repositoryRelativePath,
        content,
      );
    },
  });
  const result = await inspector.diffSession([
    { checkpointId: patchFirst.id, changedPaths: ["patch-first.txt"] },
    {
      kind: "terminal",
      operationId: "op_after_patch",
      changedPaths: ["patch-first.txt"],
    },
    {
      kind: "terminal",
      operationId: "op_terminal_first",
      changedPaths: ["terminal-first.txt"],
    },
    {
      checkpointId: terminalFirstPatch.id,
      changedPaths: ["terminal-first.txt"],
    },
    {
      kind: "terminal",
      operationId: "op_repeat_first",
      changedPaths: ["repeat.txt"],
    },
    {
      kind: "terminal",
      operationId: "op_repeat_second",
      changedPaths: ["repeat.txt"],
    },
    {
      kind: "terminal",
      operationId: "op_created",
      changedPaths: ["created.txt"],
    },
  ]);

  assert.deepEqual(resolverCalls, [
    "op_created:created.txt",
    "op_repeat_first:repeat.txt",
    "op_terminal_first:terminal-first.txt",
  ]);
  assert.equal(result.comparedFileCount, 4);
  assert.match(result.diff, /-patch first base/u);
  assert.match(result.diff, /-terminal first base/u);
  assert.match(result.diff, /-repeat base/u);
  assert.match(result.diff, /\+created final/u);
  assert.doesNotMatch(result.diff, /patch intermediate|terminal intermediate|repeat intermediate/u);
});

test("pathless non-clean terminal evidence prevents later patch baseline laundering", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-pathless-terminal-diff-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  await writeFile(path.join(root, "target.txt"), "after terminal\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "checkpoints"),
  );
  const laterPatch = await checkpoints.createCheckpoint(["target.txt"]);
  await writeFile(path.join(root, "target.txt"), "after patch\n");

  for (const outcome of [
    "unknown",
    "protected_or_hidden_changed",
  ] as const) {
    const operationId = `op_pathless_${outcome}`;
    const resolverCalls: string[] = [];
    const result = await new SnapshotDiffInspector(boundary, checkpoints, {
      resolveTerminalBeforeImage: async (
        mutation,
        repositoryRelativePath,
      ) => {
        resolverCalls.push(
          `${mutation.operationId}:${repositoryRelativePath}`,
        );
        return {
          available: false,
          reason: "unknown_observation",
        };
      },
    }).diffSession([
      {
        kind: "terminal",
        operationId,
        changedPaths: [],
        observationOutcome: outcome,
        changedPathCount: 0,
        pathFactsTruncated: false,
      },
      {
        checkpointId: laterPatch.id,
        changedPaths: ["target.txt"],
      },
    ]);

    assert.deepEqual(resolverCalls, [`${operationId}:target.txt`]);
    assert.equal(result.comparedFileCount, 0);
    assert.equal(result.changedFileCount, 0);
    assert.deepEqual(result.unavailableTerminalPaths, [{
      path: "target.txt",
      reason: "unknown_observation",
    }]);
    assert.equal(result.unavailableTerminalPathCount, 1);
    assert.equal(result.omittedTerminalPathCount, 0);
    assert.equal(result.diff, "");
  }
});

test("omitted terminal path facts prevent later patch baseline laundering", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-omitted-terminal-diff-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  await writeFile(path.join(root, "target.txt"), "after terminal\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "checkpoints"),
  );
  const laterPatch = await checkpoints.createCheckpoint(["target.txt"]);
  await writeFile(path.join(root, "target.txt"), "after patch\n");

  const resolverCalls: string[] = [];
  const result = await new SnapshotDiffInspector(boundary, checkpoints, {
    resolveTerminalBeforeImage: async (
      mutation,
      repositoryRelativePath,
    ) => {
      resolverCalls.push(
        `${mutation.operationId}:${repositoryRelativePath}`,
      );
      return presentBaseline(
        mutation.operationId,
        repositoryRelativePath,
        "unsafe post-terminal bytes\n",
      );
    },
  }).diffSession(
    [
      {
        kind: "terminal",
        operationId: "op_terminal_omitted",
        changedPaths: ["retained-other.txt"],
        observationOutcome: "observed",
        changedPathCount: 2,
        pathFactsTruncated: true,
      },
      {
        checkpointId: laterPatch.id,
        changedPaths: ["target.txt"],
      },
    ],
    { paths: ["target.txt"] },
  );

  assert.deepEqual(resolverCalls, [
    "op_terminal_omitted:target.txt",
  ]);
  assert.equal(result.comparedFileCount, 0);
  assert.equal(result.changedFileCount, 0);
  assert.deepEqual(result.unavailableTerminalPaths, [{
    path: "target.txt",
    reason: "bounded_out",
  }]);
  assert.equal(result.unavailableTerminalPathCount, 2);
  assert.equal(result.omittedTerminalPathCount, 1);
  assert.equal(result.artifactOmittedTerminalPathCount, 1);
  assert.equal(result.diff, "");
});

test("terminal rename endpoints are included even when changedPaths retains only one endpoint", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-terminal-rename-diff-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  await writeFile(path.join(root, "renamed.txt"), "renamed after\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "checkpoints"),
  );
  const result = await new SnapshotDiffInspector(boundary, checkpoints, {
    resolveTerminalBeforeImage: async (mutation, repositoryRelativePath) =>
      repositoryRelativePath === "original.txt"
        ? presentBaseline(mutation.operationId, repositoryRelativePath, "original before\n")
        : absentBaseline(mutation.operationId, repositoryRelativePath),
  }).diffSession([{
    kind: "terminal",
    operationId: "op_rename",
    changedPaths: ["renamed.txt"],
    renamedPaths: [{ from: "original.txt", to: "renamed.txt" }],
    changedPathCount: 2,
    pathFactsTruncated: false,
  }]);

  assert.equal(result.comparedFileCount, 2);
  assert.match(result.diff, /original\.txt/u);
  assert.match(result.diff, /deleted file mode/u);
  assert.match(result.diff, /renamed\.txt/u);
  assert.match(result.diff, /new file mode/u);
  assert.equal(result.omittedTerminalPathCount, 0);
});

test("case-only rename retains exact endpoints and cannot collapse to a clean alias diff", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-case-only-rename-diff-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  await writeFile(path.join(root, "readme.md"), "same bytes\n");
  const metadata = await stat(root);
  const boundary = await RepositoryBoundary.create(
    root,
    createFilesystemIdentity({
      device: metadata.dev,
      caseSensitive: false,
      unicodeNormalizationAliases: true,
    }),
  );
  const checkpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "checkpoints"),
  );
  const mutation = {
    kind: "terminal" as const,
    operationId: "op_case_rename",
    // Session changedPaths may collapse filesystem aliases; the explicit
    // rename still retains both exact endpoint spellings.
    changedPaths: ["readme.md"],
    renamedPaths: [{ from: "README.md", to: "readme.md" }],
    changedPathCount: 2,
    pathFactsTruncated: false,
  };
  const calls: string[] = [];
  const result = await new SnapshotDiffInspector(boundary, checkpoints, {
    resolveTerminalBeforeImage: async (terminal, repositoryRelativePath) => {
      calls.push(repositoryRelativePath);
      return repositoryRelativePath === "README.md"
        ? presentBaseline(terminal.operationId, repositoryRelativePath, "same bytes\n")
        : absentBaseline(terminal.operationId, repositoryRelativePath);
    },
  }).diffSession([mutation]);

  assert.deepEqual(calls, ["README.md", "readme.md"]);
  assert.equal(result.comparedFileCount, 2);
  assert.equal(result.changedFileCount, 2);
  assert.equal(result.unavailableTerminalPathCount, 0);
  assert.equal(result.omittedTerminalPathCount, 0);
  assert.match(result.diff, /diff --git a\/README\.md b\/README\.md/u);
  assert.match(result.diff, /deleted file mode/u);
  assert.match(result.diff, /diff --git a\/readme\.md b\/readme\.md/u);
  assert.match(result.diff, /new file mode/u);

  const unavailable = await new SnapshotDiffInspector(boundary, checkpoints, {
    resolveTerminalBeforeImage: async (terminal, repositoryRelativePath) =>
      repositoryRelativePath === "README.md"
        ? { available: false, reason: "missing_evidence" }
        : absentBaseline(terminal.operationId, repositoryRelativePath),
  }).diffSession([mutation]);
  assert.equal(unavailable.changedFileCount, 1);
  assert.equal(unavailable.unavailableTerminalPathCount, 1);
  assert.deepEqual(unavailable.unavailableTerminalPaths, [{
    path: "README.md",
    reason: "missing_evidence",
  }]);

  await assert.rejects(
    () => new SnapshotDiffInspector(boundary, checkpoints, {
      resolveTerminalBeforeImage: async (terminal, repositoryRelativePath) =>
        repositoryRelativePath === "README.md"
          ? presentBaseline(terminal.operationId, repositoryRelativePath, "same bytes\n")
          : absentBaseline(terminal.operationId, repositoryRelativePath),
    }).diffSession([{
      ...mutation,
      changedPathCount: 1,
    }]),
    (error: { code?: string }) => error.code === "RECOVERY_REQUIRED",
  );
});

test("pathless non-clean evidence forces later alias endpoints unavailable", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-pathless-alias-diff-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  await writeFile(path.join(root, "readme.md"), "same bytes\n");
  const metadata = await stat(root);
  const boundary = await RepositoryBoundary.create(
    root,
    createFilesystemIdentity({
      device: metadata.dev,
      caseSensitive: false,
      unicodeNormalizationAliases: true,
    }),
  );
  const checkpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "checkpoints"),
  );
  const resolverCalls: string[] = [];
  const result = await new SnapshotDiffInspector(boundary, checkpoints, {
    resolveTerminalBeforeImage: async (
      mutation,
      repositoryRelativePath,
    ) => {
      assert.equal(
        mutation.operationId,
        "op_pathless_unknown",
        "both alias endpoints must validate the earlier non-clean source",
      );
      resolverCalls.push(repositoryRelativePath);
      return presentBaseline(
        mutation.operationId,
        repositoryRelativePath,
        "same bytes\n",
      );
    },
  }).diffSession([
    {
      kind: "terminal",
      operationId: "op_pathless_unknown",
      changedPaths: [],
      observationOutcome: "unknown",
      changedPathCount: 0,
      pathFactsTruncated: false,
    },
    {
      kind: "terminal",
      operationId: "op_alias_after_pathless",
      changedPaths: ["readme.md"],
      observationOutcome: "observed",
      renamedPaths: [{ from: "README.md", to: "readme.md" }],
      changedPathCount: 2,
      pathFactsTruncated: false,
    },
  ]);

  assert.deepEqual(resolverCalls, ["README.md", "readme.md"]);
  assert.equal(result.comparedFileCount, 0);
  assert.equal(result.changedFileCount, 0);
  assert.deepEqual(result.unavailableTerminalPaths, [
    {
      path: "README.md",
      reason: "unknown_observation",
    },
    {
      path: "readme.md",
      reason: "unknown_observation",
    },
  ]);
  assert.equal(result.unavailableTerminalPathCount, 2);
  assert.equal(result.diff, "");
});

test("an earlier patch baseline survives pathless evidence before a later alias rename", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-patch-pathless-alias-diff-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  await writeFile(path.join(root, "README.md"), "session base\n");
  const metadata = await stat(root);
  const boundary = await RepositoryBoundary.create(
    root,
    createFilesystemIdentity({
      device: metadata.dev,
      caseSensitive: false,
      unicodeNormalizationAliases: true,
    }),
  );
  const checkpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "checkpoints"),
  );
  const earlierPatch = await checkpoints.createCheckpoint([
    "README.md",
  ]);
  await rm(path.join(root, "README.md"));
  await writeFile(path.join(root, "readme.md"), "rename final\n");

  const resolverCalls: string[] = [];
  const result = await new SnapshotDiffInspector(boundary, checkpoints, {
    resolveTerminalBeforeImage: async (
      mutation,
      repositoryRelativePath,
    ) => {
      resolverCalls.push(
        `${mutation.operationId}:${repositoryRelativePath}`,
      );
      assert.equal(mutation.operationId, "op_alias_after_patch");
      assert.equal(repositoryRelativePath, "readme.md");
      return absentBaseline(
        mutation.operationId,
        repositoryRelativePath,
      );
    },
  }).diffSession([
    {
      checkpointId: earlierPatch.id,
      changedPaths: ["README.md"],
    },
    {
      kind: "terminal",
      operationId: "op_pathless_after_patch",
      changedPaths: [],
      observationOutcome: "unknown",
      changedPathCount: 0,
      pathFactsTruncated: false,
    },
    {
      kind: "terminal",
      operationId: "op_alias_after_patch",
      changedPaths: ["readme.md"],
      observationOutcome: "observed",
      renamedPaths: [{ from: "README.md", to: "readme.md" }],
      changedPathCount: 2,
      pathFactsTruncated: false,
    },
  ]);

  assert.deepEqual(resolverCalls, [
    "op_alias_after_patch:readme.md",
  ]);
  assert.equal(result.comparedFileCount, 2);
  assert.equal(result.changedFileCount, 2);
  assert.equal(result.unavailableTerminalPathCount, 0);
  assert.match(result.diff, /diff --git a\/README\.md b\/README\.md/u);
  assert.match(result.diff, /deleted file mode/u);
  assert.match(result.diff, /-session base/u);
  assert.match(result.diff, /diff --git a\/readme\.md b\/readme\.md/u);
  assert.match(result.diff, /new file mode/u);
  assert.match(result.diff, /\+rename final/u);
});

test("pathKey aliases preserve the first mutation and deterministic UTF-8 session ordering", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-terminal-alias-diff-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  await writeFile(path.join(root, "Case.txt"), "case final\n");
  await writeFile(path.join(root, "\u00e9.txt"), "unicode final\n");
  await writeFile(path.join(root, "z.txt"), "z final\n");
  const metadata = await stat(root);
  const boundary = await RepositoryBoundary.create(
    root,
    createFilesystemIdentity({
      device: metadata.dev,
      caseSensitive: false,
      unicodeNormalizationAliases: true,
    }),
  );
  const checkpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "checkpoints"),
  );
  const calls: string[] = [];
  const result = await new SnapshotDiffInspector(boundary, checkpoints, {
    resolveTerminalBeforeImage: async (mutation, repositoryRelativePath) => {
      calls.push(mutation.operationId);
      return presentBaseline(
        mutation.operationId,
        repositoryRelativePath,
        `${repositoryRelativePath} before\n`,
      );
    },
  }).diffSession([
    {
      kind: "terminal",
      operationId: "op_case_first",
      changedPaths: ["Case.txt"],
    },
    {
      kind: "terminal",
      operationId: "op_case_alias",
      changedPaths: ["case.txt"],
    },
    {
      kind: "terminal",
      operationId: "op_unicode_first",
      changedPaths: ["\u00e9.txt"],
    },
    {
      kind: "terminal",
      operationId: "op_unicode_alias",
      changedPaths: ["e\u0301.txt"],
    },
    {
      kind: "terminal",
      operationId: "op_z",
      changedPaths: ["z.txt"],
    },
  ]);

  assert.deepEqual(calls, ["op_case_first", "op_z", "op_unicode_first"]);
  assert.equal(result.comparedFileCount, 3);
  assert.equal(result.diff.indexOf("z.txt") < result.diff.indexOf("\u00e9.txt"), true);
});

test("terminal resolver snapshots fail closed on every malformed invariant", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-terminal-invalid-baseline-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  await writeFile(path.join(root, "target.txt"), "after\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "checkpoints"),
  );
  const valid = presentBaseline("op_invalid", "target.txt", "before\n");
  const invalid: readonly unknown[] = [
    { ...valid, baselineId: "" },
    { ...valid, baselineId: "bad\0baseline" },
    { ...valid, entry: { ...valid.entry, path: "other.txt" } },
    { ...valid, entry: { ...valid.entry, existed: false } },
    { ...valid, entry: { ...valid.entry, bytes: null } },
    { ...valid, entry: { ...valid.entry, bytes: new Uint8Array([1]) } },
    { ...valid, entry: { ...valid.entry, mode: null } },
    { ...valid, entry: { ...valid.entry, mode: 0o200000 } },
    { ...valid, entry: { ...valid.entry, sha256: "f".repeat(64) } },
    {
      available: false,
      reason: "invented",
    },
  ];
  for (const resolution of invalid) {
    const inspector = new SnapshotDiffInspector(boundary, checkpoints, {
      resolveTerminalBeforeImage: async () => resolution as never,
    });
    await assert.rejects(
      () => inspector.diffSession([{
        kind: "terminal",
        operationId: "op_invalid",
        changedPaths: ["target.txt"],
      }]),
      (error: { code?: string }) => error.code === "RECOVERY_REQUIRED",
    );
  }
  await assert.rejects(
    () => new SnapshotDiffInspector(boundary, checkpoints, {
      resolveTerminalBeforeImage: async () => {
        throw new Error("integrity chain failed");
      },
    }).diffSession([{
      kind: "terminal",
      operationId: "op_invalid",
      changedPaths: ["target.txt"],
    }]),
    (error: { code?: string }) => error.code === "RECOVERY_REQUIRED",
  );
});

test("legacy terminal evidence limitations remain explicit per path", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-terminal-limitations-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "checkpoints"),
  );
  const reasons = [
    "legacy_placeholder",
    "missing_evidence",
    "bounded_out",
    "unknown_observation",
  ] as const;
  const result = await new SnapshotDiffInspector(boundary, checkpoints, {
    resolveTerminalBeforeImage: async (_mutation, repositoryRelativePath) => ({
      available: false,
      reason: reasons[Number(repositoryRelativePath.slice(0, 1))]!,
    }),
  }).diffSession([{
    kind: "terminal",
    operationId: "op_limitations",
    changedPaths: reasons.map((_reason, index) => `${index}-path.txt`),
  }]);
  assert.equal(result.unavailableTerminalPathCount, 4);
  assert.deepEqual(
    result.unavailableTerminalPaths?.map((fact) => fact.reason),
    reasons,
  );
  assert.equal(result.omittedTerminalPathCount, 0);
});

test("terminal retained-path totals reject incomplete or contradictory truncation evidence", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-terminal-path-totals-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "checkpoints"),
  );
  const invalid = [
    {
      pathFactsTruncated: true,
    },
    {
      changedPathCount: 0,
      pathFactsTruncated: true,
    },
    {
      changedPathCount: 2,
      pathFactsTruncated: false,
    },
  ] as const;
  for (const facts of invalid) {
    await assert.rejects(
      () => new SnapshotDiffInspector(boundary, checkpoints, {
        resolveTerminalBeforeImage: async () => ({
          available: false,
          reason: "bounded_out",
        }),
      }).diffSession([{
        kind: "terminal",
        operationId: "op_invalid_totals",
        changedPaths: ["one.txt"],
        ...facts,
      }]),
      (error: { code?: string }) => error.code === "RECOVERY_REQUIRED",
    );
  }
});

test("terminal bounds retain healthy diffs and report exact unavailable and omitted totals", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-terminal-diff-limits-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  await writeFile(path.join(root, "patch.txt"), "patch before\n");
  await writeFile(path.join(root, "a-terminal.txt"), "terminal after\n");
  await writeFile(path.join(root, "z-omitted.txt"), "omitted after\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "checkpoints"),
  );
  const checkpoint = await checkpoints.createCheckpoint(["patch.txt"]);
  await writeFile(path.join(root, "patch.txt"), "patch after\n");
  const result = await new SnapshotDiffInspector(boundary, checkpoints, {
    maxFiles: 2,
    resolveTerminalBeforeImage: async (mutation, repositoryRelativePath) =>
      presentBaseline(mutation.operationId, repositoryRelativePath, "terminal before\n"),
  }).diffSession([
    { checkpointId: checkpoint.id, changedPaths: ["patch.txt"] },
    {
      kind: "terminal",
      operationId: "op_bounded",
      changedPaths: ["a-terminal.txt", "z-omitted.txt"],
      changedPathCount: 4,
      pathFactsTruncated: true,
    },
  ]);

  assert.match(result.diff, /patch\.txt/u);
  assert.match(result.diff, /a-terminal\.txt/u);
  assert.doesNotMatch(result.diff, /z-omitted\.txt/u);
  assert.equal(result.comparedFileCount, 2);
  assert.equal(result.artifactOmittedTerminalPathCount, 2);
  assert.equal(result.omittedTerminalPathCount, 3);
  assert.equal(result.unavailableTerminalPathCount, 3);
  assert.deepEqual(result.unavailableTerminalPaths, [{
    path: "z-omitted.txt",
    reason: "bounded_out",
  }]);
});

test("terminal aggregate-input overflow omits only affected paths and patch-only overflow remains fatal", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-terminal-input-limit-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  await writeFile(path.join(root, "patch.txt"), "p-after\n");
  await writeFile(path.join(root, "a-large.txt"), "L".repeat(30));
  await writeFile(path.join(root, "z-small.txt"), "s-after\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "checkpoints"),
  );
  const patchCheckpoint = await checkpoints.createCheckpoint(["patch.txt"]);
  await writeFile(path.join(root, "patch.txt"), "p-final\n");
  const inspector = new SnapshotDiffInspector(boundary, checkpoints, {
    maxFileBytes: 64,
    maxInputBytes: 50,
    resolveTerminalBeforeImage: async (mutation, repositoryRelativePath) =>
      presentBaseline(
        mutation.operationId,
        repositoryRelativePath,
        repositoryRelativePath === "a-large.txt" ? "B".repeat(30) : "s-before\n",
      ),
  });
  const result = await inspector.diffSession([
    { checkpointId: patchCheckpoint.id, changedPaths: ["patch.txt"] },
    {
      kind: "terminal",
      operationId: "op_input",
      changedPaths: ["a-large.txt", "z-small.txt"],
    },
  ]);
  assert.match(result.diff, /patch\.txt/u);
  assert.match(result.diff, /z-small\.txt/u);
  assert.doesNotMatch(result.diff, /a-large\.txt/u);
  assert.equal(result.omittedTerminalPathCount, 1);
  assert.equal(result.unavailableTerminalPathCount, 1);
  assert.deepEqual(result.unavailableTerminalPaths, [{
    path: "a-large.txt",
    reason: "bounded_out",
  }]);

  await assert.rejects(
    () => new SnapshotDiffInspector(boundary, checkpoints, {
      maxInputBytes: 1,
    }).diffSession([
      { checkpointId: patchCheckpoint.id, changedPaths: ["patch.txt"] },
    ]),
    (error: { code?: string }) => error.code === "BUDGET_EXCEEDED",
  );
});

test("unavailable samples are bounded by UTF-8 bytes as well as endpoint count", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-terminal-sample-bound-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "checkpoints"),
  );
  const longPath = (prefix: string): string => {
    const segments = Array.from({ length: 125 }, (_, index) =>
      `${prefix}${index.toString().padStart(3, "0")}${"x".repeat(246)}`);
    return segments.join("/");
  };
  const paths = [longPath("a"), longPath("b"), longPath("c")];
  const result = await new SnapshotDiffInspector(boundary, checkpoints, {
    resolveTerminalBeforeImage: async () => ({
      available: false,
      reason: "missing_evidence",
    }),
  }).diffSession([{
    kind: "terminal",
    operationId: "op_long_paths",
    changedPaths: paths,
  }]);
  assert.equal(result.unavailableTerminalPathCount, 3);
  assert.equal((result.unavailableTerminalPaths?.length ?? 0) < 3, true);
  assert.equal(
    Buffer.byteLength(JSON.stringify(result.unavailableTerminalPaths)) <= 64 * 1024,
    true,
  );

  const many = await new SnapshotDiffInspector(boundary, checkpoints, {
    maxFiles: 400,
    resolveTerminalBeforeImage: async () => ({
      available: false,
      reason: "missing_evidence",
    }),
  }).diffSession([{
    kind: "terminal",
    operationId: "op_many_paths",
    changedPaths: Array.from(
      { length: 300 },
      (_, index) => `short-${index.toString().padStart(3, "0")}.txt`,
    ),
  }]);
  assert.equal(many.unavailableTerminalPathCount, 300);
  assert.equal(many.unavailableTerminalPaths?.length, 256);
});

test("session diff cancellation and source filtering do not resolve or disclose hidden terminal paths", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-terminal-filter-cancel-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "checkpoints"),
  );
  let calls = 0;
  const inspector = new SnapshotDiffInspector(boundary, checkpoints, {
    isPathAllowed: (candidate) => candidate !== "hidden.txt",
    resolveTerminalBeforeImage: async () => {
      calls += 1;
      return {
        available: false,
        reason: "missing_evidence",
      };
    },
  });
  const filtered = await inspector.diffSession([{
    kind: "terminal",
    operationId: "op_hidden",
    changedPaths: ["hidden.txt"],
  }]);
  assert.equal(calls, 0);
  assert.equal(filtered.excludedCount, 1);
  assert.equal(filtered.diff.includes("hidden.txt"), false);
  assert.deepEqual(filtered.unavailableTerminalPaths, []);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => inspector.diffSession([{
      kind: "terminal",
      operationId: "op_cancelled",
      changedPaths: ["visible.txt"],
    }], {}, controller.signal),
    (error: { code?: string }) => error.code === "COMMAND_CANCELLED",
  );
  assert.equal(calls, 0);

  const during = new AbortController();
  await assert.rejects(
    () => new SnapshotDiffInspector(boundary, checkpoints, {
      resolveTerminalBeforeImage: async () => {
        during.abort();
        return absentBaseline("op_cancelled_during", "visible.txt");
      },
    }).diffSession([{
      kind: "terminal",
      operationId: "op_cancelled_during",
      changedPaths: ["visible.txt"],
    }], {}, during.signal),
    (error: { code?: string }) => error.code === "COMMAND_CANCELLED",
  );
});

test("checkpoint-scope diff retains its legacy byte format", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-checkpoint-compatible-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  await writeFile(path.join(root, "sample.txt"), "before\n");
  const boundary = await RepositoryBoundary.create(root);
  const checkpoints = await CheckpointStore.create(
    boundary,
    path.join(temporary, "checkpoints"),
  );
  const checkpoint = await checkpoints.createCheckpoint(["sample.txt"]);
  await writeFile(path.join(root, "sample.txt"), "after\n");
  const result = await new SnapshotDiffInspector(
    boundary,
    checkpoints,
  ).diffCheckpoint(checkpoint.id);
  assert.equal(
    result.diff,
    "diff --git a/sample.txt b/sample.txt\n" +
      "--- a/sample.txt\n" +
      "+++ b/sample.txt\n" +
      "@@ -1,1 +1,1 @@\n" +
      "-before\n" +
      "+after\n",
  );
});

function presentBaseline(
  operationId: string,
  repositoryRelativePath: string,
  content: string,
) {
  const bytes = Buffer.from(content);
  return {
    available: true as const,
    baselineId: `terminal:${operationId}:pre`,
    entry: {
      path: repositoryRelativePath,
      existed: true,
      bytes,
      mode: 0o100644,
      sha256: sha256(bytes),
    },
  };
}

function absentBaseline(
  operationId: string,
  repositoryRelativePath: string,
) {
  return {
    available: true as const,
    baselineId: `terminal:${operationId}:pre`,
    entry: {
      path: repositoryRelativePath,
      existed: false,
      bytes: null,
      mode: null,
      sha256: null,
    },
  };
}
