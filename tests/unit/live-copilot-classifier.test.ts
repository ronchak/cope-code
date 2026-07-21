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
  TextPattern,
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
    private readonly identityText: string | readonly (string | {
      readonly text: string;
      readonly accessibleLabel: string;
    })[],
    private readonly composerEnabled = true,
    private readonly extraSignals: ReadonlySet<CopilotSignal> = new Set(),
  ) {}

  public async currentUrl(): Promise<string> {
    return "https://m365.cloud.microsoft/chat/conversation/synthetic";
  }

  public async snapshot(group: LocatorGroup): Promise<GroupSnapshot> {
    const visible = readySignals.has(group.signal) || this.extraSignals.has(group.signal);
    const enabled = visible && (group.signal !== "composer" || this.composerEnabled);
    const identityValues = Array.isArray(this.identityText)
      ? this.identityText
      : [this.identityText];
    const values = group.signal === "identity" ? identityValues : [group.signal];
    return {
      signal: group.signal,
      matchedCandidates: visible ? group.minimumCandidateMatches : 0,
      visibleElements: visible ? values.length : 0,
      enabledElements: enabled ? values.length : 0,
      elements: visible
        ? values.map((value) => ({
            visible: true,
            enabled,
            text: typeof value === "string" ? value : value.text,
            value: "",
            accessibleLabel: typeof value === "string" ? value : value.accessibleLabel,
          }))
        : [],
    };
  }

  public async fill(): Promise<void> { throw new Error("not used"); }
  public async click(): Promise<void> { throw new Error("not used"); }
  public async press(): Promise<void> { throw new Error("not used"); }
}

