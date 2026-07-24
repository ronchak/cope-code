import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { BrowserIdentityVerifier } from "../../src/browser/index.js";
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
  const browserIdentityHash = "e".repeat(64);
  const state = sessionState("session_recovery_static");
  const store = new SessionStore(root);
  await store.create(state);
  await writeRuntimeManifest(store.sessionDirectory(state.sessionId), {
    schema_version: SESSION_RUNTIME_MANIFEST_VERSION,
    transport: "edge",
    browser_config_sha256: sha256(stableJson(browser)),
    browser_identity_sha256: browserIdentityHash,
    created_at: now,
  });

  assert.equal((await assessSessionRecovery(root, state)).disposition, "abort_required");
  assert.equal((await assessSessionRecovery(root, state)).reason, "BROWSER_CONFIG_MISSING");

  await mkdir(path.join(root, "config"), { recursive: true });
  await writeFile(path.join(root, "config", "browser.json"), "{broken", "utf8");
  assert.equal((await assessSessionRecovery(root, state)).reason, "BROWSER_CONFIG_INVALID");

  const changedBrowser = { ...browser, expected_identity: "other@example.com" };
  await writeFile(
    path.join(root, "config", "browser.json"),
    `${JSON.stringify(changedBrowser)}\n`,
    "utf8",
  );
  assert.equal((await assessSessionRecovery(root, state, {
    status: "valid",
    hash: sha256(stableJson(changedBrowser)),
    identityHash: browserIdentityHash,
  })).reason, "BROWSER_CONFIG_CHANGED");

  await writeFile(path.join(root, "config", "browser.json"), `${JSON.stringify(browser)}\n`, "utf8");
  const matchingEvidence = {
    status: "valid",
    hash: sha256(stableJson(browser)),
    identityHash: browserIdentityHash,
  } as const;
  const matching = await assessSessionRecovery(root, state, matchingEvidence);
  assert.equal(matching.disposition, "resume_candidate");
  assert.equal(matching.reason, undefined);
  const identityChanged = await assessSessionRecovery(root, state, {
    ...matchingEvidence,
    identityHash: "d".repeat(64),
  });
  assert.equal(identityChanged.disposition, "abort_required");
  assert.equal(identityChanged.reason, "BROWSER_IDENTITY_CHANGED");
  const stateHomeArgument = /^[A-Za-z0-9_./:@=-]+$/u.test(root)
    ? root
    : process.platform === "win32"
      ? `'${root.replaceAll("'", "''")}'`
      : `'${root.replaceAll("'", "'\"'\"'")}'`;
  assert.equal(
    matching.next,
    `cope resume session_recovery_static --state-home ${stateHomeArgument}`,
  );
});

test("shared recovery scan validates current browser executable identity", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-session-recovery-identity-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const executablePath = path.join(root, "edge");
  await writeFile(executablePath, "edge", "utf8");
  const browser = {
    ...browserConfig(),
    browser_executable: executablePath,
  };
  await mkdir(path.join(root, "config"), { recursive: true });
  await writeFile(
    path.join(root, "config", "browser.json"),
    `${JSON.stringify(browser)}\n`,
    "utf8",
  );
  const state = sessionState("session_recovery_identity");
  const store = new SessionStore(root);
  await store.create(state);
  await writeRuntimeManifest(store.sessionDirectory(state.sessionId), {
    schema_version: SESSION_RUNTIME_MANIFEST_VERSION,
    transport: "edge",
    browser_config_sha256: sha256(stableJson(browser)),
    browser_identity_sha256: "e".repeat(64),
    created_at: now,
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

  const [assessment] = await scanSessionRecovery(
    root,
    undefined,
    undefined,
    identityVerifier,
  );
  assert.equal(assessment?.disposition, "abort_required");
  assert.equal(assessment?.reason, "BROWSER_IDENTITY_CHANGED");
  assert.match(assessment?.next ?? "", /cope abort session_recovery_identity/u);

  const compatibleVerifier: BrowserIdentityVerifier = async (product, selectedPath) => ({
    ...(await identityVerifier(product, selectedPath)),
    version: "150.0.0.0",
  });
  const verifiedUpgrade = await compatibleVerifier(browser.product, executablePath);
  const compatibleLegacyPin = sha256(stableJson({
    product: browser.product,
    executable_path: verifiedUpgrade.executablePath,
    version: browser.browser_version,
    executable_sha256: browser.browser_executable_sha256,
  }));
  await writeRuntimeManifest(store.sessionDirectory(state.sessionId), {
    schema_version: SESSION_RUNTIME_MANIFEST_VERSION,
    transport: "edge",
    browser_config_sha256: sha256(stableJson(browser)),
    browser_identity_sha256: compatibleLegacyPin,
    created_at: now,
  });
  const [compatibleAssessment] = await scanSessionRecovery(
    root,
    undefined,
    undefined,
    compatibleVerifier,
  );
  assert.equal(compatibleAssessment?.disposition, "resume_candidate");
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

test("pre-grant startup is never advertised as resumable even with matching runtime pins", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-session-recovery-pre-grant-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const browser = browserConfig();
  const state = sessionState("session_recovery_pre_grant", "preflight");
  const store = new SessionStore(root);
  await store.create(state);
  await writeRuntimeManifest(store.sessionDirectory(state.sessionId), {
    schema_version: SESSION_RUNTIME_MANIFEST_VERSION,
    transport: "edge",
    browser_config_sha256: sha256(stableJson(browser)),
    created_at: now,
  });
  await mkdir(path.join(root, "config"), { recursive: true });
  await writeFile(path.join(root, "config", "browser.json"), `${JSON.stringify(browser)}\n`, "utf8");

  const assessment = await assessSessionRecovery(root, state);
  assert.equal(assessment.disposition, "abort_required");
  assert.equal(assessment.reason, "SESSION_STARTUP_INCOMPLETE");
  assert.match(assessment.next ?? "", /cope abort session_recovery_pre_grant/u);
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
