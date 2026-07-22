import assert from "node:assert/strict";
import test from "node:test";

import type { Browser, BrowserContext, Frame, Locator, Page } from "playwright-core";

import {
  classifyCopilotPage,
  observeCopilotReadinessPage,
} from "../../src/browser/classifier.js";
import { ContextSemanticPage } from "../../src/browser/context-semantic-page.js";
import type {
  CopilotSignal,
  CopilotUiContract,
  LocatorGroup,
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

function createHarness(): {
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
    100,
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
    this.page.runProbeHook();
    return matchedSignals.has(this.signal) ||
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
