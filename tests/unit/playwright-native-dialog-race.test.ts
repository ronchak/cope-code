import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chromium } from "playwright-core";

import { ContextSemanticPage } from "../../src/browser/context-semantic-page.js";
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
const modalGroup: LocatorGroup = {
  signal: "modal",
  candidates: [{ kind: "role", role: "dialog" }],
  minimumCandidateMatches: 1,
  maximumElements: 1,
  capture: "presence",
};
const chromiumExecutable = process.env["COPE_TEST_CHROMIUM_EXECUTABLE"] ??
  chromium.executablePath();

test("native dialog aborts queued bound fill and click dispatch in Chromium", {
  skip: !existsSync(chromiumExecutable),
}, async (t) => {
  const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable });
  t.after(async () => browser.close());

  for (const action of ["fill", "click"] as const) {
    const page = await browser.newPage();
    const observedActions: string[] = [];
    await page.exposeFunction("recordAction", (value: unknown) => {
      observedActions.push(String(value));
    });
    await page.setContent(`
        <textarea style="width:200px;height:40px"></textarea>
        <button style="width:100px;height:40px">Send</button>
        <script>
          document.querySelector("textarea").addEventListener("input", () => window.recordAction("input"));
          document.querySelector("button").addEventListener("click", () => window.recordAction("click"));
        </script>
      `);
    const semantic = new PlaywrightSemanticPage(page);
    const scheduleDialog = () => {
      void page.evaluate(() => alert("synthetic native dialog")).catch(() => undefined);
    };

    await assert.rejects(
      action === "fill"
        ? semantic.fill(composerGroup, "must-not-disclose", scheduleDialog)
        : semantic.click(sendGroup, scheduleDialog),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(page.isClosed(), true);
    assert.deepEqual(
      observedActions,
      [],
      `${action} must not cross the native-dialog barrier`,
    );
  }
});

