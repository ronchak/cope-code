import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { BrowserIdentityVerifier, DiscoveredBrowser, EdgeCopilotTransport } from "../../src/browser/index.js";
import { executeDoctorCommand } from "../../src/cli/doctor.js";
import { configurationPaths, configureMachine } from "../../src/cli/onboarding.js";
import { createStandardUserHost } from "../helpers/standard-user-host.js";
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

const digest = "a".repeat(64);

test("doctor reports Chrome preview identity and privacy concisely while JSON includes evidence paths", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-doctor-browser-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const stateHome = path.join(root, "state");
  await mkdir(stateHome, { mode: 0o700 });
  const host = createStandardUserHost();
  const executablePath = "/verified/Google Chrome";
  const identityVerifier: BrowserIdentityVerifier = async (product, selectedPath) => ({
    product,
    executablePath: selectedPath,
    version: "149.0.1.2",
    executableSha256: digest,
    size: 42,
    modifiedMs: 1,
    evidence: {
      platform: "darwin",
      productName: "Google Chrome Stable",
      publisher: "EQHXZ8M8AV",
      identifier: "com.google.Chrome",
      signatureStatus: "valid",
    },
  });
  const chrome: DiscoveredBrowser = {
    ...(await identityVerifier("chrome", executablePath)),
    source: "automatic",
    locationLabel: "Found in Applications",
  };
  await configureMachine({
    paths: configurationPaths(stateHome, host),
    force: false,
    interactive: false,
    output: { write: () => undefined },
    host,
    browser: "chrome",
    identity: "person@example.com",
  }, {
    identityVerifier,
    discoverBrowsers: async () => [chrome],
    launchBrowser: async () => ({
      waitForSetupReadiness: async () => ({ classification: { state: "ready" } }),
      inspectSetupReadiness: async () => ({ classification: { state: "ready" } }),
      close: async () => undefined,
    } as unknown as EdgeCopilotTransport),
  });

  let human = "";
  await executeDoctorCommand({
    command: "doctor",
    repository: process.cwd(),
    stateHome,
    json: false,
  }, {
    stdout: { write: (value) => { human += value; } },
    stderr: { write: () => undefined },
  }, host, { browserIdentityVerifier: identityVerifier });
  assert.match(human, /Google Chrome Stable 149 — Chrome preview candidate \/ offline evidence only/u);
  assert.match(human, /Browser profile privacy: dedicated profile not created yet/u);
  assert.doesNotMatch(human, /\/verified\/Google Chrome|CopilotBrowserAgentChromeProfile/u);

  let json = "";
  await executeDoctorCommand({
    command: "doctor",
    repository: process.cwd(),
    stateHome,
    json: true,
  }, {
    stdout: { write: (value) => { json += value; } },
    stderr: { write: () => undefined },
  }, host, { browserIdentityVerifier: identityVerifier });
  const report = JSON.parse(json) as { checks: Array<{ name: string; evidence?: Record<string, unknown> }> };
  const browser = report.checks.find((check) => check.name === "Selected browser");
  assert.equal(browser?.evidence?.product, "chrome");
  assert.equal(browser?.evidence?.executable_path, executablePath);
  assert.equal(browser?.evidence?.support_track, "preview-candidate");
  assert.equal(browser?.evidence?.certification_status, "offline-evidence-only");

  let upgradedJson = "";
  await executeDoctorCommand({
    command: "doctor",
    repository: process.cwd(),
    stateHome,
    json: true,
  }, {
    stdout: { write: (value) => { upgradedJson += value; } },
    stderr: { write: () => undefined },
  }, host, {
    browserIdentityVerifier: async (product, selectedPath) => ({
      ...await identityVerifier(product, selectedPath),
      version: "150.0.1.3",
      executableSha256: "b".repeat(64),
    }),
  });
  const upgradedReport = JSON.parse(upgradedJson) as {
    checks: Array<{ name: string; ok: boolean; evidence?: Record<string, unknown> }>;
  };
  assert.equal(
    upgradedReport.checks.find((check) => check.name === "Selected browser")?.ok,
    true,
  );
  assert.equal(
    upgradedReport.checks.find((check) => check.name === "Selected browser")?.evidence?.version,
    "150.0.1.3",
  );
});

