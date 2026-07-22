import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import type { Browser, BrowserContext, Frame, Locator, Page } from "playwright-core";

import { CopilotBrowserAdapter } from "../../src/browser/copilot-browser-adapter.js";
import {
  classifyCopilotPage,
  observeCopilotReadinessPage,
} from "../../src/browser/classifier.js";
import {
  createBaselineCopilotUiContract,
  type CopilotBrowserAdapterConfig,
} from "../../src/browser/config.js";
import { ContextSemanticPage } from "../../src/browser/context-semantic-page.js";
import type {
  CopilotSignal,
  CopilotUiContract,
  GroupSnapshot,
  LocatorGroup,
  SemanticActionGuard,
  SemanticObservationCompletion,
  SemanticPage,
} from "../../src/browser/contracts.js";
import { AgentError } from "../../src/shared/errors.js";

const entryUrl = "https://m365.cloud.microsoft/chat";
const expectedIdentity = "operator@example.invalid";
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
const matchedSignals = new Set<CopilotSignal>([
  "shell",
  "conversation",
  "composer",
  "send",
  "identity",
]);

test("a stable context can complete authenticated readiness", async () => {
  const harness = createHarness();

  const inspection = await inspect(harness.semantic);

  assert.equal(inspection.state, "ready");
});

test("a native dialog during readiness cannot be hidden by an earlier snapshot", async () => {
  const harness = createHarness();
  harness.page.probeHook = () => harness.page.emitDialog();

  const inspection = await inspect(harness.semantic);

  assert.equal(inspection.state, "blocking-modal");
  assert.equal(inspection.diagnosticCode, "NATIVE_BROWSER_DIALOG_DETECTED");
  assert.equal(harness.browser.closeCalls, 1);
});

test("a DOM modal appearing during another readiness probe is inspected last", async () => {
  const harness = createHarness();
  harness.page.probeHook = () => { harness.page.modalVisible = true; };

  const inspection = await inspect(harness.semantic);

  assert.equal(inspection.state, "blocking-modal");
  assert.equal(inspection.diagnosticCode, "UNEXPECTED_BLOCKING_MODAL");
});

test("the final modal probe shares the observation action deadline", async () => {
  const harness = createHarness(100);
  harness.page.probeDelayMs = 70;
  harness.page.stallModalProbe = true;
  const startedAt = performance.now();
  let observedError: unknown;

  try {
    await inspect(harness.semantic);
  } catch (error) {
    observedError = error;
  }

  const elapsedMs = performance.now() - startedAt;
  assert.equal(observedError instanceof AgentError, true);
  assert.equal(
    (observedError as AgentError).details.diagnosticCode,
    "BROWSER_OPERATION_TIMEOUT",
  );
  assert.equal((observedError as AgentError).details.semanticGroup, "modal");
  assert.equal((observedError as AgentError).details.semanticOperation, "locator.count");
  assert.ok(
    elapsedMs < 145,
    `observation exceeded its shared action deadline (${String(elapsedMs)} ms)`,
  );
  assert.equal(harness.browser.closeCalls, 1);
});

test("an unapproved navigation during readiness invalidates the observation", async () => {
  const harness = createHarness();
  harness.page.probeHook = () => {
    harness.page.navigate("https://unapproved.invalid/fake-chat");
  };

  await assert.rejects(inspect(harness.semantic), changedObservation);
});

test("same-URL navigation during readiness invalidates the observation", async () => {
  const harness = createHarness();
  harness.page.probeHook = () => harness.page.navigate(harness.page.currentUrl);

  await assert.rejects(inspect(harness.semantic), changedObservation);
});

test("a same-URL replacement page during readiness invalidates ownership", async () => {
  const harness = createHarness();
  harness.page.probeHook = () => {
    harness.page.closed = true;
    harness.context.addPage(new ObservationPage(harness.page.currentUrl));
  };

  await assert.rejects(inspect(harness.semantic), changedObservation);
});

test("an authentication popup appearing during readiness invalidates ownership", async () => {
  const harness = createHarness();
  harness.page.probeHook = () => {
    harness.context.addPage(new ObservationPage(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    ));
  };

  await assert.rejects(inspect(harness.semantic), changedObservation);
});

test("a second configured page appearing during readiness is ambiguous", async () => {
  const harness = createHarness();
  harness.page.probeHook = () => {
    harness.context.addPage(new ObservationPage(`${entryUrl}/conversation/two`));
  };

  await assert.rejects(
    inspect(harness.semantic),
    (error: unknown) =>
      error instanceof AgentError && error.details.diagnosticCode === "AMBIGUOUS_COPILOT_PAGE",
  );
});

