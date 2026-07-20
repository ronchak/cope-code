import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext, Page } from "playwright-core";

import { ContextSemanticPage } from "../../src/browser/context-semantic-page.js";
import type { LocatorGroup } from "../../src/browser/contracts.js";

const entryUrl = "https://m365.cloud.microsoft/chat";
const modalGroup: LocatorGroup = {
  signal: "modal",
  candidates: [{ kind: "role", role: "dialog" }],
  minimumCandidateMatches: 1,
  maximumElements: 1,
  capture: "presence",
};
const selectionConfig = {
  entryUrl,
  approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
  manualAuthenticationHosts: [{ hostname: "login.microsoftonline.com" }],
} as const;

class DialogPage {
  public closed = false;
  readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  public constructor(public currentUrl: string) {}

  public url(): string { return this.currentUrl; }
  public isClosed(): boolean { return this.closed; }
  public setDefaultTimeout(_milliseconds: number): void {}
  public setDefaultNavigationTimeout(_milliseconds: number): void {}
  public async bringToFront(): Promise<void> {}
  public on(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
    return this;
  }
  public emitDialog(): void {
    for (const listener of this.#listeners.get("dialog") ?? []) listener({});
  }
  public listenerCount(event: string): number {
    return this.#listeners.get(event)?.length ?? 0;
  }
  public asPage(): Page { return this as unknown as Page; }
}

class DialogContext {
  public readonly pageList: DialogPage[];
  readonly #pageListeners: Array<(page: Page) => void> = [];

  public constructor(pages: readonly DialogPage[]) {
    this.pageList = [...pages];
  }

  public pages(): Page[] { return this.pageList.map((page) => page.asPage()); }
  public on(event: string, listener: (page: Page) => void): this {
    if (event === "page") this.#pageListeners.push(listener);
    return this;
  }
  public addPage(page: DialogPage): void {
    this.pageList.push(page);
    for (const listener of this.#pageListeners) listener(page.asPage());
  }
  public asContext(): BrowserContext { return this as unknown as BrowserContext; }
}

test("the initial page has its native-dialog listener before the first snapshot", async () => {
  const page = new DialogPage(`${entryUrl}/conversation/initial`);
  const context = new DialogContext([page]);
  const tracked = new ContextSemanticPage(
    context.asContext(),
    selectionConfig,
    page.asPage(),
    1_000,
  );

  assert.equal(page.listenerCount("dialog"), 1);
  page.emitDialog();
  const snapshot = await tracked.snapshot(modalGroup);

  assert.equal(snapshot.matchedCandidates, 1);
  assert.equal(snapshot.visibleElements, 1);
  assert.equal(snapshot.enabledElements, 0);
});

test("a replacement page is guarded before it is selected or inspected", async () => {
  const chat = new DialogPage(`${entryUrl}/conversation/initial`);
  const context = new DialogContext([chat]);
  const tracked = new ContextSemanticPage(
    context.asContext(),
    selectionConfig,
    chat.asPage(),
    1_000,
  );
  const authentication = new DialogPage(
    "https://login.microsoftonline.com/common/oauth2/authorize?step=signin",
  );

  context.addPage(authentication);
  assert.equal(authentication.listenerCount("dialog"), 1);
  authentication.emitDialog();
  assert.equal(await tracked.currentUrl(), authentication.currentUrl);
  const snapshot = await tracked.snapshot(modalGroup);

  assert.equal(snapshot.matchedCandidates, 1);
  assert.equal(snapshot.visibleElements, 1);
  assert.equal(snapshot.enabledElements, 0);
});
