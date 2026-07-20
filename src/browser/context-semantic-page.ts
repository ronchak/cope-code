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
  readonly entryUrl: string;
  readonly approvedHosts: readonly ApprovedHost[];
  readonly manualAuthenticationHosts?: readonly ApprovedHost[];
}

/**
 * Tracks the page that currently owns the configured Copilot or Microsoft
 * manual-authentication surface. Microsoft may replace the original navigation
 * tab; the adapter must not remain pinned to a stale about:blank page.
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
    return isPotentialManualAuthenticationUrl(this.#activePage.url(), this.#config);
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
 * Prefer the unique configured Copilot page, not merely any page on the same
 * approved host. While authentication is in progress, select the newest
 * allowed Microsoft authentication page so a popup or replacement tab cannot
 * leave the adapter pinned to an older sign-in surface.
 */
export function selectActiveCopilotPage(
  pages: readonly Page[],
  config: CopilotPageSelectionConfig,
  preferred?: Page,
): Page {
  const openPages = pages.filter((page) => !page.isClosed());
  const approved = openPages.filter((page) => isConfiguredCopilotUrl(page.url(), config.entryUrl));
  if (approved.length > 1) {
    throw new AgentError("TRANSPORT_INDETERMINATE", "Multiple approved Copilot pages are open", {
      diagnosticCode: "AMBIGUOUS_COPILOT_PAGE",
      pageCount: approved.length,
    });
  }
  if (approved.length === 1) return approved[0]!;

  const authentication = openPages.filter((page) =>
    isPotentialManualAuthenticationUrl(page.url(), config));
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
 * Reuse an existing configured Copilot page or an external Microsoft
 * authentication page. Otherwise create a fresh tab and navigate it explicitly.
 * An unrelated same-host page is never mistaken for an existing auth session at
 * launch, but a same-host auth transition that appears after navigation begins
 * can still be followed and must present explicit auth evidence to the classifier.
 */
export async function openTrackedCopilotPage(
  context: BrowserContext,
  config: EdgeLaunchConfig,
): Promise<ContextSemanticPage> {
  const existing = context.pages();
  const approved = existing.filter((page) =>
    !page.isClosed() && isConfiguredCopilotUrl(page.url(), config.entryUrl));
  if (approved.length > 1) {
    throw new AgentError("TRANSPORT_INDETERMINATE", "Multiple approved Copilot pages are open", {
      diagnosticCode: "AMBIGUOUS_COPILOT_PAGE",
      pageCount: approved.length,
    });
  }

  let initial = approved[0];
  if (initial === undefined) {
    const authentication = existing.filter((page) =>
      !page.isClosed() && isReusableExternalAuthenticationUrl(page.url(), config));
    initial = authentication.at(-1);
  }

  if (initial === undefined) {
    initial = await context.newPage();
    initial.setDefaultTimeout(config.waits.actionMs);
    initial.setDefaultNavigationTimeout(config.waits.actionMs);
    await initial.bringToFront().catch(() => undefined);
    const navigationDeadline = performance.now() + config.waits.actionMs;
    let navigationError: unknown;
    try {
      await initial.goto(config.entryUrl, {
        waitUntil: "domcontentloaded",
        timeout: config.waits.actionMs,
      });
    } catch (error) {
      navigationError = error;
    }
    if (!hasAllowedPage(context, config)) {
      const replacementFound = await waitForAllowedReplacementPage(
        context,
        config,
        navigationDeadline,
      );
      if (!replacementFound) {
        if (navigationError !== undefined) throw navigationError;
        throw new AgentError(
          "TRANSPORT_UNAVAILABLE",
          "The dedicated Edge session did not open the configured Copilot surface",
          {
            diagnosticCode: "EDGE_NAVIGATION_NO_ALLOWED_PAGE",
            next: "Close the dedicated Edge window, run cope setup --force, and retry.",
          },
        );
      }
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

function isConfiguredCopilotUrl(value: string, entryValue: string): boolean {
  try {
    const actual = new URL(value);
    const entry = new URL(entryValue);
    if (actual.origin !== entry.origin) return false;
    const basePath = normalizedPath(entry.pathname);
    const actualPath = normalizedPath(actual.pathname);
    return basePath === "/" || actualPath === basePath || actualPath.startsWith(`${basePath}/`);
  } catch {
    return false;
  }
}

/**
 * Manual authentication can occur on a separate Microsoft host or on a path
 * outside the configured chat surface on the same host. Selection is safe
 * because the classifier still requires explicit sign-in, MFA, or consent
 * evidence before granting the long manual window.
 */
function isPotentialManualAuthenticationUrl(
  value: string,
  config: CopilotPageSelectionConfig,
): boolean {
  return isApprovedUrl(value, config.manualAuthenticationHosts ?? []) &&
    !isConfiguredCopilotUrl(value, config.entryUrl);
}

/** At launch, do not reuse arbitrary pages on the configured host as auth pages. */
function isReusableExternalAuthenticationUrl(
  value: string,
  config: CopilotPageSelectionConfig,
): boolean {
  return isPotentialManualAuthenticationUrl(value, config) &&
    !isApprovedUrl(value, config.approvedHosts);
}

function normalizedPath(value: string): string {
  const withoutTrailingSlash = value.replace(/\/+$/u, "");
  return withoutTrailingSlash === "" ? "/" : withoutTrailingSlash;
}

function hasAllowedPage(context: BrowserContext, config: EdgeLaunchConfig): boolean {
  return context.pages().some((page) =>
    !page.isClosed() && (
      isConfiguredCopilotUrl(page.url(), config.entryUrl) ||
      isPotentialManualAuthenticationUrl(page.url(), config)
    ));
}

async function waitForAllowedReplacementPage(
  context: BrowserContext,
  config: EdgeLaunchConfig,
  deadline: number,
): Promise<boolean> {
  for (;;) {
    if (hasAllowedPage(context, config)) return true;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await delay(Math.min(config.waits.pollMs, remaining));
  }
}
