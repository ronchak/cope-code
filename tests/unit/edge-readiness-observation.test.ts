import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserStateInspection } from "../../src/browser/copilot-browser-adapter.js";
import { inspectEdgeReadinessOnce } from "../../src/browser/edge-launcher.js";
import type { CopilotSignal } from "../../src/browser/contracts.js";

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

const blockedInspection: BrowserStateInspection = {
  classification: {
    state: "unapproved-host",
    retryable: false,
    diagnosticCode: "HOST_NOT_APPROVED",
  },
  diagnostic: {
    uiContractVersion: "copilot-ui/v1:m365-2026-07",
    state: "unapproved-host",
    diagnosticCode: "HOST_NOT_APPROVED",
    locatorQuorum,
  },
};

test("Edge readiness performs one inspection instead of nesting the adapter manual wait", async () => {
  let inspections = 0;
  const result = await inspectEdgeReadinessOnce({
    inspectState: async () => {
      inspections += 1;
      return blockedInspection;
    },
  });

  assert.equal(result, blockedInspection);
  assert.equal(inspections, 1);
});

test("Edge readiness observes cancellation before inspecting the page", async () => {
  let inspections = 0;
  const controller = new AbortController();
  controller.abort(new Error("operator cancelled readiness"));

  await assert.rejects(
    inspectEdgeReadinessOnce({
      inspectState: async () => {
        inspections += 1;
        return blockedInspection;
      },
    }, controller.signal),
    /operator cancelled readiness/u,
  );
  assert.equal(inspections, 0);
});

test("Edge readiness observes cancellation that arrives during inspection", async () => {
  const controller = new AbortController();

  await assert.rejects(
    inspectEdgeReadinessOnce({
      inspectState: async () => {
        controller.abort(new Error("cancelled while inspecting"));
        return blockedInspection;
      },
    }, controller.signal),
    /cancelled while inspecting/u,
  );
});
