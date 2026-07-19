import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  classifyCopilotPage,
  observeCopilotPage,
  type CopilotPageState,
} from "../../src/browser/classifier.js";
import {
  createBaselineCopilotUiContract,
  conversationIdFromUrl,
  isApprovedUrl,
  validateBrowserConfig,
} from "../../src/browser/config.js";
import type {
  CopilotSignal,
  GroupSnapshot,
  LocatorGroup,
  SemanticPage,
} from "../../src/browser/contracts.js";
import { minimalBrowserDiagnostic } from "../../src/browser/diagnostics.js";

interface StateFixture {
  readonly schemaVersion: string;
  readonly identity: string;
  readonly states: Readonly<Record<string, readonly CopilotSignal[]>>;
}

class FixturePage implements SemanticPage {
  public constructor(
    private readonly active: ReadonlySet<CopilotSignal>,
    private readonly identity: string,
    private readonly url = "https://copilot.example.test/chat/conversation-1",
  ) {}

  public async currentUrl(): Promise<string> {
    return this.url;
  }

  public async snapshot(group: LocatorGroup): Promise<GroupSnapshot> {
    const visible = this.active.has(group.signal);
    return {
      signal: group.signal,
      matchedCandidates: visible ? group.minimumCandidateMatches : 0,
      visibleElements: visible ? 1 : 0,
      enabledElements: visible ? 1 : 0,
      elements: visible
        ? [
            {
              visible: true,
              enabled: true,
              text: group.signal === "identity" ? this.identity : group.signal,
              value: "",
              accessibleLabel: group.signal === "identity" ? this.identity : group.signal,
            },
          ]
        : [],
    };
  }

  public async fill(): Promise<void> {
    throw new Error("not used by classifier test");
  }

  public async click(): Promise<void> {
    throw new Error("not used by classifier test");
  }

  public async press(): Promise<void> {
    throw new Error("not used by classifier test");
  }
}

async function loadFixture(): Promise<StateFixture> {
  return JSON.parse(
    await readFile(join(process.cwd(), "fixtures", "browser", "page-states.v1.json"), "utf8"),
  ) as StateFixture;
}

test("synthetic page corpus classifies normal and adversarial browser states", async () => {
  const fixture = await loadFixture();
  assert.equal(fixture.schemaVersion, "synthetic-copilot-page-states/v1");
  const contract = createBaselineCopilotUiContract(fixture.identity);
  const expected: Readonly<Record<string, CopilotPageState>> = {
    ready: "ready",
    streaming: "streaming",
    "signed-out": "sign-in-required",
    mfa: "mfa-required",
    consent: "consent-required",
    throttled: "throttled",
    "service-error": "service-error",
    modal: "blocking-modal",
    "changed-selector": "changed-selector",
    unknown: "unknown",
  };
  for (const [name, signals] of Object.entries(fixture.states)) {
    const observation = await observeCopilotPage(
      new FixturePage(new Set(signals), fixture.identity),
      contract,
    );
    const classification = classifyCopilotPage(observation, contract, {
      approvedHosts: [{ hostname: "copilot.example.test" }],
      expectedIdentity: fixture.identity,
      requireProtectionIndicator: true,
    });
    assert.equal(classification.state, expected[name], name);
  }
});

test("classifier fails closed for wrong identity, missing protection, and wrong host", async () => {
  const fixture = await loadFixture();
  const contract = createBaselineCopilotUiContract(fixture.identity);
  const ready = new Set(fixture.states.ready);

  const wrongIdentity = await observeCopilotPage(
    new FixturePage(ready, "Different Account"),
    contract,
  );
  assert.equal(
    classifyCopilotPage(wrongIdentity, contract, {
      approvedHosts: [{ hostname: "copilot.example.test" }],
      expectedIdentity: fixture.identity,
      requireProtectionIndicator: true,
    }).state,
    "identity-unverified",
  );

  ready.delete("protection");
  const unprotected = await observeCopilotPage(
    new FixturePage(ready, fixture.identity),
    contract,
  );
  assert.equal(
    classifyCopilotPage(unprotected, contract, {
      approvedHosts: [{ hostname: "copilot.example.test" }],
      expectedIdentity: fixture.identity,
      requireProtectionIndicator: true,
    }).state,
    "protection-unverified",
  );

  const wrongHost = await observeCopilotPage(
    new FixturePage(ready, fixture.identity, "https://lookalike.example.test/chat"),
    contract,
  );
  assert.equal(
    classifyCopilotPage(wrongHost, contract, {
      approvedHosts: [{ hostname: "copilot.example.test" }],
      expectedIdentity: fixture.identity,
      requireProtectionIndicator: true,
    }).state,
    "unapproved-host",
  );
});

