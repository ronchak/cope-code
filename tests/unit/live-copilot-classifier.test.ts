import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyCopilotPage,
  observeCopilotPage,
  type ClassifierRequirements,
} from "../../src/browser/classifier.js";
import { createBaselineCopilotUiContract } from "../../src/browser/config.js";
import type {
  CopilotSignal,
  GroupSnapshot,
  LocatorGroup,
  SemanticPage,
} from "../../src/browser/contracts.js";

const readySignals = new Set<CopilotSignal>([
  "shell",
  "conversation",
  "composer",
  "send",
  "identity",
  "protection",
]);

class LiveShapePage implements SemanticPage {
  public constructor(
    private readonly identityText: string,
    private readonly composerEnabled = true,
  ) {}

  public async currentUrl(): Promise<string> {
    return "https://m365.cloud.microsoft/chat/conversation/synthetic";
  }

  public async snapshot(group: LocatorGroup): Promise<GroupSnapshot> {
    const visible = readySignals.has(group.signal);
    const enabled = visible && (group.signal !== "composer" || this.composerEnabled);
    return {
      signal: group.signal,
      matchedCandidates: visible ? group.minimumCandidateMatches : 0,
      visibleElements: visible ? 1 : 0,
      enabledElements: enabled ? 1 : 0,
      elements: visible
        ? [{
            visible: true,
            enabled,
            text: group.signal === "identity" ? this.identityText : group.signal,
            value: "",
            accessibleLabel: group.signal === "identity" ? this.identityText : group.signal,
          }]
        : [],
    };
  }

  public async fill(): Promise<void> { throw new Error("not used"); }
  public async click(): Promise<void> { throw new Error("not used"); }
  public async press(): Promise<void> { throw new Error("not used"); }
}

function requirements(expectedIdentity: string): ClassifierRequirements {
  return {
    entryUrl: "https://m365.cloud.microsoft/chat",
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    expectedIdentity,
    requireProtectionIndicator: true,
  };
}

test("surname-first Microsoft account text verifies the configured display name", async () => {
  const expectedIdentity = "Ronak Chakraborty";
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  const observation = await observeCopilotPage(
    new LiveShapePage("Chakraborty, Ronak"),
    contract,
  );

  const classification = classifyCopilotPage(
    observation,
    contract,
    requirements(expectedIdentity),
  );

  assert.equal(classification.state, "ready");
});

test("surname-first matching preserves first and middle name order", async () => {
  const expectedIdentity = "Ronak Kumar Chakraborty";
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  const observation = await observeCopilotPage(
    new LiveShapePage("Chakraborty, Ronak Kumar"),
    contract,
  );

  const classification = classifyCopilotPage(
    observation,
    contract,
    requirements(expectedIdentity),
  );

  assert.equal(classification.state, "ready");
});

test("an email wrapped in account-button text still verifies the exact configured address", async () => {
  const expectedIdentity = "ronak@example.com";
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  const observation = await observeCopilotPage(
    new LiveShapePage("Work account ronak@example.com"),
    contract,
  );

  const classification = classifyCopilotPage(
    observation,
    contract,
    requirements(expectedIdentity),
  );

  assert.equal(classification.state, "ready");
});

test("an address that merely contains the configured email is rejected", async () => {
  const expectedIdentity = "ronak@example.com";
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  const observation = await observeCopilotPage(
    new LiveShapePage("Work account notronak@example.com"),
    contract,
  );

  const classification = classifyCopilotPage(
    observation,
    contract,
    requirements(expectedIdentity),
  );

  assert.equal(classification.state, "identity-unverified");
});

test("identity token matching rejects extra name tokens between expected tokens", async () => {
  const expectedIdentity = "Ronak Chakraborty";
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  const observation = await observeCopilotPage(
    new LiveShapePage("Ronak Other Chakraborty"),
    contract,
  );

  const classification = classifyCopilotPage(
    observation,
    contract,
    requirements(expectedIdentity),
  );

  assert.equal(classification.state, "identity-unverified");
});

test("a visible but disabled composer never qualifies the page as ready", async () => {
  const expectedIdentity = "Ronak Chakraborty";
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  const observation = await observeCopilotPage(
    new LiveShapePage("Ronak Chakraborty", false),
    contract,
  );

  const classification = classifyCopilotPage(
    observation,
    contract,
    requirements(expectedIdentity),
  );

  assert.equal(classification.state, "changed-selector");
  assert.equal(classification.diagnosticCode, "UI_CONTRACT_QUORUM_FAILED");
});

test("the baseline contract carries the current M365 locator revision and semantic fallbacks", () => {
  const contract = createBaselineCopilotUiContract("Ronak Chakraborty");

  assert.equal(contract.version, "copilot-ui/v1:m365-2026-07");
  assert.equal(contract.groups.composer.candidates.some((candidate) => candidate.kind === "label"), true);
  assert.equal(contract.groups.composer.candidates.some((candidate) => candidate.kind === "css"), true);
  assert.deepEqual(
    contract.groups.identity.candidates.map((candidate) =>
      candidate.kind === "role" ? candidate.role : candidate.kind),
    ["button", "button"],
  );
  assert.equal(
    contract.groups.identity.candidates.some((candidate) =>
      candidate.kind === "role" && candidate.role === "link"),
    false,
  );
});
