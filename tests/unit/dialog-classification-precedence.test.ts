import assert from "node:assert/strict";
import test from "node:test";

import { classifyCopilotPage } from "../../src/browser/classifier.js";
import { createBaselineCopilotUiContract } from "../../src/browser/config.js";
import type {
  CopilotPageObservation,
  CopilotSignal,
  ElementSnapshot,
  GroupSnapshot,
} from "../../src/browser/contracts.js";

const SIGNALS: readonly CopilotSignal[] = [
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
];

test("a recoverable dialog outranks generic service-error and throttling text", () => {
  const expectedIdentity = "Synthetic Work Account";
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  const snapshots = Object.fromEntries(
    SIGNALS.map((signal) => [
      signal,
      snapshot(signal, new Set<CopilotSignal>([
        "shell",
        "conversation",
        "composer",
        "send",
        "identity",
        "protection",
        "throttled",
        "service-error",
        "modal",
      ]).has(signal), signal === "modal" || signal === "composer" || signal === "send"),
    ]),
  ) as Record<CopilotSignal, GroupSnapshot>;
  snapshots.identity = snapshot("identity", true, true, expectedIdentity);
  snapshots.protection = snapshot("protection", true, true, "enterprise data protection");
  snapshots.throttled = snapshot("throttled", true, true, "Too many requests");
  snapshots["service-error"] = snapshot(
    "service-error",
    true,
    true,
    "Something went wrong",
  );
  snapshots.modal = snapshot("modal", true, true, "Something went wrong");

  const observation: CopilotPageObservation = {
    url: "https://m365.cloud.microsoft/chat/conversation/synthetic",
    ...snapshots,
  };
  const classification = classifyCopilotPage(observation, contract, {
    entryUrl: "https://m365.cloud.microsoft/chat",
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    expectedIdentity,
    requireProtectionIndicator: true,
  });

  assert.equal(classification.state, "blocking-modal");
  assert.equal(classification.diagnosticCode, "UNEXPECTED_BLOCKING_MODAL");
});

function snapshot(
  signal: CopilotSignal,
  visible: boolean,
  enabled: boolean,
  text: string = signal,
): GroupSnapshot {
  const elements: readonly ElementSnapshot[] = visible
    ? [{ visible: true, enabled, text, value: "", accessibleLabel: text }]
    : [];
  return {
    signal,
    matchedCandidates: visible ? 1 : 0,
    visibleElements: elements.length,
    enabledElements: elements.filter((element) => element.enabled).length,
    elements,
  };
}
