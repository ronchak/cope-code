import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { AgentError } from "../../src/shared/errors.js";
import { sha256 } from "../../src/shared/crypto.js";
import {
  DEFAULT_ORGANIZATION_POLICY,
  DEFAULT_REPOSITORY_POLICY,
  PolicyEngine,
  createDefaultSessionGrant,
  zeroPolicyBudgetUsage,
  type PolicyDocument,
} from "../../src/policy/index.js";
import { LayeredRuntimePolicy } from "../../src/orchestrator/runtime-policy.js";
import { DEFAULT_GIT_EXECUTABLE, RepositoryBoundary } from "../../src/repository/boundary.js";
import { RepositoryContext } from "../../src/repository/context.js";
import { GitInspector } from "../../src/repository/git.js";
import { RepositoryTools } from "../../src/repository/repository-tools.js";
import { CommandCatalog } from "../../src/tools/command-catalog.js";

const execFileAsync = promisify(execFile);

test("bounded repository tools honor ignores, file limits, ranges, state hashes, and literal search", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cba-repository-tools-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "dependency"), { recursive: true });
  await mkdir(path.join(root, "generated"), { recursive: true });
  await writeFile(path.join(root, ".gitignore"), "generated/\n!generated/allowed.ts\n!node_modules/**\n");
  const source = "first line\nneedle on second\nthird line\n";
  await writeFile(path.join(root, "src", "main.ts"), source);
  await writeFile(path.join(root, "src", "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(root, "src", "huge.txt"), "x".repeat(200));
  await writeFile(path.join(root, "node_modules", "dependency", "secret.ts"), "needle\n");
  await writeFile(path.join(root, "generated", "ignored.ts"), "needle\n");

  const boundary = await RepositoryBoundary.create(root);
  const disclosures: string[] = [];
  const tools = await RepositoryTools.create(boundary, {
    maxFileBytes: 128,
    maxReadBytes: 64,
    contentProcessor: {
      process: async (input) => {
        disclosures.push(`${input.source}:${input.path ?? ""}`);
        return { content: input.content.replaceAll("needle", "[MATCH]"), redactionCount: 1 };
      },
    },
  });

  const listing = await tools.listFiles({ maxDepth: 4, maxResults: 100 });
  assert.equal(listing.entries.some((entry) => entry.path.includes("node_modules")), false);
  assert.equal(listing.entries.some((entry) => entry.path.includes("generated")), false);
  assert.equal(listing.entries.some((entry) => entry.path === "src/huge.txt"), false);
  assert.equal(listing.excludedCount >= 3, true);

  const read = await tools.readFile({
    path: "src/main.ts",
    startLine: 2,
    endLine: 2,
    operationId: "read_1",
  });
  assert.equal(read.content, "[MATCH] on second");
  assert.equal(read.state.sha256, sha256(source));
  assert.equal(read.startLine, 2);
  assert.equal(read.endLine, 2);
  assert.equal(read.truncated, true);

  const search = await tools.searchText({
    query: "needle",
    path: "src",
    filePatterns: ["*.ts"],
    maxResults: 10,
    contextLines: 0,
    operationId: "search_1",
  });
  assert.equal(search.matches.length, 1);
  assert.equal(search.matches[0]?.path, "src/main.ts");
  assert.equal(search.matches[0]?.line, 2);
  assert.equal(search.matches[0]?.excerpt, "[MATCH] on second");
  assert.deepEqual(disclosures, ["repository-file:src/main.ts", "repository-search:src/main.ts"]);

  await assert.rejects(
    tools.readFile({ path: "src/binary.bin" }),
    (error: unknown) => error instanceof AgentError && error.code === "UNSUPPORTED_FILE",
  );
  await assert.rejects(
    tools.readFile({ path: "src/huge.txt" }),
    (error: unknown) => error instanceof AgentError && error.code === "BUDGET_EXCEEDED",
  );
  await assert.rejects(
    tools.readFile({ path: "node_modules/dependency/secret.ts" }),
    (error: unknown) => error instanceof AgentError && error.code === "UNSUPPORTED_FILE",
  );
  await assert.rejects(
    tools.readFile({ path: "src/main.ts", startLine: 999 }),
    (error: unknown) => error instanceof AgentError && error.code === "PROTOCOL_INVALID",
  );

  const bounded = await tools.listFiles({ maxDepth: 0, maxResults: 1 });
  assert.equal(bounded.entries.length, 1);
  assert.equal(bounded.truncated, true);

  const traversalBounded = await RepositoryTools.create(boundary, {
    maxTraversalEntries: 2,
    defaultExclusionOverrides: ["*.lock"],
  });
  const traversal = await traversalBounded.listFiles({ maxDepth: 6, maxResults: 100 });
  assert.equal(traversal.entries.length <= 2, true);
  assert.equal(traversal.truncated, true);
});

