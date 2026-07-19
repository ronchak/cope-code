import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentError } from "../../src/shared/errors.js";
import { RepositoryBoundary } from "../../src/repository/boundary.js";
import { CheckpointStore } from "../../src/repository/checkpoint.js";
import { PatchEngine } from "../../src/repository/patch-engine.js";
import {
  createFilesystemIdentity,
  detectFilesystemIdentity,
  probeFilesystemIdentity,
} from "../../src/shared/filesystem-identity.js";
import { ProtectedPathPolicy } from "../../src/security/protected-paths.js";
import { RepositoryTools } from "../../src/repository/repository-tools.js";
import { SnapshotDiffInspector } from "../../src/repository/snapshot-diff.js";

test("filesystem identity keys follow observed case and Unicode alias behavior", () => {
  const sensitive = createFilesystemIdentity({
    device: 1,
    caseSensitive: true,
    unicodeNormalizationAliases: false,
  });
  assert.notEqual(sensitive.pathKey("SRC/CAFÉ.ts"), sensitive.pathKey("src/cafe\u0301.ts"));

  const aliasing = createFilesystemIdentity({
    device: 2,
    caseSensitive: false,
    unicodeNormalizationAliases: true,
  });
  assert.equal(aliasing.pathKey("SRC/CAFÉ.ts"), aliasing.pathKey("src/cafe\u0301.ts"));
  assert.equal(aliasing.pathKey("src\\app.ts"), "src/app.ts");

  for (const [caseSensitive, unicodeNormalizationAliases] of [
    [true, false],
    [true, true],
    [false, false],
    [false, true],
  ] as const) {
    const identity = createFilesystemIdentity({
      device: 10 + Number(caseSensitive) + 2 * Number(unicodeNormalizationAliases),
      caseSensitive,
      unicodeNormalizationAliases,
    });
    assert.equal(identity.pathKey("A") === identity.pathKey("a"), !caseSensitive);
    assert.equal(
      identity.pathKey("café") === identity.pathKey("cafe\u0301"),
      unicodeNormalizationAliases,
    );
  }
});

test("filesystem identity is probed on the repository volume and rejects device mismatches", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cope-fs-identity-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const repository = path.join(temporary, "repo");
  await mkdir(path.join(repository, "src"), { recursive: true });
  const metadata = await stat(repository);
  const identity = await detectFilesystemIdentity(repository);
  assert.equal(identity.device, metadata.dev);
  assert.equal(identity.pathKey("a\\b"), identity.pathKey("a/b"));
  const before = await readdir(temporary);
  const uncachedProbe = await probeFilesystemIdentity(temporary, metadata.dev);
  const after = await readdir(temporary);
  assert.equal(uncachedProbe.device, metadata.dev);
  assert.deepEqual(after, before);
  assert.equal(after.some((entry) => entry.startsWith(".cope-fs-identity-")), false);

  const mismatched = createFilesystemIdentity({
    device: metadata.dev + 1,
    caseSensitive: true,
    unicodeNormalizationAliases: false,
  });
  await assert.rejects(
    RepositoryBoundary.create(repository, mismatched),
    (error: unknown) =>
      error instanceof AgentError &&
      error.details.diagnosticCode === "FILESYSTEM_IDENTITY_DEVICE_MISMATCH",
  );
  const boundary = await RepositoryBoundary.create(repository, identity);
  assert.throws(
    () => boundary.assertDevice(metadata.dev + 1, "mounted/path"),
    (error: unknown) =>
      error instanceof AgentError &&
      error.details.diagnosticCode === "REPOSITORY_DEVICE_TRANSITION",
  );
});

test("case and Unicode aliases cannot bypass duplicate or protected-path checks", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cope-fs-alias-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const repository = path.join(temporary, "repo");
  await mkdir(path.join(repository, "src"), { recursive: true });
  const device = (await stat(repository)).dev;
  const identity = createFilesystemIdentity({
    device,
    caseSensitive: false,
    unicodeNormalizationAliases: true,
  });
  const boundary = await RepositoryBoundary.create(repository, identity);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const policy = new ProtectedPathPolicy([], true, identity);
  const patches = new PatchEngine(boundary, checkpoints, policy);

  await assert.rejects(
    patches.applyPatch({
      changes: [
        { kind: "create", path: "src/App.ts", content: "one\n" },
        { kind: "create", path: "src/app.ts", content: "two\n" },
      ],
    }),
    (error: unknown) => error instanceof AgentError && error.code === "PROTOCOL_INVALID",
  );
  await assert.rejects(
    checkpoints.createCheckpoint(["src/App.ts", "src/app.ts"]),
    (error: unknown) => error instanceof AgentError && error.code === "PROTOCOL_INVALID",
  );
  assert.throws(
    () => policy.assertAllowed(".GIT/config", "update"),
    (error: unknown) => error instanceof AgentError && error.code === "PATH_PROTECTED",
  );

  await writeFile(path.join(repository, "src", "App.ts"), "before\n");
  const checkpoint = await checkpoints.createCheckpoint(["src/App.ts"]);
  await writeFile(path.join(repository, "src", "App.ts"), "after\n");
  const diff = await new SnapshotDiffInspector(boundary, checkpoints).diffSession([
    {
      checkpointId: checkpoint.id,
      changedPaths: ["src/App.ts", "src/app.ts"],
    },
  ]);
  assert.equal(diff.comparedFileCount, 1);
  assert.equal(diff.changedFileCount, 1);

  const unicodePolicy = new ProtectedPathPolicy(
    [{ pattern: "secrets/café.txt" }],
    false,
    identity,
  );
  assert.throws(
    () => unicodePolicy.assertAllowed("SECRETS/cafe\u0301.txt", "read"),
    (error: unknown) => error instanceof AgentError && error.code === "PATH_PROTECTED",
  );

  const ignoredName = `cafe\u0301.txt`;
  await mkdir(path.join(repository, "secrets"));
  await writeFile(path.join(repository, "secrets", ignoredName), "hidden\n");
  const tools = await RepositoryTools.create(boundary, {
    extraIgnorePatterns: ["SECRETS/CAFÉ.txt"],
  });
  const listing = await tools.listFiles({ maxDepth: 2 });
  assert.equal(listing.entries.some((entry) => entry.path.includes(ignoredName)), false);
});
