import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext, ElementHandle, Frame, Locator, Page } from "playwright-core";

import { ContextSemanticPage } from "../../src/browser/context-semantic-page.js";
import type { LocatorGroup } from "../../src/browser/contracts.js";
import { AgentError } from "../../src/shared/errors.js";

const entryUrl = "https://m365.cloud.microsoft/chat";

const composerGroup: LocatorGroup = {
  signal: "composer",
  candidates: [{ kind: "css", selector: "#composer" }],
  minimumCandidateMatches: 1,
  maximumElements: 1,
  capture: "value-and-text",
};

const sendGroup: LocatorGroup = {
  signal: "send",
  candidates: [{ kind: "css", selector: "#send" }],
  minimumCandidateMatches: 1,
  maximumElements: 1,
  capture: "presence",
};

const allowAction = () => {};

class ActionLocator {
  public constructor(
    private readonly page: ActionPage,
    private readonly selector: string,
  ) {}

  public async count(): Promise<number> {
    this.page.locatorProbeHook?.();
    return this.selector === "#send" && !this.page.sendAvailable ? 0 : 1;
  }
  public nth(_index: number): Locator { return this as unknown as Locator; }
  public async isVisible(): Promise<boolean> { return true; }
  public async isEnabled(): Promise<boolean> { return true; }
  public async innerText(): Promise<string> { return this.page.composer; }
  public async inputValue(): Promise<string> { return this.page.composer; }
  public async getAttribute(_name: string): Promise<string | null> { return null; }
  public async elementHandle(): Promise<ElementHandle> {
    return new BoundActionElement(this.page, this.page.documentEpoch) as unknown as ElementHandle;
  }
}

class BoundActionElement {
  public constructor(
    private readonly page: ActionPage,
    private readonly documentEpoch: number,
  ) {}

  public async isVisible(): Promise<boolean> { return true; }
  public async isEnabled(): Promise<boolean> { return true; }
  public async evaluate(
    _callback: (...args: readonly unknown[]) => unknown,
    value?: string,
  ): Promise<void> {
    this.#beforeDispatch();
    if (value === undefined) {
      this.page.actions.push("click");
    } else {
      this.page.composer = value;
      this.page.actions.push(`fill:${value}`);
    }
  }

  #beforeDispatch(): void {
    this.page.boundActionHook?.();
    if (this.page.documentEpoch !== this.documentEpoch) {
      throw new Error("Bound element detached before dispatch");
    }
  }
}

class ActionPage {
  public closed = false;
  public composer = "";
  public documentEpoch = 0;
  public sendAvailable = true;
  public readonly actions: string[] = [];
  public locatorProbeHook: (() => void) | undefined = undefined;
  public boundActionHook: (() => void) | undefined = undefined;
  readonly #navigationListeners: Array<(frame: Frame) => void> = [];

  public constructor(public currentUrl: string) {}

  public url(): string { return this.currentUrl; }
  public isClosed(): boolean { return this.closed; }
  public setDefaultTimeout(_milliseconds: number): void {}
  public setDefaultNavigationTimeout(_milliseconds: number): void {}
  public async bringToFront(): Promise<void> {}
  public on(event: string, listener: (...args: readonly unknown[]) => void): this {
    if (event === "framenavigated") {
      this.#navigationListeners.push(listener as (frame: Frame) => void);
    }
    return this;
  }
  public mainFrame(): Frame { return this as unknown as Frame; }
  public navigateSameUrl(): void {
    this.documentEpoch += 1;
    const frame = this.mainFrame();
    for (const listener of this.#navigationListeners) listener(frame);
  }
  public locator(_selector: string): Locator {
    return new ActionLocator(this, _selector) as unknown as Locator;
  }
  public asPage(): Page { return this as unknown as Page; }
}

class ActionContext {
  public constructor(public readonly pageList: ActionPage[]) {}
  public pages(): Page[] { return this.pageList.map((page) => page.asPage()); }
  public asContext(): BrowserContext { return this as unknown as BrowserContext; }
}

test("an unchanged filled page remains actionable after its second observation", async () => {
  const page = new ActionPage(`${entryUrl}/conversation/one`);
  const context = new ActionContext([page]);
  const tracked = createTracked(context, page);

  assert.equal(await tracked.currentUrl(), page.currentUrl);
  await tracked.fill(composerGroup, "hello", allowAction);
  assert.equal(await tracked.currentUrl(), page.currentUrl);
  await tracked.click(sendGroup, allowAction);

  assert.deepEqual(page.actions, ["fill:hello", "click"]);
});

test("cancellation during locator discovery prevents composer fill dispatch", async () => {
  const page = new ActionPage(`${entryUrl}/conversation/one`);
  const context = new ActionContext([page]);
  const tracked = createTracked(context, page);
  const controller = new AbortController();
  const guard = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
  };

  assert.equal(await tracked.currentUrl(), page.currentUrl);
  page.locatorProbeHook = () => controller.abort(new Error("cancelled during locator discovery"));

  await assert.rejects(
    tracked.fill(composerGroup, "must-not-disclose", guard),
    (error: unknown) =>
      error instanceof AgentError &&
      error.details.diagnosticCode === "PRE_ACTIVATION_GUARD_FAILED" &&
      error.details.dispatchAttempted === false,
  );
  assert.deepEqual(page.actions, []);
});

