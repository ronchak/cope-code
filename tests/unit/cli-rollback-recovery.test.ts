import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AuditLog } from "../../src/audit/audit-log.js";
import { executeCommand } from "../../src/cli/commands.js";
import { DEFAULT_ORGANIZATION_POLICY, DEFAULT_REPOSITORY_POLICY } from "../../src/policy/index.js";
import { CheckpointStore } from "../../src/repository/checkpoint.js";
import { RepositoryBoundary } from "../../src/repository/boundary.js";
import { PatchEngine } from "../../src/repository/patch-engine.js";
import { ProtectedPathPolicy } from "../../src/security/protected-paths.js";
import { SessionStore } from "../../src/session/store.js";
import {
  DEFAULT_BUDGET_LIMITS,
  SESSION_SCHEMA_VERSION,
  type SessionState,
  zeroBudgetUsage,
} from "../../src/session/types.js";
import { sha256 } from "../../src/shared/crypto.js";
import { createStandardUserHost } from "../helpers/standard-user-host.js";

test("rollback retry converges checkpoint, audit, and session exactly once after process loss", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-cli-rollback-gap-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const repository = path.join(temporary, "repository");
  const stateHome = path.join(temporary, "state");
  await mkdir(path.join(repository, ".cba"), { recursive: true });
  await mkdir(path.join(stateHome, "config"), { recursive: true, mode: 0o700 });
  await chmod(stateHome, 0o700);
  await chmod(path.join(stateHome, "config"), 0o700);
  await writeFile(
    path.join(stateHome, "config", "organization-policy.json"),
    JSON.stringify(DEFAULT_ORGANIZATION_POLICY),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(repository, ".cba", "repository.json"),
    JSON.stringify({
      schema_version: "cba-repository-config/1",
      classification: "internal",
      policy: DEFAULT_REPOSITORY_POLICY,
      grant_defaults: {
        readable_paths: ["**"],
        writable_paths: ["**"],
        disclosure_classifications: ["internal"],
      },
      commands: [],
      completion: {
        required_command_ids: [],
        require_validation_after_last_mutation: false,
      },
      limits: {
        max_file_bytes: 1_048_576,
        max_read_bytes: 131_072,
        max_search_output_bytes: 131_072,
        max_diff_bytes: 524_288,
        max_checkpoint_bytes: 16_777_216,
        max_patch_bytes: 4_194_304,
      },
      retention: { retain_source_artifacts_on_completion: false },
    }),
  );
  const now = "2026-07-25T12:00:00.000Z";
  const state: SessionState = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    protocolVersion: "cba/1",
    sessionId: "session_rollback_gap",
    taskId: "task_rollback_gap",
    repositoryRoot: repository,
    repositoryFingerprintAtStart: "f".repeat(64),
    repositoryExcludedStateAtStart: "0".repeat(64),
    preExistingChanges: [],
    objective: "verify rollback recovery",
    acceptanceCriteria: ["rollback converges"],
    mode: "edit",
    status: "completed",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: now,
    policyHashes: {
      organization: "a".repeat(64),
      repository: "b".repeat(64),
      grant: "c".repeat(64),
    },
    budgetLimits: { ...DEFAULT_BUDGET_LIMITS },
    budgetUsage: zeroBudgetUsage(),
    turnSequence: 0,
    mutationSequence: 0,
    pendingOperations: [],
    completedOperationIds: [],
    mutations: [],
    validations: [],
    protocolRepairStreak: 0,
  };
  const store = new SessionStore(stateHome);
  await store.create(state);
  const sessionDirectory = store.sessionDirectory(state.sessionId);
  const auditFile = path.join(sessionDirectory, "audit.jsonl");
  const audit = new AuditLog(auditFile, state.sessionId);
  await audit.append({ type: "session.created", taskId: state.taskId, data: {} });

  const target = path.join(repository, "file.txt");
  await writeFile(target, "before\n");
  const boundary = await RepositoryBoundary.create(repository);
  const checkpointRoot = path.join(sessionDirectory, "checkpoints");
  const checkpoints = await CheckpointStore.create(boundary, checkpointRoot);
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());
  const result = await engine.editText({
    path: "file.txt",
    base_sha256: sha256("before\n"),
    old_text: "before",
    new_text: "after",
    expected_occurrences: 1,
  });
  state.lastCheckpointId = result.checkpointId;
  await store.write(state);
  await writeFile(target, "later user\n");

  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `
      const { RepositoryBoundary } = await import(process.env.CBA_BOUNDARY_URL);
      const { CheckpointStore } = await import(process.env.CBA_CHECKPOINT_URL);
      const boundary = await RepositoryBoundary.create(process.env.CBA_REPOSITORY_ROOT);
      const checkpoints = await CheckpointStore.create(
        boundary,
        process.env.CBA_CHECKPOINT_ROOT,
        { hooks: { afterRollbackCleanup: async () => process.exit(77) } },
      );
      await checkpoints.rollback(process.env.CBA_CHECKPOINT_ID, { force: true });
    `],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CBA_BOUNDARY_URL: new URL("../../src/repository/boundary.js", import.meta.url).href,
        CBA_CHECKPOINT_URL: new URL("../../src/repository/checkpoint.js", import.meta.url).href,
        CBA_REPOSITORY_ROOT: repository,
        CBA_CHECKPOINT_ROOT: checkpointRoot,
        CBA_CHECKPOINT_ID: result.checkpointId,
      },
    },
  );
  assert.equal(child.status, 77, child.stderr);
  assert.equal(await readFile(target, "utf8"), "before\n");
  assert.equal((await store.read(state.sessionId)).status, "completed");

  const command = {
    command: "rollback" as const,
    sessionId: state.sessionId,
    checkpointId: result.checkpointId,
    force: false,
    stateHome,
    json: true,
  };
  const io = {
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
  };
  assert.equal(
    await executeCommand(command, io, { host: createStandardUserHost() }),
    0,
  );
  assert.equal((await store.read(state.sessionId)).status, "rolled_back");
  assert.equal(
    await executeCommand(command, io, { host: createStandardUserHost() }),
    0,
  );

  const events = await AuditLog.verify(auditFile, state.sessionId);
  assert.equal(
    events.filter(
      (event) =>
        event.type === "checkpoint.rolled_back" &&
        event.data.checkpointId === result.checkpointId,
    ).length,
    1,
  );
  const rollbackEvent = events.find(
    (event) =>
      event.type === "checkpoint.rolled_back" &&
      event.data.checkpointId === result.checkpointId,
  );
  assert.equal(rollbackEvent?.data.forced, true);
  assert.equal(
    events.filter(
      (event) =>
        event.type === "session.ended" &&
        event.data.to === "rolled_back",
    ).length,
    1,
  );
});

