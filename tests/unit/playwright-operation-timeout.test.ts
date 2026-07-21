import assert from "node:assert/strict";
import test from "node:test";

import type { Browser, BrowserContext, ElementHandle, Frame, Locator, Page } from "playwright-core";

import { ContextSemanticPage } from "../../src/browser/context-semantic-page.js";
import { PlaywrightSemanticPage } from "../../src/browser/playwright-semantic-page.js";
import { AgentError } from "../../src/shared/errors.js";
import type { LocatorGroup } from "../../src/browser/contracts.js";

const composerGroup: LocatorGroup = {
  signal: "composer",
  candidates: [{ kind: "css", selector: "textarea" }],
  minimumCandidateMatches: 1,
  maximumElements: 1,
  capture: "value-and-text",
};
const sendGroup: LocatorGroup = {
  signal: "send",
  candidates: [{ kind: "css", selector: "button" }],
  minimumCandidateMatches: 1,
  maximumElements: 1,
  capture: "presence",
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

class TimeoutElement {
  public evaluateCalls = 0;

  public async isVisible(): Promise<boolean> { return true; }
  public async isEnabled(): Promise<boolean> { return true; }
  public async isEditable(): Promise<boolean> { return true; }
  public async getAttribute(_name: string): Promise<string | null> { return null; }
  public async evaluate(): Promise<unknown> {
    this.evaluateCalls += 1;
    return "dispatched";
  }
}

class TimeoutLocator {
  public constructor(
    private readonly countResult: Promise<number>,
    private readonly element: TimeoutElement,
  ) {}

  public async count(): Promise<number> { return this.countResult; }
  public nth(_index: number): Locator { return this as unknown as Locator; }
  public async elementHandle(): Promise<ElementHandle> {
    return this.element as unknown as ElementHandle;
  }
}

class TimeoutPage {
  public constructor(private readonly locatorValue: unknown) {}

  public on(): this { return this; }
  public locator(): Locator { return this.locatorValue as unknown as Locator; }
  public context(): BrowserContext {
    return { browser: () => null } as unknown as BrowserContext;
  }
}

function timeoutError(error: unknown): AgentError {
  assert.equal(error instanceof AgentError, true);
  assert.equal((error as AgentError).details.diagnosticCode, "BROWSER_OPERATION_TIMEOUT");
  return error as AgentError;
}

test("a deadline during locator discovery cannot issue a late fill or click", async () => {
  for (const action of ["fill", "click"] as const) {
    const discovery = deferred<number>();
    const terminationRelease = deferred<void>();
    const timeoutStarted = deferred<void>();
    const element = new TimeoutElement();
    let terminationCalls = 0;
    const semantic = new PlaywrightSemanticPage(
      new TimeoutPage(new TimeoutLocator(discovery.promise, element)) as unknown as Page,
      undefined,
      10,
      async () => {
        terminationCalls += 1;
        timeoutStarted.resolve();
        await terminationRelease.promise;
      },
    );

    const operation = action === "fill"
      ? semantic.fill(composerGroup, "must-not-disclose", () => {})
      : semantic.click(sendGroup, () => {});
    await timeoutStarted.promise;
    discovery.resolve(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(element.evaluateCalls, 0, `${action} dispatched after its deadline`);
    terminationRelease.resolve();

    let observedError: unknown;
    try {
      await operation;
    } catch (error) {
      observedError = error;
    }
    assert.equal(timeoutError(observedError).details.dispatchAttempted, false);
    assert.equal(element.evaluateCalls, 0);
    assert.equal(terminationCalls, 1);
  }
});

test("concurrent blocked snapshots share one termination and cannot swallow timeout", async () => {
  const blockedCount = new Promise<number>(() => {});
  const terminationRelease = deferred<void>();
  const timeoutStarted = deferred<void>();
  let terminationCalls = 0;
  const semantic = new PlaywrightSemanticPage(
    new TimeoutPage(
      new TimeoutLocator(blockedCount, new TimeoutElement()),
    ) as unknown as Page,
    undefined,
    10,
    async () => {
      terminationCalls += 1;
      timeoutStarted.resolve();
      await terminationRelease.promise;
    },
  );

  const snapshots = [
    semantic.snapshot(composerGroup),
    semantic.snapshot(composerGroup),
  ];
  await timeoutStarted.promise;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(terminationCalls, 1);
  terminationRelease.resolve();
  const results = await Promise.allSettled(snapshots);

  assert.equal(results.every((result) => result.status === "rejected"), true);
  for (const result of results) {
    if (result.status === "fulfilled") assert.fail("snapshot swallowed its timeout");
    assert.equal(timeoutError(result.reason).details.dispatchAttempted, false);
  }
});

function busySpin(milliseconds: number): void {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    // Deliberately starve timer callbacks while Promise continuations remain
    // eligible for the microtask queue.
  }
}

class BusyCountLocator {
  public async count(): Promise<number> { busySpin(70); return 1; }
  public nth(_index: number): Locator { return this as unknown as Locator; }
  public async isVisible(): Promise<boolean> { return true; }
  public async isEnabled(): Promise<boolean> { return true; }
  public async isEditable(): Promise<boolean> { return true; }
  public async getAttribute(_name: string): Promise<string | null> { return null; }
  public async innerText(): Promise<string> { return "ready"; }
  public async inputValue(): Promise<string> { return "ready"; }
}

class BusyEvaluateElement extends TimeoutElement {
  public override async evaluate(): Promise<unknown> {
    this.evaluateCalls += 1;
    busySpin(70);
    return "dispatched";
  }
}

test("clock checks reject operations that settle after starving their deadline timer", async () => {
  let snapshotTerminations = 0;
  const snapshotPage = new PlaywrightSemanticPage(
    new TimeoutPage(new BusyCountLocator()) as unknown as Page,
    undefined,
    50,
    async () => { snapshotTerminations += 1; },
  );
  let snapshotError: unknown;
  try {
    await snapshotPage.snapshot(composerGroup);
  } catch (error) {
    snapshotError = error;
  }
  assert.equal(timeoutError(snapshotError).details.dispatchAttempted, false);
  assert.equal(snapshotTerminations, 1);

  for (const action of ["fill", "click"] as const) {
    const element = new BusyEvaluateElement();
    let terminations = 0;
    const semantic = new PlaywrightSemanticPage(
      new TimeoutPage(
        new TimeoutLocator(Promise.resolve(1), element),
      ) as unknown as Page,
      undefined,
      50,
      async () => { terminations += 1; },
    );
    let observedError: unknown;
    try {
      if (action === "fill") {
        await semantic.fill(composerGroup, "late disclosure", () => {});
      } else {
        await semantic.click(sendGroup, () => {});
      }
    } catch (error) {
      observedError = error;
    }
    assert.equal(timeoutError(observedError).details.dispatchAttempted, true);
    assert.equal(element.evaluateCalls, 1);
    assert.equal(terminations, 1);
  }
});

class SharedDeadlineBrowser {
  public closeCalls = 0;
  public async close(): Promise<void> { this.closeCalls += 1; }
}

class SharedDeadlineElement {
  public constructor(private readonly page: SharedDeadlinePage) {}

  public async isVisible(): Promise<boolean> { return true; }
  public async isEnabled(): Promise<boolean> { return true; }
  public async isEditable(): Promise<boolean> { return true; }
  public async getAttribute(_name: string): Promise<string | null> { return null; }
  public async evaluate(
    _callback: (...args: readonly unknown[]) => unknown,
    value?: string,
  ): Promise<unknown> {
    if (value !== undefined) {
      this.page.composer = value;
      return undefined;
    }
    return new Promise<never>(() => {});
  }
}

class SharedDeadlineLocator {
  public constructor(
    private readonly page: SharedDeadlinePage,
    private readonly selector: string,
  ) {}

  public async count(): Promise<number> { return 1; }
  public nth(_index: number): Locator { return this as unknown as Locator; }
  public async elementHandle(): Promise<ElementHandle> {
    return new SharedDeadlineElement(this.page) as unknown as ElementHandle;
  }
  public async isVisible(): Promise<boolean> { return true; }
  public async isEnabled(): Promise<boolean> { return true; }
  public async isEditable(): Promise<boolean> { return true; }
  public async getAttribute(_name: string): Promise<string | null> { return null; }
  public async innerText(): Promise<string> { return this.page.composer; }
  public async inputValue(): Promise<string> {
    if (this.selector === "textarea") await this.page.snapshotDelay;
    return this.page.composer;
  }
}

class SharedDeadlinePage {
  public composer = "";
  public snapshotDelay: Promise<void> = Promise.resolve();
  public closed = false;

  public constructor(public readonly currentUrl: string) {}

  public url(): string { return this.currentUrl; }
  public isClosed(): boolean { return this.closed; }
  public mainFrame(): Frame { return this as unknown as Frame; }
  public on(): this { return this; }
  public setDefaultTimeout(_milliseconds: number): void {}
  public setDefaultNavigationTimeout(_milliseconds: number): void {}
  public async bringToFront(): Promise<void> {}
  public async close(): Promise<void> { this.closed = true; }
  public locator(selector: string): Locator {
    return new SharedDeadlineLocator(this, selector) as unknown as Locator;
  }
}

class SharedDeadlineContext {
  public constructor(
    private readonly pageValue: SharedDeadlinePage,
    private readonly browserValue: SharedDeadlineBrowser,
  ) {}

  public pages(): readonly Page[] { return [this.pageValue as unknown as Page]; }
  public browser(): Browser { return this.browserValue as unknown as Browser; }
  public on(): this { return this; }
  public async close(): Promise<void> { this.pageValue.closed = true; }
}

test("composer recheck and send dispatch share one semantic click deadline", async () => {
  const browser = new SharedDeadlineBrowser();
  const page = new SharedDeadlinePage("https://m365.cloud.microsoft/chat/conversation/deadline");
  const context = new SharedDeadlineContext(page, browser);
  const semantic = new ContextSemanticPage(
    context as unknown as BrowserContext,
    {
      entryUrl: "https://m365.cloud.microsoft/chat",
      approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    },
    page as unknown as Page,
    200,
  );

  assert.equal(await semantic.currentUrl(), page.currentUrl);
  await semantic.fill(composerGroup, "prepared draft", () => {});
  assert.equal(await semantic.currentUrl(), page.currentUrl);
  const snapshotRelease = deferred<void>();
  page.snapshotDelay = snapshotRelease.promise;
  const releaseTimer = setTimeout(() => snapshotRelease.resolve(), 100);
  const startedAt = performance.now();
  let observedError: unknown;
  try {
    await semantic.click(sendGroup, () => {});
  } catch (error) {
    observedError = error;
  } finally {
    clearTimeout(releaseTimer);
  }
  const elapsedMs = performance.now() - startedAt;

  assert.equal(timeoutError(observedError).details.dispatchAttempted, true);
  assert.ok(
    elapsedMs < 260,
    `composer recheck and send used more than one 200 ms deadline: ${elapsedMs} ms`,
  );
  assert.equal(browser.closeCalls, 1);
});