test("cancellation during the post-fill guard prevents activation dispatch", async () => {
  const page = new ActionPage(`${entryUrl}/conversation/one`);
  const context = new ActionContext([page]);
  const tracked = createTracked(context, page);
  const controller = new AbortController();
  const guard = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
  };

  assert.equal(await tracked.currentUrl(), page.currentUrl);
  await tracked.fill(composerGroup, "filled but not sent", allowAction);
  assert.equal(await tracked.currentUrl(), page.currentUrl);
  page.locatorProbeHook = () => controller.abort(new Error("cancelled during activation guard"));

  await assert.rejects(
    tracked.click(sendGroup, guard),
    (error: unknown) =>
      error instanceof AgentError &&
      error.details.diagnosticCode === "PRE_ACTIVATION_GUARD_FAILED" &&
      error.details.dispatchAttempted === false,
  );
  assert.deepEqual(page.actions, ["fill:filled but not sent"]);
});

test("activation without the post-fill observation is rejected", async () => {
  const page = new ActionPage(`${entryUrl}/conversation/one`);
  const context = new ActionContext([page]);
  const tracked = createTracked(context, page);

  assert.equal(await tracked.currentUrl(), page.currentUrl);
  await tracked.fill(composerGroup, "hello", allowAction);

  await assert.rejects(
    tracked.click(sendGroup, allowAction),
    (error: unknown) =>
      error instanceof AgentError &&
      error.details.diagnosticCode === "POST_FILL_OBSERVATION_REQUIRED",
  );
  assert.deepEqual(page.actions, ["fill:hello"]);
});

test("composer content changed after fill is rejected before send", async () => {
  const page = new ActionPage(`${entryUrl}/conversation/one`);
  const context = new ActionContext([page]);
  const tracked = createTracked(context, page);

  assert.equal(await tracked.currentUrl(), page.currentUrl);
  await tracked.fill(composerGroup, "trusted prompt with marker", allowAction);
  assert.equal(await tracked.currentUrl(), page.currentUrl);
  page.composer = "different draft";

  await assert.rejects(
    tracked.click(sendGroup, allowAction),
    (error: unknown) =>
      error instanceof AgentError &&
      error.details.diagnosticCode === "COMPOSER_CONTENT_CHANGED_BEFORE_SUBMIT",
  );
  assert.deepEqual(page.actions, ["fill:trusted prompt with marker"]);
});

test("a replacement Copilot tab cannot receive a fill without a new observation", async () => {
  const first = new ActionPage(`${entryUrl}/conversation/one`);
  const context = new ActionContext([first]);
  const tracked = createTracked(context, first);

  assert.equal(await tracked.currentUrl(), first.currentUrl);
  first.closed = true;
  const replacement = new ActionPage(`${entryUrl}/conversation/two`);
  context.pageList.push(replacement);

  await assert.rejects(
    tracked.fill(composerGroup, "must-not-move", allowAction),
    changedPageError,
  );
  assert.deepEqual(first.actions, []);
  assert.deepEqual(replacement.actions, []);
});

