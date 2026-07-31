import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { chromium } from "playwright-core";

import { observeCopilotPage } from "../../src/browser/classifier.js";
import { createBaselineCopilotUiContract } from "../../src/browser/config.js";
import { PlaywrightSemanticPage } from "../../src/browser/playwright-semantic-page.js";
import { CbaProtocolAdapter } from "../../src/orchestrator/cba-protocol-adapter.js";
import { ProtocolParseError } from "../../src/protocol/index.js";

const chromiumExecutable = process.env["COPE_TEST_CHROMIUM_EXECUTABLE"] ??
  chromium.executablePath();
const entryUrl = "https://m365.cloud.microsoft/chat";
const identity = "Chakraborty, Ronak";

/** The exact 0.1.9 English wording, kept as a drift baseline only. */
const baselineBanner =
  "cba-agent/1 isn’t fully supported. Syntax highlighting is based on Plain Text.";

const agentBody = JSON.stringify({
  kind: "agent_progress",
  phase: "discovering",
  summary: "banner provenance regression",
});
const legacyBody = JSON.stringify({ protocol: "cba/1", type: "progress" });

const codeBlock = (banner: string, body: string): string => `
  <div class="scriptor-component-code-block">
    <div data-testid="message-bar-body-info">${banner}</div>
    <div role="textbox" aria-readonly="true" aria-label="Code editor">
      <div data-line-index="0">${body}</div>
    </div>
  </div>
`;

const reply = (id: string, markup: string): string => `
  <div data-testid="copilot-message-reply-div" id="${id}">
    <div data-testid="markdown-reply">${markup}</div>
  </div>
`;

async function captureFixture(
  t: import("node:test").TestContext,
  slug: string,
  replies: string,
) {
  const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable });
  t.after(async () => browser.close().catch(() => undefined));
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `
        <meta charset="utf-8">
        <main aria-label="Microsoft 365 Copilot Chat">${replies}</main>
      `,
    });
  });
  const page = await context.newPage();
  await page.goto(`${entryUrl}/conversation/${slug}`);
  return await observeCopilotPage(
    new PlaywrightSemanticPage(page),
    createBaselineCopilotUiContract(identity),
  );
}

