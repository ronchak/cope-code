import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { BrowserContext, Page, Response } from "playwright-core";

import {
  ContextSemanticPage,
  openTrackedCopilotPage,
  selectActiveCopilotPage,
} from "../../src/browser/context-semantic-page.js";
import {
  createBaselineCopilotUiContract,
  type EdgeLaunchConfig,
} from "../../src/browser/config.js";
import { AgentError } from "../../src/shared/errors.js";

const entryUrl = "https://m365.cloud.microsoft/chat";
const authUrl = "https://login.microsoftonline.com/common/oauth2/authorize";

class FakePage {
  public frontCount = 0;
  public defaultTimeout = 0;
  public defaultNavigationTimeout = 0;
  public closed = false;
  public onGoto?: (url: string) => Promise<Response | null>;

  public constructor(public currentUrl: string) {}

  public url(): string { return this.currentUrl; }
  public isClosed(): boolean { return this.closed; }
  public async bringToFront(): Promise<void> { this.frontCount += 1; }
  public setDefaultTimeout(milliseconds: number): void { this.defaultTimeout = milliseconds; }
  public setDefaultNavigationTimeout(milliseconds: number): void {
    this.defaultNavigationTimeout = milliseconds;
  }
  public async goto(url: string): Promise<Response | null> {
    if (this.onGoto !== undefined) return this.onGoto(url);
    this.currentUrl = url;
    return null;
  }

  public asPage(): Page { return this as unknown as Page; }
}

class FakeContext {
  public readonly pageList: FakePage[];
  public newPageCalls = 0;
  public nextPage?: FakePage;

  public constructor(pages: readonly FakePage[]) {
    this.pageList = [...pages];
  }

  public pages(): Page[] { return this.pageList.map((page) => page.asPage()); }
  public async newPage(): Promise<Page> {
    this.newPageCalls += 1;
    const page = this.nextPage ?? new FakePage("about:blank");
    this.pageList.push(page);
    return page.asPage();
  }
  public asContext(): BrowserContext { return this as unknown as BrowserContext; }
}

test("launch creates a fresh navigation tab instead of reusing an arbitrary startup blank", async () => {
  const startupBlank = new FakePage("about:blank");
  const context = new FakeContext([startupBlank]);
  const navigationPage = new FakePage("about:blank");
  context.nextPage = navigationPage;
  const config = browserConfig();

  const tracked = await openTrackedCopilotPage(context.asContext(), config);

  assert.equal(context.newPageCalls, 1);
  assert.equal(startupBlank.currentUrl, "about:blank");
  assert.equal(navigationPage.currentUrl, entryUrl);
  const frontCountAfterLaunch = navigationPage.frontCount;
  assert.equal(await tracked.currentUrl(), entryUrl);
  assert.equal(navigationPage.frontCount, frontCountAfterLaunch);
  assert.equal(navigationPage.defaultTimeout, config.waits.actionMs);
  assert.equal(navigationPage.defaultNavigationTimeout, config.waits.actionMs);
});

test("launch follows an approved replacement page when the original navigation tab stays blank", async () => {
  const startupBlank = new FakePage("about:blank");
  const context = new FakeContext([startupBlank]);
  const navigationPage = new FakePage("about:blank");
  const replacement = new FakePage(`${entryUrl}/conversation/synthetic`);
  navigationPage.onGoto = async () => {
    context.pageList.push(replacement);
    throw new Error("net::ERR_ABORTED");
  };
  context.nextPage = navigationPage;
  const config = browserConfig();

  const tracked = await openTrackedCopilotPage(context.asContext(), config);

  assert.equal(navigationPage.currentUrl, "about:blank");
  assert.equal(await tracked.currentUrl(), replacement.currentUrl);
  assert.ok(replacement.frontCount >= 1);
  assert.equal(replacement.defaultTimeout, config.waits.actionMs);
  assert.equal(replacement.defaultNavigationTimeout, config.waits.actionMs);
});

test("a resolved navigation that remains about:blank fails within the action bound", async () => {
  const startupBlank = new FakePage("about:blank");
  const context = new FakeContext([startupBlank]);
  const navigationPage = new FakePage("about:blank");
  navigationPage.onGoto = async () => null;
  context.nextPage = navigationPage;
  const config = browserConfig({
    actionMs: 40,
    pollMs: 5,
    minimumStableMs: 10,
  });

  const startedAt = performance.now();
  await assert.rejects(
    openTrackedCopilotPage(context.asContext(), config),
    (error: unknown) =>
      error instanceof AgentError &&
      error.code === "TRANSPORT_UNAVAILABLE" &&
      error.details.diagnosticCode === "EDGE_NAVIGATION_NO_ALLOWED_PAGE",
  );
  const elapsed = performance.now() - startedAt;

  assert.equal(navigationPage.currentUrl, "about:blank");
  assert.ok(elapsed < 500, `blank-page failure exceeded its bound: ${String(elapsed)} ms`);
});

test("tracked semantic page moves from Microsoft authentication to the returned Copilot tab", async () => {
  const authentication = new FakePage(authUrl);
  const context = new FakeContext([authentication]);
  const config = browserConfig();
  const tracked = new ContextSemanticPage(
    context.asContext(),
    config,
    authentication.asPage(),
    config.waits.actionMs,
  );

  assert.equal(await tracked.currentUrl(), authUrl);
  assert.equal(tracked.isManualAuthenticationRedirect(), true);

  const approved = new FakePage(`${entryUrl}/conversation/returned`);
  context.pageList.push(approved);

  assert.equal(await tracked.currentUrl(), approved.currentUrl);
  assert.equal(tracked.isManualAuthenticationRedirect(), false);
  assert.ok(approved.frontCount >= 1);
  assert.equal(approved.defaultTimeout, config.waits.actionMs);
  assert.equal(approved.defaultNavigationTimeout, config.waits.actionMs);
});

test("multiple approved Copilot pages remain an ambiguity hard stop", () => {
  const first = new FakePage(`${entryUrl}/conversation/one`);
  const second = new FakePage(`${entryUrl}/conversation/two`);

  assert.throws(
    () => selectActiveCopilotPage(
      [first.asPage(), second.asPage()],
      browserConfig(),
      first.asPage(),
    ),
    (error: unknown) =>
      error instanceof AgentError &&
      error.code === "TRANSPORT_INDETERMINATE" &&
      error.details.diagnosticCode === "AMBIGUOUS_COPILOT_PAGE",
  );
});

function browserConfig(
  waitOverrides: Partial<EdgeLaunchConfig["waits"]> = {},
): EdgeLaunchConfig {
  const expectedIdentity = "Ronak Chakraborty";
  return {
    entryUrl,
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    manualAuthenticationHosts: [
      { hostname: "login.microsoftonline.com" },
      { hostname: "m365.cloud.microsoft" },
    ],
    uiContract: createBaselineCopilotUiContract(expectedIdentity),
    expectedIdentity,
    requireProtectionIndicator: false,
    maxMessageChars: 200_000,
    maxResponseChars: 1_000_000,
    waits: {
      actionMs: 1_000,
      submissionConfirmationMs: 1_000,
      responseMs: 5_000,
      manualReadinessMs: 10_000,
      pollMs: 100,
      stableSamples: 3,
      minimumStableMs: 300,
      ...waitOverrides,
    },
    profileDirectory: path.resolve("synthetic-edge-profile"),
  };
}