test("Git inspector uses fixed read-only operations and returns bounded structured state", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cba-git-tools-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["init", "--quiet", root]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "config", "user.name", "CBA Test"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "config", "user.email", "cba@example.invalid"]);
  await writeFile(path.join(root, "file with spaces.txt"), "before\n");
  await writeFile(path.join(root, ".env"), "password=beforesecretvalue\n");
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "add", "--", "file with spaces.txt", ".env"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "commit", "--quiet", "-m", "initial"]);
  await writeFile(path.join(root, "file with spaces.txt"), "after\n");
  await writeFile(path.join(root, ".env"), "password=aftersecretvalue1\n");
  await writeFile(path.join(root, "untracked.txt"), "new\n");

  const boundary = await RepositoryBoundary.create(root);
  const git = new GitInspector(boundary, { maxDiffBytes: 24 });
  const status = await git.status();
  assert.equal(typeof status.head, "string");
  assert.equal(status.entries.some((entry) => entry.path === "file with spaces.txt"), true);
  assert.equal(status.entries.some((entry) => entry.path === "untracked.txt"), true);

  const diff = await git.diff({ baseline: "worktree", paths: ["file with spaces.txt"] });
  assert.equal(diff.diff.includes("diff --git"), true);
  assert.equal(diff.outputBytes <= 24, true);
  assert.equal(diff.truncated, true);
  const filtered = await new GitInspector(boundary).diff({ baseline: "worktree" });
  assert.equal(filtered.diff.includes("aftersecretvalue1"), false);
  assert.equal(filtered.diff.includes("untracked.txt"), true);
  assert.equal(filtered.diff.includes("+new"), true);
  assert.equal(filtered.excludedCount, 1);
  await assert.rejects(
    git.diff({ paths: ["../outside"] }),
    (error: unknown) => error instanceof AgentError && error.code === "PATH_OUTSIDE_REPOSITORY",
  );
});

test("Git status fingerprint binds dirty bytes, branch, HEAD, and non-disclosing state markers", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cba-git-fingerprint-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["init", "--quiet", "--initial-branch=main", root]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "config", "user.name", "CBA Test"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "config", "user.email", "cba@example.invalid"]);
  await writeFile(path.join(root, "tracked.txt"), "base\n");
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "add", "--", "tracked.txt"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "commit", "--quiet", "-m", "initial"]);

  const git = new GitInspector(await RepositoryBoundary.create(root));
  await writeFile(path.join(root, "tracked.txt"), "opaque-value-one\n");
  await writeFile(path.join(root, "untracked.txt"), "untracked-one\n");
  const first = await git.status();
  const firstTracked = first.entries.find((entry) => entry.path === "tracked.txt");
  const firstUntracked = first.entries.find((entry) => entry.path === "untracked.txt");
  assert.equal(firstTracked?.worktreeStatus, "M");
  assert.match(firstTracked?.stateSha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.match(firstUntracked?.stateSha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(first).includes("opaque-value-one"), false);
  assert.equal(JSON.stringify(first).includes("untracked-one"), false);

  await writeFile(path.join(root, "tracked.txt"), "opaque-value-two\n");
  await writeFile(path.join(root, "untracked.txt"), "untracked-two\n");
  const sameLabelsDifferentBytes = await git.status();
  assert.equal(sameLabelsDifferentBytes.entries.find((entry) => entry.path === "tracked.txt")?.worktreeStatus, "M");
  assert.notEqual(sameLabelsDifferentBytes.snapshotSha256, first.snapshotSha256);

  await writeFile(path.join(root, ".env"), "SECRET=protected-one\n");
  const protectedBefore = await git.status();
  assert.equal(protectedBefore.entries.some((entry) => entry.path === ".env"), false);
  await writeFile(path.join(root, ".env"), "SECRET=protected-two\n");
  const protectedAfter = await git.status();
  assert.equal(protectedAfter.entries.some((entry) => entry.path === ".env"), false);
  assert.notEqual(protectedAfter.snapshotSha256, protectedBefore.snapshotSha256);

  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "switch", "--quiet", "-c", "feature"]);
  const differentBranch = await git.status();
  assert.equal(differentBranch.head, sameLabelsDifferentBytes.head);
  assert.notEqual(differentBranch.snapshotSha256, sameLabelsDifferentBytes.snapshotSha256);

  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "commit", "--quiet", "--allow-empty", "-m", "advance head"]);
  const differentHead = await git.status();
  assert.notEqual(differentHead.head, differentBranch.head);
  assert.notEqual(differentHead.snapshotSha256, differentBranch.snapshotSha256);

  await rm(path.join(root, "tracked.txt"));
  const deleted = await git.status();
  const deletion = deleted.entries.find((entry) => entry.path === "tracked.txt");
  assert.equal(deletion?.worktreeStatus, "D");
  assert.match(deletion?.stateSha256 ?? "", /^[a-f0-9]{64}$/u);
});

