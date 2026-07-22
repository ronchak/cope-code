import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { DEFAULT_GIT_EXECUTABLE, RepositoryBoundary } from "../../src/repository/boundary.js";
import { CheckpointStore } from "../../src/repository/checkpoint.js";
import { RepositoryContext } from "../../src/repository/context.js";
import { GitInspector } from "../../src/repository/git.js";
import { PatchEngine } from "../../src/repository/patch-engine.js";
import { RepositoryTools } from "../../src/repository/repository-tools.js";
import { ContentSecurity } from "../../src/security/content-security.js";
import { DisclosureLedger } from "../../src/security/disclosure-ledger.js";
import { ProtectedPathPolicy } from "../../src/security/protected-paths.js";
import { SecretScanner } from "../../src/security/secrets.js";
import { sha256 } from "../../src/shared/crypto.js";
import { CommandCatalog } from "../../src/tools/command-catalog.js";
import { ProcessRunner } from "../../src/tools/process-runner.js";
import { ToolHost, type ToolPolicyEvaluator } from "../../src/tools/tool-host.js";

const execFileAsync = promisify(execFile);

test("ToolHost dispatches the cba/1 wire arguments, applies policy, and never replays an operation", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-tool-host-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(path.join(root, "src"), { recursive: true });
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["init", "--quiet", root]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "config", "user.name", "CBA Test"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "config", "user.email", "cba@example.invalid"]);
  await writeFile(path.join(root, "src", "main.ts"), "export const value = 1;\n");
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "add", "--", "src/main.ts"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, "commit", "--quiet", "-m", "initial"]);

  const ledger = new DisclosureLedger("tool_host_session");
  const security = new ContentSecurity(new SecretScanner(), ledger, {
    modes: { "tool-result": "redact" },
  });
  const repositoryContext = await RepositoryContext.create({
    repositoryRoot: root,
    checkpointDirectory: path.join(temporary, "checkpoints"),
    repositoryTools: { contentProcessor: security },
    patchBudgets: { allowCreate: true, allowDelete: true },
  });
  const commandCatalog = new CommandCatalog([
    {
      id: "validate",
      category: "test",
      risk: "low",
      sideEffects: false,
      networkRequired: false,
      executable: process.execPath,
      fixedArguments: ["-e", "console.log('validation passed')"],
      timeoutMs: 1_000,
    },
  ]);
  const processRunner = new ProcessRunner(repositoryContext.boundary, commandCatalog, {
    contentProcessor: security,
  });
  const policy: ToolPolicyEvaluator = {
    authorize: (call) =>
      call.name === "git_diff"
        ? {
            outcome: "deny",
            reasonCode: "DIFF_DISABLED",
            explanation: "Diff disclosure is disabled for this test grant",
          }
        : { outcome: "allow" },
  };
  const host = new ToolHost({
    context: repositoryContext,
    processRunner,
    policy,
    resultProcessor: security,
    completionPathScope: { isPathInScope: (candidate) => candidate.startsWith("src/") },
  });

  const readCall = {
    operationId: "read_once",
    name: "read_file" as const,
    arguments: { path: "src/main.ts", start_line: 1, end_line: 1 },
  };
  const first = await host.dispatch(readCall);
  const replay = await host.dispatch(readCall);
  assert.equal(first.status, "success");
  assert.deepEqual(replay, first);
  assert.equal(ledger.records().filter((record) => record.operationId === "read_once").length, 1);

  const reused = await host.dispatch({
    operationId: "read_once",
    name: "read_file",
    arguments: { path: "src/other.ts" },
  });
  assert.equal(reused.status, "failure");
  assert.equal(reused.data.code, "DUPLICATE_OPERATION");

  const denied = await host.dispatch({
    operationId: "diff_denied",
    name: "git_diff",
    arguments: { scope: "working_tree" },
  });
  assert.equal(denied.status, "denied");
  assert.equal(denied.data.code, "DIFF_DISABLED");

  const unavailableLsp = await host.dispatch({
    operationId: "lsp_unconfigured",
    name: "lsp_query",
    arguments: { operation: "hover", path: "src/main.ts", line: 0, character: 0 },
  });
  assert.equal(unavailableLsp.status, "denied");
  assert.equal(unavailableLsp.data.code, "POLICY_DENIED");

  const statusOutcome = await host.dispatch({
    operationId: "git_status_safe",
    name: "git_status",
    arguments: {},
  });
  assert.equal(statusOutcome.status, "success");
  const statusEntries = statusOutcome.data.entries as ReadonlyArray<Readonly<Record<string, unknown>>>;
  assert.equal(statusEntries.every((entry) => !("stateSha256" in entry)), true);

  const stale = await host.dispatch({
    operationId: "patch_stale",
    name: "apply_patch",
    arguments: {
      changes: [
        {
          kind: "update",
          path: "src/main.ts",
          base_sha256: "0".repeat(64),
          content: "export const value = 2;\n",
        },
      ],
    },
  });
  assert.equal(stale.status, "conflict");
  assert.equal(stale.data.code, "STALE_STATE");

  await writeFile(path.join(root, "src", "main.ts"), "export const value = 2;\n");
  const command = await host.dispatch({
    operationId: "command_validate",
    name: "run_command",
    arguments: { command_id: "validate" },
  });
  assert.equal(command.status, "success");
  assert.equal(command.safeMetadata.commandId, "validate");
  assert.equal(command.safeMetadata.repositoryStateKnown, true);
  assert.equal(command.safeMetadata.repositoryHasConflicts, false);
  assert.match(String(command.safeMetadata.repositoryFingerprint), /^[a-f0-9]{64}$/u);

  await writeFile(path.join(root, "src", "main.ts"), "export const value = 3;\n");
  await writeFile(path.join(root, "src", "new.ts"), "new\n");
  await mkdir(path.join(root, ".cba"));
  await writeFile(path.join(root, ".cba", "repository.json"), "{}\n");
  const completion = await host.inspectCompletionState();
  assert.notEqual(completion.fingerprint, command.safeMetadata.repositoryFingerprint);
  assert.equal(completion.known, true);
  assert.equal(completion.changedPaths.includes("src/new.ts"), true);
  assert.equal(completion.changedPaths.includes(".cba/repository.json"), false);
  assert.deepEqual(completion.outOfScopePaths, []);
  const filteredStatus = await repositoryContext.git.status();
  assert.equal(filteredStatus.excludedCount >= 1, true);
});

