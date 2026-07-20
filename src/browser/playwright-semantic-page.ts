import type { Locator, Page } from "playwright-core";

import {
  toRegExp,
  type ElementSnapshot,
  type GroupSnapshot,
  type LocatorGroup,
  type SemanticLocator,
  type SemanticPage,
  type TextPattern,
} from "./contracts.js";

/** The only module that translates the UI contract into Playwright locators. */
export class PlaywrightSemanticPage implements SemanticPage {
  readonly #page: Page;
  #nativeDialogDetected = false;

  public constructor(page: Page) {
    this.#page = page;
    // Do not accept, dismiss, inspect, or automate unknown browser dialogs.
    // Leaving the dialog visible blocks consequential actions and the sticky
    // signal makes the adapter fail closed until the session is restarted.
    if (typeof page.on === "function") {
      page.on("dialog", () => {
        this.#nativeDialogDetected = true;
      });
    }
  }

  public async currentUrl(): Promise<string> {
    return this.#page.url();
  }

  public async snapshot(group: LocatorGroup): Promise<GroupSnapshot> {
    if (this.#nativeDialogDetected) {
      const elements: readonly ElementSnapshot[] =
        group.signal === "modal"
          ? [{ visible: true, enabled: false, text: "", value: "", accessibleLabel: "" }]
          : [];
      return {
        signal: group.signal,
        matchedCandidates: group.signal === "modal" ? group.minimumCandidateMatches : 0,
        visibleElements: elements.length,
        enabledElements: 0,
        elements,
      };
    }
    const candidateSnapshots = await Promise.all(
      group.candidates.map(async (candidate) => this.#snapshotCandidate(candidate, group)),
    );
    const matched = candidateSnapshots.filter((entry) => entry.length > 0);
    // Candidate strategies are alternatives. Read from the richest successful
    // candidate while still counting all independent matches for quorum.
    const elements = matched.reduce<readonly ElementSnapshot[]>(
      (best, current) => (current.length > best.length ? current : best),
      [],
    );
    return {
      signal: group.signal,
      matchedCandidates: matched.length,
      visibleElements: elements.filter((element) => element.visible).length,
      enabledElements: elements.filter((element) => element.visible && element.enabled).length,
      elements,
    };
  }

  public async fill(group: LocatorGroup, value: string): Promise<void> {
    const locator = await this.#firstActionable(group);
    await locator.fill(value);
  }

  public async click(group: LocatorGroup): Promise<void> {
    const locator = await this.#firstActionable(group);
    await locator.click();
  }

  public async press(group: LocatorGroup, key: "Enter"): Promise<void> {
    const locator = await this.#firstActionable(group);
    await locator.press(key);
  }

  async #snapshotCandidate(
    candidate: SemanticLocator,
    group: LocatorGroup,
  ): Promise<readonly ElementSnapshot[]> {
    try {
      const locator = this.#locator(candidate);
      const count = Math.min(await locator.count(), group.maximumElements);
      const snapshots: ElementSnapshot[] = [];
      for (let index = 0; index < count; index += 1) {
        const item = locator.nth(index);
        const visible = await safeBoolean(() => item.isVisible());
        if (!visible) continue;
        const enabled = await safeBoolean(() => item.isEnabled());
        const captureText = group.capture !== "presence";
        const text = captureText ? await safeString(() => item.innerText()) : "";
        const accessibleLabel = captureText
          ? await safeString(async () => (await item.getAttribute("aria-label")) ?? "")
          : "";
        const value =
          group.capture === "value-and-text" ? await safeString(() => item.inputValue()) : "";
        snapshots.push({ visible, enabled, text, value, accessibleLabel });
      }
      return snapshots;
    } catch {
      // A stale candidate contributes no quorum. Other strategies can still
      // identify the surface; total quorum failure becomes changed-selector.
      return [];
    }
  }

  async #firstActionable(group: LocatorGroup): Promise<Locator> {
    for (const candidate of group.candidates) {
      try {
        const locator = this.#locator(candidate);
        const count = Math.min(await locator.count(), group.maximumElements);
        for (let index = 0; index < count; index += 1) {
          const item = locator.nth(index);
          if ((await safeBoolean(() => item.isVisible())) && (await safeBoolean(() => item.isEnabled()))) {
            return item;
          }
        }
      } catch {
        // Try the next independently configured semantic locator.
      }
    }
    throw new Error(`No actionable locator for UI signal: ${group.signal}`);
  }

  #locator(candidate: SemanticLocator): Locator {
    switch (candidate.kind) {
      case "role": {
        const role = candidate.role as Parameters<Page["getByRole"]>[0];
        if (candidate.name === undefined) return this.#page.getByRole(role);
        return this.#page.getByRole(role, {
          name: textMatcher(candidate.name),
          exact: candidate.exact ?? false,
        });
      }
      case "label":
        return this.#page.getByLabel(textMatcher(candidate.label), {
          exact: candidate.exact ?? false,
        });
      case "placeholder":
        return this.#page.getByPlaceholder(textMatcher(candidate.placeholder), {
          exact: candidate.exact ?? false,
        });
      case "test-id":
        return this.#page.getByTestId(textMatcher(candidate.testId));
      case "text":
        return this.#page.getByText(textMatcher(candidate.text), {
          exact: candidate.exact ?? false,
        });
      case "css":
        return this.#page.locator(candidate.selector);
    }
  }
}

function textMatcher(value: string | TextPattern): string | RegExp {
  return typeof value === "string" ? value : toRegExp(value);
}

async function safeBoolean(operation: () => Promise<boolean>): Promise<boolean> {
  try {
    return await operation();
  } catch {
    return false;
  }
}

async function safeString(operation: () => Promise<string>): Promise<string> {
  try {
    return await operation();
  } catch {
    return "";
  }
}
