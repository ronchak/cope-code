import assert from "node:assert/strict";
import { test } from "node:test";

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
import { MutableBrowserKillSwitch } from "../../src/browser/kill-switch.js";
import { sha256 } from "../../src/shared/crypto.js";
import { AgentError } from "../../src/shared/errors.js";

type ActivationMode = "submitted" | "not-submitted" | "indeterminate";

class DynamicFakePage implements SemanticPage {
  public url = "https://copilot.example.test/chat/conversation-1";
  public identity = "Synthetic Work Account";
  public protection = true;
  public composer = "";
  public readonly userMessages: string[] = [];
  public readonly responses: string[] = ["prior response"];
  public streaming = false;
  public sendEnabled = true;
  public activationMode: ActivationMode = "submitted";
  public preActivationDiagnostic: string | undefined = undefined;
  public fillCalls = 0;
  public activationCalls = 0;
  public currentUrlCalls = 0;
  public snapshotCalls = 0;
  public stallSnapshots = false;
  public onCurrentUrl: (() => void) | undefined = undefined;

  public async currentUrl(): Promise<string> {
    this.currentUrlCalls += 1;
    this.onCurrentUrl?.();
    return this.url;
  }

  public async snapshot(group: LocatorGroup): Promise<GroupSnapshot> {
    this.snapshotCalls += 1;
    if (this.stallSnapshots) return new Promise<GroupSnapshot>(() => {});
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
    this.fillCalls += 1;
    this.composer = value;
  }

  public async click(): Promise<void> {
    this.#assertPreActivationGuard();
    await this.#activate();
  }

  public async press(): Promise<void> {
    this.#assertPreActivationGuard();
    await this.#activate();
  }

  #assertPreActivationGuard(): void {
    if (this.preActivationDiagnostic === undefined) return;
    throw new AgentError(
      "TRANSPORT_INDETERMINATE",
      "Synthetic pre-activation guard blocked dispatch",
      { diagnosticCode: this.preActivationDiagnostic, dispatchAttempted: false },
    );
  }

  async #activate(): Promise<void> {
    this.activationCalls += 1;
    if (this.activationMode === "submitted") {
      this.userMessages.push(this.composer);
      this.composer = "";
      this.responses.push("completed response envelope");
      return;
    }
    if (this.activationMode === "indeterminate") {
      this.composer = "";
      return;
    }
    throw new Error("synthetic activation failure before submission");
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
        return [element("send", "", this.sendEnabled)];
      case "identity":
        return [element(this.identity)];
      case "protection":
        return this.protection ? [element("enterprise data protection")] : [];
      case "responses":
        return this.responses.map((response) => element(response));
      case "user-messages":
        return this.userMessages.map((message) => element(message));
      case "streaming":
        return this.streaming ? [element("streaming")] : [];
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

function makeHarness(
  page = new DynamicFakePage(),
  killSwitch = new MutableBrowserKillSwitch(),
  onSleep?: () => void,
) {
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
      submissionConfirmationMs: 30,
      responseMs: 80,
      manualReadinessMs: 80,
      pollMs: 10,
      stableSamples: 2,
      minimumStableMs: 10,
    },
  };
  const adapter = new CopilotBrowserAdapter(page, config, {
    killSwitch,
    monotonicNow: () => monotonic,
    sleep: async (milliseconds, signal) => {
      if (signal?.aborted === true) throw signal.reason;
      monotonic += milliseconds;
      onSleep?.();
    },
  });
  return { adapter, page, killSwitch };
}

const request = {
  taskId: "task-1",
  turnId: "turn-1",
  submissionId: "submission-1",
  content: "Use the tool contract.",
} as const;