test("ToolHost fails closed when completion scope is unavailable and rejects unsupported regex search", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-tool-host-closed-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["init", "--quiet", root]);
  await writeFile(path.join(root, "file.txt"), "hello\n");
  const boundary = await RepositoryBoundary.create(root);
  const repository = await RepositoryTools.create(boundary);
  const checkpoints = await CheckpointStore.create(boundary, path.join(temporary, "checkpoints"));
  const host = new ToolHost({
    repository,
    git: new GitInspector(boundary),
    patchEngine: new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy()),
    processRunner: new ProcessRunner(boundary, new CommandCatalog([])),
    policy: { authorize: () => ({ outcome: "allow" }) },
  });
  const regex = await host.dispatch({
    operationId: "regex_search",
    name: "search_text",
    arguments: { query: "h.*o", mode: "regex" },
  });
  assert.equal(regex.status, "failure");
  const completion = await host.inspectCompletionState();
  assert.equal(completion.known, false);
  assert.equal(completion.outOfScopePaths.includes("file.txt"), true);
});

test("ToolHost runs an approved side-effecting validation command when protected repository state is preserved", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-tool-host-side-effect-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["init", "--quiet", root]);
  await writeFile(path.join(root, "source.txt"), "before\n");
  const repositoryContext = await RepositoryContext.create({
    repositoryRoot: root,
    checkpointDirectory: path.join(temporary, "checkpoints"),
  });
  const catalog = new CommandCatalog([{
    id: "approved-build",
    category: "build",
    risk: "low",
    sideEffects: true,
    networkRequired: false,
    executable: process.execPath,
    fixedArguments: ["-e", "console.log('build completed')"],
  }]);
  const host = new ToolHost({
    context: repositoryContext,
    processRunner: new ProcessRunner(repositoryContext.boundary, catalog),
    policy: { authorize: () => ({ outcome: "allow" }) },
    completionPathScope: { isPathInScope: () => true },
  });

  const outcome = await host.dispatch({
    operationId: "side_effect_allowed",
    name: "run_command",
    arguments: { command_id: "approved-build" },
  });
  assert.equal(outcome.status, "success");
  assert.match(String(outcome.data.stdout), /build completed/u);
  assert.equal(outcome.safeMetadata.sideEffects, true);
  assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "before\n");
});