test("rollback accepts a checkpoint created under an approved one-time file-budget expansion", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-cli-rollback-expansion-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const repository = path.join(temporary, "repository");
  const stateHome = path.join(temporary, "state");
  await mkdir(path.join(repository, ".cba"), { recursive: true });
  await mkdir(path.join(stateHome, "config"), { recursive: true, mode: 0o700 });
  await chmod(stateHome, 0o700);
  await chmod(path.join(stateHome, "config"), 0o700);
  await writeFile(
    path.join(stateHome, "config", "organization-policy.json"),
    JSON.stringify(DEFAULT_ORGANIZATION_POLICY),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(repository, ".cba", "repository.json"),
    JSON.stringify({
      schema_version: "cba-repository-config/1",
      classification: "internal",
      policy: DEFAULT_REPOSITORY_POLICY,
      grant_defaults: {
        readable_paths: ["**"],
        writable_paths: ["**"],
        disclosure_classifications: ["internal"],
      },
      commands: [],
      completion: {
        required_command_ids: [],
        require_validation_after_last_mutation: false,
      },
      limits: {
        max_file_bytes: 1_048_576,
        max_read_bytes: 131_072,
        max_search_output_bytes: 131_072,
        max_diff_bytes: 524_288,
        max_checkpoint_bytes: 16_777_216,
        max_patch_bytes: 4_194_304,
      },
      retention: { retain_source_artifacts_on_completion: false },
    }),
  );
  const now = "2026-07-25T12:00:00.000Z";
  const state: SessionState = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    protocolVersion: "cba/1",
    sessionId: "session_rollback_expansion",
    taskId: "task_rollback_expansion",
    repositoryRoot: repository,
    repositoryFingerprintAtStart: "f".repeat(64),
    repositoryExcludedStateAtStart: "0".repeat(64),
    preExistingChanges: [],
    objective: "verify rollback after one-time expansion",
    acceptanceCriteria: ["expanded checkpoint rolls back"],
    mode: "edit",
    status: "paused",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    policyHashes: {
      organization: "a".repeat(64),
      repository: "b".repeat(64),
      grant: "c".repeat(64),
    },
    // The persisted session authority allowed only one changed file; an
    // approved allow_once expansion raised the limit for one operation.
    budgetLimits: { ...DEFAULT_BUDGET_LIMITS, maxChangedFiles: 1 },
    budgetUsage: zeroBudgetUsage(),
    turnSequence: 0,
    mutationSequence: 0,
    pendingOperations: [],
    completedOperationIds: [],
    mutations: [],
    validations: [],
    protocolRepairStreak: 0,
  };
  const store = new SessionStore(stateHome);
  await store.create(state);
  const sessionDirectory = store.sessionDirectory(state.sessionId);
  const auditFile = path.join(sessionDirectory, "audit.jsonl");
  const audit = new AuditLog(auditFile, state.sessionId);
  await audit.append({ type: "session.created", taskId: state.taskId, data: {} });

  const targetA = path.join(repository, "file-a.txt");
  const targetB = path.join(repository, "file-b.txt");
  await writeFile(targetA, "before a\n");
  await writeFile(targetB, "before b\n");
  const boundary = await RepositoryBoundary.create(repository);
  const checkpointRoot = path.join(sessionDirectory, "checkpoints");
  const checkpoints = await CheckpointStore.create(boundary, checkpointRoot);
  const engine = new PatchEngine(boundary, checkpoints, new ProtectedPathPolicy());
  // Execution composes CheckpointStore with the shared structural bound, so
  // the expanded two-file mutation is captured even though the persisted
  // session limit remains one file.
  const result = await engine.applyPatch({
    changes: [
      { kind: "update", path: "file-a.txt", base_sha256: sha256("before a\n"), content: "after a\n" },
      { kind: "update", path: "file-b.txt", base_sha256: sha256("before b\n"), content: "after b\n" },
    ],
  });
  state.lastCheckpointId = result.checkpointId;
  await store.write(state);
  assert.equal(await readFile(targetA, "utf8"), "after a\n");
  assert.equal(await readFile(targetB, "utf8"), "after b\n");

  const command = {
    command: "rollback" as const,
    sessionId: state.sessionId,
    checkpointId: result.checkpointId,
    force: false,
    stateHome,
    json: true,
  };
  const io = {
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
  };
  assert.equal(
    await executeCommand(command, io, { host: createStandardUserHost() }),
    0,
  );
  assert.equal((await store.read(state.sessionId)).status, "rolled_back");
  assert.equal(await readFile(targetA, "utf8"), "before a\n");
  assert.equal(await readFile(targetB, "utf8"), "before b\n");

  const events = await AuditLog.verify(auditFile, state.sessionId);
  assert.equal(
    events.filter(
      (event) =>
        event.type === "checkpoint.rolled_back" &&
        event.data.checkpointId === result.checkpointId,
    ).length,
    1,
  );
  assert.equal(
    events.filter(
      (event) =>
        event.type === "session.ended" &&
        event.data.to === "rolled_back",
    ).length,
    1,
  );
});