test("Git hidden-state fingerprint binds ignored credentials and untracked policy controls", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cba-git-hidden-integrity-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["init", "--quiet", "--initial-branch=main", root]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "config", "user.name", "CBA Test"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "config", "user.email", "cba@example.invalid"]);
  await writeFile(path.join(root, ".gitignore"), ".env\n.cba/\n");
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "add", "--", ".gitignore"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "commit", "--quiet", "-m", "initial"]);
  await mkdir(path.join(root, ".cba"));
  await writeFile(path.join(root, ".env"), "password=first-secret-value\n");
  await writeFile(path.join(root, ".cba", "repository.json"), "{\"revision\":1}\n");

  const git = new GitInspector(await RepositoryBoundary.create(root), {
    fingerprintKey: Buffer.alloc(32, 3),
  });
  const first = await git.status();
  assert.deepEqual(first.entries, []);
  assert.equal(first.excludedCount >= 2, true);

  await writeFile(path.join(root, ".env"), "password=second-secret-value\n");
  await writeFile(path.join(root, ".cba", "repository.json"), "{\"revision\":2}\n");
  const second = await git.status();
  assert.deepEqual(second.entries, []);
  assert.notEqual(second.excludedStateSha256, first.excludedStateSha256);
  assert.notEqual(second.snapshotSha256, first.snapshotSha256);
});

test("ordinary ignored build output is excluded from the completion fingerprint", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cba-git-ignored-output-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["init", "--quiet", "--initial-branch=main", root]);
  await writeFile(path.join(root, ".gitignore"), "coverage/\n");
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "add", "--", ".gitignore"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "-c", "user.name=CBA Test", "-c", "user.email=cba@example.invalid", "commit", "--quiet", "-m", "initial"]);

  const git = new GitInspector(await RepositoryBoundary.create(root), {
    fingerprintKey: Buffer.alloc(32, 7),
  });
  const before = await git.status();
  await mkdir(path.join(root, "coverage"));
  await writeFile(path.join(root, "coverage", "result.json"), "{}\n");
  const after = await git.status();

  assert.equal(after.snapshotSha256, before.snapshotSha256);
  assert.equal(after.excludedStateSha256, before.excludedStateSha256);
  assert.equal(after.excludedCount > before.excludedCount, true);
});

