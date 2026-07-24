import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executeSessionsCommand } from "../../src/cli/sessions.js";
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
import { createStandardUserHost } from "../helpers/standard-user-host.js";

test("sessions marks a statically blocked live session with its exact recovery command", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-cli-sessions-recovery-"));
  const stateHome = path.join(root, "custom state");
  await mkdir(stateHome, { mode: 0o700 });
  context.after(async () => rm(root, { recursive: true, force: true }));
  const state = sessionState();
  const store = new SessionStore(stateHome);
  await store.create(state);
  await writeRuntimeManifest(store.sessionDirectory(state.sessionId), {
    schema_version: SESSION_RUNTIME_MANIFEST_VERSION,
    transport: "edge",
    browser_config_sha256: "a".repeat(64),
    created_at: state.createdAt,
  });
  let human = "";
  await executeSessionsCommand(
    { command: "sessions", all: true, stateHome, json: false },
    { stdout: { write: (value) => { human += value; } }, stderr: { write: () => undefined } },
    createStandardUserHost(),
  );
  assert.match(human, /! Verify browser uptime/u);
  assert.match(human, /Recovery: abort required/u);
  assert.match(human, /cope abort session_cli_recovery/u);
  assert.doesNotMatch(human, /\* Verify browser uptime/u);

  let json = "";
  await executeSessionsCommand(
    { command: "sessions", all: true, stateHome, json: true },
    { stdout: { write: (value) => { json += value; } }, stderr: { write: () => undefined } },
    createStandardUserHost(),
  );
  const result = JSON.parse(json) as {
    sessions: Array<{
      resumable: boolean;
      recovery: { disposition: string; reason: string; next: string };
    }>;
  };
  assert.equal(result.sessions[0]?.resumable, false);
  assert.deepEqual(result.sessions[0]?.recovery, {
    disposition: "abort_required",
    reason: "BROWSER_CONFIG_MISSING",
    next: `cope abort session_cli_recovery --reason "Discard interrupted session that cannot resume" ` +
      `--state-home "${stateHome}"`,
  });
});

test("sessions --all surfaces an unreadable session that blocks setup", async (context) => {
  const stateHome = await mkdtemp(path.join(tmpdir(), "cope-cli-sessions-unreadable-"));
  context.after(async () => rm(stateHome, { recursive: true, force: true }));
  const sessionDirectory = path.join(stateHome, "sessions", "session_unreadable");
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(sessionDirectory, "session.json"), "{broken", { encoding: "utf8", mode: 0o600 });

  let human = "";
  await executeSessionsCommand(
    { command: "sessions", all: true, stateHome, json: false },
    { stdout: { write: (value) => { human += value; } }, stderr: { write: () => undefined } },
    createStandardUserHost(),
  );

  assert.match(human, /! Unreadable session/u);
  assert.match(human, /Recovery: reconcile required/u);
  assert.match(human, /session_unreadable/u);
  assert.match(human, /trusted recovery tooling/u);
  assert.match(human, /Updated: unknown/u);
});

function sessionState(): SessionState {
  const now = "2026-07-24T12:00:00.000Z";
  return {
    schemaVersion: 1,
    protocolVersion: "cba/1",
    sessionId: "session_cli_recovery",
    taskId: "task_cli_recovery",
    repositoryRoot: "/private/repository",
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
}
