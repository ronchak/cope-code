import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { chromium } from "playwright-core";

import {
  classifyCopilotPage,
  observeCopilotReadinessPage,
  observeCopilotPage,
} from "../../src/browser/classifier.js";
import { CopilotBrowserAdapter } from "../../src/browser/copilot-browser-adapter.js";
import {
  createBaselineCopilotUiContract,
  type CopilotBrowserAdapterConfig,
} from "../../src/browser/config.js";
import { ContextSemanticPage } from "../../src/browser/context-semantic-page.js";
import { PlaywrightSemanticPage } from "../../src/browser/playwright-semantic-page.js";
import type { TextPattern } from "../../src/browser/contracts.js";
import {
  ProtocolParseError,
  parseProtocolEnvelope,
} from "../../src/protocol/index.js";

const chromiumExecutable = process.env["COPE_TEST_CHROMIUM_EXECUTABLE"] ??
  chromium.executablePath();
const expectedIdentity = "approved@example.com";
const entryUrl = "https://m365.cloud.microsoft/chat";

test("the current M365 navigation avatar verifies the visible display name in Chromium", {
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
            aria-label="Message Copilot"
            style="width:200px;height:40px"
          ></div>
          <button aria-label="Send message">Send</button>
          <div role="navigation">
            <footer role="none">
              <div>
                <span
                  role="img"
                  id="user-account-avatar"
                  aria-hidden="true"
                  aria-label="Chakraborty, Ronak"
                  style="display:inline-block;width:32px;height:32px"
                ><span>CR</span></span>
                <span>Chakraborty, Ronak</span>
              </div>
              <div
                role="button"
                tabindex="0"
                aria-label="Chakraborty, Ronak"
                style="width:200px;height:40px"
              ></div>
            </footer>
          </div>
        </main>
      `,
    });
  });
  const page = await context.newPage();
  await page.goto(`${entryUrl}/conversation/current-navigation-avatar`);
  const visibleIdentity = "Chakraborty, Ronak";
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
  assert.equal(observation.identity.elements[0]?.accessibleLabel, visibleIdentity);
  assert.equal(classification.state, "ready");
  assert.equal(classification.diagnosticCode, "READY");
});

test("the current M365 message envelopes expose submission and response evidence in Chromium", {
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
            aria-label="Message Copilot"
            style="width:200px;height:40px"
          ></div>
          <button aria-label="Send message">Send</button>
          <div data-testid="chatQuestion">
            <h5>You said:</h5>
            <div data-testid="chatOutput">prompt [[COPILOT_AGENT_TASK_V2:marker]]</div>
          </div>
          <div data-testid="copilot-message-reply-div">
            <h6>Copilot said:</h6>
            <div data-testid="markdown-reply">response</div>
          </div>
          <div role="navigation">
            <footer role="none">
              <div>
                <span id="user-account-avatar" aria-hidden="true">CR</span>
              </div>
              <div
                role="button"
                tabindex="0"
                aria-label="Chakraborty, Ronak"
                style="width:200px;height:40px"
              ></div>
            </footer>
          </div>
        </main>
      `,
    });
  });
  const page = await context.newPage();
  await page.goto(`${entryUrl}/conversation/current-message-envelopes`);
  const contract = createBaselineCopilotUiContract("Chakraborty, Ronak");
  const observation = await observeCopilotPage(new PlaywrightSemanticPage(page), contract);

  assert.equal(observation["user-messages"].visibleElements, 1);
  assert.match(observation["user-messages"].elements[0]?.text ?? "", /COPILOT_AGENT_TASK_V2/u);
  assert.equal(observation.responses.visibleElements, 1);
  assert.match(observation.responses.elements[0]?.text ?? "", /response/u);
});