test("Git status reports a conflict even when its path is policy-hidden", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cba-git-hidden-conflict-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["init", "--quiet", "--initial-branch=main", root]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "config", "user.name", "CBA Test"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "config", "user.email", "cba@example.invalid"]);
  await writeFile(path.join(root, ".env"), "base\n");
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "add", "--", ".env"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "commit", "--quiet", "-m", "base"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "checkout", "--quiet", "-b", "other"]);
  await writeFile(path.join(root, ".env"), "other\n");
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "commit", "--quiet", "-am", "other"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "checkout", "--quiet", "main"]);
  await writeFile(path.join(root, ".env"), "main\n");
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "commit", "--quiet", "-am", "main"]);
  await assert.rejects(execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "merge", "other"]));

  const status = await new GitInspector(await RepositoryBoundary.create(root)).status();
  assert.equal(status.hasConflicts, true);
  assert.deepEqual(status.entries, []);
  assert.equal(status.excludedCount, 1);
});

test("Git status identifies unresolved conflicts for fail-closed completion", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cba-git-conflict-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["init", "--quiet", "--initial-branch=main", root]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "config", "user.name", "CBA Test"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "config", "user.email", "cba@example.invalid"]);
  await writeFile(path.join(root, "conflict.txt"), "base\n");
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "add", "--", "conflict.txt"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "commit", "--quiet", "-m", "base"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "switch", "--quiet", "-c", "left"]);
  await writeFile(path.join(root, "conflict.txt"), "left\n");
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "commit", "--quiet", "-am", "left"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "switch", "--quiet", "main"]);
  await writeFile(path.join(root, "conflict.txt"), "right\n");
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "commit", "--quiet", "-am", "right"]);
  await assert.rejects(execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "merge", "left"]));

  const status = await new GitInspector(await RepositoryBoundary.create(root)).status();
  assert.equal(status.hasConflicts, true);
  assert.equal(status.entries.some((entry) => entry.kind === "unmerged"), true);
});

