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

const DEDICATED_MICROSOFT_LOGIN_HOSTS = new Set([
  "login.microsoftonline.com",
  "login.live.com",
  "login.microsoft.com",
]);

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

  /** External Microsoft authentication hosts retain the long manual window. */
  public isManualAuthenticationRedirect(): boolean {
    return isReusableExternalAuthenticationUrl(this.#activePage.url(), this.#config);
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
 * approved host. While authentication is in progress, select only a URL with a
 * genuine Microsoft authentication shape so unrelated M365 and Office tabs
 * cannot displace the tracked navigation page.
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
    isGenuineManualAuthenticationUrl(page.url(), config));
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
 * Reuse an existing configured Copilot page or a genuine Microsoft
 * authentication page. Otherwise create a fresh tab and navigate it explicitly.
 * The newly navigated tab may remain selected for a same-tab auth transition,
 * but unrelated pre-existing tabs cannot satisfy launch readiness.
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
    if (!hasAllowedPage(context, config, initial)) {
      const replacementFound = await waitForAllowedReplacementPage(
        context,
        config,
        initial,
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
 * A manual-authentication host is not enough by itself. Setup intentionally
 * allowlists several broad Microsoft and Office hosts for visible redirects;
 * selecting one requires a dedicated login host, an OAuth-style query, or an
 * authentication-shaped path. This excludes roots and unrelated pages such as
 * m365.cloud.microsoft/search and www.office.com/.
 */
export function isGenuineManualAuthenticationUrl(
  value: string,
  config: CopilotPageSelectionConfig,
): boolean {
  if (
    !isApprovedUrl(value, config.manualAuthenticationHosts ?? []) ||
    isConfiguredCopilotUrl(value, config.entryUrl)
  ) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  const hostname = url.hostname.toLocaleLowerCase().replace(/\.$/u, "");
  const path = normalizedPath(url.pathname).toLocaleLowerCase();
  const authPath = /(?:^|\/)(?:auth|authorize|federation|kmsi|login|oauth2?|ppsecure|sas|signin)(?:\/|$|\.)/iu.test(path);
  const authQuery = [
    "client_id",
    "code_challenge",
    "login_hint",
    "prompt",
    "redirect_uri",
    "response_type",
    "sso_reload",
    "state",
  ].some((key) => url.searchParams.has(key));
  const dedicatedLoginPath = DEDICATED_MICROSOFT_LOGIN_HOSTS.has(hostname) && path !== "/";
  return authPath || authQuery || dedicatedLoginPath;
}

/** At launch and in the outer retry loop, trust only genuine external auth URLs. */
function isReusableExternalAuthenticationUrl(
  value: string,
  config: CopilotPageSelectionConfig,
): boolean {
  return isGenuineManualAuthenticationUrl(value, config) &&
    !isApprovedUrl(value, config.approvedHosts);
}

function isNavigatedSameTabAuthenticationCandidate(
  page: Page,
  navigationPage: Page,
  config: CopilotPageSelectionConfig,
): boolean {
  const value = page.url();
  return page === navigationPage &&
    value !== "about:blank" &&
    isApprovedUrl(value, config.manualAuthenticationHosts ?? []) &&
    !isConfiguredCopilotUrl(value, config.entryUrl);
}

function normalizedPath(value: string): string {
  const withoutTrailingSlash = value.replace(/\/+$/u, "");
  return withoutTrailingSlash === "" ? "/" : withoutTrailingSlash;
}

function hasAllowedPage(
  context: BrowserContext,
  config: EdgeLaunchConfig,
  navigationPage: Page,
): boolean {
  return context.pages().some((page) =>
    !page.isClosed() && (
      isConfiguredCopilotUrl(page.url(), config.entryUrl) ||
      isGenuineManualAuthenticationUrl(page.url(), config) ||
      isNavigatedSameTabAuthenticationCandidate(page, navigationPage, config)
    ));
}

async function waitForAllowedReplacementPage(
  context: BrowserContext,
  config: EdgeLaunchConfig,
  navigationPage: Page,
  deadline: number,
): Promise<boolean> {
  for (;;) {
    if (hasAllowedPage(context, config, navigationPage)) return true;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await delay(Math.min(config.waits.pollMs, remaining));
  }
}
