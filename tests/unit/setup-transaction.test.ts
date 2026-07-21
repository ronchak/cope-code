import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SESSION_RUNTIME_MANIFEST_VERSION,
  writeRuntimeManifest,
} from "../../src/cli/session-files.js";
import {
  commitBrowserSetup,
  pinBrowserConfigurationForSession,
  readBrowserConfigBaseline,
} from "../../src/cli/setup-transaction.js";
import type { BrowserFileConfig } from "../../src/config/types.js";
import { BrowserConfigTransactionLock } from "../../src/config/browser-config-lock.js";
import { UnsupportedHostPlatform } from "../../src/platform/index.js";
import { DEFAULT_ORGANIZATION_POLICY } from "../../src/policy/index.js";
import { SessionStore } from "../../src/session/store.js";
import { DEFAULT_BUDGET_LIMITS, zeroBudgetUsage, type SessionState } from "../../src/session/types.js";
import { AgentError } from "../../src/shared/errors.js";

const host = new UnsupportedHostPlatform("linux", "x64");

function browserConfig(product: "edge" | "chrome" = "edge"): BrowserFileConfig {
  return {
    schema_version: "cba-browser-config/2",
    product,
    browser_contract_version: "cope-visible-browser/v1",
    entry_url: "https://m365.cloud.microsoft/chat",
    approved_hosts: [{ hostname: "m365.cloud.microsoft", allow_subdomains: false }],
    expected_identity: "person@example.com",
    require_protection_indicator: false,
    profile_directory: `/private/cope/${product}`,
    browser_executable: `/verified/${product}`,
    browser_version: "149.0.1.2",
    browser_executable_sha256: "a".repeat(64),
  };
}

test("browser setup compare-and-swap catches edits both before and during final revalidation", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-setup-cas-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const configDirectory = path.join(root, "config");
  await mkdir(configDirectory, { recursive: true });
  const browserFile = path.join(configDirectory, "browser.json");
  const policyFile = path.join(configDirectory, "organization-policy.json");
  await writeFile(browserFile, "original\n", "utf8");
  const baseline = await readBrowserConfigBaseline(browserFile);
  await writeFile(browserFile, "changed-before\n", "utf8");
  await assert.rejects(
    commitBrowserSetup({
      stateHome: root,
      browserFile,
      browserBaseline: baseline,
      organizationPolicyFile: policyFile,
      browserConfig: browserConfig(),
      host,
      revalidate: async () => undefined,
    }),
    (error: unknown) => error instanceof AgentError &&
      error.details.diagnosticCode === "BROWSER_CONFIG_COMPARE_AND_SWAP_FAILED",
  );
  assert.equal(await readFile(browserFile, "utf8"), "changed-before\n");

  await writeFile(browserFile, "original\n", "utf8");
  await assert.rejects(
    commitBrowserSetup({
      stateHome: root,
      browserFile,
      browserBaseline: baseline,
      organizationPolicyFile: policyFile,
      browserConfig: browserConfig("chrome"),
      host,
      revalidate: async () => { await writeFile(browserFile, "changed-during\n", "utf8"); },
    }),
    (error: unknown) => error instanceof AgentError &&
      error.details.diagnosticCode === "BROWSER_CONFIG_COMPARE_AND_SWAP_FAILED",
  );
  assert.equal(await readFile(browserFile, "utf8"), "changed-during\n");
});

test("first-run policy creation uses compare-and-swap after readiness", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-setup-policy-cas-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const browserFile = path.join(root, "config", "browser.json");
  const policyFile = path.join(root, "config", "organization-policy.json");
  const baseline = await readBrowserConfigBaseline(browserFile);
  await assert.rejects(commitBrowserSetup({
    stateHome: root,
    browserFile,
    browserBaseline: baseline,
    organizationPolicyFile: policyFile,
    organizationPolicyToCreate: {
      ...DEFAULT_ORGANIZATION_POLICY,
      policy_id: "test",
      revision: "1",
    },
    browserConfig: browserConfig(),
    host,
    revalidate: async () => {
      await mkdir(path.dirname(policyFile), { recursive: true });
      await writeFile(policyFile, "managed-policy-appeared\n", "utf8");
    },
  }), (error: unknown) => error instanceof AgentError &&
    error.details.diagnosticCode === "SETUP_POLICY_COMPARE_AND_SWAP_FAILED");
  await assert.rejects(readFile(browserFile), { code: "ENOENT" });
  assert.equal(await readFile(policyFile, "utf8"), "managed-policy-appeared\n");
});

