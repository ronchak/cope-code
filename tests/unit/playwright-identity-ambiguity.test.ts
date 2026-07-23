import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { chromium } from "playwright-core";

import {
  classifyCopilotPage,
  observeCopilotReadinessPage,
  observeCopilotPage,
} from "../../src/browser/classifier.js";
import { createBaselineCopilotUiContract } from "../../src/browser/config.js";
import { PlaywrightSemanticPage } from "../../src/browser/playwright-semantic-page.js";
import type { TextPattern } from "../../src/browser/contracts.js";

const chromiumExecutable = process.env["COPE_TEST_CHROMIUM_EXECUTABLE"] ??
  chromium.executablePath();
const expectedIdentity = "approved@example.com";
const entryUrl = "https://m365.cloud.microsoft/chat";

test("a Microsoft account-manager display name reaches ready state in Chromium", {
  skip: !existsSync(chromiumExecutable),
}, async (t) => {
  const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable });
  t.after(async () => browser.close().catch(() => undefined));
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `
        <meta charset="utf-8">
        <main aria-label="Microsoft 365 Copilot Chat">
          <div
            role="textbox"
            contenteditable="true"
            aria-label="Ask Copilot"
            style="width:200px;height:40px"
          ></div>
          <button aria-label="Send message">Send</button>
          <button
            id="mectrl_headerPicture"
            aria-label="Account manager for Ronak Chakraborty"
          ></button>
        </main>
      `,
    });
  });
  const page = await context.newPage();
  await page.goto(`${entryUrl}/conversation/account-manager-wrapper`);
  const visibleIdentity = "Ronak Chakraborty";
  const contract = createBaselineCopilotUiContract(visibleIdentity);
  const observation = await observeCopilotReadinessPage(
    new PlaywrightSemanticPage(page),
    contract,
  );
  const classification = classifyCopilotPage(observation, contract, {
    entryUrl,
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    expectedIdentity: visibleIdentity,
    requireProtectionIndicator: false,
  });

  assert.ok(observation.conversation.visibleElements > 0);
  assert.ok(observation.composer.enabledElements > 0);
  assert.equal(observation.identity.elements[0]?.accessibleLabel, "Account manager for Ronak Chakraborty");
  assert.equal(classification.state, "ready");
  assert.equal(classification.diagnosticCode, "READY");
});

test("an alternate-only Chromium profile control cannot verify current ownership", {
  skip: !existsSync(chromiumExecutable),
}, async (t) => {
  const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable });
  t.after(async () => browser.close().catch(() => undefined));
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `
        <meta charset="utf-8">
        <main>
          <textarea placeholder="Message Copilot" style="width:200px;height:40px"></textarea>
          <button aria-label="Send">Send</button>
          <button data-testid="profile-alternate">Switch account Ronak Chakraborty</button>
        </main>
      `,
    });
  });
  const page = await context.newPage();
  await page.goto(`${entryUrl}/conversation/alternate-only`);
  const visibleIdentity = "Ronak Chakraborty";
  const contract = createBaselineCopilotUiContract(visibleIdentity);
  const observation = await observeCopilotReadinessPage(
    new PlaywrightSemanticPage(page),
    contract,
  );
  const classification = classifyCopilotPage(observation, contract, {
    entryUrl,
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    expectedIdentity: visibleIdentity,
    requireProtectionIndicator: false,
  });

  assert.equal(observation.identity.visibleElements, 1);
  assert.equal(classification.state, "identity-unverified");
  assert.equal(classification.diagnosticCode, "IDENTITY_NOT_VERIFIED");
});

test("a visible alternate profile cannot verify a conflicting current Chromium account", {
  skip: !existsSync(chromiumExecutable),
}, async (t) => {
  const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable });
  t.after(async () => browser.close().catch(() => undefined));
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `
        <meta charset="utf-8">
        <main>
          <textarea placeholder="Message Copilot" style="width:200px;height:40px"></textarea>
          <button aria-label="Send">Send</button>
          <button id="mectrl-current">Current account other@example.com</button>
          <button data-testid="profile-alternate">Switch to approved@example.com</button>
          <div role="status" aria-label="Enterprise data protection"></div>
        </main>
      `,
    });
  });
  const page = await context.newPage();
  await page.goto(`${entryUrl}/conversation/identity-ambiguity`);
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  const observation = await observeCopilotPage(new PlaywrightSemanticPage(page), contract);
  const classification = classifyCopilotPage(observation, contract, {
    entryUrl,
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    expectedIdentity,
    requireProtectionIndicator: false,
  });

  assert.equal(observation.identity.visibleElements, 2);
  assert.equal(classification.state, "identity-unverified");
  assert.equal(classification.diagnosticCode, "IDENTITY_NOT_VERIFIED");
});

