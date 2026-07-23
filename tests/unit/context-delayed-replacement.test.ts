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
  public pageListener?: (page: Page) => void;

  public pages(): Page[] { return this.pageList.map((page) => page.asPage()); }
  public on(event: string, listener: (page: Page) => void): this {
    if (event === "page") this.pageListener = listener;
    return this;
  }
  public addPage(page: DelayedPage): void {
    this.pageList.push(page);
    this.pageListener?.(page.asPage());
  }
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

test("an external tenant SSO redirect on the tracked setup page remains open for manual sign-in", async () => {
  const context = new DelayedContext();
  const ssoUrl = "https://identity.example.test/sso/login";
  context.navigationPage.onGoto = async () => {
    context.navigationPage.currentUrl = ssoUrl;
    return null;
  };

  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());

  assert.equal(await tracked.currentUrl(), ssoUrl);
  assert.equal(tracked.isManualAuthenticationRedirect(), true);
});

test("an external tenant SSO popup opened by the tracked setup context receives manual ownership", async () => {
  const context = new DelayedContext();
  const sso = new DelayedPage("https://identity.example.test/sso/login");
  context.navigationPage.onGoto = async () => {
    context.navigationPage.currentUrl = "https://m365.cloud.microsoft/chat";
    context.addPage(sso);
    return null;
  };

  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());

  assert.equal(await tracked.currentUrl(), sso.currentUrl);
  assert.equal(tracked.isManualAuthenticationRedirect(), true);
});

function browserConfig(): EdgeLaunchConfig {
  const expectedIdentity = "Ronak Chakraborty";
  return {
    product: "edge",
    browserContractVersion: "cope-visible-browser/v1",
    browserExecutable: path.resolve("synthetic-edge-executable"),
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
