import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { BrowserContext, Page, Response } from "playwright-core";

import {
  ContextSemanticPage,
  isGenuineManualAuthenticationUrl,
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
  public async close(): Promise<void> { this.closed = true; }
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

class StalledLaunchBrowser {
  public closeCalls = 0;
  public constructor(private readonly closeRelease: Promise<void>) {}
  public async close(): Promise<void> {
    this.closeCalls += 1;
    await this.closeRelease;
  }
}

class StalledNewPageContext extends FakeContext {
  public constructor(
    pages: readonly FakePage[],
    private readonly pageResult: Promise<Page>,
    private readonly browserValue: StalledLaunchBrowser,
  ) {
    super(pages);
  }

  public override async newPage(): Promise<Page> {
    this.newPageCalls += 1;
    return this.pageResult;
  }
  public browser(): StalledLaunchBrowser { return this.browserValue; }
}

class BusyNewPageContext extends FakeContext {
  public constructor(
    pages: readonly FakePage[],
    private readonly pageValue: FakePage,
    private readonly browserValue: StalledLaunchBrowser,
  ) {
    super(pages);
  }

  public override async newPage(): Promise<Page> {
    const deadline = performance.now() + 30;
    while (performance.now() < deadline) {
      // Starve the timeout callback while the protocol promise settles.
    }
    return this.pageValue.asPage();
  }
  public browser(): StalledLaunchBrowser { return this.browserValue; }
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

test("fresh launch bounds a stalled newPage independently of owner teardown", async () => {
  const pageResult = deferred<Page>();
  const closeRelease = deferred<void>();
  const browser = new StalledLaunchBrowser(closeRelease.promise);
  const context = new StalledNewPageContext(
    [new FakePage("about:blank")],
    pageResult.promise,
    browser,
  );
  const config = browserConfig({ actionMs: 10 });

  const observedError = await rejectionWithin(
    openTrackedCopilotPage(context.asContext(), config),
    100,
  );
  assert.equal(observedError instanceof AgentError, true);
  assert.equal((observedError as AgentError).details.diagnosticCode, "BROWSER_OPERATION_TIMEOUT");
  assert.equal((observedError as AgentError).details.dispatchAttempted, false);
  assert.equal(browser.closeCalls, 1);

  const latePage = new FakePage("about:blank");
  pageResult.resolve(latePage.asPage());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(latePage.closed, true);
  closeRelease.resolve();
});

test("an expired launch deadline prevents issuing newPage", async () => {
  const pageResult = deferred<Page>();
  const browser = new StalledLaunchBrowser(Promise.resolve());
  const context = new StalledNewPageContext(
    [new FakePage("about:blank")],
    pageResult.promise,
    browser,
  );

  const launch = openTrackedCopilotPage(
    context.asContext(),
    browserConfig({ actionMs: 10 }),
  );
  const starvationDeadline = performance.now() + 30;
  while (performance.now() < starvationDeadline) {
    // Prevent the queued protocol microtask from running before its deadline.
  }
  const observedError = await rejectionWithin(launch, 100);
  assert.equal(observedError instanceof AgentError, true);
  assert.equal((observedError as AgentError).details.diagnosticCode, "BROWSER_OPERATION_TIMEOUT");
  assert.equal(context.newPageCalls, 0);
  assert.equal(browser.closeCalls, 1);
});

test("fresh launch retires a new page that settles after starving its deadline", async () => {
  const latePage = new FakePage("about:blank");
  const browser = new StalledLaunchBrowser(Promise.resolve());
  const context = new BusyNewPageContext(
    [new FakePage("about:blank")],
    latePage,
    browser,
  );

  const observedError = await rejectionWithin(
    openTrackedCopilotPage(context.asContext(), browserConfig({ actionMs: 10 })),
    100,
  );
  assert.equal(observedError instanceof AgentError, true);
  assert.equal((observedError as AgentError).details.diagnosticCode, "BROWSER_OPERATION_TIMEOUT");
  assert.equal(browser.closeCalls, 1);
  assert.equal(latePage.closed, true);
});

test("a late newPage rejection after timeout remains observed", async () => {
  const pageResult = deferred<Page>();
  const closeRelease = deferred<void>();
  const browser = new StalledLaunchBrowser(closeRelease.promise);
  const context = new StalledNewPageContext(
    [new FakePage("about:blank")],
    pageResult.promise,
    browser,
  );

  const observedError = await rejectionWithin(
    openTrackedCopilotPage(context.asContext(), browserConfig({ actionMs: 10 })),
    100,
  );
  assert.equal(observedError instanceof AgentError, true);
  assert.equal((observedError as AgentError).details.diagnosticCode, "BROWSER_OPERATION_TIMEOUT");
  // The launch race itself must continue observing this rejection after its
  // timeout diagnostic has already settled.
  pageResult.reject(new Error("late newPage rejection"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  closeRelease.resolve();
});

test("fresh launch foregrounds the exact new page before navigating it", async () => {
  const overlappingAuthentication = new FakePage(
    "https://m365.cloud.microsoft/oauth2/authorize?client_id=client&state=opaque",
  );
  const context = new FakeContext([overlappingAuthentication]);
  const navigationPage = new FakePage("about:blank");
  navigationPage.onGoto = async () => {
    assert.equal(navigationPage.frontCount, 1);
    assert.equal(overlappingAuthentication.frontCount, 0);
    navigationPage.currentUrl = entryUrl;
    return null;
  };
  context.nextPage = navigationPage;

  await openTrackedCopilotPage(context.asContext(), browserConfig());

  assert.equal(navigationPage.frontCount, 1);
  // Once navigation finishes, normal selection correctly returns ownership to
  // the still-open genuine authentication surface.
  assert.equal(overlappingAuthentication.frontCount, 1);
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

test("an unrelated pre-existing Office tab cannot satisfy replacement-page discovery", async () => {
  const officeRoot = new FakePage("https://www.office.com/");
  const context = new FakeContext([officeRoot]);
  const navigationPage = new FakePage("about:blank");
  navigationPage.onGoto = async () => null;
  context.nextPage = navigationPage;
  const config = browserConfig({
    actionMs: 40,
    pollMs: 5,
    minimumStableMs: 10,
  });

  await assert.rejects(
    openTrackedCopilotPage(context.asContext(), config),
    (error: unknown) =>
      error instanceof AgentError &&
      error.details.diagnosticCode === "EDGE_NAVIGATION_NO_ALLOWED_PAGE",
  );
  assert.equal(officeRoot.frontCount, 0);
});

test("launch reuses a pre-existing external Microsoft authentication page", async () => {
  const authentication = new FakePage(authUrl);
  const context = new FakeContext([authentication]);
  const config = browserConfig();

  const tracked = await openTrackedCopilotPage(context.asContext(), config);

  assert.equal(context.newPageCalls, 0);
  assert.equal(tracked.isManualAuthenticationRedirect(), true);
  assert.ok(authentication.frontCount >= 1);
  assert.equal(authentication.defaultTimeout, config.waits.actionMs);
  assert.equal(authentication.defaultNavigationTimeout, config.waits.actionMs);
});

test("launch gives external authentication ownership over ambiguous chats", async () => {
  const first = new FakePage(`${entryUrl}/conversation/first`);
  const olderAuthentication = new FakePage(`${authUrl}?step=older`);
  const authentication = new FakePage(`${authUrl}?step=newer`);
  const replacement = new FakePage(`${entryUrl}/conversation/replacement`);
  const context = new FakeContext([
    first,
    olderAuthentication,
    replacement,
    authentication,
  ]);
  const config = browserConfig();

  const tracked = await openTrackedCopilotPage(context.asContext(), config);

  assert.equal(context.newPageCalls, 0);
  assert.equal(tracked.isManualAuthenticationRedirect(), true);
  assert.ok(authentication.frontCount >= 1);

  authentication.closed = true;
  assert.equal(
    await tracked.withManualReadinessProbe(() =>
      tracked.holdForManualAuthenticationHandoff(true)),
    true,
  );
  assert.ok(olderAuthentication.frontCount >= 1);

  olderAuthentication.closed = true;
  await assert.rejects(
    tracked.currentUrl(),
    (error: unknown) =>
      error instanceof AgentError &&
      error.code === "TRANSPORT_INDETERMINATE" &&
      error.details.diagnosticCode === "AMBIGUOUS_COPILOT_PAGE",
  );
});

test("closed auth and unrelated Office pages do not suppress chat ambiguity", async () => {
  for (const extra of [
    new FakePage(authUrl),
    new FakePage("https://www.office.com/"),
  ]) {
    if (extra.currentUrl === authUrl) extra.closed = true;
    const context = new FakeContext([
      new FakePage(`${entryUrl}/conversation/first`),
      extra,
      new FakePage(`${entryUrl}/conversation/replacement`),
    ]);

    await assert.rejects(
      openTrackedCopilotPage(context.asContext(), browserConfig()),
      (error: unknown) =>
        error instanceof AgentError &&
        error.code === "TRANSPORT_INDETERMINATE" &&
        error.details.diagnosticCode === "AMBIGUOUS_COPILOT_PAGE",
      extra.currentUrl,
    );
  }
});

test("tracked semantic page moves to the returned Copilot tab after auth closes", async () => {
  const authentication = new FakePage(authUrl);
  const context = new FakeContext([authentication]);
  const config = browserConfig();
  const tracked = new ContextSemanticPage(
    context.asContext(),
    config,
    authentication.asPage(),
    config.waits.actionMs,
  );

  assert.equal(
    await tracked.withManualReadinessProbe(() =>
      tracked.holdForManualAuthenticationHandoff(true)),
    true,
  );
  assert.equal(tracked.isManualAuthenticationRedirect(), true);

  const approved = new FakePage(`${entryUrl}/conversation/returned`);
  context.pageList.push(approved);

  assert.equal(
    await tracked.withManualReadinessProbe(() =>
      tracked.holdForManualAuthenticationHandoff(true)),
    true,
  );
  authentication.closed = true;
  assert.equal(await tracked.currentUrl(), approved.currentUrl);
  assert.equal(tracked.isManualAuthenticationRedirect(), false);
  assert.ok(approved.frontCount >= 1);
  assert.equal(approved.defaultTimeout, config.waits.actionMs);
  assert.equal(approved.defaultNavigationTimeout, config.waits.actionMs);
});

test("broad Office hosts require genuine authentication evidence", () => {
  const config = browserConfig();

  assert.equal(isGenuineManualAuthenticationUrl("https://www.office.com/", config), false);
  assert.equal(
    isGenuineManualAuthenticationUrl("https://m365.cloud.microsoft/search?state=opaque", config),
    false,
  );
  assert.equal(
    isGenuineManualAuthenticationUrl("https://www.office.com/?state=opaque&prompt=login", config),
    false,
  );
  assert.equal(
    isGenuineManualAuthenticationUrl(
      "https://www.office.com/oauth2/authorize?client_id=client&state=opaque",
      config,
    ),
    true,
  );
  assert.equal(
    isGenuineManualAuthenticationUrl("https://login.microsoftonline.com/", config),
    true,
  );
});

test("same-host pages outside the chat path do not inherit the long URL-only auth window", async () => {
  const sameHost = new FakePage("https://m365.cloud.microsoft/search");
  const context = new FakeContext([sameHost]);
  const config = browserConfig();
  const tracked = new ContextSemanticPage(
    context.asContext(),
    config,
    sameHost.asPage(),
    config.waits.actionMs,
  );

  assert.equal(await tracked.currentUrl(), sameHost.currentUrl);
  assert.equal(tracked.isManualAuthenticationRedirect(), false);
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
    product: "edge",
    browserContractVersion: "cope-visible-browser/v1",
    browserExecutable: path.resolve("synthetic-edge-executable"),
    entryUrl,
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    manualAuthenticationHosts: [
      { hostname: "login.microsoftonline.com" },
      { hostname: "m365.cloud.microsoft" },
      { hostname: "office.com" },
      { hostname: "www.office.com" },
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
