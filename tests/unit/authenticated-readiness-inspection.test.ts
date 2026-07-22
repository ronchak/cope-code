import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserContext, Locator, Page } from "playwright-core";

import { CopilotBrowserAdapter } from "../../src/browser/copilot-browser-adapter.js";
import { createBaselineCopilotUiContract, type CopilotBrowserAdapterConfig } from "../../src/browser/config.js";
import { observeCopilotPage } from "../../src/browser/classifier.js";
import { PlaywrightSemanticPage } from "../../src/browser/playwright-semantic-page.js";
import type {
  CopilotSignal,
  GroupSnapshot,
  LocatorGroup,
  SemanticActionGuard,
  SemanticPage,
} from "../../src/browser/contracts.js";

class AuthenticatedReadinessPage implements SemanticPage {
  public readonly inspectedSignals: CopilotSignal[] = [];
  public fillCalls = 0;
  public terminationCalls = 0;
  public currentUrlCalls = 0;
  readonly #transcriptDelegate: PlaywrightSemanticPage;

  public constructor() {
    this.#transcriptDelegate = new PlaywrightSemanticPage(
      new StalledTranscriptPage() as unknown as Page,
      undefined,
      20,
      async () => { this.terminationCalls += 1; },
    );
  }

  public async currentUrl(): Promise<string> {
    this.currentUrlCalls += 1;
    return "https://m365.cloud.microsoft/chat/conversation/ready";
  }

  public async snapshot(group: LocatorGroup): Promise<GroupSnapshot> {
    this.inspectedSignals.push(group.signal);
    if (group.signal === "responses") return this.#transcriptDelegate.snapshot(group);

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
    this.fillCalls += 1;
    throw new Error("fill is outside this readiness regression");
  }

  public async click(_group: LocatorGroup, _guard: SemanticActionGuard): Promise<void> {
    throw new Error("click is outside this readiness regression");
  }
}

class BlockingReadinessPage extends AuthenticatedReadinessPage {
  public constructor(
    private readonly composerStarted: Deferred<void>,
    private readonly composerRelease: Promise<void>,
  ) {
    super();
  }

  public override async snapshot(group: LocatorGroup): Promise<GroupSnapshot> {
    if (group.signal === "composer") {
      this.composerStarted.resolve();
      await this.composerRelease;
    }
    return super.snapshot(group);
  }
}

test("authenticated setup readiness does not inspect historical transcript content", async () => {
  const page = new AuthenticatedReadinessPage();
  const adapter = new CopilotBrowserAdapter(page, config());

  const inspection = await adapter.inspectState();

  assert.equal(inspection.classification.state, "ready");
  assert.equal(page.inspectedSignals.includes("responses"), false);
  assert.equal(page.inspectedSignals.includes("user-messages"), false);
  assert.deepEqual(
    [...page.inspectedSignals].sort(),
    [
      "shell",
      "conversation",
      "composer",
      "send",
      "streaming",
      "identity",
      "protection",
      "signed-out",
      "mfa",
      "consent",
      "throttled",
      "service-error",
      "modal",
    ].sort(),
  );
  assert.equal(page.terminationCalls, 0);
});

test("the former full readiness observation hits a real Playwright transcript timeout", async () => {
  const page = new AuthenticatedReadinessPage();

  await assert.rejects(
    observeCopilotPage(page, config().uiContract),
    (error: unknown) =>
      isTranscriptTimeout(error),
  );

  assert.equal(page.terminationCalls, 1);
  assert.equal(page.fillCalls, 0);
});

test("submission still uses full transcript observation and fails before prompt fill", async () => {
  const page = new AuthenticatedReadinessPage();
  const adapter = new CopilotBrowserAdapter(page, config());

  await assert.rejects(
    adapter.submit({
      taskId: "task-readiness-regression",
      turnId: "turn-1",
      submissionId: "submission-1",
      content: "must-not-disclose",
    }),
    (error: unknown) => isTranscriptTimeout(error),
  );

  assert.equal(page.terminationCalls, 1);
  assert.equal(page.fillCalls, 0);
});

test("overlapping readiness and submission operations are rejected before a second observation", async () => {
  const composerStarted = deferred<void>();
  const composerRelease = deferred<void>();
  const page = new BlockingReadinessPage(composerStarted, composerRelease.promise);
  const adapter = new CopilotBrowserAdapter(page, config());
  const firstInspection = adapter.inspectState();
  await composerStarted.promise;

  for (const overlapping of [
    adapter.inspectState(),
    adapter.submit({
      taskId: "task-concurrent-observation",
      turnId: "turn-1",
      submissionId: "submission-concurrent-observation",
      content: "must-not-disclose",
    }),
  ]) {
    await assert.rejects(
      overlapping,
      (error: unknown) =>
        error instanceof Error &&
        "details" in error &&
        (error as { readonly details: Readonly<Record<string, unknown>> }).details.diagnosticCode ===
          "CONCURRENT_BROWSER_OPERATION",
    );
  }
  assert.equal(page.currentUrlCalls, 1);
  assert.equal(page.fillCalls, 0);

  composerRelease.resolve();
  const inspection = await firstInspection;
  assert.equal(inspection.classification.state, "ready");
});

class StalledTranscriptPage {
  public on(): this { return this; }
  public locator(): Locator { return new StalledTranscriptLocator() as unknown as Locator; }
  public context(): BrowserContext {
    return { browser: () => null } as unknown as BrowserContext;
  }
}

class StalledTranscriptLocator {
  public async count(): Promise<number> { return 1; }
  public nth(): Locator { return this as unknown as Locator; }
  public async isVisible(): Promise<boolean> { return true; }
  public async isEnabled(): Promise<boolean> { return true; }
  public async getAttribute(): Promise<string | null> { return null; }
  public async innerText(): Promise<string> { return new Promise<string>(() => {}); }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function isTranscriptTimeout(error: unknown): boolean {
  if (!(error instanceof Error) || !("details" in error)) return false;
  const details = (error as { readonly details: Readonly<Record<string, unknown>> }).details;
  return details.diagnosticCode === "BROWSER_OPERATION_TIMEOUT" &&
    details.semanticGroup === "responses" &&
    details.semanticOperation === "locator.innerText";
}

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