test("Git inspection disables a repository-controlled fsmonitor command", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX hook fixture; Windows invocation hardening is covered by the same fixed Git override");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "cba-git-fsmonitor-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["init", "--quiet", root]);
  await writeFile(path.join(root, "tracked.txt"), "safe\n");
  const sentinel = path.join(root, "fsmonitor-was-executed");
  const hook = path.join(root, "malicious-fsmonitor.sh");
  await writeFile(hook, `#!/bin/sh\nprintf invoked > "${sentinel}"\nexit 0\n`);
  await chmod(hook, 0o700);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "config", "core.fsmonitor", hook]);

  const boundary = await RepositoryBoundary.create(root);
  const status = await new GitInspector(boundary).status();

  assert.equal(status.entries.some((entry) => entry.path === "tracked.txt"), true);
  await assert.rejects(access(sentinel), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("Git diff runs through a config-free shadow gitdir and cannot execute clean filters", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX filter fixture; the config-free shadow gitdir is platform-independent");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "cba-git-filter-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["init", "--quiet", root]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "config", "user.name", "CBA Test"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "config", "user.email", "cba@example.invalid"]);
  const sentinel = path.join(root, "filter-was-executed");
  const hook = path.join(root, "malicious-filter.sh");
  await writeFile(hook, `#!/bin/sh\nprintf invoked > "${sentinel}"\ncat\n`);
  await chmod(hook, 0o700);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "config", "filter.evil.clean", hook]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "config", "filter.evil.smudge", "cat"]);
  await writeFile(path.join(root, ".gitattributes"), "*.txt filter=evil\n");
  await writeFile(path.join(root, "tracked.txt"), "before\n");
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "add", "--", ".gitattributes", "tracked.txt"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "commit", "--quiet", "-m", "initial"]);
  await rm(sentinel, { force: true });
  await writeFile(path.join(root, "tracked.txt"), "after\n");

  const git = new GitInspector(await RepositoryBoundary.create(root));
  const diff = await git.diff({ baseline: "worktree", paths: ["tracked.txt"] });

  assert.equal(diff.diff.includes("after"), true);
  await assert.rejects(access(sentinel), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("exact descendant policy prevents list, search, status, and directory diff disclosure", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cba-descendant-policy-"));
  const checkpointDirectory = await mkdtemp(path.join(os.tmpdir(), "cba-descendant-checkpoints-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(checkpointDirectory, { recursive: true, force: true });
  });
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["init", "--quiet", root]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "config", "user.name", "CBA Test"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "config", "user.email", "cba@example.invalid"]);
  await mkdir(path.join(root, "src", "private"), { recursive: true });
  await writeFile(path.join(root, "src", "public.txt"), "needle public before\n");
  await writeFile(path.join(root, "src", "private", "secret.txt"), "needle private before\n");
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "add", "--", "src"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "commit", "--quiet", "-m", "initial"]);
  await writeFile(path.join(root, "src", "public.txt"), "needle public after\n");
  await writeFile(path.join(root, "src", "private", "secret.txt"), "needle private after\n");

  let policy: LayeredRuntimePolicy | undefined;
  const repository = await RepositoryContext.create({
    repositoryRoot: root,
    checkpointDirectory,
    repositoryTools: {
      isPathReadable: (candidate, operation) =>
        policy?.isReadPathAllowed(operation, candidate) ?? false,
    },
  });
  const repositoryPolicy: PolicyDocument = {
    ...DEFAULT_REPOSITORY_POLICY,
    policy_id: "repository-descendant-deny",
    capabilities: {
      ...DEFAULT_REPOSITORY_POLICY.capabilities,
      paths: {
        ...DEFAULT_REPOSITORY_POLICY.capabilities.paths,
        read: { allow: ["**"], deny: ["src/private/**"], unmatched: "deny" },
      },
    },
  };
  policy = new LayeredRuntimePolicy({
    engine: new PolicyEngine({
      organization: DEFAULT_ORGANIZATION_POLICY,
      repository: repositoryPolicy,
      session: createDefaultSessionGrant({
        grant_id: "grant_descendant",
        task_id: "task_descendant",
        repository_root: root,
        mode: "auto",
        readable_paths: ["**"],
      }),
    }),
    boundary: repository.boundary,
    commandCatalog: new CommandCatalog([]),
    currentUsage: zeroPolicyBudgetUsage,
  });

  assert.equal(policy.isReadPathAllowed("list_files", "src"), true);
  assert.equal(policy.isReadPathAllowed("list_files", "src/private/secret.txt"), false);

  const listing = await repository.tools.listFiles({ path: "src", maxDepth: 4, maxResults: 100 });
  assert.deepEqual(listing.entries.map((entry) => entry.path), ["src/public.txt"]);
  assert.equal(listing.excludedCount >= 1, true);

  const search = await repository.tools.searchText({
    path: "src",
    query: "needle",
    maxResults: 10,
    contextLines: 0,
  });
  assert.deepEqual(search.matches.map((entry) => entry.path), ["src/public.txt"]);
  assert.equal(search.matches.some((entry) => entry.excerpt.includes("private")), false);

  const status = await repository.git.status();
  assert.deepEqual(status.entries.map((entry) => entry.path), ["src/public.txt"]);
  assert.equal(status.excludedCount, 1);
  await writeFile(path.join(root, "src", "private", "secret.txt"), "needle private changed again\n");
  const hiddenChange = await repository.git.status();
  assert.deepEqual(hiddenChange.entries.map((entry) => entry.path), ["src/public.txt"]);
  assert.notEqual(hiddenChange.snapshotSha256, status.snapshotSha256);

  const diff = await repository.git.diff({ baseline: "worktree", paths: ["src"] });
  assert.equal(diff.diff.includes("public after"), true);
  assert.equal(diff.diff.includes("private"), false);
  assert.equal(diff.excludedCount, 1);
});

test("a non-readable directory is not emitted but traversal can reach an allowed descendant", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cba-policy-traversal-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src", "bridge", "allowed"), { recursive: true });
  await writeFile(path.join(root, "src", "bridge", "allowed", "visible.txt"), "visible\n");
  const boundary = await RepositoryBoundary.create(root);
  const tools = await RepositoryTools.create(boundary, {
    isPathReadable: (candidate) => candidate !== "src/bridge",
  });

  const listing = await tools.listFiles({ path: "src", maxDepth: 4, maxResults: 100 });
  assert.equal(listing.entries.some((entry) => entry.path === "src/bridge"), false);
  assert.equal(
    listing.entries.some((entry) => entry.path === "src/bridge/allowed/visible.txt"),
    true,
  );
});
