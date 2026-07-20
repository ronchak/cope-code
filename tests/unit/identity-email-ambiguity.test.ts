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

const entryUrl = "https://m365.cloud.microsoft/chat";
const readySignals = new Set<CopilotSignal>([
  "shell",
  "conversation",
  "composer",
  "send",
  "identity",
  "protection",
]);

class AccountControlPage implements SemanticPage {
  public constructor(private readonly accountText: string) {}

  public async currentUrl(): Promise<string> {
    return `${entryUrl}/conversation/synthetic`;
  }

  public async snapshot(group: LocatorGroup): Promise<GroupSnapshot> {
    const visible = readySignals.has(group.signal);
    return {
      signal: group.signal,
      matchedCandidates: visible ? group.minimumCandidateMatches : 0,
      visibleElements: visible ? 1 : 0,
      enabledElements: visible ? 1 : 0,
      elements: visible
        ? [{
            visible: true,
            enabled: true,
            text: group.signal === "identity" ? this.accountText : group.signal,
            value: "",
            accessibleLabel: group.signal === "identity" ? this.accountText : group.signal,
          }]
        : [],
    };
  }

  public async fill(_group: LocatorGroup, _value: string): Promise<void> {
    throw new Error("not used");
  }

  public async click(_group: LocatorGroup): Promise<void> {
    throw new Error("not used");
  }

  public async press(_group: LocatorGroup, _key: "Enter"): Promise<void> {
    throw new Error("not used");
  }
}

test("an account control containing multiple email addresses cannot verify identity", async () => {
  const expectedIdentity = "ronak@example.com";
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  const observation = await observeCopilotPage(
    new AccountControlPage("Switch from other@example.com to ronak@example.com"),
    contract,
  );

  const classification = classifyCopilotPage(observation, contract, {
    entryUrl,
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    expectedIdentity,
    requireProtectionIndicator: true,
  });

  assert.equal(classification.state, "identity-unverified");
  assert.equal(classification.diagnosticCode, "IDENTITY_NOT_VERIFIED");
});

test("one exact email wrapped in account-control text still verifies identity", async () => {
  const expectedIdentity = "ronak@example.com";
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  const observation = await observeCopilotPage(
    new AccountControlPage("Work account ronak@example.com"),
    contract,
  );

  const classification = classifyCopilotPage(observation, contract, {
    entryUrl,
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    expectedIdentity,
    requireProtectionIndicator: true,
  });

  assert.equal(classification.state, "ready");
});
