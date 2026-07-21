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
  readonly #navigationEpochs = new WeakMap<Page, number>();
  readonly #staleAuthenticationPages = new WeakSet<Page>();
  #activePage: Page;
  #observedUrl: string | undefined;
  #filledPage: Page | undefined;
  #filledUrl: string | undefined;
  #filledGroup: LocatorGroup | undefined;
  #filledValue: string | undefined;
  #postFillObservationSeen = false;
  #authenticationPage: Page | undefined;
  #configuredPageBeforeAuthentication: Page | undefined;
  #configuredUrlBeforeAuthentication: string | undefined;
  #configuredEpochBeforeAuthentication = 0;

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
    for (const page of context.pages()) this.#configurePage(page);
    this.#configurePage(initialPage);
    if (typeof context.on === "function") {
      context.on("page", (page) => {
        this.#configurePage(page);
      });
    }
  }

  public async focusActivePage(force = false): Promise<Page> {
    const pages = this.#context.pages();
    const returnedConfiguredPage = this.#returnedConfiguredPage(pages);
    if (returnedConfiguredPage !== undefined) {
      this.#markCurrentAuthenticationPagesStale(pages);
    }

    const selectablePages = returnedConfiguredPage === undefined
      ? pages.filter((page) =>
        !this.#staleAuthenticationPages.has(page) ||
        !isGenuineManualAuthenticationUrl(page.url(), this.#config))
      : pages;
    const selected = returnedConfiguredPage ?? selectActiveCopilotPage(
      selectablePages,
      this.#config,
      this.#activePage,
    );

    if (isGenuineManualAuthenticationUrl(selected.url(), this.#config)) {
      this.#trackAuthenticationSelection(pages, selected);
    } else if (isConfiguredCopilotUrl(selected.url(), this.#config.entryUrl)) {
      this.#clearAuthenticationTracking();
    }

    const changed = selected !== this.#activePage;
    this.#activePage = selected;
    if (changed) this.#observedUrl = undefined;
    this.#configurePage(selected);
    if (force || changed) await selected.bringToFront().catch(() => undefined);
    return selected;
  }

  /** External Microsoft authentication hosts retain the long manual window. */
  public isManualAuthenticationRedirect(): boolean {
    return isReusableExternalAuthenticationUrl(this.#activePage.url(), this.#config);
  }

  public async currentUrl(): Promise<string> {
    // The first observation after composer fill is part of the same submission
    // transaction. It must inspect the exact page that received the prompt, not
    // silently adopt a replacement tab with the same conversation URL.
    if (this.#filledPage !== undefined && !this.#postFillObservationSeen) {
      const page = this.#verifiedFilledPage();
      const currentUrl = page.url();
      this.#activePage = page;
      this.#observedUrl = currentUrl;
      this.#postFillObservationSeen = true;
      return currentUrl;
    }

    // A later observation means the prior filled draft was not activated. Drop
    // the transaction pin so an explicit retry can inspect the current context.
    if (this.#filledPage !== undefined) this.#clearFilledPagePin();

    const page = await this.focusActivePage();
    const currentUrl = page.url();
    this.#observedUrl = currentUrl;
    return currentUrl;
  }

  public async snapshot(group: LocatorGroup): Promise<GroupSnapshot> {
    return this.#delegate(this.#activePage).snapshot(group);
  }

  /**
   * Fill is permitted only on the exact page and URL used by the trusted
   * observation. A successful fill starts a transaction pin that remains active
   * through the second trust observation and send activation.
   */
  public async fill(group: LocatorGroup, value: string): Promise<void> {
    const page = this.#verifiedObservedPage();
    const expectedUrl = this.#observedUrl!;
    await this.#delegate(page).fill(group, value);
    if (page.isClosed() || page.url() !== expectedUrl) {
      this.#clearFilledPagePin();
      throw new AgentError(
        "TRANSPORT_INDETERMINATE",
        "The observed Copilot page changed while the composer was being filled",
        { diagnosticCode: "ACTIVE_PAGE_CHANGED_DURING_FILL" },
      );
    }
    this.#filledPage = page;
    this.#filledUrl = expectedUrl;
    this.#filledGroup = group;
    this.#filledValue = value;
    this.#postFillObservationSeen = false;
  }

  /** Send activation requires a completed post-fill observation on the same page. */
  public async click(group: LocatorGroup): Promise<void> {
    const page = await this.#activationPageOrThrow();
    try {
      await this.#delegate(page).click(group);
    } finally {
      this.#clearFilledPagePin();
    }
  }

  /** Enter activation follows the same post-fill page-identity requirements. */
  public async press(group: LocatorGroup, key: "Enter"): Promise<void> {
    const page = await this.#activationPageOrThrow();
    try {
      await this.#delegate(page).press(group, key);
    } finally {
      this.#clearFilledPagePin();
    }
  }

  /**
   * Every failure before delegating click or Enter is conclusively
   * pre-dispatch. Preserve that fact for the adapter so a guarded failure
   * remains safely retryable instead of being treated as indeterminate.
   */
  async #activationPageOrThrow(): Promise<Page> {
    try {
      return await this.#verifiedActivationPage();
    } catch (error) {
      if (error instanceof AgentError && error.details.dispatchAttempted === false) {
        throw error;
      }
      const diagnosticCode =
        error instanceof AgentError && typeof error.details.diagnosticCode === "string"
          ? error.details.diagnosticCode
          : "PRE_ACTIVATION_GUARD_FAILED";
      throw new AgentError(
        "TRANSPORT_INDETERMINATE",
        "The Copilot pre-activation guard blocked browser activation",
        { diagnosticCode, dispatchAttempted: false },
        { cause: error },
      );
    }
  }

  #verifiedObservedPage(): Page {
    const selected = selectActiveCopilotPage(
      this.#context.pages(),
      this.#config,
      this.#activePage,
    );
    const currentUrl = this.#activePage.url();
    if (
      selected !== this.#activePage ||
      this.#activePage.isClosed() ||
      this.#observedUrl === undefined ||
      currentUrl !== this.#observedUrl
    ) {
      throw new AgentError(
        "TRANSPORT_INDETERMINATE",
        "The observed Copilot page changed before the browser action",
        { diagnosticCode: "ACTIVE_PAGE_CHANGED_BEFORE_ACTION" },
      );
    }
    return this.#activePage;
  }

  async #verifiedActivationPage(): Promise<Page> {
    if (
      this.#filledPage === undefined ||
      this.#filledUrl === undefined ||
      this.#filledGroup === undefined ||
      this.#filledValue === undefined ||
      !this.#postFillObservationSeen
    ) {
      throw new AgentError(
        "TRANSPORT_INDETERMINATE",
        "The filled Copilot composer was not re-verified before activation",
        { diagnosticCode: "POST_FILL_OBSERVATION_REQUIRED" },
      );
    }

    const page = this.#verifiedFilledPage();
    const composer = await this.#delegate(page).snapshot(this.#filledGroup);
    const filledValue = this.#filledValue;
    const contentStillPresent = composer.elements.some(
      (element) =>
        element.visible &&
        element.enabled &&
        (element.value === filledValue || element.text === filledValue),
    );
    if (!contentStillPresent) {
      this.#clearFilledPagePin();
      throw new AgentError(
        "TRANSPORT_INDETERMINATE",
        "The Copilot composer changed after it was filled",
        { diagnosticCode: "COMPOSER_CONTENT_CHANGED_BEFORE_SUBMIT" },
      );
    }

    // Recheck page ownership after reading the composer so a replacement or
    // navigation during that read cannot be followed by activation.
    return this.#verifiedFilledPage();
  }

  #verifiedFilledPage(): Page {
    const filledPage = this.#filledPage;
    const filledUrl = this.#filledUrl;
    if (filledPage === undefined || filledUrl === undefined) {
      throw new AgentError(
        "TRANSPORT_INDETERMINATE",
        "The filled Copilot page transaction is unavailable",
        { diagnosticCode: "FILLED_PAGE_TRANSACTION_MISSING" },
      );
    }

    let selected: Page;
    try {
      selected = selectActiveCopilotPage(
        this.#context.pages(),
        this.#config,
        filledPage,
      );
    } catch (error) {
      this.#clearFilledPagePin();
      throw error;
    }

    if (
      selected !== filledPage ||
      filledPage.isClosed() ||
      filledPage.url() !== filledUrl
    ) {
      this.#clearFilledPagePin();
      throw new AgentError(
        "TRANSPORT_INDETERMINATE",
        "The Copilot page that received the prompt changed before activation",
        { diagnosticCode: "ACTIVE_PAGE_CHANGED_AFTER_FILL" },
      );
    }
    return filledPage;
  }

  #returnedConfiguredPage(pages: readonly Page[]): Page | undefined {
    const authenticationPage = this.#authenticationPage;
    if (authenticationPage === undefined) return undefined;

    const configuredPage = uniqueConfiguredCopilotPage(pages, this.#config.entryUrl);
    if (configuredPage === undefined) return undefined;
    if (authenticationPage.isClosed() || !pages.includes(authenticationPage)) {
      return configuredPage;
    }

    const priorConfiguredPage = this.#configuredPageBeforeAuthentication;
    if (priorConfiguredPage === undefined || configuredPage !== priorConfiguredPage) {
      return configuredPage;
    }
    if (configuredPage.url() !== this.#configuredUrlBeforeAuthentication) {
      return configuredPage;
    }
    const currentEpoch = this.#navigationEpochs.get(configuredPage) ?? 0;
    return currentEpoch > this.#configuredEpochBeforeAuthentication
      ? configuredPage
      : undefined;
  }

  #trackAuthenticationSelection(pages: readonly Page[], selected: Page): void {
    if (this.#authenticationPage !== undefined) {
      this.#authenticationPage = selected;
      return;
    }
    const configuredPage = uniqueConfiguredCopilotPage(pages, this.#config.entryUrl);
    this.#authenticationPage = selected;
    this.#configuredPageBeforeAuthentication = configuredPage;
    this.#configuredUrlBeforeAuthentication = configuredPage?.url();
    this.#configuredEpochBeforeAuthentication = configuredPage === undefined
      ? 0
      : this.#navigationEpochs.get(configuredPage) ?? 0;
  }

  #markCurrentAuthenticationPagesStale(pages: readonly Page[]): void {
    for (const page of pages) {
      if (!page.isClosed() && isGenuineManualAuthenticationUrl(page.url(), this.#config)) {
        this.#staleAuthenticationPages.add(page);
      }
    }
    this.#clearAuthenticationTracking();
  }

  #clearAuthenticationTracking(): void {
    this.#authenticationPage = undefined;
    this.#configuredPageBeforeAuthentication = undefined;
    this.#configuredUrlBeforeAuthentication = undefined;
    this.#configuredEpochBeforeAuthentication = 0;
  }

  #clearFilledPagePin(): void {
    this.#filledPage = undefined;
    this.#filledUrl = undefined;
    this.#filledGroup = undefined;
    this.#filledValue = undefined;
    this.#postFillObservationSeen = false;
  }

  #configurePage(page: Page): void {
    if (this.#configuredPages.has(page)) return;
    // Construct the delegate first so its native-dialog listener is active
    // before navigation, foregrounding, or the first semantic snapshot.
    this.#delegate(page);
    this.#navigationEpochs.set(page, 0);
    page.on("framenavigated", (frame) => {
      const mainFrame = typeof page.mainFrame === "function" ? page.mainFrame() : undefined;
      if (mainFrame !== undefined && frame !== mainFrame) return;
      this.#navigationEpochs.set(page, (this.#navigationEpochs.get(page) ?? 0) + 1);
      // A popup that navigates again is no longer the stale auth surface that
      // was left behind by the prior completed handoff.
      this.#staleAuthenticationPages.delete(page);
    });
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

function uniqueConfiguredCopilotPage(
  pages: readonly Page[],
  entryUrl: string,
): Page | undefined {
  const configured = pages.filter((page) =>
    !page.isClosed() && isConfiguredCopilotUrl(page.url(), entryUrl));
  if (configured.length > 1) {
    throw new AgentError("TRANSPORT_INDETERMINATE", "Multiple approved Copilot pages are open", {
      diagnosticCode: "AMBIGUOUS_COPILOT_PAGE",
      pageCount: configured.length,
    });
  }
  return configured[0];
}

/**
 * Prefer the newest eligible configured Copilot or genuine Microsoft
 * authentication page. ContextSemanticPage adds stateful handoff tracking so a
 * returned configured chat can subsequently outrank a stale auth popup.
 */
export function selectActiveCopilotPage(
  pages: readonly Page[],
  config: CopilotPageSelectionConfig,
  preferred?: Page,
): Page {
  const openPages = pages.filter((page) => !page.isClosed());
  const configuredPage = uniqueConfiguredCopilotPage(openPages, config.entryUrl);
  const authentication = openPages.filter((page) =>
    isGenuineManualAuthenticationUrl(page.url(), config));
  const newestEligible = openPages.findLast((page) =>
    page === configuredPage || authentication.includes(page));
  if (newestEligible !== undefined) return newestEligible;

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
 * Unrelated pages on broadly allowlisted Office hosts never satisfy launch.
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

  let tracked: ContextSemanticPage;
  if (initial === undefined) {
    initial = await context.newPage();
    // Install the native-dialog listener before navigation can execute page
    // script or open a replacement authentication window.
    tracked = new ContextSemanticPage(
      context,
      config,
      initial,
      config.waits.actionMs,
    );
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
  } else {
    tracked = new ContextSemanticPage(
      context,
      config,
      initial,
      config.waits.actionMs,
    );
  }

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
 * allowlists several broad Microsoft and Office hosts for visible redirects.
 * Dedicated login hosts are authentication surfaces by definition; other hosts
 * require an authentication-shaped path or a coherent OAuth query. This rejects
 * roots and unrelated pages such as m365.cloud.microsoft/search and office.com/.
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

  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (DEDICATED_MICROSOFT_LOGIN_HOSTS.has(hostname)) return true;

  const path = normalizedPath(url.pathname).toLowerCase();
  const authPath = /(?:^|\/)(?:auth|authorize|federation|kmsi|login|oauth2?|ppsecure|sas|signin)(?:\/|$|\.)/iu.test(path);
  if (authPath) return true;

  const oauthCoreCount = [
    "client_id",
    "code_challenge",
    "redirect_uri",
    "response_type",
  ].filter((key) => url.searchParams.has(key)).length;
  const oauthSupportCount = [
    "login_hint",
    "prompt",
    "sso_reload",
    "state",
  ].filter((key) => url.searchParams.has(key)).length;
  return oauthCoreCount >= 2 || (oauthCoreCount >= 1 && oauthSupportCount >= 1);
}

/** At launch and in the outer retry loop, trust only genuine external auth URLs. */
function isReusableExternalAuthenticationUrl(
  value: string,
  config: CopilotPageSelectionConfig,
): boolean {
  return isGenuineManualAuthenticationUrl(value, config) &&
    !isApprovedUrl(value, config.approvedHosts);
}

function normalizedPath(value: string): string {
  const withoutTrailingSlash = value.replace(/\/+$/u, "");
  return withoutTrailingSlash === "" ? "/" : withoutTrailingSlash;
}

function hasAllowedPage(
  context: BrowserContext,
  config: EdgeLaunchConfig,
): boolean {
  return context.pages().some((page) =>
    !page.isClosed() && (
      isConfiguredCopilotUrl(page.url(), config.entryUrl) ||
      isGenuineManualAuthenticationUrl(page.url(), config)
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
