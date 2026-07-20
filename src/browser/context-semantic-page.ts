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
  readonly #delegates = new WeakMap<Page, PlaywrightSemanticPage>();
  #activePage: Page;

  public constructor(
    context: BrowserContext,
    config: CopilotPageSelectionConfig,
    initialPage: Page,
  ) {
    this.#context = context;
    this.#config = config;
    this.#activePage = initialPage;
  }

  public async focusActivePage(): Promise<Page> {
    const selected = selectActiveCopilotPage(
      this.#context.pages(),
      this.#config,
      this.#activePage,
    );
    this.#activePage = selected;
    await selected.bringToFront().catch(() => undefined);
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
 * retain the current approved Microsoft auth page or select the newest one. A
 * second approved Copilot page is ambiguous and remains a hard stop.
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
  if (preferred !== undefined && authentication.includes(preferred)) return preferred;
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
      const replacementExists = context.pages().some((page) =>
        !page.isClosed() && (
          isApprovedUrl(page.url(), config.approvedHosts) ||
          isApprovedUrl(page.url(), config.manualAuthenticationHosts ?? [])
        ));
      if (!replacementExists) throw error;
    }
  }

  for (const page of context.pages()) {
    page.setDefaultTimeout(config.waits.actionMs);
    page.setDefaultNavigationTimeout(config.waits.actionMs);
  }
  const tracked = new ContextSemanticPage(context, config, initial);
  await tracked.focusActivePage();
  return tracked;
}