test("overlapping adapter operations cannot launder a same-URL navigation", async () => {
  const page = new ObservationPage(`${entryUrl}/conversation/one`);
  const browser = new ObservationBrowser();
  const context = new ObservationContext([page], browser);
  const tracked = new ContextSemanticPage(
    context.asContext(),
    {
      entryUrl,
      approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
      manualAuthenticationHosts: [{ hostname: "login.microsoftonline.com" }],
    },
    page.asPage(),
    100,
  );
  const composerStarted = deferred<void>();
  const composerRelease = deferred<void>();
  const translated = new TranslatingContextPage(
    tracked,
    composerStarted,
    composerRelease.promise,
  );
  const adapter = new CopilotBrowserAdapter(translated, baselineConfig());
  const first = settleWithin(adapter.inspectState(), 500);
  let overlappingInspection: Readonly<Record<string, unknown>> | undefined;
  let overlappingSubmission: Readonly<Record<string, unknown>> | undefined;
  try {
    await settleWithin(Promise.all([
      composerStarted.promise,
      translated.oldEvidenceCaptured.promise,
    ]), 500);

    page.matchedSignals = new Set(["composer"]);
    page.navigate(page.currentUrl);
    overlappingInspection = await settleWithin(adapter.inspectState(), 500);
    overlappingSubmission = await settleWithin(adapter.submit({
      taskId: "task-context-overlap",
      turnId: "turn-1",
      submissionId: "submission-context-overlap",
      content: "must-not-disclose",
    }), 500);
  } finally {
    composerRelease.resolve();
  }
  const firstInspection = await first;

  assert.deepEqual(overlappingInspection, {
    status: "rejected",
    diagnosticCode: "CONCURRENT_BROWSER_OPERATION",
  });
  assert.deepEqual(overlappingSubmission, {
    status: "rejected",
    diagnosticCode: "CONCURRENT_BROWSER_OPERATION",
  });
  assert.deepEqual(firstInspection, {
    status: "rejected",
    diagnosticCode: "ACTIVE_PAGE_CHANGED_DURING_OBSERVATION",
  });
  assert.equal(translated.currentUrlCalls, 1);
  assert.equal(translated.fillCalls, 0);
});

function createHarness(actionMs = 100): {
  readonly semantic: ContextSemanticPage;
  readonly page: ObservationPage;
  readonly context: ObservationContext;
  readonly browser: ObservationBrowser;
} {
  const page = new ObservationPage(`${entryUrl}/conversation/one`);
  const browser = new ObservationBrowser();
  const context = new ObservationContext([page], browser);
  const semantic = new ContextSemanticPage(
    context.asContext(),
    {
      entryUrl,
      approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
      manualAuthenticationHosts: [{ hostname: "login.microsoftonline.com" }],
      uiContract: contract,
    },
    page.asPage(),
    actionMs,
  );
  return {
    semantic,
    page,
    context,
    browser,
  };
}

class ObservationLocator {
  public constructor(
    private readonly page: ObservationPage,
    private readonly signal: CopilotSignal,
  ) {}

  public async count(): Promise<number> {
    if (this.signal === "modal" && this.page.stallModalProbe) {
      return new Promise<number>(() => {});
    }
    if (this.page.probeDelayMs > 0) await delay(this.page.probeDelayMs);
    this.page.runProbeHook();
    return this.page.matchedSignals.has(this.signal) ||
        (this.signal === "modal" && this.page.modalVisible)
      ? 1
      : 0;
  }
  public nth(): Locator { return this as unknown as Locator; }
  public async isVisible(): Promise<boolean> { return true; }
  public async isEnabled(): Promise<boolean> { return true; }
  public async isEditable(): Promise<boolean> { return this.signal === "composer"; }
  public async getAttribute(name: string): Promise<string | null> {
    return name === "aria-label" && this.signal === "identity" ? expectedIdentity : null;
  }
  public async innerText(): Promise<string> {
    return this.signal === "identity" ? expectedIdentity : this.signal;
  }
  public async inputValue(): Promise<string> { return ""; }
}

class ObservationPage {
  public closed = false;
  public modalVisible = false;
  public probeDelayMs = 0;
  public stallModalProbe = false;
  public matchedSignals = new Set(matchedSignals);
  public probeHook: (() => void) | undefined;
  readonly #navigationListeners: Array<(frame: Frame) => void> = [];
  readonly #dialogListeners: Array<() => void> = [];

  public constructor(public currentUrl: string) {}

