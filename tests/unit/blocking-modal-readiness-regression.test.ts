import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserStateInspection } from "../../src/browser/copilot-browser-adapter.js";
import type { CopilotPageState } from "../../src/browser/classifier.js";
import type { BrowserWaitConfig } from "../../src/browser/config.js";
import type { CopilotSignal } from "../../src/browser/contracts.js";
import {
  isTerminalManualReadinessState,
  waitForStableManualReadiness,
} from "../../src/browser/manual-readiness.js";

const waits: BrowserWaitConfig = {
  actionMs: 1_000,
  submissionConfirmationMs: 1_000,
  responseMs: 1_000,
  manualReadinessMs: 5_000,
  pollMs: 250,
  stableSamples: 3,
  minimumStableMs: 750,
};

const locatorQuorum = Object.fromEntries([
  "shell",
  "conversation",
  "composer",
  "send",
  "responses",
  "user-messages",
  "streaming",
  "identity",
  "protection",
  "signed-out",
  "mfa",
  "consent",
  "throttled",
  "service-error",
  "modal",
].map((signal) => [signal, false])) as Readonly<Record<CopilotSignal, boolean>>;

test("a visible blocking dialog remains non-ready but can be cleared during the manual window", async () => {
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

  assert.equal(isTerminalManualReadinessState("blocking-modal"), false);
  assert.equal(result.classification.state, "ready");
  assert.equal(calls, 7);
  assert.equal(now, waits.pollMs * 6);
});

test("an unapproved host remains a short fail despite the dialog exception", async () => {
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
