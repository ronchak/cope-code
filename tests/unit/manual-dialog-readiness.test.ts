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
  identity: true,
  protection: true,
  "signed-out": false,
  mfa: false,
  consent: false,
  throttled: false,
  "service-error": false,
  modal: true,
};

test("a visible blocking dialog retains the manual window and can recover", async () => {
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
});

test("dialogs are manual while unapproved hosts remain terminal", () => {
  assert.equal(isTerminalManualReadinessState("blocking-modal"), false);
  assert.equal(isTerminalManualReadinessState("unapproved-host"), true);
  assert.equal(isTerminalManualReadinessState("unknown"), true);
});

function inspection(state: CopilotPageState, diagnosticCode: string): BrowserStateInspection {
  return {
    classification: { state, retryable: state === "ready", diagnosticCode },
    diagnostic: {
      uiContractVersion: "copilot-ui/v1:m365-2026-07",
      state,
      diagnosticCode,
      locatorQuorum,
    },
  };
}
