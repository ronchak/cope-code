import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { chromium } from "playwright-core";

import { PlaywrightSemanticPage } from "../../src/browser/playwright-semantic-page.js";
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
const chromiumExecutable = process.env["COPE_TEST_CHROMIUM_EXECUTABLE"] ??
  chromium.executablePath();

test("native dialog aborts queued bound fill and click dispatch in Chromium", {
  skip: !existsSync(chromiumExecutable),
}, async (t) => {
  const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable });
  t.after(async () => browser.close());

  for (const dismiss of [false, true]) {
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
      if (dismiss) {
        // Model an operator/browser dismissal racing the fail-closed target abort.
        page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => undefined); });
      }
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
        `${action} must not cross the ${dismiss ? "dismissed" : "open"} native-dialog barrier`,
      );
    }
  }
});
