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
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
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

async function rejectionWithin(promise: Promise<unknown>, milliseconds: number): Promise<unknown> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => assert.fail("operation unexpectedly fulfilled"),
        (error: unknown) => error,
      ),
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(
          () => reject(new Error(`operation did not reject within ${milliseconds} ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
  }
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
    const observedError = await rejectionWithin(operation, 100);
    assert.equal(timeoutError(observedError).details.dispatchAttempted, false);
    // The diagnostic must settle while owner teardown is deliberately stalled.
    const laterError = await rejectionWithin(semantic.snapshot(composerGroup), 100);
    assert.equal(timeoutError(laterError).details.dispatchAttempted, false);
    discovery.resolve(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(element.evaluateCalls, 0, `${action} dispatched after its deadline`);
    terminationRelease.resolve();
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
  const results = await Promise.all([
    rejectionWithin(snapshots[0]!, 100),
    rejectionWithin(snapshots[1]!, 100),
  ]);
  assert.equal(terminationCalls, 1);
  for (const error of results) {
    assert.equal(timeoutError(error).details.dispatchAttempted, false);
  }
  const laterError = await rejectionWithin(semantic.snapshot(composerGroup), 100);
  assert.equal(timeoutError(laterError).details.dispatchAttempted, false);
  assert.equal(terminationCalls, 1);
  terminationRelease.resolve();
});

test("one delegate timeout immediately revokes concurrent work in another delegate", async () => {
  const controller = new AbortController();
  const terminationRelease = deferred<void>();
  const blockedSnapshot = new Promise<number>(() => {});
  const delayedDiscovery = deferred<number>();
  const delayedElement = new TimeoutElement();
  let terminationStarts = 0;
  let sharedTermination: Promise<void> | undefined;
  const terminate = () => {
    controller.abort();
    sharedTermination ??= (async () => {
      terminationStarts += 1;
      await terminationRelease.promise;
    })();
    return sharedTermination;
  };
  const shortDelegate = new PlaywrightSemanticPage(
    new TimeoutPage(
      new TimeoutLocator(blockedSnapshot, new TimeoutElement()),
    ) as unknown as Page,
    undefined,
    10,
    terminate,
    controller.signal,
  );
  const longDelegate = new PlaywrightSemanticPage(
    new TimeoutPage(
      new TimeoutLocator(delayedDiscovery.promise, delayedElement),
    ) as unknown as Page,
    undefined,
    1_000,
    terminate,
    controller.signal,
  );

  const concurrentFill = longDelegate.fill(composerGroup, "must-not-disclose", () => {});
  const triggerTimeout = shortDelegate.snapshot(composerGroup);
  const [snapshotError, fillError] = await Promise.all([
    rejectionWithin(triggerTimeout, 100),
    rejectionWithin(concurrentFill, 100),
  ]);
  assert.equal(timeoutError(snapshotError).details.dispatchAttempted, false);
  assert.equal(timeoutError(fillError).details.dispatchAttempted, false);
  assert.equal(terminationStarts, 1);

  delayedDiscovery.resolve(1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(delayedElement.evaluateCalls, 0);
  const laterError = await rejectionWithin(longDelegate.snapshot(composerGroup), 100);
  assert.equal(timeoutError(laterError).details.dispatchAttempted, false);
  assert.equal(terminationStarts, 1);
  terminationRelease.resolve();
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
  public constructor(private readonly closeDelay: Promise<void> = Promise.resolve()) {}
  public async close(): Promise<void> {
    this.closeCalls += 1;
    await this.closeDelay;
  }
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

class StalledForegroundPage extends SharedDeadlinePage {
  public bringToFrontCalls = 0;

  public constructor(
    currentUrl: string,
    private readonly foregroundRelease: Promise<void> = Promise.resolve(),
  ) {
    super(currentUrl);
  }

  public override async bringToFront(): Promise<void> {
    this.bringToFrontCalls += 1;
    await this.foregroundRelease;
  }
}

class MultiPageDeadlineContext {
  public constructor(
    private readonly pageValues: readonly SharedDeadlinePage[],
    private readonly browserValue: SharedDeadlineBrowser,
  ) {}

  public pages(): readonly Page[] {
    return this.pageValues.map((page) => page as unknown as Page);
  }
  public browser(): Browser { return this.browserValue as unknown as Browser; }
  public on(): this { return this; }
  public async close(): Promise<void> {
    for (const page of this.pageValues) page.closed = true;
  }
}

class BudgetBurningContext extends MultiPageDeadlineContext {
  public override pages(): readonly Page[] {
    busySpin(20);
    return super.pages();
  }
}

test("replacement-page foregrounding is bounded and permanently revokes the session", async () => {
  const foregroundRelease = deferred<void>();
  const terminationRelease = deferred<void>();
  const browser = new SharedDeadlineBrowser(terminationRelease.promise);
  const chat = new SharedDeadlinePage("https://m365.cloud.microsoft/chat/conversation/foreground");
  const authentication = new StalledForegroundPage(
    "https://login.microsoftonline.com/common/oauth2/authorize",
    foregroundRelease.promise,
  );
  const context = new MultiPageDeadlineContext([chat, authentication], browser);
  const semantic = new ContextSemanticPage(
    context as unknown as BrowserContext,
    {
      entryUrl: "https://m365.cloud.microsoft/chat",
      approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
      manualAuthenticationHosts: [{ hostname: "login.microsoftonline.com" }],
    },
    chat as unknown as Page,
    10,
  );

  const observedError = await rejectionWithin(semantic.currentUrl(), 100);
  assert.equal(timeoutError(observedError).details.dispatchAttempted, false);
  assert.equal(browser.closeCalls, 1);
  const laterError = await rejectionWithin(semantic.currentUrl(), 100);
  assert.equal(timeoutError(laterError).details.dispatchAttempted, false);
  assert.equal(browser.closeCalls, 1);

  // Promise.race must keep observing the raw activation after the diagnostic
  // settles; a late browser rejection must not become unhandled.
  foregroundRelease.reject(new Error("late target-closed rejection"));
  terminationRelease.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("an expired focus deadline prevents foreground dispatch", async () => {
  const browser = new SharedDeadlineBrowser();
  const chat = new SharedDeadlinePage("https://m365.cloud.microsoft/chat/conversation/focus-budget");
  const authentication = new StalledForegroundPage(
    "https://login.microsoftonline.com/common/oauth2/authorize",
  );
  const context = new BudgetBurningContext([chat, authentication], browser);
  const semantic = new ContextSemanticPage(
    context as unknown as BrowserContext,
    {
      entryUrl: "https://m365.cloud.microsoft/chat",
      approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
      manualAuthenticationHosts: [{ hostname: "login.microsoftonline.com" }],
    },
    chat as unknown as Page,
    10,
  );

  const observedError = await rejectionWithin(semantic.currentUrl(), 100);
  assert.equal(timeoutError(observedError).details.dispatchAttempted, false);
  assert.equal(authentication.bringToFrontCalls, 0);
  assert.equal(browser.closeCalls, 1);
});

test("composer recheck and send dispatch share one semantic click deadline", async () => {
  const terminationRelease = deferred<void>();
  const browser = new SharedDeadlineBrowser(terminationRelease.promise);
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
  const laterError = await rejectionWithin(semantic.currentUrl(), 100);
  assert.equal(timeoutError(laterError).details.dispatchAttempted, false);
  assert.equal(browser.closeCalls, 1);
  terminationRelease.resolve();
});