test("ToolHost makes undeclared visible, protected, and nested-Git command mutations indeterminate", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-tool-host-command-drift-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));

  const runMutation = async (
    id: string,
    source: string,
    sideEffects = false,
    seedIgnoredOutput = false,
  ): Promise<Awaited<ReturnType<ToolHost["dispatch"]>>> => {
    const root = path.join(temporary, id);
    await mkdir(root);
    await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["init", "--quiet", root]);
    await writeFile(path.join(root, ".gitignore"), ".env\ncoverage/\n");
    await writeFile(path.join(root, "source.txt"), "before\n");
    await writeFile(path.join(root, ".env"), "TOKEN=before\n");
    if (seedIgnoredOutput) {
      await mkdir(path.join(root, "coverage"));
      await writeFile(path.join(root, "coverage", "result.json"), "{\"before\":true}");
    }
    const repositoryContext = await RepositoryContext.create({
      repositoryRoot: root,
      checkpointDirectory: path.join(temporary, `${id}-checkpoints`),
    });
    const catalog = new CommandCatalog([{
      id,
      category: "test",
      risk: "low",
      sideEffects,
      networkRequired: false,
      executable: process.execPath,
      fixedArguments: ["-e", source],
    }]);
    const host = new ToolHost({
      context: repositoryContext,
      processRunner: new ProcessRunner(repositoryContext.boundary, catalog),
      policy: { authorize: () => ({ outcome: "allow" }) },
      completionPathScope: { isPathInScope: (candidate) => candidate === "source.txt" },
    });
    return host.dispatch({
      operationId: `op_${id.replaceAll("-", "_")}`,
      name: "run_command",
      arguments: { command_id: id },
    });
  };

  const visible = await runMutation(
    "visible-drift",
    "require('node:fs').writeFileSync('source.txt', 'after\\n')",
  );
  assert.equal(visible.status, "indeterminate");
  assert.equal(visible.data.code, "RECOVERY_REQUIRED");
  assert.match(String(visible.data.message), /declared side-effect-free changed repository state/u);

  const sideEffectVisible = await runMutation(
    "side-effect-visible-drift",
    "require('node:fs').writeFileSync('source.txt', 'after\\n')",
    true,
  );
  assert.equal(sideEffectVisible.status, "indeterminate");
  assert.equal(sideEffectVisible.data.code, "RECOVERY_REQUIRED");
  assert.match(String(sideEffectVisible.data.message), /approved command changed Git-visible/u);

  const protectedMutation = await runMutation(
    "protected-drift",
    "require('node:fs').writeFileSync('.env', 'TOKEN=after\\n')",
  );
  assert.equal(protectedMutation.status, "indeterminate");
  assert.equal(protectedMutation.data.code, "RECOVERY_REQUIRED");

  const gitControlMutation = await runMutation(
    "git-control-drift",
    "require('node:fs').appendFileSync('.git/config', '\\n[cba-test]\\nchanged = true\\n')",
  );
  assert.equal(gitControlMutation.status, "indeterminate");
  assert.equal(gitControlMutation.data.code, "RECOVERY_REQUIRED");

  const nestedGit = await runMutation(
    "nested-git",
    "require('node:fs').mkdirSync('nested/.git', { recursive: true }); require('node:fs').writeFileSync('nested/.git/HEAD', 'ref: refs/heads/main\\n')",
  );
  assert.equal(nestedGit.status, "indeterminate");
  assert.equal(nestedGit.data.code, "RECOVERY_REQUIRED");
  assert.match(String(nestedGit.data.message), /unverifiable/u);

  const ignoredReadOnlyDrift = await runMutation(
    "ignored-read-only-drift",
    "require('node:fs').writeFileSync('coverage/result.json', '{\"after\":true}')",
    false,
    true,
  );
  assert.equal(ignoredReadOnlyDrift.status, "indeterminate");
  assert.equal(ignoredReadOnlyDrift.data.code, "RECOVERY_REQUIRED");

  const ignoredBuildOutput = await runMutation(
    "ignored-build-output",
    "require('node:fs').writeFileSync('coverage/result.json', '{\"after\":true}')",
    true,
    true,
  );
  assert.equal(ignoredBuildOutput.status, "success");
  assert.equal(ignoredBuildOutput.safeMetadata.sideEffects, true);
});

