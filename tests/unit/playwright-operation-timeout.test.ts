import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserContext, ElementHandle, Locator, Page } from "playwright-core";

import { PlaywrightSemanticPage } from "../../src/browser/playwright-semantic-page.js";
import { AgentError } from "../../src/shared/errors.js";
import type { LocatorGroup } from "../../src/browser/contracts.js";

const composerGroup: LocatorGroup = {
  signal: "composer",
  candidates: [{ kind: "css", selector: "textarea" }],
  minimumCandidateMatches: 1,
  maximumElements: 1,
  capture: "value-and-text",
};
const sendGroup: LocatorGroup = {
  signal: "send",
  candidates: [{ kind: "css", selector: "button" }],
  minimumCandidateMatches: 1,
  maximumElements: 1,
  capture: "presence",
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

class TimeoutElement {
  public evaluateCalls = 0;

  public async isVisible(): Promise<boolean> { return true; }
  public async isEnabled(): Promise<boolean> { return true; }
  public async isEditable(): Promise<boolean> { return true; }
  public async getAttribute(_name: string): Promise<string | null> { return null; }
  public async evaluate(): Promise<unknown> {
    this.evaluateCalls += 1;
    return "dispatched";
  }
}

class TimeoutLocator {
  public constructor(
    private readonly countResult: Promise<number>,
    private readonly element: TimeoutElement,
  ) {}

  public async count(): Promise<number> { return this.countResult; }
  public nth(_index: number): Locator { return this as unknown as Locator; }
  public async elementHandle(): Promise<ElementHandle> {
    return this.element as unknown as ElementHandle;
  }
}

class TimeoutPage {
  public constructor(private readonly locatorValue: TimeoutLocator) {}

  public on(): this { return this; }
  public locator(): Locator { return this.locatorValue as unknown as Locator; }
  public context(): BrowserContext {
    return { browser: () => null } as unknown as BrowserContext;
  }
}

function timeoutError(error: unknown): AgentError {
  assert.equal(error instanceof AgentError, true);
  assert.equal((error as AgentError).details.diagnosticCode, "BROWSER_OPERATION_TIMEOUT");
  return error as AgentError;
}

test("a deadline during locator discovery cannot issue a late fill or click", async () => {
  for (const action of ["fill", "click"] as const) {
    const discovery = deferred<number>();
    const terminationRelease = deferred<void>();
    const timeoutStarted = deferred<void>();
    const element = new TimeoutElement();
    let terminationCalls = 0;
    const semantic = new PlaywrightSemanticPage(
      new TimeoutPage(new TimeoutLocator(discovery.promise, element)) as unknown as Page,
      undefined,
      10,
      async () => {
        terminationCalls += 1;
        timeoutStarted.resolve();
        await terminationRelease.promise;
      },
    );

    const operation = action === "fill"
      ? semantic.fill(composerGroup, "must-not-disclose", () => {})
      : semantic.click(sendGroup, () => {});
    await timeoutStarted.promise;
    discovery.resolve(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(element.evaluateCalls, 0, `${action} dispatched after its deadline`);
    terminationRelease.resolve();

    let observedError: unknown;
    try {
      await operation;
    } catch (error) {
      observedError = error;
    }
    assert.equal(timeoutError(observedError).details.dispatchAttempted, false);
    assert.equal(element.evaluateCalls, 0);
    assert.equal(terminationCalls, 1);
  }
});

test("concurrent blocked snapshots share one termination and cannot swallow timeout", async () => {
  const blockedCount = new Promise<number>(() => {});
  const terminationRelease = deferred<void>();
  const timeoutStarted = deferred<void>();
  let terminationCalls = 0;
  const semantic = new PlaywrightSemanticPage(
    new TimeoutPage(
      new TimeoutLocator(blockedCount, new TimeoutElement()),
    ) as unknown as Page,
    undefined,
    10,
    async () => {
      terminationCalls += 1;
      timeoutStarted.resolve();
      await terminationRelease.promise;
    },
  );

  const snapshots = [
    semantic.snapshot(composerGroup),
    semantic.snapshot(composerGroup),
  ];
  await timeoutStarted.promise;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(terminationCalls, 1);
  terminationRelease.resolve();
  const results = await Promise.allSettled(snapshots);

  assert.equal(results.every((result) => result.status === "rejected"), true);
  for (const result of results) {
    if (result.status === "fulfilled") assert.fail("snapshot swallowed its timeout");
    assert.equal(timeoutError(result.reason).details.dispatchAttempted, false);
  }
});
