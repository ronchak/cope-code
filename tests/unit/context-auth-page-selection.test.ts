import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";

import {
  isGenuineManualAuthenticationUrl,
  selectActiveCopilotPage,
} from "../../src/browser/context-semantic-page.js";

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
    { hostname: "m365copilot.com" },
    { hostname: "login.microsoftonline.com" },
    { hostname: "login.live.com" },
    { hostname: "login.microsoft.com" },
    { hostname: "office.com" },
    { hostname: "www.office.com" },
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

test("a newer same-host authentication-shaped tab replaces the previously tracked auth page", () => {
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

test("broad Office and M365 allowlist entries are not reusable authentication pages by host alone", () => {
  for (const value of [
    "https://m365.cloud.microsoft/search",
    "https://m365copilot.com/",
    "https://office.com/",
    "https://www.office.com/",
  ]) {
    assert.equal(
      isGenuineManualAuthenticationUrl(value, selectionConfig),
      false,
      value,
    );
  }
});

test("dedicated login hosts or explicit auth evidence qualify an allowlisted Microsoft redirect", () => {
  for (const value of [
    "https://login.microsoftonline.com/",
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=synthetic",
    "https://login.live.com/oauth20_authorize.srf?client_id=synthetic",
    "https://office.com/auth/continue?state=synthetic",
    "https://m365copilot.com/signin?redirect_uri=https%3A%2F%2Fm365.cloud.microsoft%2Fchat",
  ]) {
    assert.equal(
      isGenuineManualAuthenticationUrl(value, selectionConfig),
      true,
      value,
    );
  }
});

test("an unrelated Office tab cannot replace the tracked blank navigation page", () => {
  const blank = new UrlPage("about:blank");
  const office = new UrlPage("https://www.office.com/");

  const selected = selectActiveCopilotPage(
    [blank.asPage(), office.asPage()],
    selectionConfig,
    blank.asPage(),
  );

  assert.equal(selected, blank.asPage());
});
