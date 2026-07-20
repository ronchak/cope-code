import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runMachinePreflight } from "../../src/preflight/machine.js";
import { DEFAULT_GIT_EXECUTABLE } from "../../src/repository/boundary.js";
import { AgentError } from "../../src/shared/errors.js";
import { UnsupportedHostPlatform } from "../../src/platform/index.js";
import { createStandardUserHost } from "../helpers/standard-user-host.js";

test("offline preflight verifies Node, Git, and a local repository without Edge", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-preflight-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  initializeGitRepository(root);
  const result = await runMachinePreflight({
    repositoryRoot: root,
    liveBrowser: false,
    host: createStandardUserHost(),
  });
  assert.match(result.gitVersion, /^git version /);
  assert.equal(await realpath(result.repositoryTopLevel), await realpath(root));
});

test("live preflight is refused on unsupported hosts", async () => {
  await assert.rejects(
    () => runMachinePreflight({
      repositoryRoot: process.cwd(),
      liveBrowser: true,
      host: new UnsupportedHostPlatform("linux", "x64"),
    }),
    (error: unknown) =>
      error instanceof AgentError &&
      error.code === "TRANSPORT_UNAVAILABLE" &&
      error.details.diagnosticCode === "LIVE_BROWSER_HOST_UNSUPPORTED",
  );
});

test("preflight fails before transport startup when the worktree contains a nested Git boundary", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-preflight-nested-git-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  initializeGitRepository(root);
  await mkdir(path.join(root, "embedded", ".git"), { recursive: true });
  await writeFile(path.join(root, "embedded", "source.txt"), "nested content\n");

  await assert.rejects(
    runMachinePreflight({
      repositoryRoot: root,
      liveBrowser: false,
      host: createStandardUserHost(),
    }),
    (error: unknown) =>
      error instanceof AgentError &&
      error.code === "UNSUPPORTED_FILE" &&
      /Nested Git repositories/iu.test(error.message),
  );
});

function initializeGitRepository(root: string): void {
  const initialized = spawnSync(DEFAULT_GIT_EXECUTABLE, ["init", "-q", root], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(
    initialized.status,
    0,
    [
      `git init failed using ${DEFAULT_GIT_EXECUTABLE}`,
      `status=${String(initialized.status)}`,
      `signal=${String(initialized.signal)}`,
      `error=${initialized.error?.message ?? ""}`,
      `stderr=${initialized.stderr.trim()}`,
    ].join("\n"),
  );
}
