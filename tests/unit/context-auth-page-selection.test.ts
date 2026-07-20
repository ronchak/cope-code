import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";

import { selectActiveCopilotPage } from "../../src/browser/context-semantic-page.js";

class UrlPage {
  public constructor(private readonly value: string) {}
  public url(): string { return this.value; }
  public isClosed(): boolean { return false; }
  public asPage(): Page { return this as unknown as Page; }
}

test("a newer Microsoft authentication tab replaces the previously tracked auth page", () => {
  const older = new UrlPage("https://login.microsoftonline.com/common/oauth2/authorize?step=one");
  const newer = new UrlPage("https://login.microsoftonline.com/common/oauth2/authorize?step=two");

  const selected = selectActiveCopilotPage(
    [older.asPage(), newer.asPage()],
    {
      approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
      manualAuthenticationHosts: [{ hostname: "login.microsoftonline.com" }],
    },
    older.asPage(),
  );

  assert.equal(selected, newer.asPage());
});