test("a background-page dialog aborts queued actions on the active Chromium target", {
  skip: !existsSync(chromiumExecutable),
}, async (t) => {
  for (const action of ["fill", "click"] as const) {
    const profile = await mkdtemp(join(tmpdir(), "cope-dialog-race-"));
    const context = await chromium.launchPersistentContext(profile, {
      headless: true,
      executablePath: chromiumExecutable,
    }).catch(async (error: unknown) => {
      await rm(profile, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
      throw error;
    });
    t.after(async () => {
      await context.close().catch(() => undefined);
      await rm(profile, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    });
    const browser = context.browser();
    assert.notEqual(browser, null, "persistent Chromium context must expose its process owner");
    await context.route("**/*", async (route) => {
      const chat = route.request().url().includes("m365.cloud.microsoft");
      await route.fulfill({
        contentType: "text/html",
        body: chat
          ? `<textarea style="width:200px;height:40px"></textarea>
             <button style="width:100px;height:40px">Send</button>
             <script>
               document.querySelector("textarea").addEventListener("input", () => window.recordAction("input"));
               document.querySelector("button").addEventListener("click", () => window.recordAction("click"));
             </script>`
          : "<main>background</main>",
      });
    });
    const chat = await context.newPage();
    const observedActions: string[] = [];
    await chat.exposeFunction("recordAction", (value: unknown) => {
      observedActions.push(String(value));
    });
    const chatUrl = "https://m365.cloud.microsoft/chat/conversation/dialog-race";
    await chat.goto(chatUrl);
    const background = await context.newPage();
    await background.goto("https://example.test/background");
    const tracked = new ContextSemanticPage(context, {
      entryUrl: "https://m365.cloud.microsoft/chat",
      approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    }, chat, 1_000);
    const actionHandle = await chat.locator(action === "fill" ? "textarea" : "button")
      .elementHandle();
    assert.notEqual(actionHandle, null);
    let dialogSeen = false;
    background.on("dialog", () => {
      dialogSeen = true;
    });

    assert.equal(await tracked.currentUrl(), chatUrl);
    if (action === "click") {
      await tracked.fill(composerGroup, "prepared draft", () => {});
      assert.equal(await tracked.currentUrl(), chatUrl);
      observedActions.length = 0;
    }
    let releaseDelayStarted: (() => void) | undefined;
    const delayStarted = new Promise<void>((resolve) => { releaseDelayStarted = resolve; });
    await chat.exposeFunction("delayStarted", () => releaseDelayStarted?.());
    const blocker = chat.evaluate(() => {
      void (window as unknown as { delayStarted: () => Promise<void> }).delayStarted();
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        // Keep the target's JavaScript engine occupied after Node has observed
        // the binding, so the bound action is certainly queued behind this task.
      }
    });
    void blocker.catch(() => undefined);
    await delayStarted;

    // Queue the already-authorized bound-target dispatch while that target is
    // busy. A dialog on a different page must terminate the browser before the
    // queued evaluate can run; application code never dismisses the dialog.
    const actionPromise = actionHandle!.evaluate((node, requestedAction) => {
      if (!(node instanceof HTMLElement) || !node.isConnected) {
        throw new Error("bound action target detached");
      }
      if (requestedAction === "fill") {
        if (!(node instanceof HTMLTextAreaElement)) throw new Error("unexpected composer");
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        if (valueSetter === undefined) throw new Error("missing value setter");
        valueSetter.call(node, "must-not-disclose");
        node.dispatchEvent(new InputEvent("input", { bubbles: true }));
        return;
      }
      node.click();
    }, action);
    void actionPromise.catch(() => undefined);
    const browserDisconnected = new Promise<void>((resolve) => {
      browser!.once("disconnected", () => resolve());
    });
    const dialogPromise = background.evaluate(() => alert("background dialog"));
    void dialogPromise.catch(() => undefined);

    await assert.rejects(actionPromise);
    await browserDisconnected;
    assert.equal(dialogSeen, true);
    assert.equal(chat.isClosed(), true);
    assert.equal(browser!.isConnected(), false);
    assert.deepEqual(observedActions, [], `${action} must not outlive a background dialog`);
    assert.equal(await tracked.currentUrl(), chatUrl);
    const modal = await tracked.snapshot(modalGroup);
    assert.equal(modal.matchedCandidates, 1);
    assert.equal(modal.enabledElements, 0);
  }
});

test("renderer stalls terminate bounded snapshots, fills, and clicks in persistent Chromium", {
  skip: !existsSync(chromiumExecutable),
}, async () => {
  for (const operation of ["snapshot", "fill", "click"] as const) {
    const profile = await mkdtemp(join(tmpdir(), `cope-operation-timeout-${operation}-`));
    const context = await chromium.launchPersistentContext(profile, {
      headless: true,
      executablePath: chromiumExecutable,
    });
    try {
      const browser = context.browser();
      assert.notEqual(browser, null, "persistent Chromium context must expose its process owner");
      await context.route("**/*", async (route) => {
        await route.fulfill({
          contentType: "text/html",
          body: `
            <textarea style="width:200px;height:40px"></textarea>
            <button style="width:100px;height:40px">Send</button>
            <script>
              if (${JSON.stringify(operation)} === "fill") {
                document.querySelector("textarea").addEventListener("input", () => {
                  while (true) { /* renderer intentionally blocked */ }
                });
              }
              if (${JSON.stringify(operation)} === "click") {
                document.querySelector("button").addEventListener("click", () => {
                  while (true) { /* renderer intentionally blocked */ }
                });
              }
            </script>
          `,
        });
      });
      const page = await context.newPage();
      const chatUrl = `https://m365.cloud.microsoft/chat/conversation/timeout-${operation}`;
      await page.goto(chatUrl);
      const tracked = new ContextSemanticPage(context, {
        entryUrl: "https://m365.cloud.microsoft/chat",
        approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
      }, page, 100);
      assert.equal(await tracked.currentUrl(), chatUrl);

      if (operation === "click") {
        await tracked.fill(composerGroup, "prepared draft", () => {});
        assert.equal(await tracked.currentUrl(), chatUrl);
      }
      if (operation === "snapshot") {
        let rendererBlocked: (() => void) | undefined;
        const blocked = new Promise<void>((resolve) => { rendererBlocked = resolve; });
        await page.exposeFunction("rendererBlocked", () => rendererBlocked?.());
        const blocker = page.evaluate(() => {
          void (window as unknown as { rendererBlocked: () => Promise<void> }).rendererBlocked();
          while (true) { /* renderer intentionally blocked */ }
        });
        void blocker.catch(() => undefined);
        await blocked;
      }

      const disconnected = new Promise<void>((resolve) => {
        browser!.once("disconnected", () => resolve());
      });
      const startedAt = performance.now();
      let observedError: unknown;
      // Keep the regression itself bounded if the production timeout barrier
      // is accidentally removed: force process teardown, then fail below on
      // the missing BROWSER_OPERATION_TIMEOUT diagnostic.
      const watchdog = setTimeout(() => {
        void browser!.close().catch(() => undefined);
      }, 2_000);
      try {
        if (operation === "snapshot") {
          await tracked.snapshot(composerGroup);
        } else if (operation === "fill") {
          await tracked.fill(composerGroup, "bounded disclosure", () => {});
        } else {
          await tracked.click(sendGroup, () => {});
        }
      } catch (error) {
        observedError = error;
      } finally {
        clearTimeout(watchdog);
      }
      const elapsedMs = performance.now() - startedAt;

      assert.equal(observedError instanceof AgentError, true);
      assert.equal(
        (observedError as AgentError).details.diagnosticCode,
        "BROWSER_OPERATION_TIMEOUT",
      );
      assert.equal(
        (observedError as AgentError).details.dispatchAttempted,
        operation !== "snapshot",
      );
      assert.ok(elapsedMs < 2_000, `${operation} exceeded its bounded teardown window`);
      await disconnected;
      assert.equal(browser!.isConnected(), false);
    } finally {
      await context.close().catch(() => undefined);
      await rm(profile, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  }
});