test("adapter submits once, confirms its task marker, and captures a stable response", async () => {
  const { adapter, page } = makeHarness();
  const receipt = await adapter.submit(request);
  assert.equal(receipt.status, "submitted");
  assert.match(receipt.transportMarker ?? "", /^\[\[COPILOT_AGENT_TASK_V2:/u);
  assert.equal(page.activationCalls, 1);
  assert.equal(page.userMessages.length, 1);

  const duplicate = await adapter.submit(request);
  assert.equal(duplicate.status, "submitted");
  assert.equal(page.activationCalls, 1, "same idempotency key must never activate twice");

  const response = await adapter.receive(request);
  assert.equal(response.status, "completed");
  if (response.status === "completed") {
    assert.equal(response.content, "completed response envelope");
  }
});

test("fresh adapter recovers the response baseline from the persisted task marker", async () => {
  const page = new DynamicFakePage();
  const first = makeHarness(page);
  const receipt = await first.adapter.submit(request);
  assert.equal(receipt.status, "submitted");
  await first.adapter.close();

  const restarted = makeHarness(page);
  const resolved = await restarted.adapter.resolveSubmission({
    taskId: request.taskId,
    turnId: request.turnId,
    submissionId: request.submissionId,
    ...(receipt.conversationId === undefined ? {} : { expectedConversationId: receipt.conversationId }),
  });
  assert.equal(resolved.status, "submitted");
  const response = await restarted.adapter.receive({
    taskId: request.taskId,
    turnId: request.turnId,
    submissionId: request.submissionId,
    ...(receipt.conversationId === undefined ? {} : { expectedConversationId: receipt.conversationId }),
  });
  assert.equal(response.status, "completed");
  if (response.status === "completed") assert.equal(response.content, "completed response envelope");
  assert.equal(page.activationCalls, 1, "recovery must not activate the composer again");
});

test("response correlation rejects baseline mutation instead of accepting same-count text drift", async () => {
  const { adapter, page } = makeHarness();
  assert.equal((await adapter.submit(request)).status, "submitted");
  page.responses.splice(0, page.responses.length, "mutated prior response");

  const response = await adapter.receive(request);
  assert.equal(response.status, "indeterminate");
  if (response.status === "indeterminate") {
    assert.equal(response.diagnosticCode, "RESPONSE_BASELINE_CHANGED");
  }
});

test("a pre-existing empty assistant envelope cannot become the current response", async () => {
  const { adapter, page } = makeHarness();
  page.responses.push("");
  assert.equal((await adapter.submit(request)).status, "submitted");
  // Replace the empty pre-existing envelope with delayed text and remove the
  // genuinely appended envelope. Envelope-aware correlation must see prefix
  // drift rather than treating the delayed prior response as this task's append.
  page.responses.splice(1, 2, "delayed prior response");

  const response = await adapter.receive(request);
  assert.equal(response.status, "indeterminate");
  if (response.status === "indeterminate") {
    assert.equal(response.diagnosticCode, "RESPONSE_BASELINE_CHANGED");
  }
});

test("the one appended assistant envelope may stream from empty to stable text", async () => {
  const page = new DynamicFakePage();
  const { adapter } = makeHarness(page, new MutableBrowserKillSwitch(), () => {
    page.responses[page.responses.length - 1] = "completed response envelope";
  });
  assert.equal((await adapter.submit(request)).status, "submitted");
  page.responses[page.responses.length - 1] = "";

  const response = await adapter.receive(request);
  assert.equal(response.status, "completed");
  if (response.status === "completed") {
    assert.equal(response.content, "completed response envelope");
  }
});

test("response correlation rejects more than one appended assistant envelope", async () => {
  const { adapter, page } = makeHarness();
  assert.equal((await adapter.submit(request)).status, "submitted");
  page.responses.push("unrelated second assistant envelope");

  const response = await adapter.receive(request);
  assert.equal(response.status, "indeterminate");
  if (response.status === "indeterminate") {
    assert.equal(response.diagnosticCode, "RESPONSE_SEQUENCE_AMBIGUOUS");
  }
});

test("duplicate task markers are ambiguous and never confirm a response", async () => {
  const { adapter, page } = makeHarness();
  const receipt = await adapter.submit(request);
  assert.equal(receipt.status, "submitted");
  page.userMessages.push(receipt.transportMarker ?? "missing marker");

  const response = await adapter.receive(request);
  assert.equal(response.status, "indeterminate");
  if (response.status === "indeterminate") {
    assert.equal(response.diagnosticCode, "TASK_MARKER_AMBIGUOUS");
  }
});

test("legacy markers can prove submission but cannot recover a response baseline", async () => {
  const page = new DynamicFakePage();
  const encoded = Buffer.from(JSON.stringify([
    request.taskId,
    request.turnId,
    request.submissionId,
  ]), "utf8").toString("base64url");
  page.userMessages.push(`legacy [[COPILOT_AGENT_TASK_V1:${encoded}]]`);
  const { adapter } = makeHarness(page);

  const resolved = await adapter.resolveSubmission(request);
  assert.equal(resolved.status, "submitted");
  const response = await adapter.receive(request);
  assert.equal(response.status, "indeterminate");
  if (response.status === "indeterminate") {
    assert.equal(response.diagnosticCode, "RESPONSE_BASELINE_UNKNOWN");
  }
  assert.equal(page.activationCalls, 0);
});

test("historical filtered-baseline V2 markers cannot correlate delayed empty envelopes", async () => {
  const page = new DynamicFakePage();
  const encoded = Buffer.from(JSON.stringify([
    request.taskId,
    request.turnId,
    request.submissionId,
    "response-sequence/v1",
    0,
    sha256(JSON.stringify([])),
  ]), "utf8").toString("base64url");
  page.userMessages.push(`[[COPILOT_AGENT_TASK_V2:${encoded}]]`);
  page.responses.splice(0, page.responses.length, "delayed prior response");
  const { adapter } = makeHarness(page);

  const resolved = await adapter.resolveSubmission(request);
  assert.equal(resolved.status, "submitted");
  const response = await adapter.receive(request);
  assert.equal(response.status, "indeterminate");
  if (response.status === "indeterminate") {
    assert.equal(response.diagnosticCode, "RESPONSE_BASELINE_UNKNOWN");
  }
  assert.equal(page.activationCalls, 0);
});

test("new submissions reject both legacy and current reserved marker prefixes", async () => {
  for (const prefix of [
    "[[COPILOT_AGENT_TASK_V1:",
    "[[COPILOT_AGENT_TASK_V2:",
  ]) {
    const { adapter, page } = makeHarness();
    await assert.rejects(
      adapter.submit({ ...request, content: `ordinary text ${prefix}injected]]` }),
      (error: unknown) => error instanceof AgentError && error.code === "PROTOCOL_INVALID",
    );
    assert.equal(page.fillCalls, 0);
    assert.equal(page.activationCalls, 0);
  }
});

test("malformed correlation-matching legacy and current markers are ambiguous", async () => {
  for (const [version, trailingFields] of [
    ["V1", ["malformed-extra-field"]],
    ["V2", []],
    ["V2", ["malformed-extra-field"]],
  ] as const) {
    const page = new DynamicFakePage();
    const encoded = Buffer.from(JSON.stringify([
      request.taskId,
      request.turnId,
      request.submissionId,
      ...trailingFields,
    ]), "utf8").toString("base64url");
    page.userMessages.push(`[[COPILOT_AGENT_TASK_${version}:${encoded}]]`);
    const { adapter } = makeHarness(page);

    const resolved = await adapter.resolveSubmission(request);
    assert.equal(resolved.status, "indeterminate");
    assert.equal(resolved.diagnosticCode, "TASK_MARKER_AMBIGUOUS");
    assert.equal(page.activationCalls, 0);
  }
});

test("response completion waits for streaming to end as well as stable content", async () => {
  const page = new DynamicFakePage();
  let polls = 0;
  const { adapter } = makeHarness(page, new MutableBrowserKillSwitch(), () => {
    polls += 1;
    page.streaming = false;
  });
  assert.equal((await adapter.submit(request)).status, "submitted");
  page.streaming = true;
  const response = await adapter.receive(request);
  assert.equal(response.status, "completed");
  assert.ok(polls >= 1);
  assert.equal(page.streaming, false);
});

test("indeterminate activation cannot be retried until marker evidence resolves it", async () => {
  const { adapter, page } = makeHarness();
  page.activationMode = "indeterminate";
  const receipt = await adapter.submit(request);
  assert.equal(receipt.status, "indeterminate");
  assert.equal(page.activationCalls, 1);

  const repeated = await adapter.submit(request);
  assert.equal(repeated.status, "indeterminate");
  assert.equal(page.activationCalls, 1, "indeterminate submission must not be replayed");

  page.userMessages.push(receipt.transportMarker ?? "missing marker");
  const recovered = await adapter.resolveSubmission(request);
  assert.equal(recovered.status, "submitted");
  assert.equal(page.activationCalls, 1);
});

test("pre-activation guard failures are known not-submitted and safely retryable", async () => {
  const { adapter, page } = makeHarness();
  page.preActivationDiagnostic = "COMPOSER_CONTENT_CHANGED_BEFORE_SUBMIT";

  const first = await adapter.submit(request);
  assert.equal(first.status, "not-submitted");
  assert.equal(first.diagnosticCode, "COMPOSER_CONTENT_CHANGED_BEFORE_SUBMIT");
  assert.equal(page.activationCalls, 0);

  page.preActivationDiagnostic = undefined;
  page.url = "https://copilot.example.test/chat/conversation-2";
  const retry = await adapter.submit(request);
  assert.equal(retry.status, "submitted");
  assert.equal(page.activationCalls, 1);
});

test("failed activation remains indeterminate because dispatch timing cannot be proven", async () => {
  const { adapter, page } = makeHarness();
  page.activationMode = "not-submitted";
  const first = await adapter.submit(request);
  assert.equal(first.status, "indeterminate");
  assert.equal(page.activationCalls, 1);

  const second = await adapter.submit(request);
  assert.equal(second.status, "indeterminate");
  assert.equal(page.activationCalls, 1);
});

test("configured send-control strategy never guesses Enter when send is disabled", async () => {
  const { adapter, page } = makeHarness();
  page.sendEnabled = false;
  const receipt = await adapter.submit(request);
  assert.equal(receipt.status, "not-submitted");
  assert.equal(receipt.diagnosticCode, "SEND_CONTROL_NOT_ACTIONABLE");
  assert.equal(page.activationCalls, 0);
  page.sendEnabled = true;
  const retry = await adapter.submit(request);
  assert.equal(retry.status, "submitted");
  assert.equal(page.activationCalls, 1, "known pre-activation failure may be retried explicitly");
});

test("host, identity, and protection assertions run before composer disclosure", async () => {
  const wrongHost = makeHarness();
  wrongHost.page.url = "https://lookalike.example.test/chat";
  assert.equal((await wrongHost.adapter.submit(request)).status, "not-submitted");
  assert.equal(wrongHost.page.fillCalls, 0);

  const wrongIdentity = makeHarness();
  wrongIdentity.page.identity = "Personal Account";
  const identityReceipt = await wrongIdentity.adapter.submit(request);
  assert.equal(identityReceipt.status, "not-submitted");
  assert.equal(identityReceipt.diagnosticCode, "IDENTITY_NOT_VERIFIED");
  assert.equal(wrongIdentity.page.fillCalls, 0);

  const noProtection = makeHarness();
  noProtection.page.protection = false;
  const protectionReceipt = await noProtection.adapter.submit(request);
  assert.equal(protectionReceipt.status, "not-submitted");
  assert.equal(protectionReceipt.diagnosticCode, "PROTECTION_NOT_VERIFIED");
  assert.equal(noProtection.page.fillCalls, 0);
});

test("kill switch prevents browser action and receive waits are abortable", async () => {
  const stopped = makeHarness();
  stopped.killSwitch.disable("central-disable");
  await assert.rejects(stopped.adapter.submit(request), /disabled/u);
  assert.equal(stopped.page.fillCalls, 0);

  const active = makeHarness();
  const receipt = await active.adapter.submit(request);
  assert.equal(receipt.status, "submitted");
  const controller = new AbortController();
  controller.abort("test abort");
  const result = await active.adapter.receive(request, { signal: controller.signal });
  assert.equal(result.status, "cancelled");
});

test("cancellation during the first trust observation prevents composer disclosure", async () => {
  const controller = new AbortController();
  const page = new DynamicFakePage();
  page.onCurrentUrl = () => controller.abort(new Error("cancelled during observation"));
  const { adapter } = makeHarness(page);

  await assert.rejects(
    adapter.submit(request, { signal: controller.signal }),
    /cancelled during observation/u,
  );
  assert.equal(page.fillCalls, 0);
  assert.equal(page.activationCalls, 0);
});

test("cancellation during the second trust observation prevents activation", async () => {
  const controller = new AbortController();
  const page = new DynamicFakePage();
  page.onCurrentUrl = () => {
    if (page.currentUrlCalls === 2) {
      controller.abort(new Error("cancelled before activation"));
    }
  };
  const { adapter } = makeHarness(page);

  const receipt = await adapter.submit(request, { signal: controller.signal });
  assert.equal(receipt.status, "not-submitted");
  assert.equal(receipt.diagnosticCode, "PRE_SUBMISSION_ASSERTION_ABORTED");
  assert.equal(page.fillCalls, 1);
  assert.equal(page.activationCalls, 0);
});

test("manual readiness waits on explicitly configured auth hosts without interacting", async () => {
  const page = new DynamicFakePage();
  page.url = "https://login.example.test/manual-sign-in";
  let sleepCount = 0;
  const { adapter } = makeHarness(page, new MutableBrowserKillSwitch(), () => {
    sleepCount += 1;
    page.url = "https://copilot.example.test/chat/conversation-1";
  });
  const inspection = await adapter.waitForManualReadiness();
  assert.equal(inspection.classification.state, "ready");
  assert.equal(sleepCount, 1);
  assert.equal(page.fillCalls, 0);
  assert.equal(page.activationCalls, 0);
});

test("provenance-bound SSO readiness never reads IdP DOM and fully reinspects Copilot on return", async () => {
  const page = new DynamicFakePage();
  page.url = "https://identity.example.test/sso/login";
  page.stallSnapshots = true;
  const { adapter } = makeHarness(page);

  const handoff = await Promise.race([
    adapter.inspectManualReadinessState(async () => true),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("manual SSO inspection touched stalled DOM")), 50);
    }),
  ]);
  assert.equal(handoff.classification.diagnosticCode, "MANUAL_SSO_HANDOFF");
  assert.equal(page.currentUrlCalls, 0);
  assert.equal(page.snapshotCalls, 0);

  page.url = "https://copilot.example.test/chat/conversation-1";
  page.stallSnapshots = false;
  const ready = await adapter.inspectManualReadinessState(
    async () => false,
    () => true,
  );
  assert.equal(ready.classification.state, "ready");
  assert.ok(page.currentUrlCalls > 0);
  assert.ok(page.snapshotCalls > 0);
});

