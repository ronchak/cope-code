import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { BrowserIdentityVerifier } from "../../src/browser/index.js";
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
import type { BrowserFileConfig } from "../../src/config/types.js";
import { sha256, stableJson } from "../../src/shared/crypto.js";
import { createStandardUserHost } from "../helpers/standard-user-host.js";

test("sessions marks a statically blocked live session with its exact recovery command", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-cli-sessions-recovery-"));
  const stateHome = path.join(root, "custom $USER `state`'s");
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
  const quotedStateHome = process.platform === "win32"
    ? `'${stateHome.replaceAll("'", "''")}'`
    : `'${stateHome.replaceAll("'", "'\"'\"'")}'`;
  assert.deepEqual(result.sessions[0]?.recovery, {
    disposition: "abort_required",
    reason: "BROWSER_CONFIG_MISSING",
    next: `cope abort session_cli_recovery --reason 'Discard interrupted session that cannot resume' ` +
      `--state-home ${quotedStateHome}`,
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

test("sessions --all treats an embedded session id mismatch as unreadable", async (context) => {
  const stateHome = await mkdtemp(path.join(tmpdir(), "cope-cli-sessions-id-mismatch-"));
  context.after(async () => rm(stateHome, { recursive: true, force: true }));
  const state = sessionState();
  const directoryId = "session_directory_identity";
  const sessionDirectory = path.join(stateHome, "sessions", directoryId);
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(sessionDirectory, "session.json"),
    `${JSON.stringify({ ...state, sessionId: "session_embedded_identity" })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  let human = "";
  await executeSessionsCommand(
    { command: "sessions", all: true, stateHome, json: false },
    { stdout: { write: (value) => { human += value; } }, stderr: { write: () => undefined } },
    createStandardUserHost(),
  );

  assert.match(human, /! Unreadable session/u);
  assert.match(human, new RegExp(directoryId, "u"));
  assert.doesNotMatch(human, /session_embedded_identity/u);
  assert.match(human, /trusted recovery tooling/u);
});

test("sessions --all does not advertise resume after browser identity drift", async (context) => {
  const stateHome = await mkdtemp(path.join(tmpdir(), "cope-cli-sessions-identity-"));
  context.after(async () => rm(stateHome, { recursive: true, force: true }));
  const executablePath = path.join(stateHome, "edge");
  await writeFile(executablePath, "edge", { encoding: "utf8", mode: 0o600 });
  const browser: BrowserFileConfig = {
    schema_version: "cba-browser-config/2",
    product: "edge",
    browser_contract_version: "cope-visible-browser/v1",
    entry_url: "https://m365.cloud.microsoft/chat",
    approved_hosts: [{ hostname: "m365.cloud.microsoft", allow_subdomains: false }],
    expected_identity: "person@example.com",
    require_protection_indicator: false,
    profile_directory: path.join(stateHome, "profiles", "edge"),
    browser_executable: executablePath,
    browser_version: "149.0.1.2",
    browser_executable_sha256: "a".repeat(64),
  };
  await mkdir(path.join(stateHome, "config"), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(stateHome, "config", "browser.json"),
    `${JSON.stringify(browser)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const state = sessionState();
  const store = new SessionStore(stateHome);
  await store.create(state);
  await writeRuntimeManifest(store.sessionDirectory(state.sessionId), {
    schema_version: SESSION_RUNTIME_MANIFEST_VERSION,
    transport: "edge",
    browser_config_sha256: sha256(stableJson(browser)),
    browser_identity_sha256: "e".repeat(64),
    created_at: state.createdAt,
  });
  const identityVerifier: BrowserIdentityVerifier = async (product, selectedPath) => ({
    product,
    executablePath: await realpath(selectedPath),
    version: browser.browser_version,
    executableSha256: "b".repeat(64),
    size: 4,
    modifiedMs: 1,
    evidence: {
      platform: "darwin",
      productName: "Microsoft Edge Stable",
      publisher: "UBF8T346G9",
      identifier: "com.microsoft.edgemac",
      signatureStatus: "valid",
    },
  });

  let human = "";
  await executeSessionsCommand(
    { command: "sessions", all: true, stateHome, json: false },
    { stdout: { write: (value) => { human += value; } }, stderr: { write: () => undefined } },
    createStandardUserHost(),
    identityVerifier,
  );

  assert.match(human, /! Verify browser uptime/u);
  assert.match(human, /verified browser executable no longer matches/u);
  assert.match(human, /cope abort session_cli_recovery/u);
  assert.doesNotMatch(human, /\* Verify browser uptime/u);
  assert.doesNotMatch(human, /cope resume/u);
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
