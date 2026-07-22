import assert from "node:assert/strict";
import test from "node:test";

import { CopilotBrowserAdapter } from "../../src/browser/copilot-browser-adapter.js";
import { createBaselineCopilotUiContract, type CopilotBrowserAdapterConfig } from "../../src/browser/config.js";
import type {
  CopilotSignal,
  GroupSnapshot,
  LocatorGroup,
  SemanticActionGuard,
  SemanticPage,
} from "../../src/browser/contracts.js";
import { AgentError } from "../../src/shared/errors.js";

class AuthenticatedReadinessPage implements SemanticPage {
  public readonly inspectedSignals: CopilotSignal[] = [];

  public async currentUrl(): Promise<string> {
    return "https://m365.cloud.microsoft/chat/conversation/ready";
  }

  public async snapshot(group: LocatorGroup): Promise<GroupSnapshot> {
    this.inspectedSignals.push(group.signal);
    if (group.signal === "responses" || group.signal === "user-messages") {
      throw new AgentError(
        "TRANSPORT_INDETERMINATE",
        "A historical transcript probe exceeded the browser action timeout",
        {
          diagnosticCode: "BROWSER_OPERATION_TIMEOUT",
          semanticGroup: group.signal,
          semanticOperation: "locator.innerText",
          dispatchAttempted: false,
        },
      );
    }

    const matched = group.signal === "conversation" ||
      group.signal === "composer" ||
      group.signal === "identity";
    const actionable = group.signal === "composer";
    const text = group.signal === "identity" ? "operator@example.invalid" : "";
    return snapshot(group, matched, actionable, text);
  }

  public async fill(
    _group: LocatorGroup,
    _value: string,
    _guard: SemanticActionGuard,
  ): Promise<void> {
    throw new Error("fill is outside this readiness regression");
  }

  public async click(_group: LocatorGroup, _guard: SemanticActionGuard): Promise<void> {
    throw new Error("click is outside this readiness regression");
  }
}

test("authenticated setup readiness does not inspect historical transcript content", async () => {
  const page = new AuthenticatedReadinessPage();
  const adapter = new CopilotBrowserAdapter(page, config());

  const inspection = await adapter.inspectState();

  assert.equal(inspection.classification.state, "ready");
  assert.equal(page.inspectedSignals.includes("responses"), false);
  assert.equal(page.inspectedSignals.includes("user-messages"), false);
  for (const required of [
    "conversation",
    "composer",
    "identity",
    "protection",
    "signed-out",
    "mfa",
    "consent",
    "throttled",
    "service-error",
    "modal",
  ] as const) {
    assert.equal(page.inspectedSignals.includes(required), true, `readiness skipped ${required}`);
  }
});

function config(): CopilotBrowserAdapterConfig {
  return {
    entryUrl: "https://m365.cloud.microsoft/chat",
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    uiContract: createBaselineCopilotUiContract("operator@example.invalid"),
    expectedIdentity: "operator@example.invalid",
    requireProtectionIndicator: false,
    maxMessageChars: 200_000,
    maxResponseChars: 1_000_000,
    waits: {
      actionMs: 50,
      submissionConfirmationMs: 50,
      responseMs: 50,
      manualReadinessMs: 500,
      pollMs: 10,
      stableSamples: 2,
      minimumStableMs: 20,
    },
  };
}

function snapshot(
  group: LocatorGroup,
  matched: boolean,
  actionable: boolean,
  text: string,
): GroupSnapshot {
  return {
    signal: group.signal,
    matchedCandidates: matched ? group.minimumCandidateMatches : 0,
    visibleElements: matched ? 1 : 0,
    enabledElements: actionable ? 1 : 0,
    elements: matched
      ? [{ visible: true, enabled: actionable, text, value: "", accessibleLabel: text }]
      : [],
  };
}
