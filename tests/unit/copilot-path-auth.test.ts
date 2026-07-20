import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyCopilotPage,
  observeCopilotPage,
} from "../../src/browser/classifier.js";
import { createBaselineCopilotUiContract } from "../../src/browser/config.js";
import type {
  CopilotSignal,
  GroupSnapshot,
  LocatorGroup,
  SemanticPage,
} from "../../src/browser/contracts.js";

class SignalPage implements SemanticPage {
  public constructor(
    private readonly url: string,
    private readonly signals: ReadonlySet<CopilotSignal>,
    private readonly identity: string,
  ) {}

  public async currentUrl(): Promise<string> { return this.url; }

  public async snapshot(group: LocatorGroup): Promise<GroupSnapshot> {
    const visible = this.signals.has(group.signal);
    return {
      signal: group.signal,
      matchedCandidates: visible ? group.minimumCandidateMatches : 0,
      visibleElements: visible ? 1 : 0,
      enabledElements: visible ? 1 : 0,
      elements: visible
        ? [{
            visible: true,
            enabled: true,
            text: group.signal === "identity" ? this.identity : group.signal,
            value: "",
            accessibleLabel: group.signal === "identity" ? this.identity : group.signal,
          }]
        : [],
    };
  }

  public async fill(): Promise<void> { throw new Error("not used"); }
  public async click(): Promise<void> { throw new Error("not used"); }
  public async press(): Promise<void> { throw new Error("not used"); }
}

const identity = "Synthetic Work Account";
const contract = createBaselineCopilotUiContract(identity);
const requirements = {
  entryUrl: "https://m365.cloud.microsoft/chat",
  approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
  expectedIdentity: identity,
  requireProtectionIndicator: true,
} as const;

test("explicit same-host sign-in evidence remains retryable outside the chat path", async () => {
  const observation = await observeCopilotPage(
    new SignalPage(
      "https://m365.cloud.microsoft/auth/continue",
      new Set<CopilotSignal>(["signed-out"]),
      identity,
    ),
    contract,
  );

  const classification = classifyCopilotPage(observation, contract, requirements);
  assert.equal(classification.state, "sign-in-required");
  assert.equal(classification.diagnosticCode, "MANUAL_SIGN_IN_REQUIRED");
});

test("an arbitrary same-host page cannot become ready outside the configured chat path", async () => {
  const observation = await observeCopilotPage(
    new SignalPage(
      "https://m365.cloud.microsoft/search",
      new Set<CopilotSignal>([
        "shell",
        "conversation",
        "composer",
        "identity",
        "protection",
      ]),
      identity,
    ),
    contract,
  );

  const classification = classifyCopilotPage(observation, contract, requirements);
  assert.equal(classification.state, "unapproved-host");
  assert.equal(classification.diagnosticCode, "COPILOT_SURFACE_NOT_APPROVED");
});
