import { setTimeout as delay } from "node:timers/promises";

import type { BrowserContext, Page } from "playwright-core";

import { AgentError } from "../shared/errors.js";
import {
  isApprovedUrl,
  type ApprovedHost,
  type EdgeLaunchConfig,
} from "./config.js";
import type { GroupSnapshot, LocatorGroup, SemanticPage } from "./contracts.js";
import { PlaywrightSemanticPage } from "./playwright-semantic-page.js";

export interface CopilotPageSelectionConfig {
  readonly approvedHosts: readonly ApprovedHost[];
  readonly manualAuthenticationHosts?: readonly ApprovedHost[];
}

/**
 * Tracks the page that currently owns the approved Copilot or Microsoft manual
 * authentication surface. Microsoft may replace the original navigation tab;
 * the adapter must not remain pinned to a stale about:blank page.
 */
export class ContextSemanticPage implements SemanticPage {
  readonly #context: BrowserContext;
  readonly #config: CopilotPageSelectionConfig;
  readonly #actionMs: number;
  readonly #delegates = new WeakMap<Page, PlaywrightSemanticPage>();
  readonly #configuredPages = new WeakSet<Page>();
  #activePage: Page;

  public constructor(
    context: BrowserContext,
    config: CopilotPageSelectionConfig,
    initialPage: Page,
    actionMs: number,
  ) {
    if (!Number.isSafeInteger(actionMs) || actionMs <= 0) {
      throw new TypeError("Context page action timeout must be a positive integer");
    }
    this.#context = context;
    this.#config = config;
    this.#activePage = initialPage;
    this.#actionMs = actionMs;
    this.#configurePage(initialPage);
  }

  public async focusActivePage(force = false): Promise<Page> {
    const selected = selectActiveCopilotPage(
      this.#context.pages(),
      this.#config,
      this.#activePage,
    );
    const changed = selected !== this.#activePage;
    this.#activePage = selected;
    this.#configurePage(selected);
    if (force || changed) await selected.bringToFront().catch(() => undefined);
    return selected;
  }

  public isManualAuthenticationRedirect(): boolean {
    return isApprovedUrl(
      this.#activePage.url(),
      this.#config.manualAuthenticationHosts ?? [],
    ) && !isApprovedUrl(this.#activePage.url(), this.#config.approvedHosts);
  }

  public async currentUrl(): Promise<string> {
    return (await this.focusActivePage()).url();
  }

  public async snapshot(group: LocatorGroup): Promise<GroupSnapshot> {
    return this.#delegate(this.#activePage).snapshot(group);
  }

  public async fill(group: LocatorGroup, value: string): Promise<void> {
    const page = await this.focusActivePage();
    await this.#delegate(page).fill(group, value);
  }

  public async click(group: LocatorGroup): Promise<void> {
    const page = await this.focusActivePage();
    await this.#delegate(page).click(group);
  }

  public async press(group: LocatorGroup, key: "Enter"): Promise<void> {
    const page = await this.focusActivePage();
    await this.#delegate(page).press(group, key);
  }

  #configurePage(page: Page): void {
    if (this.#configuredPages.has(page)) return;
    page.setDefaultTimeout(this.#actionMs);
    page.setDefaultNavigationTimeout(this.#actionMs);
    this.#configuredPages.add(page);
  }

  #delegate(page: Page): PlaywrightSemanticPage {
    const existing = this.#delegates.get(page);
    if (existing !== undefined) return existing;
    const created = new PlaywrightSemanticPage(page);
    this.#delegates.set(page, created);
    return created;
  }
}

/**
 * Prefer the unique approved Copilot page. While authentication is in progress,
 * select the newest approved Microsoft authentication page so a popup or
 * replacement tab cannot leave the adapter pinned to an older sign-in surface.
 * A second approved Copilot page is ambiguous and remains a hard stop.
 */
export function selectActiveCopilotPage(
  pages: readonly Page[],
  config: CopilotPageSelectionConfig,
  preferred?: Page,
): Page {
  const openPages = pages.filter((page) => !page.isClosed());
  const approved = openPages.filter((page) => isApprovedUrl(page.url(), config.approvedHosts));
  if (approved.length > 1) {
    throw new AgentError("TRANSPORT_INDETERMINATE", "Multiple approved Copilot pages are open", {
      diagnosticCode: "AMBIGUOUS_COPILOT_PAGE",
      pageCount: approved.length,
    });
  }
  if (approved.length === 1) return approved[0]!;

  const authentication = openPages.filter((page) =>
    isApprovedUrl(page.url(), config.manualAuthenticationHosts ?? []));
  const newestAuthentication = authentication.at(-1);
  if (newestAuthentication !== undefined) return newestAuthentication;

  if (preferred !== undefined && !preferred.isClosed()) return preferred;
  const newestOpenPage = openPages.at(-1);
  if (newestOpenPage !== undefined) return newestOpenPage;
  throw new AgentError("TRANSPORT_UNAVAILABLE", "The dedicated Edge context has no open page", {
    diagnosticCode: "EDGE_PAGE_MISSING",
  });
}

/**
 * Reuse an existing approved or in-progress Microsoft authentication page.
 * Otherwise create a fresh tab, navigate it explicitly, and bring the tracked
 * result to the foreground. Arbitrary startup blank tabs are never selected as
 * the navigation target.
 */
export async function openTrackedCopilotPage(
  context: BrowserContext,
  config: EdgeLaunchConfig,
): Promise<ContextSemanticPage> {
  const existing = context.pages();
  const approved = existing.filter((page) =>
    !page.isClosed() && isApprovedUrl(page.url(), config.approvedHosts));
  if (approved.length > 1) {
    throw new AgentError("TRANSPORT_INDETERMINATE", "Multiple approved Copilot pages are open", {
      diagnosticCode: "AMBIGUOUS_COPILOT_PAGE",
      pageCount: approved.length,
    });
  }

  let initial = approved[0];
  if (initial === undefined) {
    const authentication = existing.filter((page) =>
      !page.isClosed() && isApprovedUrl(page.url(), config.manualAuthenticationHosts ?? []));
    initial = authentication.at(-1);
  }

  if (initial === undefined) {
    initial = await context.newPage();
    initial.setDefaultTimeout(config.waits.actionMs);
    initial.setDefaultNavigationTimeout(config.waits.actionMs);
    await initial.bringToFront().catch(() => undefined);
    try {
      await initial.goto(config.entryUrl, {
        waitUntil: "domcontentloaded",
        timeout: config.waits.actionMs,
      });
    } catch (error) {
      if (!await waitForAllowedReplacementPage(context, config)) throw error;
    }
  }

  const tracked = new ContextSemanticPage(
    context,
    config,
    initial,
    config.waits.actionMs,
  );
  await tracked.focusActivePage(true);
  return tracked;
}

async function waitForAllowedReplacementPage(
  context: BrowserContext,
  config: EdgeLaunchConfig,
): Promise<boolean> {
  const deadline = performance.now() + config.waits.actionMs;
  for (;;) {
    if (context.pages().some((page) =>
      !page.isClosed() && (
        isApprovedUrl(page.url(), config.approvedHosts) ||
        isApprovedUrl(page.url(), config.manualAuthenticationHosts ?? [])
      ))) {
      return true;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await delay(Math.min(config.waits.pollMs, remaining));
  }
}
