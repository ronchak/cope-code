import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext, Locator, Page } from "playwright-core";

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

class ActionLocator {
  public constructor(private readonly page: ActionPage) {}

  public async count(): Promise<number> { return 1; }
  public nth(_index: number): Locator { return this as unknown as Locator; }
  public async isVisible(): Promise<boolean> { return true; }
  public async isEnabled(): Promise<boolean> { return true; }
  public async innerText(): Promise<string> { return this.page.composer; }
  public async inputValue(): Promise<string> { return this.page.composer; }
  public async getAttribute(_name: string): Promise<string | null> { return null; }
  public async fill(value: string): Promise<void> {
    this.page.composer = value;
    this.page.actions.push(`fill:${value}`);
  }
  public async click(): Promise<void> { this.page.actions.push("click"); }
  public async press(key: string): Promise<void> { this.page.actions.push(`press:${key}`); }
}

class ActionPage {
  public closed = false;
  public composer = "";
  public readonly actions: string[] = [];

  public constructor(public currentUrl: string) {}

  public url(): string { return this.currentUrl; }
  public isClosed(): boolean { return this.closed; }
  public setDefaultTimeout(_milliseconds: number): void {}
  public setDefaultNavigationTimeout(_milliseconds: number): void {}
  public async bringToFront(): Promise<void> {}
  public on(_event: string, _listener: (...args: readonly unknown[]) => void): this { return this; }
  public locator(_selector: string): Locator {
    return new ActionLocator(this) as unknown as Locator;
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
  await tracked.fill(composerGroup, "hello");
  assert.equal(await tracked.currentUrl(), page.currentUrl);
  await tracked.click(sendGroup);

  assert.deepEqual(page.actions, ["fill:hello", "click"]);
});

test("composer-enter activation uses the same post-fill page pin", async () => {
  const page = new ActionPage(`${entryUrl}/conversation/one`);
  const context = new ActionContext([page]);
  const tracked = createTracked(context, page);

  assert.equal(await tracked.currentUrl(), page.currentUrl);
  await tracked.fill(composerGroup, "hello");
  assert.equal(await tracked.currentUrl(), page.currentUrl);
  await tracked.press(composerGroup, "Enter");

  assert.deepEqual(page.actions, ["fill:hello", "press:Enter"]);
});

test("activation without the post-fill observation is rejected", async () => {
  const page = new ActionPage(`${entryUrl}/conversation/one`);
  const context = new ActionContext([page]);
  const tracked = createTracked(context, page);

  assert.equal(await tracked.currentUrl(), page.currentUrl);
  await tracked.fill(composerGroup, "hello");

  await assert.rejects(
    tracked.click(sendGroup),
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
  await tracked.fill(composerGroup, "trusted prompt with marker");
  assert.equal(await tracked.currentUrl(), page.currentUrl);
  page.composer = "different draft";

  await assert.rejects(
    tracked.click(sendGroup),
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
    tracked.fill(composerGroup, "must-not-move"),
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
    tracked.fill(composerGroup, "must-not-disclose"),
    changedPageError,
  );
  assert.deepEqual(page.actions, []);
});

test("a second configured Copilot page creates a hard stop before prompt fill", async () => {
  const first = new ActionPage(`${entryUrl}/conversation/one`);
  const context = new ActionContext([first]);
  const tracked = createTracked(context, first);

  assert.equal(await tracked.currentUrl(), first.currentUrl);
  const second = new ActionPage(`${entryUrl}/conversation/two`);
  context.pageList.push(second);

  await assert.rejects(
    tracked.fill(composerGroup, "must-not-disclose"),
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
  await tracked.fill(composerGroup, "filled-only-on-first");
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
  await tracked.fill(composerGroup, "filled-only-on-first");
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