test("a non-ready configured page cannot end an active external SSO handoff", async () => {
  const page = new DynamicFakePage();
  page.identity = "Unexpected Account";
  const { adapter } = makeHarness(page);

  const inspection = await adapter.inspectManualReadinessState(
    async () => false,
    () => true,
  );

  assert.equal(inspection.classification.diagnosticCode, "MANUAL_SSO_HANDOFF");
  assert.ok(page.currentUrlCalls > 0);
  assert.ok(page.snapshotCalls > 0);
  assert.equal(page.fillCalls, 0);
  assert.equal(page.activationCalls, 0);
});

test("same submission id with changed task correlation is rejected", async () => {
  const { adapter } = makeHarness();
  await adapter.submit(request);
  await assert.rejects(
    adapter.submit({ ...request, taskId: "different-task" }),
    /correlation changed/u,
  );
});

test("all turns for a task remain bound to the initially submitted conversation", async () => {
  const { adapter, page } = makeHarness();
  assert.equal((await adapter.submit(request)).status, "submitted");
  page.url = "https://copilot.example.test/chat/a-different-conversation";
  const next = await adapter.submit({
    taskId: request.taskId,
    turnId: "turn-2",
    submissionId: "submission-2",
    content: "second turn",
  });
  assert.equal(next.status, "not-submitted");
  assert.equal(next.diagnosticCode, "TASK_CONVERSATION_MISMATCH");
  assert.equal(page.activationCalls, 1);
});
