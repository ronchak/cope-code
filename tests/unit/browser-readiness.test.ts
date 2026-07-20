import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserStateInspection } from "../../src/browser/copilot-browser-adapter.js";
import { browserReadinessGuidance } from "../../src/browser/diagnostics.js";
import { waitForStableManualReadiness } from "../../src/browser/manual-readiness.js";
import type { BrowserWaitConfig } from "../../src/browser/config.js";
import type { CopilotPageState, PageClassification } from "../../src/browser/classifier.js";
import type { CopilotSignal } from "../../src/browser/contracts.js";
import { renderHumanError } from "../../src/cli/friendly-output.js";
import { AgentError } from "../../src/shared/errors.js";

const waits: BrowserWaitConfig = {
  actionMs: 15_000,
  submissionConfirmationMs: 12_000,
  responseMs: 180_000,
  manualReadinessMs: 5_000,
  pollMs: 250,
  stableSamples: 3,
  minimumStableMs: 750,
};

const locatorQuorum: Readonly<Record<CopilotSignal, boolean>> = {
  shell: true,
  conversation: true,
  composer: true,
  send: true,
  responses: false,
  "user-messages": false,
  streaming: false,
  identity: false,
  protection: false,
  "signed-out": false,
  mfa: false,
  consent: false,
  throttled: false,
  "service-error": false,
  modal: false,
};

test("a transient identity miss does not abort visible Edge readiness", async () => {
  let now = 0;
  let calls = 0;
  const sequence = [
    inspection("identity-unverified", "IDENTITY_NOT_VERIFIED"),
    inspection("ready", "READY"),
  ] as const;

  const result = await waitForStableManualReadiness(
    async () => sequence[Math.min(calls++, sequence.length - 1)]!,
    waits,
    waits.manualReadinessMs,
    undefined,
    {
      monotonicNow: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    },
  );

  assert.equal(result.classification.state, "ready");
  assert.equal(calls, 2);
  assert.equal(now, waits.pollMs);
});

test("a persistent unsafe readiness state still fails closed after a stable quorum", async () => {
  let now = 0;
  let calls = 0;
  const blocked = inspection("identity-unverified", "IDENTITY_NOT_VERIFIED");

  const result = await waitForStableManualReadiness(
    async () => { calls += 1; return blocked; },
    waits,
    waits.manualReadinessMs,
    undefined,
    {
      monotonicNow: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    },
  );

  assert.equal(result.classification.state, "identity-unverified");
  assert.equal(calls, 4);
  assert.equal(now, waits.minimumStableMs);
});

test("readiness diagnostics explain stale identity configuration without exposing identity data", () => {
  const classification: PageClassification = {
    state: "identity-unverified",
    retryable: false,
    diagnosticCode: "IDENTITY_NOT_VERIFIED",
  };
  const guidance = browserReadinessGuidance(classification, locatorQuorum);

  assert.match(guidance.summary ?? "", /could not verify the configured work account/u);
  assert.match(guidance.next ?? "", /cope setup --force/u);
  assert.deepEqual(guidance.missingSignals, ["identity"]);
  assert.equal(JSON.stringify(guidance).includes("someone@example.com"), false);
});

test("human errors surface the safe browser diagnostic and remediation", () => {
  const output = renderHumanError(new AgentError(
    "TRANSPORT_UNAVAILABLE",
    "The visible Copilot session did not reach a verified ready state",
    {
      state: "identity-unverified",
      diagnosticCode: "IDENTITY_NOT_VERIFIED",
      summary: "Copilot loaded, but Cope could not verify the configured work account.",
      next: "Run cope setup --force and enter the exact visible account.",
      missingSignals: ["identity"],
    },
  ));

  assert.match(output, /IDENTITY_NOT_VERIFIED/u);
  assert.match(output, /Missing browser signals: identity/u);
  assert.match(output, /cope setup --force/u);
});

function inspection(state: CopilotPageState, diagnosticCode: string): BrowserStateInspection {
  return {
    classification: { state, retryable: state === "ready", diagnosticCode },
    diagnostic: {
      uiContractVersion: "copilot-ui/v1",
      state,
      diagnosticCode,
      locatorQuorum,
    },
  };
}
