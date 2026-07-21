import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext, Page } from "playwright-core";

import { classifyCopilotPage, observeCopilotPage } from "../../src/browser/classifier.js";
import { createBaselineCopilotUiContract } from "../../src/browser/config.js";
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
const identity = "Synthetic Work Account";
const contract = createBaselineCopilotUiContract(identity);

class DialogPage {
  public closed = false;
  readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  public constructor(public currentUrl: string) {}

  public url(): string { return this.currentUrl; }
  public isClosed(): boolean { return this.closed; }
  public setDefaultTimeout(_milliseconds: number): void {}
  public setDefaultNavigationTimeout(_milliseconds: number): void {}
  public async bringToFront(): Promise<void> {}
  public async close(): Promise<void> { this.closed = true; }
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

test("a dialog on a replacement page remains terminal after that target closes", async () => {
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
  assert.equal(authentication.closed, true);

  const observation = await observeCopilotPage(tracked, contract);
  const classification = classifyCopilotPage(observation, contract, {
    entryUrl,
    approvedHosts: selectionConfig.approvedHosts,
    expectedIdentity: identity,
    requireProtectionIndicator: false,
  });

  assert.equal(observation.url, chat.currentUrl);
  assert.equal(observation.modal.matchedCandidates, 1);
  assert.equal(observation.modal.enabledElements, 0);
  assert.equal(classification.state, "blocking-modal");
  assert.equal(classification.diagnosticCode, "NATIVE_BROWSER_DIALOG_DETECTED");
});