  public url(): string { return this.currentUrl; }
  public isClosed(): boolean { return this.closed; }
  public mainFrame(): Frame { return this as unknown as Frame; }
  public setDefaultTimeout(): void {}
  public setDefaultNavigationTimeout(): void {}
  public async bringToFront(): Promise<void> {}
  public on(event: string, listener: (...args: readonly unknown[]) => void): this {
    if (event === "framenavigated") {
      this.#navigationListeners.push(listener as (frame: Frame) => void);
    } else if (event === "dialog") {
      this.#dialogListeners.push(listener as () => void);
    }
    return this;
  }
  public locator(selector: string): Locator {
    const signal = selector.replace("[data-cope-signal='", "").replace("']", "") as CopilotSignal;
    return new ObservationLocator(this, signal) as unknown as Locator;
  }
  public navigate(url: string): void {
    this.currentUrl = url;
    const frame = this.mainFrame();
    for (const listener of this.#navigationListeners) listener(frame);
  }
  public emitDialog(): void {
    for (const listener of this.#dialogListeners) listener();
  }
  public runProbeHook(): void {
    const hook = this.probeHook;
    this.probeHook = undefined;
    hook?.();
  }
  public asPage(): Page { return this as unknown as Page; }
}

class TranslatingContextPage implements SemanticPage {
  public currentUrlCalls = 0;
  public fillCalls = 0;
  public readonly oldEvidenceCaptured = deferred<void>();
  readonly #capturedOldSignals = new Set<CopilotSignal>();
  #composerBlocked = false;

  public constructor(
    private readonly tracked: ContextSemanticPage,
    private readonly composerStarted: Deferred<void>,
    private readonly composerRelease: Promise<void>,
  ) {}

  public async currentUrl(): Promise<string> {
    this.currentUrlCalls += 1;
    return this.tracked.currentUrl();
  }

  public async snapshot(group: LocatorGroup): Promise<GroupSnapshot> {
    if (group.signal === "composer" && !this.#composerBlocked) {
      this.#composerBlocked = true;
      this.composerStarted.resolve();
      await this.composerRelease;
    }
    const result = await this.tracked.snapshot(groups[group.signal]);
    if (group.signal === "conversation" || group.signal === "identity") {
      this.#capturedOldSignals.add(group.signal);
      if (this.#capturedOldSignals.size === 2) this.oldEvidenceCaptured.resolve();
    }
    return result;
  }

  public completeObservation(): Promise<SemanticObservationCompletion> {
    return this.tracked.completeObservation();
  }

  public async fill(
    group: LocatorGroup,
    value: string,
    guard: SemanticActionGuard,
  ): Promise<void> {
    this.fillCalls += 1;
    await this.tracked.fill(groups[group.signal], value, guard);
  }

  public click(group: LocatorGroup, guard: SemanticActionGuard): Promise<void> {
    return this.tracked.click(groups[group.signal], guard);
  }
}

class ObservationBrowser {
  public closeCalls = 0;
  public async close(): Promise<void> { this.closeCalls += 1; }
}

class ObservationContext {
  readonly #pageListeners: Array<(page: Page) => void> = [];

  public constructor(
    public readonly pageList: ObservationPage[],
    private readonly browserValue: ObservationBrowser,
  ) {}

  public pages(): Page[] { return this.pageList.map((page) => page.asPage()); }
  public browser(): Browser { return this.browserValue as unknown as Browser; }
  public on(event: string, listener: (...args: readonly unknown[]) => void): this {
    if (event === "page") this.#pageListeners.push(listener as (page: Page) => void);
    return this;
  }
  public addPage(page: ObservationPage): void {
    this.pageList.push(page);
    for (const listener of this.#pageListeners) listener(page.asPage());
  }
  public asContext(): BrowserContext { return this as unknown as BrowserContext; }
}

const groups = Object.fromEntries(signals.map((signal) => [signal, {
  signal,
  candidates: [{ kind: "css", selector: `[data-cope-signal='${signal}']` }],
  minimumCandidateMatches: 1,
  maximumElements: 1,
  capture: signal === "composer" ? "value-and-text" : "text",
} satisfies LocatorGroup])) as unknown as CopilotUiContract["groups"];

const contract: CopilotUiContract = {
  version: "copilot-ui/v1:test-observation-consistency",
  certifiedSurface: "test-only",
  submissionStrategy: "send-control",
  groups,
};

async function inspect(page: ContextSemanticPage) {
  const observation = await observeCopilotReadinessPage(page, contract);
  return classifyCopilotPage(observation, contract, {
    entryUrl,
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    expectedIdentity,
    requireProtectionIndicator: false,
  });
}

function changedObservation(error: unknown): boolean {
  return error instanceof AgentError &&
    error.details.diagnosticCode === "ACTIVE_PAGE_CHANGED_DURING_OBSERVATION";
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

async function settleWithin(
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<Readonly<Record<string, unknown>>> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({
          status: "fulfilled",
          state: typeof value === "object" && value !== null && "classification" in value
            ? (value as { readonly classification: { readonly state: string } }).classification.state
            : "completed",
        }),
        (error: unknown) => ({
          status: "rejected",
          diagnosticCode: error instanceof AgentError
            ? error.details.diagnosticCode
            : "UNEXPECTED_ERROR",
        }),
      ),
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(
          () => reject(new Error(`operation did not settle within ${milliseconds} ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
  }
}

function baselineConfig(): CopilotBrowserAdapterConfig {
  return {
    entryUrl,
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    manualAuthenticationHosts: [{ hostname: "login.microsoftonline.com" }],
    uiContract: createBaselineCopilotUiContract(expectedIdentity),
    expectedIdentity,
    requireProtectionIndicator: false,
    maxMessageChars: 200_000,
    maxResponseChars: 1_000_000,
    waits: {
      actionMs: 100,
      submissionConfirmationMs: 100,
      responseMs: 100,
      manualReadinessMs: 500,
      pollMs: 10,
      stableSamples: 2,
      minimumStableMs: 20,
    },
  };
}
