import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executeCommand } from "../../src/cli/commands.js";
import {
  SESSION_RUNTIME_MANIFEST_VERSION,
  writeRuntimeManifest,
} from "../../src/cli/session-files.js";
import { SessionStore } from "../../src/session/store.js";
import {
  DEFAULT_BUDGET_LIMITS,
  zeroBudgetUsage,
  type SessionState,
} from "../../src/session/types.js";
import { AgentError } from "../../src/shared/errors.js";
import { createStandardUserHost } from "../helpers/standard-user-host.js";

test("resume reports missing pinned browser configuration without exposing raw ENOENT", async (context) => {
  const stateHome = await mkdtemp(path.join(tmpdir(), "cope-resume-recovery-"));
  context.after(async () => rm(stateHome, { recursive: true, force: true }));
  const now = "2026-07-24T12:00:00.000Z";
  const state: SessionState = {
    schemaVersion: 1,
    protocolVersion: "cba/1",
    sessionId: "session_resume_recovery",
    taskId: "task_resume_recovery",
    repositoryRoot: "/missing/repository",
    repositoryFingerprintAtStart: "f".repeat(64),
    repositoryExcludedStateAtStart: "0".repeat(64),
    preExistingChanges: [],
    objective: "Verify browser uptime",
    acceptanceCriteria: [],
    mode: "inspect",
    status: "transport_starting",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
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
  await writeRuntimeManifest(store.sessionDirectory(state.sessionId), {
    schema_version: SESSION_RUNTIME_MANIFEST_VERSION,
    transport: "edge",
    browser_config_sha256: "a".repeat(64),
    created_at: now,
  });

  await assert.rejects(executeCommand({
    command: "resume",
    sessionId: state.sessionId,
    approveGrant: false,
    stateHome,
    json: false,
  }, {
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
  }, {
    host: createStandardUserHost(),
  }), (error: unknown) => {
    assert.ok(error instanceof AgentError);
    assert.equal(error.details.diagnosticCode, "BROWSER_CONFIG_MISSING");
    assert.equal(error.details.disposition, "abort_required");
    assert.match(error.message, /browser configuration required by this session is missing/u);
    assert.doesNotMatch(error.message, /ENOENT/u);
    return true;
  });

  const exitCode = await executeCommand({
    command: "abort",
    sessionId: state.sessionId,
    reason: "Discard interrupted session",
    stateHome,
    json: false,
  }, {
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
  }, {
    host: createStandardUserHost(),
  });
  assert.equal(exitCode, 0);
  assert.equal((await store.read(state.sessionId)).status, "aborted");
});
