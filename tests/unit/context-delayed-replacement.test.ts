import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { BrowserContext, Page, Response } from "playwright-core";

import { openTrackedCopilotPage } from "../../src/browser/context-semantic-page.js";
import {
  createBaselineCopilotUiContract,
  type EdgeLaunchConfig,
} from "../../src/browser/config.js";

class DelayedPage {
  public closed = false;
  public onGoto?: () => Promise<Response | null>;

  public constructor(public currentUrl: string) {}

  public url(): string { return this.currentUrl; }
  public isClosed(): boolean { return this.closed; }
  public async bringToFront(): Promise<void> {}
  public setDefaultTimeout(_milliseconds: number): void {}
  public setDefaultNavigationTimeout(_milliseconds: number): void {}
  public async goto(url: string): Promise<Response | null> {
    if (this.onGoto !== undefined) return this.onGoto();
    this.currentUrl = url;
    return null;
  }
  public asPage(): Page { return this as unknown as Page; }
}

class DelayedContext {
  public readonly pageList: DelayedPage[] = [new DelayedPage("about:blank")];
  public navigationPage = new DelayedPage("about:blank");

  public pages(): Page[] { return this.pageList.map((page) => page.asPage()); }
  public async newPage(): Promise<Page> {
    this.pageList.push(this.navigationPage);
    return this.navigationPage.asPage();
  }
  public asContext(): BrowserContext { return this as unknown as BrowserContext; }
}

test("a replacement Copilot tab arriving just after navigation abort is still adopted", async () => {
  const context = new DelayedContext();
  const replacement = new DelayedPage(
    "https://m365.cloud.microsoft/chat/conversation/delayed",
  );
  context.navigationPage.onGoto = async () => {
    void delay(20).then(() => { context.pageList.push(replacement); });
    throw new Error("net::ERR_ABORTED");
  };

  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());

  assert.equal(await tracked.currentUrl(), replacement.currentUrl);
});

function browserConfig(): EdgeLaunchConfig {
  const expectedIdentity = "Ronak Chakraborty";
  return {
    entryUrl: "https://m365.cloud.microsoft/chat",
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    manualAuthenticationHosts: [{ hostname: "login.microsoftonline.com" }],
    uiContract: createBaselineCopilotUiContract(expectedIdentity),
    expectedIdentity,
    requireProtectionIndicator: false,
    maxMessageChars: 10_000,
    maxResponseChars: 10_000,
    waits: {
      actionMs: 500,
      submissionConfirmationMs: 500,
      responseMs: 1_000,
      manualReadinessMs: 2_000,
      pollMs: 50,
      stableSamples: 3,
      minimumStableMs: 150,
    },
    profileDirectory: path.resolve("synthetic-delayed-edge-profile"),
  };
}