test(
  "protocol provenance follows the owned protocol label, not Microsoft banner prose",
  { skip: !existsSync(chromiumExecutable) },
  async (t) => {
    const observation = await captureFixture(
      t,
      "banner-prose-drift",
      [
        // 0: the historical exact 0.1.9 wording must keep working.
        reply("historical-exact", codeBlock(baselineBanner, agentBody)),
        // 1: Microsoft rewrites the surrounding sentence; one owned label remains.
        reply(
          "rewritten-sentence",
          codeBlock(
            "The language cba-agent/1 is not recognised, so this block is shown as plain text.",
            agentBody,
          ),
        ),
        // 2: whitespace and Unicode punctuation drift around the label.
        reply(
          "punctuation-drift",
          codeBlock(
            "&nbsp;&nbsp;“cba-agent/1”&nbsp;— isn&#8217;t&#8195;fully   supported.&nbsp;",
            agentBody,
          ),
        ),
        // 3: two protocol labels in one banner cannot establish ownership.
        reply(
          "two-labels",
          codeBlock("cba-agent/1 and cba/1 are not fully supported.", agentBody),
        ),
        // 4: unsupported major version.
        reply("version-2", codeBlock("cba-agent/2 isn’t fully supported.", agentBody)),
        // 5: a two-digit version must not be read as version 1.
        reply("version-10", codeBlock("cba-agent/10 isn’t fully supported.", agentBody)),
        // 6: dotted lookalike is a distinct, unsupported label.
        reply("dotted", codeBlock("cba-agent/1.0 isn’t fully supported.", agentBody)),
        // 7: boundary-glued lookalike yields no label at all.
        reply("glued", codeBlock("xcba-agent/1 isn’t fully supported.", agentBody)),
        // 8: underscore lookalike yields no label at all.
        reply("underscore", codeBlock("cba_agent/1 isn’t fully supported.", agentBody)),
      ].join(""),
    );
    const evidence = observation.responses.elements.map((element) => element.responseCapture);

    // Historical wording: accepted, and recorded as matching the baseline.
    assert.equal(evidence[0]?.status, "protocol_reconstructed");
    assert.equal(evidence[0]?.protocolVersion, "cba-agent/1");
    assert.equal(evidence[0]?.bannerContract, "supported");
    assert.equal(evidence[0]?.bannerTokenCount, 1);
    assert.equal(evidence[0]?.bannerMatchesBaseline, true);

    // Rewritten prose: still executable, and flagged as drifted.
    assert.equal(evidence[1]?.status, "protocol_reconstructed");
    assert.equal(evidence[1]?.protocolVersion, "cba-agent/1");
    assert.equal(evidence[1]?.bannerMatchesBaseline, false);
    assert.match(evidence[1]?.bannerVariant ?? "", /^[0-9a-f]{8}$/u);

    // Whitespace/Unicode drift: still executable.
    assert.equal(evidence[2]?.status, "protocol_reconstructed");
    assert.equal(evidence[2]?.bannerTokenCount, 1);
    assert.equal(evidence[2]?.bannerMatchesBaseline, false);

    // Distinct wording variants must be distinguishable in evidence.
    assert.notEqual(evidence[1]?.bannerVariant, evidence[0]?.bannerVariant);
    assert.notEqual(evidence[2]?.bannerVariant, evidence[1]?.bannerVariant);

    // Two labels in one banner: fail closed, never "pick the first".
    assert.equal(evidence[3]?.status, "protocol_widget_ambiguous");
    assert.equal(evidence[3]?.reasonCode, "PROTOCOL_WIDGET_BANNER_LABEL_AMBIGUOUS");
    assert.equal(evidence[3]?.bannerTokenCount, 2);

    // Unsupported and lookalike labels stay non-executable.
    for (const index of [4, 5, 6] as const) {
      assert.equal(evidence[index]?.status, "model_protocol_malformed");
      assert.equal(evidence[index]?.protocolErrorCode, "UNSUPPORTED_VERSION");
      assert.equal(evidence[index]?.bannerContract, "unsupported_version");
    }
    assert.equal(evidence[5]?.protocolVersion, "cba-agent/10");
    assert.equal(evidence[6]?.protocolVersion, "cba-agent/1.0");

    // Boundary-glued and underscore lookalikes carry no protocol label, so the
    // widget is never treated as protocol-owned and the JSON stays inert.
    for (const index of [7, 8] as const) {
      assert.equal(evidence[index]?.status, "rendered_text");
      assert.equal(evidence[index]?.protocolBlockCount, 0);
      assert.equal(evidence[index]?.bannerContract, undefined);
    }

    // Exactly the three well-formed widgets are executable.
    assert.equal(
      evidence.filter((entry) => entry?.status === "protocol_reconstructed").length,
      3,
    );

    // The drifted-prose response must reconstruct and parse end to end.
    const adapter = new CbaProtocolAdapter();
    const turn = adapter.parseModelTurn(observation.responses.elements[1]?.text ?? "", {
      taskId: "task_banner_drift",
      turnId: "turn_0001",
    });
    assert.equal(turn.messages[0]?.type, "progress");

    // Generic JSON whose shape merely resembles an intent is not authority.
    assert.throws(
      () =>
        adapter.parseModelTurn(observation.responses.elements[8]?.text ?? "", {
          taskId: "task_banner_drift",
          turnId: "turn_0002",
        }),
      ProtocolParseError,
    );
  },
);

