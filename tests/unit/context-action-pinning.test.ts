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
  public async fill(value: string): Promise<void> { this.page.actions.push(`fill:${value}`); }
  public async click(): Promise<void> { this.page.actions.push("click"); }
  public async press(key: string): Promise<void> { this.page.actions.push(`press:${key}`); }
}

class ActionPage {
  public closed = false;
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

test("an unchanged observed page remains actionable", async () => {
  const page = new ActionPage(`${entryUrl}/conversation/one`);
  const context = new ActionContext([page]);
  const tracked = createTracked(context, page);

  assert.equal(await tracked.currentUrl(), page.currentUrl);
  await tracked.fill(composerGroup, "hello");
  await tracked.click(sendGroup);
  await tracked.press(composerGroup, "Enter");

  assert.deepEqual(page.actions, ["fill:hello", "click", "press:Enter"]);
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
    tracked.click(sendGroup),
    changedPageError,
  );
  assert.deepEqual(page.actions, []);
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