test("doctor orders stale-session recovery before missing browser setup", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-doctor-recovery-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const stateHome = path.join(root, "state");
  await mkdir(stateHome, { mode: 0o700 });
  const now = "2026-07-24T12:00:00.000Z";
  const state = recoverySessionState("session_doctor_recovery", now);
  const store = new SessionStore(stateHome);
  await store.create(state);
  await writeRuntimeManifest(store.sessionDirectory(state.sessionId), {
    schema_version: SESSION_RUNTIME_MANIFEST_VERSION,
    transport: "edge",
    browser_config_sha256: "a".repeat(64),
    created_at: now,
  });

  let human = "";
  await executeDoctorCommand({
    command: "doctor",
    repository: process.cwd(),
    stateHome,
    json: false,
  }, {
    stdout: { write: (value) => { human += value; } },
    stderr: { write: () => undefined },
  }, createStandardUserHost());
  const recoveryIndex = human.indexOf("Session recovery:");
  const setupIndex = human.indexOf("Browser setup:");
  assert.ok(recoveryIndex >= 0);
  assert.ok(setupIndex > recoveryIndex);
  assert.match(human, /cope abort session_doctor_recovery/u);
  assert.match(human, /resolve session recovery before setup/iu);
});

test("doctor reports a resume candidate before an otherwise-required setup retry", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-doctor-resume-candidate-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const stateHome = path.join(root, "state");
  await mkdir(path.join(stateHome, "config"), { recursive: true, mode: 0o700 });
  const executablePath = path.join(root, "edge");
  await writeFile(executablePath, "edge", "utf8");
  const now = "2026-07-24T12:00:00.000Z";
  const browser: BrowserFileConfig = {
    schema_version: "cba-browser-config/2",
    product: "edge",
    browser_contract_version: "cope-visible-browser/v1",
    entry_url: "https://m365.cloud.microsoft/chat",
    approved_hosts: [{ hostname: "m365.cloud.microsoft", allow_subdomains: false }],
    expected_identity: "person@example.com",
    require_protection_indicator: false,
    profile_directory: "/private/cope/edge",
    browser_executable: executablePath,
    browser_version: "149.0.1.2",
    browser_executable_sha256: digest,
  };
  await writeFile(
    path.join(stateHome, "config", "browser.json"),
    `${JSON.stringify(browser)}\n`,
    "utf8",
  );
  const state = recoverySessionState("session_doctor_resume", now);
  const store = new SessionStore(stateHome);
  await store.create(state);
  await writeRuntimeManifest(store.sessionDirectory(state.sessionId), {
    schema_version: SESSION_RUNTIME_MANIFEST_VERSION,
    transport: "edge",
    browser_config_sha256: sha256(stableJson(browser)),
    created_at: now,
  });

  let human = "";
  await executeDoctorCommand({
    command: "doctor",
    repository: process.cwd(),
    stateHome,
    json: false,
  }, {
    stdout: { write: (value) => { human += value; } },
    stderr: { write: () => undefined },
  }, createStandardUserHost(), {
    browserIdentityVerifier: async (product, selectedPath) => ({
      product,
      executablePath: await realpath(selectedPath),
      version: browser.browser_version,
      executableSha256: browser.browser_executable_sha256,
      size: 4,
      modifiedMs: 1,
      evidence: {
        platform: "darwin",
        productName: "Microsoft Edge Stable",
        publisher: "UBF8T346G9",
        identifier: "com.microsoft.edgemac",
        signatureStatus: "valid",
      },
    }),
  });

  const recoveryIndex = human.indexOf("Session recovery:");
  const setupIndex = human.indexOf("Browser setup:");
  assert.ok(recoveryIndex >= 0);
  assert.ok(setupIndex > recoveryIndex);
  assert.match(human, /cope resume session_doctor_resume/u);
  assert.match(human, /resolve session recovery before setup/iu);
});

function recoverySessionState(sessionId: string, now: string): SessionState {
  return {
    schemaVersion: 1,
    protocolVersion: "cba/1",
    sessionId,
    taskId: `task_${sessionId}`,
    repositoryRoot: process.cwd(),
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
