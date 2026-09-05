import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { chromium } from "playwright-core";

import { classifyCopilotPage, observeCopilotPage } from "../../src/browser/classifier.js";
import { createBaselineCopilotUiContract } from "../../src/browser/config.js";
import { PlaywrightSemanticPage } from "../../src/browser/playwright-semantic-page.js";

const chromiumExecutable = process.env["COPE_TEST_CHROMIUM_EXECUTABLE"] ??
  chromium.executablePath();

test("service signals ignore task and response text while preserving real Copilot alerts in Chromium", {
  skip: !existsSync(chromiumExecutable),
}, async (t) => {
  const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable });
  t.after(async () => browser.close().catch(() => undefined));
  const entryUrl = "https://m365.cloud.microsoft/chat";
  const expectedIdentity = "Test User";
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  const cases = [
    { name: "task composer", body: '<div role="textbox" contenteditable="true" aria-label="Message Copilot">Implement rate limiting and the something went wrong error</div>', expected: "ready" },
    { name: "sent task", body: '<div data-testid="chatQuestion">Implement rate limiting</div>', expected: "ready" },
    { name: "tool result", body: '<div data-testid="chatQuestion">Test output: service unavailable; try again later</div>', expected: "ready" },
    { name: "assistant explanation", body: '<div data-testid="copilot-message-reply-div">I will add rate limiting</div>', expected: "ready" },
    { name: "quoted error", body: '<div data-testid="copilot-message-reply-div"><div data-testid="markdown-reply">The expected message is something went wrong</div></div>', expected: "ready" },
    { name: "code inside a live region", body: '<div data-testid="copilot-message-reply-div" role="status"><pre><code>throw new Error("service unavailable")</code></pre></div>', expected: "ready" },
    { name: "service alert", body: '<div role="alert">Something went wrong</div>', expected: "service-error" },
    { name: "service alert with contraction", body: '<div role="alert">Copilot couldn\'t respond</div>', expected: "service-error" },
    { name: "throttle status", body: '<div role="status">Too many requests. Try again later.</div>', expected: "throttled" },
    { name: "inline service alert", body: '<div data-testid="copilot-message-reply-div"><div role="alert">Something went wrong</div></div>', expected: "service-error" },
    { name: "inline throttle status", body: '<div data-testid="copilot-message-reply-div"><div role="status">Too many requests</div></div>', expected: "throttled" },
  ];
  for (const scenario of cases) {
    const context = await browser.newContext();
    try {
      await context.route("**/*", (route) => route.fulfill({
        contentType: "text/html",
        body: `<main>
          ${scenario.name === "task composer" ? "" : '<div role="textbox" contenteditable="true" aria-label="Message Copilot" style="width:200px;height:40px"></div>'}
          <button aria-label="Send message">Send</button>
          <button id="mectrl_headerPicture" aria-label="Account manager for Test User">Test User</button>
          ${scenario.body}
        </main>`,
      }));
      const page = await context.newPage();
      await page.goto(`${entryUrl}/conversation/service-signal`);
      const observation = await observeCopilotPage(new PlaywrightSemanticPage(page), contract);
      assert.equal(classifyCopilotPage(observation, contract, {
        entryUrl,
        approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
        expectedIdentity,
        requireProtectionIndicator: false,
      }).state, scenario.expected, scenario.name);
    } finally {
      await context.close();
    }
  }

  // Use the real locator chain (including nth and visibility) to catch both
  // Playwright selector parsing errors and changed regex matching semantics.
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent('<div role="alert"></div>');
    const semanticPage = new PlaywrightSemanticPage(page);
    const quotedPatterns = [
      { source: String.raw`couldn't respond`, text: "couldn't respond" },
      { source: String.raw`couldn\'t respond`, text: "couldn't respond" },
      { source: String.raw`said "service unavailable"`, text: 'said "service unavailable"' },
      { source: String.raw`said \"service unavailable\"`, text: 'said "service unavailable"' },
      { source: String.raw`path\\'problem'`, text: String.raw`path\'problem'` },
      { source: String.raw`path\\\'problem\'`, text: String.raw`path\'problem'` },
      { source: String.raw`path\\"problem"`, text: String.raw`path\"problem"` },
      { source: String.raw`path\\\"problem\"`, text: String.raw`path\"problem"` },
    ];
    for (const scenario of quotedPatterns) {
      await page.getByRole("alert").evaluate((node, text) => { node.textContent = text; }, scenario.text);
      const observation = await semanticPage.snapshot({
        ...contract.groups["service-error"],
        candidates: [{ kind: "text", text: { source: `^${scenario.source}$`, flags: "i" } }],
      });
      assert.equal(observation.visibleElements, 1, `quoted regex: ${scenario.source}`);
    }
  } finally {
    await context.close();
  }
});
