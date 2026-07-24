import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assessSessionRecovery,
  scanSessionRecovery,
} from "../../src/cli/session-recovery.js";
import {
  SESSION_RUNTIME_MANIFEST_VERSION,
  writeRuntimeManifest,
} from "../../src/cli/session-files.js";
import type { BrowserFileConfig } from "../../src/config/types.js";
import { SessionStore } from "../../src/session/store.js";
import {
  DEFAULT_BUDGET_LIMITS,
  zeroBudgetUsage,
  type SessionState,
  type SessionStatus,
} from "../../src/session/types.js";
import { sha256, stableJson } from "../../src/shared/crypto.js";

const now = "2026-07-24T12:00:00.000Z";

test("live recovery distinguishes matching, missing, invalid, and changed browser configuration", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-session-recovery-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const browser = browserConfig();
  const state = sessionState("session_recovery_static");
  const store = new SessionStore(root);
  await store.create(state);
  await writeRuntimeManifest(store.sessionDirectory(state.sessionId), {
    schema_version: SESSION_RUNTIME_MANIFEST_VERSION,
    transport: "edge",
    browser_config_sha256: sha256(stableJson(browser)),
    created_at: now,
  });

  assert.equal((await assessSessionRecovery(root, state)).disposition, "abort_required");
  assert.equal((await assessSessionRecovery(root, state)).reason, "BROWSER_CONFIG_MISSING");

  await mkdir(path.join(root, "config"), { recursive: true });
  await writeFile(path.join(root, "config", "browser.json"), "{broken", "utf8");
  assert.equal((await assessSessionRecovery(root, state)).reason, "BROWSER_CONFIG_INVALID");

  await writeFile(
    path.join(root, "config", "browser.json"),
    `${JSON.stringify({ ...browser, expected_identity: "other@example.com" })}\n`,
    "utf8",
  );
  assert.equal((await assessSessionRecovery(root, state)).reason, "BROWSER_CONFIG_CHANGED");

  await writeFile(path.join(root, "config", "browser.json"), `${JSON.stringify(browser)}\n`, "utf8");
  const matching = await assessSessionRecovery(root, state);
  assert.equal(matching.disposition, "resume_candidate");
  assert.equal(matching.reason, undefined);
  const stateHomeArgument = /^[A-Za-z0-9_./:@=-]+$/u.test(root)
    ? root
    : `"${root.replaceAll("\"", "\\\"")}"`;
  assert.equal(
    matching.next,
    `cope resume session_recovery_static --state-home ${stateHomeArgument}`,
  );
});

test("missing browser configuration requires reconciliation when mutation evidence exists", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-session-recovery-mutation-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const state = sessionState("session_recovery_mutation");
  state.mutationSequence = 1;
  state.mutations.push({
    operationId: "operation_1",
    checkpointId: "checkpoint_1",
    changedPaths: ["tracked.txt"],
    changedLines: 1,
    completedAt: now,
    repositoryFingerprint: "f".repeat(64),
  });
  const store = new SessionStore(root);
  await store.create(state);
  await writeRuntimeManifest(store.sessionDirectory(state.sessionId), {
    schema_version: SESSION_RUNTIME_MANIFEST_VERSION,
    transport: "edge",
    browser_config_sha256: "a".repeat(64),
    created_at: now,
  });

  const assessment = await assessSessionRecovery(root, state);
  assert.equal(assessment.disposition, "reconcile_required");
  assert.equal(assessment.reason, "MUTATION_EVIDENCE_PRESENT");
  assert.match(assessment.next ?? "", /cope status session_recovery_mutation/u);
});

test("a pending read-only operation still permits abort when browser configuration is missing", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-session-recovery-read-only-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const state = sessionState("session_recovery_read_only");
  state.pendingOperations.push({
    operationId: "op-read-only",
    tool: "read_file",
    mutating: false,
    requestHash: "d".repeat(64),
    status: "indeterminate",
    acceptedAt: now,
  });
  const store = new SessionStore(root);
  await store.create(state);
  await writeRuntimeManifest(store.sessionDirectory(state.sessionId), {
    schema_version: SESSION_RUNTIME_MANIFEST_VERSION,
    transport: "edge",
    browser_config_sha256: "a".repeat(64),
    created_at: now,
  });

  const assessment = await assessSessionRecovery(root, state);
  assert.equal(assessment.disposition, "abort_required");
  assert.equal(assessment.reason, "BROWSER_CONFIG_MISSING");

  state.pendingOperations[0] = { ...state.pendingOperations[0]!, mutating: true };
  const mutatingAssessment = await assessSessionRecovery(root, state);
  assert.equal(mutatingAssessment.disposition, "reconcile_required");
  assert.equal(mutatingAssessment.reason, "MUTATION_EVIDENCE_PRESENT");
});

test("terminal sessions never require runtime or browser recovery inputs", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-session-recovery-terminal-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const state = sessionState("session_recovery_terminal", "failed");
  const store = new SessionStore(root);
  await store.create(state);

  const [assessment] = await scanSessionRecovery(root);
  assert.equal(assessment?.disposition, "terminal");
  assert.equal(assessment?.transport, undefined);
});

test("an unreadable nonterminal runtime manifest requires reconciliation", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-session-recovery-unreadable-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const state = sessionState("session_recovery_unreadable");
  const store = new SessionStore(root);
  await store.create(state);

  const assessment = await assessSessionRecovery(root, state);
  assert.equal(assessment.disposition, "reconcile_required");
  assert.equal(assessment.reason, "RUNTIME_MANIFEST_UNREADABLE");
});

function sessionState(
  sessionId: string,
  status: SessionStatus = "transport_starting",
): SessionState {
  return {
    schemaVersion: 1,
    protocolVersion: "cba/1",
    sessionId,
    taskId: `task_${sessionId}`,
    repositoryRoot: "/private/repository",
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
    ...(status === "failed"
      ? {
          completedAt: now,
          failure: { code: "TRANSPORT_UNAVAILABLE", message: "test" },
        }
      : {}),
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

function browserConfig(): BrowserFileConfig {
  return {
    schema_version: "cba-browser-config/2",
    product: "edge",
    browser_contract_version: "cope-visible-browser/v1",
    entry_url: "https://m365.cloud.microsoft/chat",
    approved_hosts: [{ hostname: "m365.cloud.microsoft", allow_subdomains: false }],
    expected_identity: "person@example.com",
    require_protection_indicator: false,
    profile_directory: "/private/cope/edge",
    browser_executable: "/verified/edge",
    browser_version: "149.0.1.2",
    browser_executable_sha256: "a".repeat(64),
  };
}
