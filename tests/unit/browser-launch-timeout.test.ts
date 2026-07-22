import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { Browser, BrowserContext, Locator, Page } from "playwright-core";

import { createBaselineCopilotUiContract } from "../../src/browser/config.js";
import { EdgeCopilotTransport } from "../../src/browser/edge-launcher.js";
import { ExclusiveProfileLock } from "../../src/browser/profile-lock.js";
import { AgentError } from "../../src/shared/errors.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

// These are deadlock sentinels, not product timing assertions. The fixture's
// action timeout remains 20 ms; leave enough scheduling margin for loaded and
// emulated CI hosts to deliver that timer and the resulting promise callbacks.
const ASYNC_DEADLOCK_WATCHDOG_MS = 2_000;
const CLOSE_DEADLOCK_WATCHDOG_MS = 1_000;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function rejectionWithin(promise: Promise<unknown>, milliseconds: number): Promise<unknown> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => assert.fail("launch unexpectedly fulfilled"),
        (error: unknown) => error,
      ),
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(
          () => reject(new Error(`launch did not reject within ${milliseconds} ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
  }
}

class LaunchBrowser {
  public closeCalls = 0;
  public constructor(private readonly closeResult: Promise<void>) {}
  public async close(): Promise<void> {
    this.closeCalls += 1;
    await this.closeResult;
  }
}

class LaunchPage {
  public url(): string { return "about:blank"; }
  public isClosed(): boolean { return false; }
}

class StalledLaunchContext {
  readonly #startupPage = new LaunchPage();
  public newPageCalls = 0;
  public contextCloseCalls = 0;

  public constructor(
    private readonly browserValue: LaunchBrowser,
    private readonly newPageResult: Promise<Page>,
  ) {}

  public pages(): readonly Page[] { return [this.#startupPage as unknown as Page]; }
  public browser(): Browser { return this.browserValue as unknown as Browser; }
  public async newPage(): Promise<Page> {
    this.newPageCalls += 1;
    return this.newPageResult;
  }
  public async close(): Promise<void> { this.contextCloseCalls += 1; }
}

class BlockingLocator {
  public async count(): Promise<number> { return new Promise<number>(() => {}); }
}

class BlockingPage {
  public url(): string { return "https://m365.cloud.microsoft/chat/conversation/blocked"; }
  public isClosed(): boolean { return false; }
  public on(): this { return this; }
  public setDefaultTimeout(): void {}
  public setDefaultNavigationTimeout(): void {}
  public async bringToFront(): Promise<void> {}
  public locator(): Locator { return new BlockingLocator() as unknown as Locator; }
  public getByRole(): Locator { return this.locator(); }
  public getByLabel(): Locator { return this.locator(); }
  public getByPlaceholder(): Locator { return this.locator(); }
  public getByTestId(): Locator { return this.locator(); }
  public getByText(): Locator { return this.locator(); }
}

class BlockingOperationContext {
  readonly #page = new BlockingPage();
  public constructor(private readonly browserValue: LaunchBrowser) {}
  public pages(): readonly Page[] { return [this.#page as unknown as Page]; }
  public browser(): Browser { return this.browserValue as unknown as Browser; }
  public on(): this { return this; }
  public async close(): Promise<void> {}
}

class OwnerlessOperationContext {
  readonly #page = new BlockingPage();
  public closeCalls = 0;
  public constructor(private readonly closeResult: Promise<void>) {}
  public pages(): readonly Page[] { return [this.#page as unknown as Page]; }
  public browser(): null { return null; }
  public on(): this { return this; }
  public async close(): Promise<void> {
    this.closeCalls += 1;
    await this.closeResult;
  }
}

class OwnerlessLaunchContext {
  public closeCalls = 0;
  public newPageCalls = 0;
  public constructor(
    private readonly closeResult: Promise<void>,
    private readonly newPageResult: Promise<Page>,
  ) {}
  public pages(): readonly Page[] { return []; }
  public browser(): null { return null; }
  public async newPage(): Promise<Page> {
    this.newPageCalls += 1;
    return this.newPageResult;
  }
  public async close(): Promise<void> {
    this.closeCalls += 1;
    await this.closeResult;
  }
}

test("launcher returns a page timeout while held owner cleanup retains the profile lock", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-launch-timeout-held-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const closeRelease = deferred<void>();
  const newPageResult = deferred<Page>();
  const browser = new LaunchBrowser(closeRelease.promise);
  const context = new StalledLaunchContext(browser, newPageResult.promise);
  const { config, profile } = await launchFixture(root);

  const observedError = await rejectionWithin(
    EdgeCopilotTransport.launch(
      config,
      launchDependencies(context as unknown as BrowserContext),
    ),
    ASYNC_DEADLOCK_WATCHDOG_MS,
  );
  assert.equal(observedError instanceof AgentError, true);
  assert.equal((observedError as AgentError).details.diagnosticCode, "BROWSER_OPERATION_TIMEOUT");
  assert.equal((observedError as AgentError).details.semanticGroup, "context");
  assert.equal((observedError as AgentError).details.semanticOperation, "context.newPage");
  assert.equal(browser.closeCalls, 1);
  assert.equal(context.contextCloseCalls, 0);
  await assert.rejects(ExclusiveProfileLock.acquire(profile), lockedProfileError);

  closeRelease.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const reacquired = await ExclusiveProfileLock.acquire(profile);
  await reacquired.release();
});

test("rejected owner cleanup retains the profile lock fail-closed", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-launch-timeout-rejected-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const closeResult = deferred<void>();
  const newPageResult = deferred<Page>();
  const browser = new LaunchBrowser(closeResult.promise);
  const context = new StalledLaunchContext(browser, newPageResult.promise);
  const { config, profile } = await launchFixture(root);

  const observedError = await rejectionWithin(
    EdgeCopilotTransport.launch(
      config,
      launchDependencies(context as unknown as BrowserContext),
    ),
    ASYNC_DEADLOCK_WATCHDOG_MS,
  );
  assert.equal(observedError instanceof AgentError, true);
  assert.equal((observedError as AgentError).details.diagnosticCode, "BROWSER_OPERATION_TIMEOUT");
  closeResult.reject(new Error("synthetic owner close failure"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(browser.closeCalls, 1);
  await assert.rejects(ExclusiveProfileLock.acquire(profile), lockedProfileError);
});

test("ownerless launch returns promptly while held fallback cleanup retains the lock", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-ownerless-close-held-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const closeRelease = deferred<void>();
  const newPageResult = deferred<Page>();
  const context = new OwnerlessLaunchContext(closeRelease.promise, newPageResult.promise);
  const { config, profile } = await launchFixture(root);

  const observedError = await rejectionWithin(
    EdgeCopilotTransport.launch(
      config,
      launchDependencies(context as unknown as BrowserContext),
    ),
    ASYNC_DEADLOCK_WATCHDOG_MS,
  );
  assert.equal(observedError instanceof AgentError, true);
  assert.equal(
    (observedError as AgentError).details.diagnosticCode,
    "BROWSER_OPERATION_TIMEOUT",
  );
  assert.equal(context.newPageCalls, 1);
  assert.equal(context.closeCalls, 1);
  await assert.rejects(ExclusiveProfileLock.acquire(profile), lockedProfileError);

  closeRelease.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const reacquired = await ExclusiveProfileLock.acquire(profile);
  await reacquired.release();
});

test("ownerless launch retains the lock when fallback cleanup rejects", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-ownerless-close-rejected-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const closeResult = deferred<void>();
  const newPageResult = deferred<Page>();
  const context = new OwnerlessLaunchContext(closeResult.promise, newPageResult.promise);
  const { config, profile } = await launchFixture(root);

  const observedError = await rejectionWithin(
    EdgeCopilotTransport.launch(
      config,
      launchDependencies(context as unknown as BrowserContext),
    ),
    ASYNC_DEADLOCK_WATCHDOG_MS,
  );
  assert.equal(observedError instanceof AgentError, true);
  assert.equal(
    (observedError as AgentError).details.diagnosticCode,
    "BROWSER_OPERATION_TIMEOUT",
  );
  closeResult.reject(new Error("synthetic ownerless context close failure"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.closeCalls, 1);
  await assert.rejects(ExclusiveProfileLock.acquire(profile), lockedProfileError);
});

test("context-owned persistent launch remains usable and releases its lock on close", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-ownerless-success-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const closeRelease = deferred<void>();
  const context = new OwnerlessOperationContext(closeRelease.promise);
  const { config, profile } = await launchFixture(root);

  const transport = await EdgeCopilotTransport.launch(
    config,
    launchDependencies(context as unknown as BrowserContext),
  );
  await assert.rejects(ExclusiveProfileLock.acquire(profile), lockedProfileError);
  const closePromise = transport.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.closeCalls, 1);
  await assert.rejects(ExclusiveProfileLock.acquire(profile), lockedProfileError);
  closeRelease.resolve();
  await closePromise;

  const reacquired = await ExclusiveProfileLock.acquire(profile);
  await reacquired.release();
});

test("ownerless operation timeout shares context teardown and retains the lock until success", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-ownerless-operation-held-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const closeRelease = deferred<void>();
  const context = new OwnerlessOperationContext(closeRelease.promise);
  const { config, profile } = await launchFixture(root);
  const transport = await EdgeCopilotTransport.launch(
    config,
    launchDependencies(context as unknown as BrowserContext),
  );

  const [firstError, secondError] = await Promise.all([
    rejectionWithin(transport.inspectState(), ASYNC_DEADLOCK_WATCHDOG_MS),
    rejectionWithin(transport.inspectState(), ASYNC_DEADLOCK_WATCHDOG_MS),
  ]);
  const diagnosticCodes = [firstError, secondError].map((error) => {
    assert.equal(error instanceof AgentError, true);
    return (error as AgentError).details.diagnosticCode;
  }).sort();
  assert.deepEqual(diagnosticCodes, [
    "BROWSER_OPERATION_TIMEOUT",
    "CONCURRENT_BROWSER_OPERATION",
  ]);
  await transport.close();
  assert.equal(context.closeCalls, 1);
  await assert.rejects(ExclusiveProfileLock.acquire(profile), lockedProfileError);

  closeRelease.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const reacquired = await ExclusiveProfileLock.acquire(profile);
  await reacquired.release();
});

test("rejected ownerless operation teardown retains the profile lock fail-closed", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-ownerless-operation-rejected-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const closeResult = deferred<void>();
  const context = new OwnerlessOperationContext(closeResult.promise);
  const { config, profile } = await launchFixture(root);
  const transport = await EdgeCopilotTransport.launch(
    config,
    launchDependencies(context as unknown as BrowserContext),
  );

  const operationError = await rejectionWithin(transport.inspectState(), ASYNC_DEADLOCK_WATCHDOG_MS);
  assert.equal(operationError instanceof AgentError, true);
  assert.equal((operationError as AgentError).details.diagnosticCode, "BROWSER_OPERATION_TIMEOUT");
  await transport.close();
  closeResult.reject(new Error("synthetic ownerless operation close failure"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.closeCalls, 1);
  await assert.rejects(ExclusiveProfileLock.acquire(profile), lockedProfileError);
});

test("public transport close stays bounded after a held operation teardown", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-transport-close-held-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const closeRelease = deferred<void>();
  const browser = new LaunchBrowser(closeRelease.promise);
  const context = new BlockingOperationContext(browser);
  const { config, profile } = await launchFixture(root);
  const transport = await EdgeCopilotTransport.launch(
    config,
    launchDependencies(context as unknown as BrowserContext),
  );

  const operationError = await rejectionWithin(transport.inspectState(), ASYNC_DEADLOCK_WATCHDOG_MS);
  assert.equal(operationError instanceof AgentError, true);
  assert.equal((operationError as AgentError).details.diagnosticCode, "BROWSER_OPERATION_TIMEOUT");
  await Promise.race([
    transport.close(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("transport close inherited stalled teardown")), CLOSE_DEADLOCK_WATCHDOG_MS);
    }),
  ]);
  assert.equal(browser.closeCalls, 1);
  await assert.rejects(ExclusiveProfileLock.acquire(profile), lockedProfileError);

  closeRelease.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const reacquired = await ExclusiveProfileLock.acquire(profile);
  await reacquired.release();
});

test("public transport close retains the lock when operation teardown rejects", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-transport-close-rejected-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const closeResult = deferred<void>();
  const browser = new LaunchBrowser(closeResult.promise);
  const context = new BlockingOperationContext(browser);
  const { config, profile } = await launchFixture(root);
  const transport = await EdgeCopilotTransport.launch(
    config,
    launchDependencies(context as unknown as BrowserContext),
  );

  const operationError = await rejectionWithin(transport.inspectState(), ASYNC_DEADLOCK_WATCHDOG_MS);
  assert.equal(operationError instanceof AgentError, true);
  assert.equal((operationError as AgentError).details.diagnosticCode, "BROWSER_OPERATION_TIMEOUT");
  await transport.close();
  closeResult.reject(new Error("synthetic operation teardown failure"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(browser.closeCalls, 1);
  await assert.rejects(ExclusiveProfileLock.acquire(profile), lockedProfileError);
});

function lockedProfileError(error: unknown): boolean {
  return error instanceof AgentError && error.details.diagnosticCode === "EDGE_PROFILE_LOCKED";
}

async function launchFixture(root: string): Promise<{
  readonly config: Parameters<typeof EdgeCopilotTransport.launch>[0];
  readonly profile: string;
}> {
  const executable = path.join(root, "Google Chrome");
  const profile = path.join(root, "profile");
  await writeFile(executable, "chrome fixture\n", "utf8");
  await chmod(executable, 0o700);
  return {
    profile,
    config: {
      product: "chrome",
      browserContractVersion: "cope-visible-browser/v1",
      browserExecutable: executable,
      profileDirectory: profile,
      entryUrl: "https://m365.cloud.microsoft/chat",
      approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
      uiContract: createBaselineCopilotUiContract("user@example.invalid"),
      expectedIdentity: "user@example.invalid",
      requireProtectionIndicator: false,
      maxMessageChars: 10_000,
      maxResponseChars: 10_000,
      waits: {
        actionMs: 20,
        submissionConfirmationMs: 100,
        responseMs: 100,
        manualReadinessMs: 100,
        pollMs: 10,
        stableSamples: 2,
        minimumStableMs: 10,
      },
    },
  };
}

function launchDependencies(
  context: BrowserContext,
): Parameters<typeof EdgeCopilotTransport.launch>[1] {
  return {
    browserIdentityVerifier: async (product, executablePath) => ({
      product,
      executablePath: await realpath(executablePath),
      version: "149.0.1.2",
      executableSha256: "a".repeat(64),
      size: 42,
      modifiedMs: 1,
      evidence: {
        platform: "darwin",
        productName: "Google Chrome Stable",
        publisher: "EQHXZ8M8AV",
        identifier: "com.google.Chrome",
        signatureStatus: "valid",
      },
    }),
    launchPersistentContext: async () => context,
  };
}
