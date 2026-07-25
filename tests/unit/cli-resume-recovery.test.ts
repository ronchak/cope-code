import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executeCommand } from "../../src/cli/commands.js";
import {
  SESSION_RUNTIME_MANIFEST_VERSION,
  writeSessionGrant,
  writeRuntimeManifest,
} from "../../src/cli/session-files.js";
import { createDefaultSessionGrant } from "../../src/policy/index.js";
import { SecretScanner } from "../../src/security/secrets.js";
import { CompletionHandoffStore } from "../../src/session/completion-handoff-store.js";
import { SessionStore } from "../../src/session/store.js";
import {
  DEFAULT_BUDGET_LIMITS,
  zeroBudgetUsage,
  type SessionState,
  type SessionStatus,
} from "../../src/session/types.js";
import { AgentError } from "../../src/shared/errors.js";
import { createStandardUserHost } from "../helpers/standard-user-host.js";

test("status suppresses a provisional completion handoff for a paused session", async (context) => {
  const stateHome = await mkdtemp(path.join(tmpdir(), "cope-status-provisional-handoff-"));
  context.after(async () => rm(stateHome, { recursive: true, force: true }));
  const now = "2026-07-24T12:00:00.000Z";
  const state = sessionState("session_provisional_handoff", "paused", now);
  state.pauseReason = "pause before completion handoff revalidation";
  const store = new SessionStore(stateHome);
  await store.create(state);
  const sessionDirectory = store.sessionDirectory(state.sessionId);
  const fingerprintKey = Buffer.alloc(32, 11);
  await writeFile(path.join(sessionDirectory, "fingerprint.key"), fingerprintKey, { mode: 0o600 });
  const handoffs = new CompletionHandoffStore(
    path.join(sessionDirectory, "handoff"),
    state.sessionId,
    new SecretScanner(fingerprintKey),
  );
  state.completionHandoff = await handoffs.save({
    summary: "This provisional report must remain hidden.",
    acceptanceCriteria: [],
    validation: [],
    skippedValidation: [],
    remainingRisks: [],
    recommendedFollowUp: [],
  }, {
    accepted: true,
    reasons: [],
    actual: {
      changedPaths: [],
      agentChangedPaths: [],
      preExistingPaths: [],
      successfulCommands: [],
      failedCommands: [],
      gitStatusSummary: "clean",
      repositoryFingerprint: "f".repeat(64),
    },
  }, now);
  await store.write(state);
  await writeSessionGrant(sessionDirectory, createDefaultSessionGrant({
    grant_id: "grant_provisional_handoff",
    task_id: state.taskId,
    repository_root: state.repositoryRoot,
    mode: state.mode,
  }));

  let stdout = "";
  const exitCode = await executeCommand({
    command: "status",
    sessionId: state.sessionId,
    stateHome,
    json: true,
  }, {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: () => undefined },
  }, {
    host: createStandardUserHost(),
  });

  assert.equal(exitCode, 0);
  const rendered = JSON.parse(stdout) as {
    completionReport: unknown;
  };
  assert.equal(rendered.completionReport, null);
  assert.doesNotMatch(stdout, /This provisional report must remain hidden/u);
  await handoffs.read(state.completionHandoff);
});

test("status migrates a legacy handoff from a non-completed terminal session", async (context) => {
  const stateHome = await mkdtemp(path.join(tmpdir(), "cope-status-legacy-terminal-handoff-"));
  context.after(async () => rm(stateHome, { recursive: true, force: true }));
  const now = "2026-07-24T12:00:00.000Z";
  const state = sessionState("session_legacy_terminal_handoff", "rolled_back", now);
  state.completedAt = now;
  const store = new SessionStore(stateHome);
  await store.create(state);
  const sessionDirectory = store.sessionDirectory(state.sessionId);
  const fingerprintKey = Buffer.alloc(32, 13);
  await writeFile(path.join(sessionDirectory, "fingerprint.key"), fingerprintKey, { mode: 0o600 });
  const handoffs = new CompletionHandoffStore(
    path.join(sessionDirectory, "handoff"),
    state.sessionId,
    new SecretScanner(fingerprintKey),
  );
  state.completionHandoff = await handoffs.save({
    summary: "This legacy terminal report must be removed.",
    acceptanceCriteria: [],
    validation: [],
    skippedValidation: [],
    remainingRisks: [],
    recommendedFollowUp: [],
  }, {
    accepted: true,
    reasons: [],
    actual: {
      changedPaths: [],
      agentChangedPaths: [],
      preExistingPaths: [],
      successfulCommands: [],
      failedCommands: [],
      gitStatusSummary: "clean",
      repositoryFingerprint: "f".repeat(64),
    },
  }, now);
  await store.write(state);
  await writeSessionGrant(sessionDirectory, createDefaultSessionGrant({
    grant_id: "grant_legacy_terminal_handoff",
    task_id: state.taskId,
    repository_root: state.repositoryRoot,
    mode: state.mode,
  }));

  let stdout = "";
  const exitCode = await executeCommand({
    command: "status",
    sessionId: state.sessionId,
    stateHome,
    json: true,
  }, {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: () => undefined },
  }, {
    host: createStandardUserHost(),
  });

  assert.equal(exitCode, 0);
  const rendered = JSON.parse(stdout) as { completionReport: unknown };
  assert.equal(rendered.completionReport, null);
  assert.doesNotMatch(stdout, /This legacy terminal report must be removed/u);
  await assert.rejects(() => handoffs.read(), /unavailable/u);
  const durable = JSON.parse(
    await readFile(path.join(sessionDirectory, "session.json"), "utf8"),
  ) as SessionState;
  assert.equal(durable.completionHandoff, undefined);
});

test("resume reports missing pinned browser configuration without exposing raw ENOENT", async (context) => {
  const stateHome = await mkdtemp(path.join(tmpdir(), "cope-resume-recovery-"));
  context.after(async () => rm(stateHome, { recursive: true, force: true }));
  const now = "2026-07-24T12:00:00.000Z";
  const state = sessionState("session_resume_recovery", "transport_starting", now);
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

test("resume rejects a runtime-pinned pre-grant session before configuration loading", async (context) => {
  const stateHome = await mkdtemp(path.join(tmpdir(), "cope-resume-pre-grant-"));
  context.after(async () => rm(stateHome, { recursive: true, force: true }));
  const now = "2026-07-24T12:00:00.000Z";
  const state = sessionState("session_resume_pre_grant", "preflight", now);
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
    assert.equal(error.details.diagnosticCode, "SESSION_STARTUP_INCOMPLETE");
    assert.equal(error.details.disposition, "abort_required");
    assert.match(error.message, /initial grant became resumable/u);
    return true;
  });
});

function sessionState(
  sessionId: string,
  status: SessionStatus,
  now: string,
): SessionState {
  return {
    schemaVersion: 1,
    protocolVersion: "cba/1",
    sessionId,
    taskId: `task_${sessionId}`,
    repositoryRoot: "/missing/repository",
    repositoryFingerprintAtStart: "f".repeat(64),
    repositoryExcludedStateAtStart: "0".repeat(64),
    preExistingChanges: [],
    objective: "Verify browser uptime",
    acceptanceCriteria: [],
    mode: "inspect",
    status,
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
}