test("identity snapshot overflow cannot hide the conflicting current Chromium account", {
  skip: !existsSync(chromiumExecutable),
}, async (t) => {
  const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable });
  t.after(async () => browser.close().catch(() => undefined));
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    const alternateProfiles = Array.from(
      { length: 50 },
      (_, index) =>
        `<button data-testid="profile-${index}">approved@example.com</button>`,
    ).join("\n");
    await route.fulfill({
      contentType: "text/html",
      body: `
        <meta charset="utf-8">
        <main>
          <textarea placeholder="Message Copilot" style="width:200px;height:40px"></textarea>
          <button aria-label="Send">Send</button>
          ${alternateProfiles}
          <button id="mectrl-current">Current account other@example.com</button>
          <div role="status" aria-label="Enterprise data protection"></div>
        </main>
      `,
    });
  });
  const page = await context.newPage();
  await page.goto(`${entryUrl}/conversation/identity-overflow`);
  const contract = createBaselineCopilotUiContract(expectedIdentity);
  const observation = await observeCopilotPage(new PlaywrightSemanticPage(page), contract);
  const classification = classifyCopilotPage(observation, contract, {
    entryUrl,
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    expectedIdentity,
    requireProtectionIndicator: false,
  });

  assert.equal(observation.identity.matchedCandidates, 0);
  assert.equal(observation.identity.visibleElements, 0);
  assert.equal(classification.state, "identity-unverified");
  assert.equal(classification.diagnosticCode, "IDENTITY_NOT_VERIFIED");
});

test("normalized and patterned identity evidence cannot hide conflicting Chromium accounts", {
  skip: !existsSync(chromiumExecutable),
}, async (t) => {
  const cases: ReadonlyArray<{
    readonly expected: string | TextPattern;
    readonly markup: string;
  }> = [
    {
      expected: expectedIdentity,
      markup: `
        <button id="mectrl-current" aria-label="approved@example.com">
          Current account other＠example.com
        </button>`,
    },
    {
      expected: { source: "example\\.com", flags: "iu" },
      markup: `
        <button id="mectrl-current">Current account other@example.com</button>
        <button data-testid="profile-alternate">Switch to approved@example.com</button>`,
    },
    {
      expected: "Ronak Chakraborty",
      markup: `
        <button id="mectrl-current" aria-label="Other Person">
          Ronak Chakraborty
        </button>`,
    },
    {
      expected: { source: "account", flags: "iu" },
      markup: `
        <button id="mectrl-current">Current account Alice</button>
        <button data-testid="profile-alternate">Switch account Bob</button>`,
    },
  ];

  for (const [index, fixture] of cases.entries()) {
    const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable });
    t.after(async () => browser.close().catch(() => undefined));
    const context = await browser.newContext();
    await context.route("**/*", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `
          <meta charset="utf-8">
          <main>
            <textarea placeholder="Message Copilot" style="width:200px;height:40px"></textarea>
            <button aria-label="Send">Send</button>
            ${fixture.markup}
            <div role="status" aria-label="Enterprise data protection"></div>
          </main>
        `,
      });
    });
    const page = await context.newPage();
    await page.goto(`${entryUrl}/conversation/identity-normalization-${index}`);
    const contract = createBaselineCopilotUiContract(fixture.expected);
    const observation = await observeCopilotPage(new PlaywrightSemanticPage(page), contract);
    const classification = classifyCopilotPage(observation, contract, {
      entryUrl,
      approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
      expectedIdentity: fixture.expected,
      requireProtectionIndicator: false,
    });

    assert.equal(classification.state, "identity-unverified");
    assert.equal(classification.diagnosticCode, "IDENTITY_NOT_VERIFIED");
  }
});