test("the live adapter submits with a trusted click, adopts the URL, and restores CBA fences", {
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
        <style>
          body { margin: 0; }
          #composer, #send { display: block; width: 240px; height: 48px; margin: 16px; }
        </style>
        <main aria-label="Microsoft 365 Copilot Chat">
          <textarea
            id="composer"
            role="textbox"
            aria-label="Message Copilot"
          ></textarea>
          <button id="send" aria-label="Send message">Send</button>
          <section id="transcript"></section>
          <div role="navigation">
            <footer role="none">
              <div><span id="user-account-avatar" aria-hidden="true">SA</span></div>
              <div
                role="button"
                tabindex="0"
                aria-label="Chakraborty, Ronak"
                style="width:200px;height:40px"
              ></div>
            </footer>
          </div>
        </main>
        <script>
          document.querySelector("#send").addEventListener("click", (event) => {
            document.body.dataset.trustedClick = String(event.isTrusted);
            if (!event.isTrusted) return;
            const composer = document.querySelector("#composer");
            const transcript = document.querySelector("#transcript");
            const question = document.createElement("div");
            question.dataset.testid = "chatQuestion";
            question.textContent = composer.value;
            const response = document.createElement("div");
            response.dataset.testid = "copilot-message-reply-div";
            const markdown = document.createElement("div");
            markdown.dataset.testid = "markdown-reply";
            const codeBlock = document.createElement("div");
            codeBlock.className = "scriptor-component-code-block";
            const languageIndicator = document.createElement("div");
            languageIndicator.dataset.testid = "message-bar-body-info";
            languageIndicator.textContent =
              "cba/1 isn’t fully supported. Syntax highlighting is based on Plain Text.";
            const editor = document.createElement("div");
            editor.setAttribute("role", "textbox");
            editor.setAttribute("aria-readonly", "true");
            editor.setAttribute("aria-label", "Code editor");
            const line = document.createElement("div");
            line.dataset.lineIndex = "0";
            line.textContent = JSON.stringify({
              protocol: "cba/1",
              message_type: "complete_task",
              summary: "trusted adapter flow",
            });
            editor.append(line);
            codeBlock.append(languageIndicator, editor);
            markdown.append(codeBlock);
            response.append(markdown);
            transcript.append(question, response);
            composer.value = "";
            setTimeout(() => {
              history.replaceState({}, "", "/chat/conversation/materialized");
            }, 25);
          });
        </script>
      `,
    });
  });
  const page = await context.newPage();
  await page.goto(entryUrl);
  const contract = createBaselineCopilotUiContract("Chakraborty, Ronak");
  const config: CopilotBrowserAdapterConfig = {
    entryUrl,
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    expectedIdentity: "Chakraborty, Ronak",
    requireProtectionIndicator: false,
    uiContract: contract,
    maxMessageChars: 10_000,
    maxResponseChars: 10_000,
    waits: {
      actionMs: 5_000,
      submissionConfirmationMs: 2_000,
      responseMs: 2_000,
      manualReadinessMs: 2_000,
      pollMs: 10,
      stableSamples: 2,
      minimumStableMs: 10,
    },
  };
  const semanticPage = new ContextSemanticPage(context, config, page, config.waits.actionMs);
  const adapter = new CopilotBrowserAdapter(semanticPage, config);
  const request = {
    taskId: "task-live-composition",
    turnId: "turn-live-composition",
    submissionId: "submission-live-composition",
    content: "Use the tool contract.",
  } as const;

  const receipt = await adapter.submit(request);
  assert.equal(receipt.status, "submitted", JSON.stringify({
    receipt,
    url: page.url(),
    questions: await page.locator('[data-testid="chatQuestion"]').allInnerTexts(),
    trustedClick: await page.getAttribute("body", "data-trusted-click"),
  }));
  assert.equal(await page.getAttribute("body", "data-trusted-click"), "true");
  assert.equal(page.url(), `${entryUrl}/conversation/materialized`);

  const response = await adapter.receive(request);
  assert.equal(response.status, "completed");
  if (response.status === "completed") {
    assert.equal(
      response.content,
      "```cba/1\n" +
        '{"protocol":"cba/1","message_type":"complete_task","summary":"trusted adapter flow"}' +
        "\n```",
    );
  }
});