test("minimal browser diagnostics contain only state and locator quorum", async () => {
  const fixture = await loadFixture();
  const contract = createBaselineCopilotUiContract(fixture.identity);
  const observation = await observeCopilotPage(
    new FixturePage(new Set(fixture.states.ready), fixture.identity),
    contract,
  );
  const classification = classifyCopilotPage(observation, contract, {
    approvedHosts: [{ hostname: "copilot.example.test" }],
    expectedIdentity: fixture.identity,
    requireProtectionIndicator: true,
  });
  const serialized = JSON.stringify(minimalBrowserDiagnostic(observation, contract, classification));
  assert.doesNotMatch(serialized, /Synthetic Work Account/u);
  assert.doesNotMatch(serialized, /copilot\.example\.test/u);
  assert.match(serialized, /"state":"ready"/u);
});

test("approved host matching is exact unless subdomains are explicitly granted", () => {
  assert.equal(isApprovedUrl("https://m365.cloud.microsoft/chat", [{ hostname: "m365.cloud.microsoft" }]), true);
  assert.equal(isApprovedUrl("https://evil-m365.cloud.microsoft/chat", [{ hostname: "m365.cloud.microsoft" }]), false);
  assert.equal(isApprovedUrl("https://tenant.m365.cloud.microsoft/chat", [{ hostname: "m365.cloud.microsoft" }]), false);
  assert.equal(
    isApprovedUrl("https://tenant.m365.cloud.microsoft/chat", [
      { hostname: "m365.cloud.microsoft", allowSubdomains: true },
    ]),
    true,
  );
  assert.equal(isApprovedUrl("http://m365.cloud.microsoft/chat", [{ hostname: "m365.cloud.microsoft" }]), false);
  assert.equal(isApprovedUrl("https://m365.cloud.microsoft:444/chat", [{ hostname: "m365.cloud.microsoft" }]), false);
});

test("browser config requires an explicitly approved HTTPS entry point", () => {
  const identity = "Synthetic Work Account";
  assert.throws(() =>
    validateBrowserConfig({
      entryUrl: "https://unapproved.example.test/chat",
      approvedHosts: [{ hostname: "copilot.example.test" }],
      uiContract: createBaselineCopilotUiContract(identity),
      expectedIdentity: identity,
      requireProtectionIndicator: true,
      maxMessageChars: 1000,
      maxResponseChars: 1000,
      waits: {
        actionMs: 100,
        submissionConfirmationMs: 100,
        responseMs: 100,
        manualReadinessMs: 100,
        pollMs: 10,
        stableSamples: 2,
        minimumStableMs: 10,
      },
    }),
  );
});

test("browser configuration and UI contracts reject unknown nested fields", () => {
  const identity = "Synthetic Work Account";
  const base = {
    entryUrl: "https://copilot.example.test/chat",
    approvedHosts: [{ hostname: "copilot.example.test" }],
    uiContract: createBaselineCopilotUiContract(identity),
    expectedIdentity: identity,
    requireProtectionIndicator: true,
    maxMessageChars: 1000,
    maxResponseChars: 1000,
    waits: {
      actionMs: 100,
      submissionConfirmationMs: 100,
      responseMs: 100,
      manualReadinessMs: 100,
      pollMs: 10,
      stableSamples: 2,
      minimumStableMs: 10,
    },
  };
  assert.throws(
    () => validateBrowserConfig({ ...base, unexpected: true } as never),
    /unknown fields/u,
  );
  assert.throws(
    () => validateBrowserConfig({
      ...base,
      approvedHosts: [{ hostname: "copilot.example.test", unexpected: true }],
    } as never),
    /unknown fields/u,
  );
  const uiContract = structuredClone(base.uiContract) as unknown as {
    groups: Record<string, { candidates: Array<Record<string, unknown>> }>;
  };
  const composerCandidate = uiContract.groups.composer?.candidates[0];
  assert.ok(composerCandidate);
  composerCandidate.unexpected = true;
  assert.throws(
    () => validateBrowserConfig({ ...base, uiContract } as never),
    /unknown fields/u,
  );
});

test("conversation identity distinguishes query state without retaining raw URL data", () => {
  const first = conversationIdFromUrl(
    "https://copilot.example.test/chat/conversation?opaque=synthetic-secret-one",
  );
  const second = conversationIdFromUrl(
    "https://copilot.example.test/chat/conversation?opaque=synthetic-secret-two",
  );
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /synthetic-secret/u);
  assert.match(first, /^browser-conversation:[a-f0-9]{32}$/u);
});
