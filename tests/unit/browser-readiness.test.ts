import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserStateInspection } from "../../src/browser/copilot-browser-adapter.js";
import { browserReadinessGuidance } from "../../src/browser/diagnostics.js";
import { isTerminalEdgeReadinessInspection } from "../../src/browser/edge-launcher.js";
import {
  isTerminalManualReadinessState,
  waitForStableManualReadiness,
} from "../../src/browser/manual-readiness.js";
import type { BrowserWaitConfig } from "../../src/browser/config.js";
import type { CopilotPageState, PageClassification } from "../../src/browser/classifier.js";
import type { CopilotSignal } from "../../src/browser/contracts.js";
import { renderHumanError } from "../../src/cli/friendly-output.js";
import { AgentError } from "../../src/shared/errors.js";

const waits: BrowserWaitConfig = {
  actionMs: 1_000,
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

test("a persistent identity mismatch still fails closed after the UI hydration window", async () => {
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
  assert.equal(calls, 5);
  assert.equal(now, waits.actionMs);
});

test("an unapproved non-authentication host still fails on the short stable quorum", async () => {
  let now = 0;
  let calls = 0;
  const blocked = inspection("unapproved-host", "HOST_NOT_APPROVED");

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

  assert.equal(result.classification.state, "unapproved-host");
  assert.equal(calls, 4);
  assert.equal(now, waits.minimumStableMs);
});

test("an approved manual-authentication redirect can return to Copilot", async () => {
  let now = 0;
  let calls = 0;
  const sequence = [
    inspection("unapproved-host", "HOST_NOT_APPROVED"),
    inspection("unapproved-host", "HOST_NOT_APPROVED"),
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
      isTerminalInspection: (candidate) => candidate.classification.state !== "unapproved-host",
    },
  );

  assert.equal(result.classification.state, "ready");
  assert.equal(calls, 3);
  assert.equal(now, waits.pollMs * 2);
});

test("only a host-level Microsoft authentication redirect receives the long manual window", () => {
  assert.equal(
    isTerminalEdgeReadinessInspection(
      inspection("unapproved-host", "HOST_NOT_APPROVED"),
      true,
    ),
    false,
  );
  assert.equal(
    isTerminalEdgeReadinessInspection(
      inspection("unapproved-host", "HOST_NOT_APPROVED"),
      false,
    ),
    true,
  );
  assert.equal(
    isTerminalEdgeReadinessInspection(
      inspection("unapproved-host", "COPILOT_SURFACE_NOT_APPROVED"),
      true,
    ),
    true,
  );
  assert.equal(
    isTerminalEdgeReadinessInspection(
      inspection("sign-in-required", "MANUAL_SIGN_IN_REQUIRED"),
      false,
    ),
    false,
  );
});

test("a transient unknown page can hydrate into the certified Copilot surface", async () => {
  let now = 0;
  let calls = 0;
  const sequence = [
    inspection("unknown", "UNKNOWN_PAGE_STATE"),
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

test("a persistent unknown page returns a bounded diagnostic instead of waiting ten minutes", async () => {
  let now = 0;
  let calls = 0;
  const unknown = inspection("unknown", "UNKNOWN_PAGE_STATE");

  const result = await waitForStableManualReadiness(
    async () => { calls += 1; return unknown; },
    waits,
    waits.manualReadinessMs,
    undefined,
    {
      monotonicNow: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    },
  );

  assert.equal(result.classification.state, "unknown");
  assert.equal(calls, 5);
  assert.equal(now, waits.actionMs);
});

test("a visible blocking dialog retains the manual window and may recover", async () => {
  let now = 0;
  let calls = 0;

  const result = await waitForStableManualReadiness(
    async () => {
      calls += 1;
      return calls < 7
        ? inspection("blocking-modal", "UNEXPECTED_BLOCKING_MODAL")
        : inspection("ready", "READY");
    },
    waits,
    waits.manualReadinessMs,
    undefined,
    {
      monotonicNow: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    },
  );

  assert.equal(result.classification.state, "ready");
  assert.equal(calls, 7);
  assert.equal(now, waits.pollMs * 6);
  assert.equal(isTerminalManualReadinessState("blocking-modal"), false);
});

test("manual sign-in states retain the long readiness window and may recover", async () => {
  let now = 0;
  let calls = 0;

  const result = await waitForStableManualReadiness(
    async () => {
      calls += 1;
      return calls < 7
        ? inspection("sign-in-required", "MANUAL_SIGN_IN_REQUIRED")
        : inspection("ready", "READY");
    },
    waits,
    waits.manualReadinessMs,
    undefined,
    {
      monotonicNow: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    },
  );

  assert.equal(result.classification.state, "ready");
  assert.equal(now, waits.pollMs * 6);
  assert.equal(isTerminalManualReadinessState("sign-in-required"), false);
  assert.equal(isTerminalManualReadinessState("blocking-modal"), false);
  assert.equal(isTerminalManualReadinessState("unknown"), true);
  assert.equal(isTerminalManualReadinessState("streaming"), true);
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

test("human errors expose only the controlled page-change reason", () => {
  const output = renderHumanError(new AgentError(
    "TRANSPORT_INDETERMINATE",
    "The Copilot page changed during semantic readiness inspection",
    {
      diagnosticCode: "ACTIVE_PAGE_CHANGED_DURING_OBSERVATION",
      dispatchAttempted: false,
      observationChangeReason: "navigation-epoch",
    },
  ));

  assert.match(output, /Page-change reason: navigation-epoch/u);
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