function requirements(expectedIdentity: string | TextPattern): ClassifierRequirements {
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

test("an expected alternate profile cannot override a conflicting current account", async () => {
  const expectedIdentity = "approved@example.com";
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  const observation = await observeCopilotPage(
    new LiveShapePage([
      "Current account other@example.com",
      "Switch to approved@example.com",
    ]),
    contract,
  );

  const classification = classifyCopilotPage(
    observation,
    contract,
    requirements(expectedIdentity),
  );

  assert.equal(classification.state, "identity-unverified");
  assert.equal(classification.diagnosticCode, "IDENTITY_NOT_VERIFIED");
});

test("duplicate controls for the configured current account remain valid", async () => {
  const expectedIdentity = "approved@example.com";
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  const observation = await observeCopilotPage(
    new LiveShapePage([
      "Work account approved@example.com",
      "Account manager approved@example.com",
    ]),
    contract,
  );

  const classification = classifyCopilotPage(
    observation,
    contract,
    requirements(expectedIdentity),
  );

  assert.equal(classification.state, "ready");
});

test("conflicting email channels on one account control fail closed", async () => {
  const expectedIdentity = "approved@example.com";
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  for (const identity of [
    { text: "Current other@example.com", accessibleLabel: "approved@example.com" },
    { text: "approved@example.com", accessibleLabel: "Current other@example.com" },
    { text: "Current other＠example.com", accessibleLabel: "approved@example.com" },
  ]) {
    const observation = await observeCopilotPage(new LiveShapePage([identity]), contract);
    const classification = classifyCopilotPage(
      observation,
      contract,
      requirements(expectedIdentity),
    );
    assert.equal(classification.state, "identity-unverified");
  }
});

test("duplicate email channels and a generic account label remain compatible", async () => {
  const expectedIdentity = "approved@example.com";
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  for (const identity of [
    { text: "approved@example.com", accessibleLabel: "approved@example.com" },
    { text: "approved@example.com", accessibleLabel: "Account manager" },
  ]) {
    const observation = await observeCopilotPage(new LiveShapePage([identity]), contract);
    const classification = classifyCopilotPage(
      observation,
      contract,
      requirements(expectedIdentity),
    );
    assert.equal(classification.state, "ready");
  }
});

test("a matching display-name channel cannot override conflicting accessible identity", async () => {
  const expectedIdentity = "Ronak Chakraborty";
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  for (const identity of [
    { text: "Ronak Chakraborty", accessibleLabel: "Other Person" },
    { text: "Other Person", accessibleLabel: "Ronak Chakraborty" },
  ]) {
    const observation = await observeCopilotPage(new LiveShapePage([identity]), contract);
    const classification = classifyCopilotPage(
      observation,
      contract,
      requirements(expectedIdentity),
    );
    assert.equal(classification.state, "identity-unverified");
  }
});

test("an expected email channel cannot override a conflicting display identity", async () => {
  const expectedIdentity = "approved@example.com";
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  for (const identity of [
    { text: expectedIdentity, accessibleLabel: "Other Person" },
    { text: "Other Person", accessibleLabel: expectedIdentity },
    { text: `Ronak Chakraborty ${expectedIdentity}`, accessibleLabel: "Account manager" },
  ]) {
    const observation = await observeCopilotPage(new LiveShapePage([identity]), contract);
    const classification = classifyCopilotPage(
      observation,
      contract,
      requirements(expectedIdentity),
    );
    assert.equal(classification.state, "identity-unverified");
  }
});

test("a broad identity pattern cannot merge distinct visible account controls", async () => {
  const expectedIdentity: TextPattern = { source: "account", flags: "iu" };
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  const observation = await observeCopilotPage(
    new LiveShapePage([
      "Current account Alice",
      "Switch account Bob",
    ]),
    contract,
  );

  const classification = classifyCopilotPage(
    observation,
    contract,
    requirements(expectedIdentity),
  );
  assert.equal(classification.state, "identity-unverified");
});

test("identity patterns match canonical subjects, not generic account wrappers", async () => {
  for (const fixture of [
    {
      expected: { source: "account", flags: "iu" } as TextPattern,
      identities: ["Account manager"],
      expectedState: "identity-unverified",
    },
    {
      expected: { source: "alice", flags: "iu" } as TextPattern,
      identities: ["Current account Alice", "Switch account Alice"],
      expectedState: "ready",
    },
    {
      expected: { source: "alice|bob", flags: "iu" } as TextPattern,
      identities: ["Current account Alice", "Switch account Bob"],
      expectedState: "identity-unverified",
    },
    {
      expected: { source: "approved@example\\.com", flags: "iu" } as TextPattern,
      identities: [
        "Work account approved@example.com",
        "Switch to approved@example.com",
      ],
      expectedState: "ready",
    },
    {
      expected: { source: "will smith", flags: "iu" } as TextPattern,
      identities: ["Will Account Smith", "Will Smith"],
      expectedState: "identity-unverified",
    },
    {
      expected: { source: "ronak|kumar|chakraborty", flags: "iu" } as TextPattern,
      identities: ["Ronak Kumar Chakraborty", "Chakraborty Kumar Ronak"],
      expectedState: "identity-unverified",
    },
    {
      expected: { source: "approved@example\\.com", flags: "iu" } as TextPattern,
      identities: ["account work approved@example.com"],
      expectedState: "identity-unverified",
    },
  ] as const) {
    const contract = createBaselineCopilotUiContract(fixture.expected);
    const observation = await observeCopilotPage(
      new LiveShapePage(fixture.identities),
      contract,
    );
    const classification = classifyCopilotPage(
      observation,
      contract,
      requirements(fixture.expected),
    );
    assert.equal(classification.state, fixture.expectedState);
  }
});

test("generic labels and presentation order remain compatible with one display identity", async () => {
  const expectedIdentity = "Ronak Chakraborty";
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  for (const identity of [
    { text: "Ronak Chakraborty", accessibleLabel: "Account manager" },
    { text: "Ronak Chakraborty", accessibleLabel: "Chakraborty, Ronak" },
  ]) {
    const observation = await observeCopilotPage(new LiveShapePage([identity]), contract);
    const classification = classifyCopilotPage(
      observation,
      contract,
      requirements(expectedIdentity),
    );
    assert.equal(classification.state, "ready");
  }
});

test("identity patterns reject empty and conflicting explicit channels", async () => {
  const expectedIdentity: TextPattern = { source: "approved", flags: "iu" };
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  for (const identity of [
    { text: "", accessibleLabel: "" },
    { text: "other@example.com", accessibleLabel: "approved@example.com" },
    "other@example.com",
  ]) {
    const identityControls = typeof identity === "string"
      ? [identity, "approved@example.com"]
      : [identity];
    const observation = await observeCopilotPage(new LiveShapePage(identityControls), contract);
    const classification = classifyCopilotPage(
      observation,
      contract,
      requirements(expectedIdentity),
    );
    assert.equal(classification.state, "identity-unverified");
  }
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

test("display-name identity matching rejects prefix and suffix account text", async () => {
  const expectedIdentity = "Ronak Chakraborty";
  const contract = createBaselineCopilotUiContract(expectedIdentity);

  for (const candidate of [
    "Other Ronak Chakraborty",
    "Ronak Chakraborty Test",
    "Work account Ronak Chakraborty",
    "Chakraborty, Ronak (other tenant)",
  ]) {
    const observation = await observeCopilotPage(
      new LiveShapePage(candidate),
      contract,
    );
    const classification = classifyCopilotPage(
      observation,
      contract,
      requirements(expectedIdentity),
    );

    assert.equal(classification.state, "identity-unverified", candidate);
  }
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

test("incidental auth evidence in conversation content cannot override an actionable chat", async () => {
  const expectedIdentity = "Ronak Chakraborty";
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  const observation = await observeCopilotPage(
    new LiveShapePage(
      expectedIdentity,
      true,
      new Set<CopilotSignal>(["signed-out", "mfa", "consent"]),
    ),
    contract,
  );

  const classification = classifyCopilotPage(
    observation,
    contract,
    requirements(expectedIdentity),
  );

  assert.equal(classification.state, "ready");
});

test("manual auth evidence still blocks a configured chat without an actionable composer", async () => {
  const expectedIdentity = "Ronak Chakraborty";
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  const observation = await observeCopilotPage(
    new LiveShapePage(
      expectedIdentity,
      false,
      new Set<CopilotSignal>(["mfa"]),
    ),
    contract,
  );

  const classification = classifyCopilotPage(
    observation,
    contract,
    requirements(expectedIdentity),
  );

  assert.equal(classification.state, "mfa-required");
});

test("the baseline contract carries the current M365 locator revision and semantic fallbacks", () => {
  const contract = createBaselineCopilotUiContract("Ronak Chakraborty");

  assert.equal(contract.version, "copilot-ui/v1:m365-2026-07");
  assert.equal(contract.groups.composer.candidates.some((candidate) => candidate.kind === "label"), true);
  assert.equal(contract.groups.composer.candidates.some((candidate) => candidate.kind === "css"), true);
  assert.deepEqual(
    contract.groups.identity.candidates.map((candidate) =>
      candidate.kind === "role" ? candidate.role : candidate.kind),
    ["css"],
  );
  const identityCss = contract.groups.identity.candidates[0];
  assert.ok(identityCss?.kind === "css");
  assert.equal(
    identityCss.selector.split(",").every((selector) =>
      /mectrl|mecontrol|me-control|account-control|account-menu|profile|persona/iu.test(selector)),
    true,
  );
  assert.equal(
    contract.groups.identity.candidates.some((candidate) =>
      candidate.kind === "role" && candidate.role === "link"),
    false,
  );

  const sendCss = contract.groups.send.candidates.find((candidate) => candidate.kind === "css");
  assert.ok(sendCss?.kind === "css");
  const sendSelectors = sendCss.selector.split(",").map((selector) => selector.trim());
  assert.equal(
    sendSelectors.every((selector) =>
      selector.startsWith("button") || selector.startsWith('[role="button"]')),
    true,
  );
  assert.equal(
    sendSelectors.some((selector) => selector === '[data-testid*="send" i]'),
    false,
  );

  assert.equal(
    contract.groups.protection.candidates.some((candidate) => candidate.kind === "text"),
    false,
  );
  assert.equal(
    contract.groups.protection.candidates.some((candidate) => candidate.kind === "test-id"),
    false,
  );
  assert.equal(
    contract.groups.protection.candidates.some((candidate) =>
      candidate.kind === "role" && (candidate.role === "status" || candidate.role === "img")),
    true,
  );
  assert.equal(
    contract.groups.protection.candidates.some((candidate) => candidate.kind === "css"),
    false,
  );
  for (const candidate of contract.groups.protection.candidates) {
    if (candidate.kind === "role") {
      assert.equal(typeof candidate.name, "object");
      if (typeof candidate.name !== "object" || candidate.name === undefined) continue;
      const matcher = new RegExp(candidate.name.source, candidate.name.flags);
      assert.equal(matcher.test("Enterprise data protection"), true);
      assert.equal(matcher.test("Not protected"), false);
      assert.equal(matcher.test("Enterprise data protection disabled"), false);
    }
  }
});
