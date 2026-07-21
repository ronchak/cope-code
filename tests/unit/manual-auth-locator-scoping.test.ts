import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "playwright-core";

import { createBaselineCopilotUiContract } from "../../src/browser/config.js";
import { PlaywrightSemanticPage } from "../../src/browser/playwright-semantic-page.js";

class ProbeLocator {
  public constructor(private readonly visible: boolean) {}

  public async count(): Promise<number> { return this.visible ? 1 : 0; }
  public nth(_index: number): Locator { return this as unknown as Locator; }
  public async isVisible(): Promise<boolean> { return this.visible; }
  public async isEnabled(): Promise<boolean> { return this.visible; }
  public async isEditable(): Promise<boolean> { return this.visible; }
  public async innerText(): Promise<string> {
    return "Please accept the consent request and enter a verification code to sign in.";
  }
  public async getAttribute(_name: string): Promise<string | null> { return null; }
  public async inputValue(): Promise<string> { return ""; }
}

class TextOnlyPage {
  public textQueries = 0;

  public on(_event: string, _listener: (...args: readonly unknown[]) => void): this { return this; }
  public getByText(): Locator {
    this.textQueries += 1;
    return new ProbeLocator(true) as unknown as Locator;
  }
  public getByRole(): Locator { return new ProbeLocator(false) as unknown as Locator; }
  public getByLabel(): Locator { return new ProbeLocator(false) as unknown as Locator; }
  public getByPlaceholder(): Locator { return new ProbeLocator(false) as unknown as Locator; }
  public getByTestId(): Locator { return new ProbeLocator(false) as unknown as Locator; }
  public locator(): Locator { return new ProbeLocator(false) as unknown as Locator; }
  public asPage(): Page { return this as unknown as Page; }
}

test("manual authentication signals never scan free conversation text", async () => {
  const contract = createBaselineCopilotUiContract("Ronak Chakraborty");
  const probe = new TextOnlyPage();
  const page = new PlaywrightSemanticPage(probe.asPage());

  for (const signal of ["signed-out", "mfa", "consent"] as const) {
    assert.equal(
      contract.groups[signal].candidates.some((candidate) => candidate.kind === "text"),
      false,
      `${signal} must not contain a free-text locator`,
    );
    const snapshot = await page.snapshot(contract.groups[signal]);
    assert.equal(snapshot.visibleElements, 0, signal);
  }

  assert.equal(
    contract.groups["signed-out"].candidates.some(
      (candidate) => candidate.kind === "role" && candidate.role === "link",
    ),
    false,
  );
  assert.equal(probe.textQueries, 0);
});
