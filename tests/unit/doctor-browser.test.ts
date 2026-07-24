import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
  const state: SessionState = {
    schemaVersion: 1,
    protocolVersion: "cba/1",
    sessionId: "session_doctor_recovery",
    taskId: "task_doctor_recovery",
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
