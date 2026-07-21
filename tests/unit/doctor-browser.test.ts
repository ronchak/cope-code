import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { BrowserIdentityVerifier, DiscoveredBrowser, EdgeCopilotTransport } from "../../src/browser/index.js";
import { executeDoctorCommand } from "../../src/cli/doctor.js";
import { configurationPaths, configureMachine } from "../../src/cli/onboarding.js";
import { UnsupportedHostPlatform } from "../../src/platform/index.js";

const digest = "a".repeat(64);

test("doctor reports Chrome preview identity and privacy concisely while JSON includes evidence paths", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-doctor-browser-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const stateHome = path.join(root, "state");
  await mkdir(stateHome, { mode: 0o700 });
  const host = new UnsupportedHostPlatform("linux", "x64");
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
      waitForManualReadiness: async () => ({ classification: { state: "ready" } }),
      inspectState: async () => ({ classification: { state: "ready" } }),
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
});