test(
  "multiplicity and legacy cba/1 provenance stay fail-closed under banner prose drift",
  { skip: !existsSync(chromiumExecutable) },
  async (t) => {
    const drifted = "Language cba-agent/1 is displayed as plain text.";
    const driftedLegacy = "Language cba/1 is displayed as plain text.";
    const observation = await captureFixture(
      t,
      "banner-multiplicity-drift",
      [
        // 0: two banners inside one block.
        reply(
          "two-banners",
          `
            <div class="scriptor-component-code-block">
              <div data-testid="message-bar-body-info">${drifted}</div>
              <div data-testid="message-bar-body-info">${drifted}</div>
              <div role="textbox" aria-readonly="true" aria-label="Code editor">
                <div data-line-index="0">${agentBody}</div>
              </div>
            </div>
          `,
        ),
        // 1: two editors inside one block.
        reply(
          "two-editors",
          `
            <div class="scriptor-component-code-block">
              <div data-testid="message-bar-body-info">${drifted}</div>
              <div role="textbox" aria-readonly="true" aria-label="Code editor">
                <div data-line-index="0">${agentBody}</div>
              </div>
              <div role="textbox" aria-readonly="true" aria-label="Code editor">
                <div data-line-index="0">${agentBody}</div>
              </div>
            </div>
          `,
        ),
        // 2: two protocol blocks in one response.
        reply(
          "two-blocks",
          codeBlock(drifted, agentBody) + codeBlock(drifted, agentBody),
        ),
        // 3: a drifted banner that is not owned by any code block.
        reply(
          "unowned-banner",
          `<div data-testid="message-bar-body-info">${drifted}</div><p>prose</p>`,
        ),
        // 4: a quoted protocol fence inside a non-protocol widget stays inert.
        reply(
          "quoted-fence",
          `
            <div class="scriptor-component-code-block">
              <div data-testid="message-bar-body-info">markdown is displayed as plain text.</div>
              <div role="textbox" aria-readonly="true" aria-label="Code editor">
                <div data-line-index="0">\`\`\`cba-agent/1</div>
                <div data-line-index="1">${agentBody}</div>
                <div data-line-index="2">\`\`\`</div>
              </div>
            </div>
          `,
        ),
        // 5: legacy cba/1 with drifted prose reconstructs and keeps 0.1.8 correlation.
        reply("legacy", codeBlock(driftedLegacy, legacyBody)),
        // 6: malformed line indices stay rejected.
        reply(
          "broken-lines",
          `
            <div class="scriptor-component-code-block">
              <div data-testid="message-bar-body-info">${drifted}</div>
              <div role="textbox" aria-readonly="true" aria-label="Code editor">
                <div data-line-index="0">{"kind":"agent_progress",</div>
                <div data-line-index="5">"phase":"discovering","summary":"gap"}</div>
              </div>
            </div>
          `,
        ),
      ].join(""),
    );
    const evidence = observation.responses.elements.map((element) => element.responseCapture);

    assert.equal(evidence[0]?.status, "protocol_widget_ambiguous");
    assert.equal(evidence[0]?.reasonCode, "PROTOCOL_WIDGET_BANNER_COUNT");
    assert.equal(evidence[1]?.status, "protocol_widget_ambiguous");
    assert.equal(evidence[1]?.reasonCode, "PROTOCOL_WIDGET_EDITOR_COUNT");
    assert.equal(evidence[2]?.status, "model_protocol_malformed");
    assert.equal(evidence[2]?.protocolErrorCode, "MULTIPLE_ENVELOPES");
    assert.equal(evidence[3]?.status, "unsupported_capture_contract");
    assert.equal(evidence[3]?.reasonCode, "PROTOCOL_WIDGET_NOT_OWNED");
    assert.equal(evidence[4]?.status, "model_protocol_malformed");
    assert.equal(evidence[4]?.reasonCode, "MODEL_PROTOCOL_UNOWNED_FENCE");
    assert.equal(evidence[4]?.protocolErrorCode, "MISSING_ENVELOPE");
    assert.equal(evidence[6]?.status, "protocol_widget_ambiguous");
    assert.equal(evidence[6]?.reasonCode, "PROTOCOL_WIDGET_LINE_INDEX_INVALID");

    // Legacy cba/1 stays reconstructable, and the 0.1.8 correlation identity is
    // still the legacy envelope rather than rendered text, despite drifted prose.
    assert.equal(evidence[5]?.status, "protocol_reconstructed");
    assert.equal(evidence[5]?.protocolVersion, "cba/1");
    assert.equal(evidence[5]?.bannerMatchesBaseline, false);
    assert.equal(
      observation.responses.elements[5]?.text,
      `\`\`\`cba/1\n${legacyBody}\n\`\`\``,
    );
    assert.equal(
      observation.responses.elements[5]?.correlationText,
      `\`\`\`cba/1\n${legacyBody}\n\`\`\``,
    );
  },
);