test("same-tab navigation after observation blocks the consequential action", async () => {
  const page = new ActionPage(`${entryUrl}/conversation/one`);
  const context = new ActionContext([page]);
  const tracked = createTracked(context, page);

  assert.equal(await tracked.currentUrl(), page.currentUrl);
  page.currentUrl = `${entryUrl}/conversation/two`;

  await assert.rejects(
    tracked.fill(composerGroup, "must-not-disclose", allowAction),
    changedPageError,
  );
  assert.deepEqual(page.actions, []);
});

test("same-URL navigation after observation blocks composer fill", async () => {
  const page = new ActionPage(`${entryUrl}/conversation/one`);
  const context = new ActionContext([page]);
  const tracked = createTracked(context, page);

  assert.equal(await tracked.currentUrl(), page.currentUrl);
  page.navigateSameUrl();

  await assert.rejects(
    tracked.fill(composerGroup, "must-not-disclose", allowAction),
    changedPageError,
  );
  assert.deepEqual(page.actions, []);
});

test("same-URL navigation during fill locator discovery blocks dispatch", async () => {
  const page = new ActionPage(`${entryUrl}/conversation/one`);
  const context = new ActionContext([page]);
  const tracked = createTracked(context, page);

  assert.equal(await tracked.currentUrl(), page.currentUrl);
  page.locatorProbeHook = () => {
    page.locatorProbeHook = undefined;
    page.navigateSameUrl();
  };

  await assert.rejects(
    tracked.fill(composerGroup, "must-not-disclose", allowAction),
    changedPageError,
  );
  assert.deepEqual(page.actions, []);
});

test("same-URL navigation during bound fill cannot retarget the new document", async () => {
  const page = new ActionPage(`${entryUrl}/conversation/one`);
  const context = new ActionContext([page]);
  const tracked = createTracked(context, page);

  assert.equal(await tracked.currentUrl(), page.currentUrl);
  page.boundActionHook = () => {
    page.boundActionHook = undefined;
    page.navigateSameUrl();
  };

  await assert.rejects(
    tracked.fill(composerGroup, "must-not-disclose", allowAction),
    /bound element detached before dispatch/iu,
  );
  assert.deepEqual(page.actions, []);
});

test("same-URL navigation after fill blocks activation even if the draft survives", async () => {
  const page = new ActionPage(`${entryUrl}/conversation/one`);
  const context = new ActionContext([page]);
  const tracked = createTracked(context, page);

  assert.equal(await tracked.currentUrl(), page.currentUrl);
  await tracked.fill(composerGroup, "restored draft", allowAction);
  assert.equal(await tracked.currentUrl(), page.currentUrl);
  page.navigateSameUrl();

  await assert.rejects(
    tracked.click(sendGroup, allowAction),
    (error: unknown) =>
      error instanceof AgentError &&
      error.details.diagnosticCode === "ACTIVE_PAGE_CHANGED_AFTER_FILL",
  );
  assert.deepEqual(page.actions, ["fill:restored draft"]);
});

test("same-URL navigation during click locator discovery blocks dispatch", async () => {
  const page = new ActionPage(`${entryUrl}/conversation/one`);
  const context = new ActionContext([page]);
  const tracked = createTracked(context, page);

  assert.equal(await tracked.currentUrl(), page.currentUrl);
  await tracked.fill(composerGroup, "restored draft", allowAction);
  assert.equal(await tracked.currentUrl(), page.currentUrl);
  let locatorProbes = 0;
  page.locatorProbeHook = () => {
    locatorProbes += 1;
    if (locatorProbes === 2) page.navigateSameUrl();
  };

  await assert.rejects(
    tracked.click(sendGroup, allowAction),
    (error: unknown) =>
      error instanceof AgentError &&
      error.details.diagnosticCode === "ACTIVE_PAGE_CHANGED_AFTER_FILL" &&
      error.details.dispatchAttempted === false,
  );
  assert.deepEqual(page.actions, ["fill:restored draft"]);
});

