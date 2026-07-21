import assert from "node:assert/strict";
import test from "node:test";

import { CopilotBrowserAdapter } from "../../src/browser/copilot-browser-adapter.js";
import {
  createBaselineCopilotUiContract,
  type CopilotBrowserAdapterConfig,
} from "../../src/browser/config.js";
import type {
  CopilotSignal,
  GroupSnapshot,
  LocatorGroup,
  SemanticPage,
} from "../../src/browser/contracts.js";
import { AgentError } from "../../src/shared/errors.js";

class GuardedPage implements SemanticPage {
  public readonly url = "https://copilot.example.test/chat/conversation-one";
  public readonly userMessages: string[] = [];
  public readonly responses: string[] = ["previous response"];
  public composer = "";
  public preActivationGuardCode: string | undefined = "COMPOSER_CONTENT_CHANGED_BEFORE_SUBMIT";
  public activationCalls = 0;

  public async currentUrl(): Promise<string> {
    return this.url;
  }

  public async snapshot(group: LocatorGroup): Promise<GroupSnapshot> {
    const elements = this.#elements(group.signal);
    return {
      signal: group.signal,
      matchedCandidates: elements.length > 0 ? group.minimumCandidateMatches : 0,
      visibleElements: elements.length,
      enabledElements: elements.filter((element) => element.enabled).length,
      elements,
    };
  }

  public async fill(_group: LocatorGroup, value: string): Promise<void> {
    this.composer = value;
  }

  public async click(_group: LocatorGroup): Promise<void> {
    if (this.preActivationGuardCode !== undefined) {
      throw new AgentError(
        "TRANSPORT_INDETERMINATE",
        "Synthetic pre-activation guard",
        { diagnosticCode: this.preActivationGuardCode },
      );
    }
    this.activationCalls += 1;
    this.userMessages.push(this.composer);
    this.composer = "";
    this.responses.push("completed response");
  }

  public async press(group: LocatorGroup, _key: "Enter"): Promise<void> {
    await this.click(group);
  }

  #elements(signal: CopilotSignal) {
    const element = (text: string, value = "", enabled = true) => ({
      visible: true,
      enabled,
      text,
      value,
      accessibleLabel: text,
    });

    switch (signal) {
      case "shell":
      case "conversation":
        return [element(signal)];
      case "composer":
        return [element("message copilot", this.composer)];
      case "send":
        return [element("send")];
      case "identity":
        return [element("Synthetic Work Account")];
      case "protection":
        return [element("enterprise data protection")];
      case "responses":
        return this.responses.map((response) => element(response));
      case "user-messages":
        return this.userMessages.map((message) => element(message));
      case "streaming":
      case "signed-out":
      case "mfa":
      case "consent":
      case "throttled":
      case "service-error":
      case "modal":
        return [];
    }
  }
}

test("a known pre-dispatch guard returns not-submitted and permits a safe retry", async () => {
  const page = new GuardedPage();
  let monotonic = 0;
  const config: CopilotBrowserAdapterConfig = {
    entryUrl: "https://copilot.example.test/chat",
    approvedHosts: [{ hostname: "copilot.example.test" }],
    manualAuthenticationHosts: [{ hostname: "login.example.test" }],
    uiContract: createBaselineCopilotUiContract("Synthetic Work Account"),
    expectedIdentity: "Synthetic Work Account",
    requireProtectionIndicator: true,
    maxMessageChars: 10_000,
    maxResponseChars: 10_000,
    waits: {
      actionMs: 100,
      submissionConfirmationMs: 40,
      responseMs: 100,
      manualReadinessMs: 100,
      pollMs: 10,
      stableSamples: 2,
      minimumStableMs: 10,
    },
  };
  const adapter = new CopilotBrowserAdapter(page, config, {
    monotonicNow: () => monotonic,
    sleep: async (milliseconds) => { monotonic += milliseconds; },
  });
  const request = {
    taskId: "task-one",
    turnId: "turn-one",
    submissionId: "submission-one",
    content: "Do not dispatch until every guard passes.",
  } as const;

  const blocked = await adapter.submit(request);
  assert.equal(blocked.status, "not-submitted");
  assert.equal(blocked.diagnosticCode, "COMPOSER_CONTENT_CHANGED_BEFORE_SUBMIT");
  assert.equal(page.activationCalls, 0);

  page.preActivationGuardCode = undefined;
  const retried = await adapter.submit(request);
  assert.equal(retried.status, "submitted");
  assert.equal(page.activationCalls, 1);
});