test("ToolHost serves checkpoint and true session diffs without disclosing filtered path names", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-tool-host-snapshot-diff-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await mkdir(root);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["init", "--quiet", root]);
  await writeFile(path.join(root, "a.txt"), "base a\n");
  await writeFile(path.join(root, "b.txt"), "base b\n");
  await writeFile(path.join(root, "hidden.txt"), "hidden before\n");
  const repositoryContext = await RepositoryContext.create({
    repositoryRoot: root,
    checkpointDirectory: path.join(temporary, "checkpoints"),
    repositoryTools: {
      isPathReadable: (candidate) => candidate !== "hidden.txt",
    },
    patchBudgets: { allowCreate: true, allowDelete: true },
  });
  const first = await repositoryContext.patchEngine.applyPatch({
    operationId: "op_first",
    changes: [{
      kind: "update",
      path: "a.txt",
      base_sha256: sha256("base a\n"),
      content: "middle a\n",
    }],
  });
  const second = await repositoryContext.patchEngine.applyPatch({
    operationId: "op_second",
    changes: [
      {
        kind: "update",
        path: "a.txt",
        base_sha256: sha256("middle a\n"),
        content: "final a\n",
      },
      {
        kind: "update",
        path: "b.txt",
        base_sha256: sha256("base b\n"),
        content: "final b\n",
      },
    ],
  });
  let lastCheckpointId = second.checkpointId;
  const mutations = [
    { checkpointId: first.checkpointId, changedPaths: ["a.txt"] },
    { checkpointId: second.checkpointId, changedPaths: ["a.txt", "b.txt"] },
  ];
  const host = new ToolHost({
    context: repositoryContext,
    processRunner: new ProcessRunner(repositoryContext.boundary, new CommandCatalog([])),
    policy: { authorize: () => ({ outcome: "allow" }) },
    completionPathScope: { isPathInScope: () => true },
    resultProcessor: {
      process: async (input) => ({
        content: `${input.content}${"x".repeat(1_024)}`,
        redactionCount: 1,
      }),
    },
    sessionDiffState: () => ({ lastCheckpointId, mutations }),
  });

  const checkpoint = await host.dispatch({
    operationId: "diff_checkpoint",
    name: "git_diff",
    arguments: { scope: "checkpoint" },
  });
  assert.equal(checkpoint.status, "success");
  assert.equal(checkpoint.data.baseline, second.checkpointId);
  assert.match(String(checkpoint.data.diff), /-middle a/u);
  assert.doesNotMatch(String(checkpoint.data.diff), /base a/u);

  const session = await host.dispatch({
    operationId: "diff_session",
    name: "git_diff",
    arguments: { scope: "session" },
  });
  assert.equal(session.status, "success");
  assert.equal(session.data.baseline, "earliest-agent-checkpoint");
  assert.match(String(session.data.diff), /-base a/u);
  assert.doesNotMatch(String(session.data.diff), /middle a/u);

  const bounded = await host.dispatch({
    operationId: "diff_bounded",
    name: "git_diff",
    arguments: { scope: "checkpoint", baseline: second.checkpointId, max_bytes: 80 },
  });
  assert.equal(bounded.status, "success");
  assert.equal(Number(bounded.data.outputBytes) <= 80, true);
  assert.equal(bounded.data.truncated, true);
  assert.equal(bounded.safeMetadata.redactionCount, 1);

  const hiddenCheckpoint = await repositoryContext.checkpoints.createCheckpoint(["a.txt", "hidden.txt"]);
  await writeFile(path.join(root, "hidden.txt"), "hidden after\n");
  lastCheckpointId = hiddenCheckpoint.id;
  const filtered = await host.dispatch({
    operationId: "diff_hidden",
    name: "git_diff",
    arguments: { scope: "checkpoint" },
  });
  assert.equal(filtered.status, "success");
  assert.equal(filtered.data.excludedCount, 1);
  assert.equal(JSON.stringify(filtered.data).includes("hidden.txt"), false);
  assert.equal(JSON.stringify(filtered.data).includes("hidden after"), false);

  await mkdir(path.join(root, "nested", ".git"), { recursive: true });
  const unsafeCompletion = await host.inspectCompletionState();
  assert.equal(unsafeCompletion.known, false);
  assert.equal(unsafeCompletion.hasConflicts, true);
  assert.match(unsafeCompletion.gitStatusSummary, /unavailable/iu);
});
