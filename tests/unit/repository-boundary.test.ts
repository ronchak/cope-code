import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { AgentError } from "../../src/shared/errors.js";
import {
  DEFAULT_GIT_EXECUTABLE,
  RepositoryBoundary,
  discoverRepositoryRoot,
  normalizeRepositoryPath,
} from "../../src/repository/boundary.js";
import { RepositoryContext } from "../../src/repository/context.js";

const execFileAsync = promisify(execFile);

test("default Git executable resolves through a supported installation or controlled PATH", () => {
  assert.equal(
    DEFAULT_GIT_EXECUTABLE === "git" || DEFAULT_GIT_EXECUTABLE.toLowerCase().endsWith("\\git.exe"),
    true,
  );
});

test("repository path normalization rejects Windows escape and alias forms on every platform", () => {
  const malicious = [
    "../outside",
    "src/../../outside",
    "..\\outside",
    "C:\\outside",
    "C:outside",
    "\\\\server\\share\\file",
    "//server/share/file",
    "\\\\?\\C:\\outside",
    "\\\\.\\PhysicalDrive0",
    "file.txt:secret",
    "CON",
    "con.txt",
    "aux.js",
    "LPT9.log",
    "folder. ",
    "folder/file.",
    "a//b",
    "a/./b",
    "a/../b",
    "bad<name.ts",
    "bad|name.ts",
    "bad*name.ts",
    `${"x".repeat(256)}.ts`,
  ];
  for (const candidate of malicious) {
    assert.throws(
      () => normalizeRepositoryPath(candidate),
      (error: unknown) => error instanceof AgentError && error.code === "PATH_OUTSIDE_REPOSITORY",
      candidate,
    );
  }
  assert.equal(normalizeRepositoryPath("src\\feature\\index.ts"), "src/feature/index.ts");
  assert.equal(normalizeRepositoryPath(".", true), "");
});

test("boundary rejects hard-linked files that could alias data outside the repository", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-hardlink-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const repository = path.join(temporary, "repo");
  await mkdir(repository);
  const outside = path.join(temporary, "outside.txt");
  await writeFile(outside, "aliased content\n");
  try {
    await link(outside, path.join(repository, "alias.txt"));
  } catch (error) {
    if (["EPERM", "EXDEV", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      context.skip("Filesystem does not permit the hard-link probe");
      return;
    }
    throw error;
  }
  const boundary = await RepositoryBoundary.create(repository);
  await assert.rejects(
    boundary.resolveExistingFile("alias.txt"),
    (error: unknown) => error instanceof AgentError && error.code === "UNSUPPORTED_FILE",
  );
});

test("boundary canonicalizes the root, allows regular files, and rejects link escapes", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-boundary-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const repository = path.join(temporary, "repo");
  const outside = path.join(temporary, "outside");
  await mkdir(path.join(repository, "src"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(repository, "src", "ok.ts"), "export const ok = true;\n");
  await writeFile(path.join(outside, "secret.txt"), "do not read\n");

  const boundary = await RepositoryBoundary.create(repository);
  const file = await boundary.resolveExistingFile("src/ok.ts");
  assert.equal(file.relativePath, "src/ok.ts");
  assert.equal(file.exists, true);
  const future = await boundary.resolveForCreate("src/new.ts");
  assert.equal(future.exists, false);

  try {
    await symlink(outside, path.join(repository, "linked"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      context.skip("The Windows test account cannot create a junction");
      return;
    }
    throw error;
  }
  await assert.rejects(
    boundary.resolveExistingFile("linked/secret.txt"),
    (error: unknown) => error instanceof AgentError && error.code === "UNSUPPORTED_FILE",
  );
});

test("repository discovery asks Git for the canonical top-level directory", async (context) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "cba-discover-"));
  context.after(async () => rm(repository, { recursive: true, force: true }));
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["init", "--quiet", repository]);
  await mkdir(path.join(repository, "a", "b"), { recursive: true });
  const root = await discoverRepositoryRoot(path.join(repository, "a", "b"));
  assert.equal(root, await import("node:fs/promises").then(({ realpath }) => realpath(repository)));
});

test("boundary invariant and path resolution reject descendant Git worktrees", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-nested-git-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const repository = path.join(temporary, "repo");
  await mkdir(path.join(repository, "embedded", ".git"), { recursive: true });
  await mkdir(path.join(repository, "linked-worktree"), { recursive: true });
  await writeFile(path.join(repository, "embedded", "source.txt"), "nested repository content\n");
  await writeFile(path.join(repository, "linked-worktree", ".git"), "gitdir: elsewhere\n");
  await writeFile(path.join(repository, "linked-worktree", "source.txt"), "linked worktree content\n");
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["init", "--quiet", repository]);

  const boundary = await RepositoryBoundary.create(repository);
  await assert.rejects(
    boundary.assertNoNestedGitBoundaries(),
    (error: unknown) =>
      error instanceof AgentError &&
      error.code === "UNSUPPORTED_FILE" &&
      /Nested Git repositories/iu.test(error.message),
  );
  await assert.rejects(
    boundary.resolveExistingFile("embedded/source.txt"),
    (error: unknown) =>
      error instanceof AgentError &&
      error.code === "UNSUPPORTED_FILE" &&
      /nested Git repositories/iu.test(error.message),
  );
  await assert.rejects(
    boundary.resolveExistingFile("linked-worktree/source.txt"),
    (error: unknown) =>
      error instanceof AgentError &&
      error.code === "UNSUPPORTED_FILE" &&
      /nested Git repositories/iu.test(error.message),
  );
});

test("repository composition rejects an index gitlink even without a checked-out marker", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-gitlink-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const repository = path.join(temporary, "repo");
  await mkdir(repository);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["init", "--quiet", repository]);
  await writeFile(path.join(repository, "README.md"), "root repository\n");
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", repository, "add", "--", "README.md"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, [
    "-C",
    repository,
    "-c",
    "user.name=CBA Test",
    "-c",
    "user.email=cba@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "initial",
  ]);
  const { stdout } = await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", repository, "rev-parse", "HEAD"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, [
    "-C",
    repository,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${stdout.trim()},vendor/sub`,
  ]);

  await assert.rejects(
    RepositoryContext.create({
      repositoryRoot: repository,
      checkpointDirectory: path.join(temporary, "checkpoints"),
    }),
    (error: unknown) =>
      error instanceof AgentError &&
      error.code === "UNSUPPORTED_FILE" &&
      /submodule gitlinks/iu.test(error.message),
  );
});
