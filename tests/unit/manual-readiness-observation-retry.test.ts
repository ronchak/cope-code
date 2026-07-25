import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserStateInspection } from "../../src/browser/copilot-browser-adapter.js";
import type { BrowserWaitConfig } from "../../src/browser/config.js";
import {
  isRecoverableManualReadinessObservationError,
  waitForStableManualReadiness,
} from "../../src/browser/manual-readiness.js";
import { AgentError } from "../../src/shared/errors.js";

const waits: BrowserWaitConfig = {
  actionMs: 20,
  submissionConfirmationMs: 20,
  responseMs: 100,
  manualReadinessMs: 100,
  pollMs: 10,
  stableSamples: 2,
  minimumStableMs: 10,
};

test("manual readiness retries a pre-dispatch observation invalidated by page change", async () => {
  let now = 0;
  let calls = 0;
  const sleeps: number[] = [];
  const invalidation = changedObservation();

  const result = await waitForStableManualReadiness(
    async () => {
      calls += 1;
      if (calls === 1) throw invalidation;
      return inspection("ready", "READY");
    },
    waits,
    waits.manualReadinessMs,
    undefined,
    {
      monotonicNow: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    },
  );

  assert.equal(result.classification.state, "ready");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [10]);
});

test("page-change invalidation clears stability evidence from the prior document", async () => {
  let now = 0;
  let calls = 0;

  const result = await waitForStableManualReadiness(
    async () => {
      calls += 1;
      if (calls === 1) return inspection("service-error", "SERVICE_ERROR_VISIBLE");
      if (calls === 2) throw changedObservation();
      if (calls === 3) return inspection("service-error", "SERVICE_ERROR_VISIBLE");
      return inspection("ready", "READY");
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
  assert.equal(calls, 4);
});

test("repeated page-change invalidation remains bounded by the manual readiness deadline", async () => {
  let now = 0;
  let calls = 0;
  const boundedWaits = { ...waits, manualReadinessMs: 25 };

  await assert.rejects(
    waitForStableManualReadiness(
      async () => {
        calls += 1;
        now += 3;
        throw changedObservation();
      },
      boundedWaits,
      boundedWaits.manualReadinessMs,
      undefined,
      {
        monotonicNow: () => now,
        sleep: async (milliseconds) => { now += milliseconds; },
      },
    ),
    (error: unknown) => isRecoverableManualReadinessObservationError(error),
  );

  assert.equal(now, 25);
  assert.equal(calls, 3);
});

test("manual readiness does not retry other browser failures", async () => {
  for (const error of [
    new AgentError(
      "TRANSPORT_INDETERMINATE",
      "Renderer operation timed out",
      { diagnosticCode: "BROWSER_OPERATION_TIMEOUT", dispatchAttempted: false },
    ),
    new AgentError(
      "TRANSPORT_INDETERMINATE",
      "Page changed after dispatch",
      { diagnosticCode: "ACTIVE_PAGE_CHANGED_DURING_OBSERVATION", dispatchAttempted: true },
    ),
  ]) {
    let calls = 0;
    let sleeps = 0;

    await assert.rejects(
      waitForStableManualReadiness(
        async () => {
          calls += 1;
          throw error;
        },
        waits,
        waits.manualReadinessMs,
        undefined,
        {
          monotonicNow: () => 0,
          sleep: async () => { sleeps += 1; },
        },
      ),
      (observed: unknown) => observed === error,
    );

    assert.equal(calls, 1);
    assert.equal(sleeps, 0);
  }
});

test("manual readiness never retries ambiguous page ownership", async () => {
  const ambiguity = new AgentError(
    "TRANSPORT_INDETERMINATE",
    "Multiple configured Copilot pages are open",
    { diagnosticCode: "AMBIGUOUS_COPILOT_PAGE", dispatchAttempted: false },
  );
  let calls = 0;
  let sleeps = 0;

  await assert.rejects(
    waitForStableManualReadiness(
      async () => {
        calls += 1;
        throw ambiguity;
      },
      waits,
      waits.manualReadinessMs,
      undefined,
      {
        monotonicNow: () => 0,
        sleep: async () => { sleeps += 1; },
      },
    ),
    (error: unknown) => error === ambiguity,
  );

  assert.equal(calls, 1);
  assert.equal(sleeps, 0);
});

test("cancellation racing a page-change invalidation wins without another retry", async () => {
  const controller = new AbortController();
  const cancellation = new Error("operator cancelled readiness");
  let calls = 0;
  let sleeps = 0;

  await assert.rejects(
    waitForStableManualReadiness(
      async () => {
        calls += 1;
        controller.abort(cancellation);
        throw changedObservation();
      },
      waits,
      waits.manualReadinessMs,
      controller.signal,
      {
        monotonicNow: () => 0,
        sleep: async () => { sleeps += 1; },
      },
    ),
    (error: unknown) => error === cancellation,
  );

  assert.equal(calls, 1);
  assert.equal(sleeps, 0);
});

function changedObservation(): AgentError {
  return new AgentError(
    "TRANSPORT_INDETERMINATE",
    "The Copilot page changed during semantic readiness inspection",
    {
      diagnosticCode: "ACTIVE_PAGE_CHANGED_DURING_OBSERVATION",
      dispatchAttempted: false,
    },
  );
}

function inspection(
  state: BrowserStateInspection["classification"]["state"],
  diagnosticCode: string,
): BrowserStateInspection {
  return {
    classification: {
      state,
      retryable: state !== "ready",
      diagnosticCode,
    },
    diagnostic: {
      uiContractVersion: "test/v1",
      state,
      diagnosticCode,
      locatorQuorum: {} as BrowserStateInspection["diagnostic"]["locatorQuorum"],
    },
  };
}
