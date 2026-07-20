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

const selectionConfig = {
  entryUrl: "https://m365.cloud.microsoft/chat",
  approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
  manualAuthenticationHosts: [
    { hostname: "m365.cloud.microsoft" },
    { hostname: "login.microsoftonline.com" },
  ],
} as const;

test("a newer external Microsoft authentication tab replaces the previously tracked auth page", () => {
  const older = new UrlPage("https://login.microsoftonline.com/common/oauth2/authorize?step=one");
  const newer = new UrlPage("https://login.microsoftonline.com/common/oauth2/authorize?step=two");

  const selected = selectActiveCopilotPage(
    [older.asPage(), newer.asPage()],
    selectionConfig,
    older.asPage(),
  );

  assert.equal(selected, newer.asPage());
});

test("a newer same-host authentication tab replaces the previously tracked auth page", () => {
  const older = new UrlPage("https://m365.cloud.microsoft/auth/continue?step=one");
  const newer = new UrlPage("https://m365.cloud.microsoft/auth/continue?step=two");

  const selected = selectActiveCopilotPage(
    [older.asPage(), newer.asPage()],
    selectionConfig,
    older.asPage(),
  );

  assert.equal(selected, newer.asPage());
});

test("an unrelated page on the approved host does not displace the configured chat surface", () => {
  const unrelated = new UrlPage("https://m365.cloud.microsoft/search");
  const chat = new UrlPage("https://m365.cloud.microsoft/chat/conversation/synthetic");

  const selected = selectActiveCopilotPage(
    [unrelated.asPage(), chat.asPage()],
    selectionConfig,
    unrelated.asPage(),
  );

  assert.equal(selected, chat.asPage());
});