test("same-URL navigation during bound click cannot retarget the new document", async () => {
  const page = new ActionPage(`${entryUrl}/conversation/one`);
  const context = new ActionContext([page]);
  const tracked = createTracked(context, page);

  assert.equal(await tracked.currentUrl(), page.currentUrl);
  await tracked.fill(composerGroup, "restored draft", allowAction);
  assert.equal(await tracked.currentUrl(), page.currentUrl);
  page.boundActionHook = () => {
    page.boundActionHook = undefined;
    page.navigateSameUrl();
  };

  await assert.rejects(
    tracked.click(sendGroup, allowAction),
    /bound element detached before dispatch/iu,
  );
  assert.deepEqual(page.actions, ["fill:restored draft"]);
});

test("a vanished send control is classified as conclusively pre-dispatch", async () => {
  const page = new ActionPage(`${entryUrl}/conversation/one`);
  const context = new ActionContext([page]);
  const tracked = createTracked(context, page);

  assert.equal(await tracked.currentUrl(), page.currentUrl);
  await tracked.fill(composerGroup, "safe retry draft", allowAction);
  assert.equal(await tracked.currentUrl(), page.currentUrl);
  page.sendAvailable = false;

  await assert.rejects(
    tracked.click(sendGroup, allowAction),
    (error: unknown) =>
      error instanceof AgentError &&
      error.details.diagnosticCode === "ACTIONABLE_LOCATOR_NOT_FOUND" &&
      error.details.dispatchAttempted === false,
  );
  assert.deepEqual(page.actions, ["fill:safe retry draft"]);
});

test("a second configured Copilot page creates a hard stop before prompt fill", async () => {
  const first = new ActionPage(`${entryUrl}/conversation/one`);
  const context = new ActionContext([first]);
  const tracked = createTracked(context, first);

  assert.equal(await tracked.currentUrl(), first.currentUrl);
  const second = new ActionPage(`${entryUrl}/conversation/two`);
  context.pageList.push(second);

  await assert.rejects(
    tracked.fill(composerGroup, "must-not-disclose", allowAction),
    ambiguousPageError,
  );
  assert.deepEqual(first.actions, []);
  assert.deepEqual(second.actions, []);
});

test("a same-URL replacement after fill aborts the second trust observation", async () => {
  const firstUrl = `${entryUrl}/conversation/one`;
  const first = new ActionPage(firstUrl);
  const context = new ActionContext([first]);
  const tracked = createTracked(context, first);

  assert.equal(await tracked.currentUrl(), firstUrl);
  await tracked.fill(composerGroup, "filled-only-on-first", allowAction);
  first.closed = true;
  const replacement = new ActionPage(firstUrl);
  context.pageList.push(replacement);

  await assert.rejects(
    tracked.currentUrl(),
    (error: unknown) =>
      error instanceof AgentError &&
      error.details.diagnosticCode === "ACTIVE_PAGE_CHANGED_AFTER_FILL",
  );
  assert.deepEqual(first.actions, ["fill:filled-only-on-first"]);
  assert.deepEqual(replacement.actions, []);
});

test("a second configured page appearing after fill aborts before activation", async () => {
  const first = new ActionPage(`${entryUrl}/conversation/one`);
  const context = new ActionContext([first]);
  const tracked = createTracked(context, first);

  assert.equal(await tracked.currentUrl(), first.currentUrl);
  await tracked.fill(composerGroup, "filled-only-on-first", allowAction);
  const second = new ActionPage(`${entryUrl}/conversation/two`);
  context.pageList.push(second);

  await assert.rejects(tracked.currentUrl(), ambiguousPageError);
  assert.deepEqual(first.actions, ["fill:filled-only-on-first"]);
  assert.deepEqual(second.actions, []);
});

function createTracked(
  context: ActionContext,
  page: ActionPage,
): ContextSemanticPage {
  return new ContextSemanticPage(
    context.asContext(),
    {
      entryUrl,
      approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
      manualAuthenticationHosts: [{ hostname: "login.microsoftonline.com" }],
    },
    page.asPage(),
    1_000,
  );
}

function changedPageError(error: unknown): boolean {
  return error instanceof AgentError &&
    error.code === "TRANSPORT_INDETERMINATE" &&
    error.details.diagnosticCode === "ACTIVE_PAGE_CHANGED_BEFORE_ACTION";
}

function ambiguousPageError(error: unknown): boolean {
  return error instanceof AgentError &&
    error.code === "TRANSPORT_INDETERMINATE" &&
    error.details.diagnosticCode === "AMBIGUOUS_COPILOT_PAGE";
}
