import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyCopilotPage,
  type ClassifierRequirements,
} from "../../src/browser/classifier.js";
import { createBaselineCopilotUiContract } from "../../src/browser/config.js";
import type {
  CopilotPageObservation,
  CopilotSignal,
  GroupSnapshot,
} from "../../src/browser/contracts.js";
import {
  isTerminalEdgeReadinessInspection,
} from "../../src/browser/edge-launcher.js";

const signals: readonly CopilotSignal[] = [
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
const identity = "Synthetic Work Account";
const contract = createBaselineCopilotUiContract(identity);
const requirements: ClassifierRequirements = {
  entryUrl: "https://m365.cloud.microsoft/chat",
  approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
  expectedIdentity: identity,
  requireProtectionIndicator: false,
};

test("a sticky native browser dialog returns a bounded terminal diagnostic", () => {
  const classification = classifyCopilotPage(
    modalObservation(false),
    contract,
    requirements,
  );

  assert.equal(classification.state, "blocking-modal");
  assert.equal(classification.diagnosticCode, "NATIVE_BROWSER_DIALOG_DETECTED");
  assert.equal(
    isTerminalEdgeReadinessInspection(inspection(classification), false),
    true,
  );
});

test("a recoverable DOM dialog retains the operator window", () => {
  const classification = classifyCopilotPage(
    modalObservation(true),
    contract,
    requirements,
  );

  assert.equal(classification.state, "blocking-modal");
  assert.equal(classification.diagnosticCode, "UNEXPECTED_BLOCKING_MODAL");
  assert.equal(
    isTerminalEdgeReadinessInspection(inspection(classification), false),
    false,
  );
});

function modalObservation(enabled: boolean): CopilotPageObservation {
  const snapshots = Object.fromEntries(
    signals.map((signal) => [signal, snapshot(signal, signal === "modal", enabled)]),
  ) as Record<CopilotSignal, GroupSnapshot>;
  return {
    url: "https://m365.cloud.microsoft/chat/conversation/synthetic",
    ...snapshots,
  };
}

function snapshot(
  signal: CopilotSignal,
  visible: boolean,
  enabled: boolean,
): GroupSnapshot {
  return {
    signal,
    matchedCandidates: visible ? 1 : 0,
    visibleElements: visible ? 1 : 0,
    enabledElements: visible && enabled ? 1 : 0,
    elements: visible
      ? [{
          visible: true,
          enabled,
          text: "",
          value: "",
          accessibleLabel: "",
        }]
      : [],
  };
}

function inspection(
  classification: ReturnType<typeof classifyCopilotPage>,
) {
  return {
    classification,
    diagnostic: {
      uiContractVersion: contract.version,
      state: classification.state,
      diagnosticCode: classification.diagnosticCode,
      locatorQuorum: Object.fromEntries(
        signals.map((signal) => [signal, signal === "modal"]),
      ) as Readonly<Record<CopilotSignal, boolean>>,
    },
  };
}
