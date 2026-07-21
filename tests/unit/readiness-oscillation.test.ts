import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserStateInspection } from "../../src/browser/copilot-browser-adapter.js";
import type { CopilotPageState } from "../../src/browser/classifier.js";
import type { CopilotSignal } from "../../src/browser/contracts.js";
import type { BrowserWaitConfig } from "../../src/browser/config.js";
import { waitForStableManualReadiness } from "../../src/browser/manual-readiness.js";

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
  shell: false,
  conversation: false,
  composer: false,
  send: false,
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

test("alternating non-manual diagnostics share one bounded hydration window", async () => {
  let now = 0;
  let calls = 0;

  const result = await waitForStableManualReadiness(
    async () => {
      const current = calls % 2 === 0
        ? inspection("unknown", "UNKNOWN_PAGE_STATE")
        : inspection("changed-selector", "UI_CONTRACT_QUORUM_FAILED");
      calls += 1;
      return current;
    },
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

test("recoverable dialogs reset intermittent unsafe-host samples for the full manual window", async () => {
  let now = 0;
  let calls = 0;

  const result = await waitForStableManualReadiness(
    async () => {
      const current = calls % 2 === 0
        ? inspection("unapproved-host", "HOST_NOT_APPROVED")
        : inspection("blocking-modal", "UNEXPECTED_BLOCKING_MODAL");
      calls += 1;
      return current;
    },
    waits,
    waits.manualReadinessMs,
    undefined,
    {
      monotonicNow: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    },
  );

  assert.equal(result.classification.state, "blocking-modal");
  assert.equal(calls, waits.manualReadinessMs / waits.pollMs);
  assert.equal(now, waits.manualReadinessMs);
});

function inspection(state: CopilotPageState, diagnosticCode: string): BrowserStateInspection {
  return {
    classification: { state, retryable: false, diagnosticCode },
    diagnostic: {
      uiContractVersion: "copilot-ui/v1:m365-2026-07",
      state,
      diagnosticCode,
      locatorQuorum,
    },
  };
}