test("browser configuration lock is exclusive and stale recovery cannot delete a new owner", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-setup-lock-race-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const lockDirectory = path.join(root, "config", ".browser-config.lock");
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(path.join(lockDirectory, "owner.json"), JSON.stringify({
    version: 1,
    pid: 2_147_483_647,
    token: "browser-config-lock-stale-owner-token",
    createdAt: "2026-07-19T12:00:00.000Z",
  }), "utf8");
  const contenders = await Promise.allSettled([
    BrowserConfigTransactionLock.acquire(root),
    BrowserConfigTransactionLock.acquire(root),
  ]);
  const winners = contenders.filter((result): result is PromiseFulfilledResult<BrowserConfigTransactionLock> =>
    result.status === "fulfilled");
  assert.equal(winners.length, 1);
  assert.equal(contenders.filter((result) => result.status === "rejected").length, 1);
  await assert.rejects(
    BrowserConfigTransactionLock.acquire(root),
    (error: unknown) => error instanceof AgentError && error.details.diagnosticCode === "BROWSER_CONFIG_LOCKED",
  );
  await winners[0]!.value.release();
  const afterRelease = await BrowserConfigTransactionLock.acquire(root);
  await afterRelease.release();
});

test("session pinning rejects a browser hash race before writing its runtime manifest", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-session-pin-race-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  let manifestWritten = false;
  await assert.rejects(pinBrowserConfigurationForSession({
    stateHome: root,
    expectedBrowserHash: "a".repeat(64),
    loadCurrent: async () => ({ hashes: { browser: "b".repeat(64) } }),
    writeManifest: async () => { manifestWritten = true; },
  }), (error: unknown) => error instanceof AgentError &&
    error.details.diagnosticCode === "BROWSER_CONFIG_START_RACE");
  assert.equal(manifestWritten, false);
});

test("browser setup blocks on unreadable resumable session state and leaves configuration untouched", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-setup-session-scan-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const configDirectory = path.join(root, "config");
  const browserFile = path.join(configDirectory, "browser.json");
  const policyFile = path.join(configDirectory, "organization-policy.json");
  await mkdir(path.join(root, "sessions", "session_unreadable"), { recursive: true });
  await mkdir(configDirectory, { recursive: true });
  await writeFile(browserFile, "original\n", "utf8");
  const baseline = await readBrowserConfigBaseline(browserFile);
  await assert.rejects(
    commitBrowserSetup({
      stateHome: root,
      browserFile,
      browserBaseline: baseline,
      organizationPolicyFile: policyFile,
      browserConfig: browserConfig("chrome"),
      host,
      revalidate: async () => undefined,
    }),
    (error: unknown) => error instanceof AgentError &&
      error.details.diagnosticCode === "BROWSER_CONFIG_SESSION_SCAN_FAILED",
  );
  assert.equal(await readFile(browserFile, "utf8"), "original\n");
});

test("browser setup refuses a valid resumable live-browser session", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-setup-live-session-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const configDirectory = path.join(root, "config");
  const browserFile = path.join(configDirectory, "browser.json");
  const policyFile = path.join(configDirectory, "organization-policy.json");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(browserFile, "original\n", "utf8");
  const baseline = await readBrowserConfigBaseline(browserFile);
  const now = "2026-07-19T12:00:00.000Z";
  const state: SessionState = {
    schemaVersion: 1,
    protocolVersion: "cba/1",
    sessionId: "session_live_setup",
    taskId: "task_live_setup",
    repositoryRoot: path.join(root, "repository"),
    repositoryFingerprintAtStart: "f".repeat(64),
    repositoryExcludedStateAtStart: "0".repeat(64),
    preExistingChanges: [],
    objective: "Keep the browser session resumable",
    acceptanceCriteria: [],
    mode: "edit",
    status: "paused",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    pauseReason: "test",
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
  const store = new SessionStore(root);
  await store.create(state);
  await writeRuntimeManifest(store.sessionDirectory(state.sessionId), {
    schema_version: SESSION_RUNTIME_MANIFEST_VERSION,
    transport: "edge",
    browser_config_sha256: "d".repeat(64),
    created_at: now,
  });
  await assert.rejects(
    commitBrowserSetup({
      stateHome: root,
      browserFile,
      browserBaseline: baseline,
      organizationPolicyFile: policyFile,
      browserConfig: browserConfig("chrome"),
      host,
      revalidate: async () => undefined,
    }),
    (error: unknown) => error instanceof AgentError &&
      error.details.diagnosticCode === "BROWSER_CONFIG_RESUMABLE_SESSION",
  );
  assert.equal(await readFile(browserFile, "utf8"), "original\n");
});