test("a late Chromium overlay cannot receive or redirect trusted send activation", {
  skip: !existsSync(chromiumExecutable),
}, async (t) => {
  const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable });
  t.after(async () => browser.close().catch(() => undefined));
  const context = await browser.newContext();
  const activations: string[] = [];
  await context.exposeFunction("recordCopeActivation", (target: string) => {
    activations.push(target);
  });
  await context.route("**/*", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `
        <meta charset="utf-8">
        <style>
          body { margin: 0; }
          #send { display: block; width: 240px; height: 48px; margin: 16px; }
          #cover {
            display: none;
            position: fixed;
            inset: 0;
            z-index: 1000;
            background: rgba(255, 0, 0, 0.05);
          }
        </style>
        <button id="send" aria-label="Send message">Send</button>
        <button id="cover">Overlay</button>
        <script>
          const send = document.querySelector("#send");
          const cover = document.querySelector("#cover");
          window.addEventListener("mousemove", () => {
            cover.style.display = "block";
          }, { once: true });
          send.addEventListener("click", () => window.recordCopeActivation("send"));
          cover.addEventListener("click", () => window.recordCopeActivation("overlay"));
        </script>
      `,
    });
  });
  const page = await context.newPage();
  await page.goto(`${entryUrl}/conversation/late-overlay`);
  const semanticPage = new PlaywrightSemanticPage(page, undefined, 500);
  const sendGroup = createBaselineCopilotUiContract("Chakraborty, Ronak").groups.send;

  await assert.rejects(
    semanticPage.click(sendGroup, () => undefined),
    (error: unknown) =>
      error instanceof Error &&
      (
        error.message.includes("configured action timeout") ||
        error.message.includes("exceeded its configured action timeout") ||
        error.message.includes("did not remain pinned to the bound send element")
      ),
  );
  assert.deepEqual(activations, []);
});

for (const variant of ["json", "unlabeled"] as const) {
  test(`a ${variant} Chromium code editor containing CBA-shaped JSON remains inert`, {
    skip: !existsSync(chromiumExecutable),
  }, async (t) => {
    const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable });
    t.after(async () => browser.close().catch(() => undefined));
    const context = await browser.newContext();
    const cbaShapedJson = JSON.stringify({
      protocol: "cba/1",
      message_type: "tool_request",
      message_id: "msg_1",
      task_id: "task_1",
      turn_id: 2,
      operations: [{ operation_id: "op_1", tool: "git_status", arguments: {} }],
    });
    await context.route("**/*", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `
          <meta charset="utf-8">
          <main aria-label="Microsoft 365 Copilot Chat">
            <div data-testid="copilot-message-reply-div">
              <div data-testid="markdown-reply">
                <div class="scriptor-component-code-block">
                  ${
                    variant === "json"
                      ? '<div data-testid="code-language">JSON</div>'
                      : ""
                  }
                  <div role="textbox" aria-readonly="true" aria-label="Code editor">
                    <div data-line-index="0">${cbaShapedJson}</div>
                  </div>
                </div>
              </div>
            </div>
          </main>
        `,
      });
    });
    const page = await context.newPage();
    await page.goto(`${entryUrl}/conversation/inert-${variant}`);
    const contract = createBaselineCopilotUiContract("Chakraborty, Ronak");
    const observation = await observeCopilotPage(new PlaywrightSemanticPage(page), contract);
    const rendered = observation.responses.elements[0]?.text ?? "";

    assert.doesNotMatch(rendered, /```cba\/1/u);
    assert.throws(
      () =>
        parseProtocolEnvelope(rendered, {
          expected_task_id: "task_1",
          expected_turn_id: 2,
        }),
      (error: unknown) =>
        error instanceof ProtocolParseError &&
        error.protocolCode === "MISSING_ENVELOPE",
    );
  });
}

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
