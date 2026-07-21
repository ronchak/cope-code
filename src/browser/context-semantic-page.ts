import { setTimeout as delay } from "node:timers/promises";

import type { Browser, BrowserContext, Page } from "playwright-core";

import { AgentError } from "../shared/errors.js";
import {
  isApprovedUrl,
  type ApprovedHost,
  type EdgeLaunchConfig,
} from "./config.js";
import type {
  CopilotUiContract,
  GroupSnapshot,
  LocatorGroup,
  SemanticActionGuard,
  SemanticPage,
} from "./contracts.js";
import { PlaywrightSemanticPage } from "./playwright-semantic-page.js";

export interface CopilotPageSelectionConfig {
  readonly entryUrl: string;
  readonly approvedHosts: readonly ApprovedHost[];
  readonly manualAuthenticationHosts?: readonly ApprovedHost[];
  readonly uiContract?: CopilotUiContract;
}

interface ConfirmedAuthenticationHandoff {
  readonly configuredPage: Page;
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
  readonly #browser: Browser | null;
  readonly #config: CopilotPageSelectionConfig;
  readonly #actionMs: number;
  readonly #delegates = new WeakMap<Page, PlaywrightSemanticPage>();
  readonly #configuredPages = new WeakSet<Page>();
  readonly #navigationEpochs = new WeakMap<Page, number>();
  #nativeDialogEpoch = 0;
  #activePage: Page;
  #observedUrl: string | undefined;
  #observedEpoch: number | undefined;
  #observedDialogEpoch: number | undefined;
  #filledPage: Page | undefined;
  #filledUrl: string | undefined;
  #filledEpoch: number | undefined;
  #filledDialogEpoch: number | undefined;
  #filledGroup: LocatorGroup | undefined;
  #filledValue: string | undefined;
  #postFillObservationSeen = false;
  #authenticationPage: Page | undefined;
  #operationTermination: Promise<void> | undefined;
  #operationTimedOut = false;
  readonly #operationTimeoutController = new AbortController();

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
    // Capture the owner once. The production persistent-context launcher
    // verifies that this is non-null before any page can become actionable.
    this.#browser = typeof context.browser === "function" ? context.browser() : null;
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
    this.#assertOperationAvailable();
    if (this.#nativeDialogEpoch > 0) return this.#activePage;
    let pages = this.#context.pages();
    const handoff = await this.#returnedConfiguredPage(pages);
    // Page discovery and the in-place readiness probe can yield. Refresh the
    // context before selecting or retiring any authentication surface.
    pages = this.#context.pages();
    const returnedConfiguredPage = handoff !== undefined &&
        this.#handoffStillCurrent(handoff, pages)
      ? handoff.configuredPage
      : undefined;
    if (handoff !== undefined && returnedConfiguredPage !== undefined) {
      this.#clearAuthenticationTracking();
    }

    const selected = returnedConfiguredPage ?? this.#selectCurrentPage(pages);

    if (isGenuineManualAuthenticationUrl(selected.url(), this.#config)) {
      await this.#trackAuthenticationSelection(pages, selected);
    } else if (isConfiguredCopilotUrl(selected.url(), this.#config.entryUrl)) {
      this.#clearAuthenticationTracking();
    }

    const changed = selected !== this.#activePage;
    this.#activePage = selected;
    if (changed) {
      this.#observedUrl = undefined;
      this.#observedEpoch = undefined;
      this.#observedDialogEpoch = undefined;
    }
    this.#configurePage(selected);
    if (force || changed) await selected.bringToFront().catch(() => undefined);
    return selected;
  }

  /** External Microsoft authentication hosts retain the long manual window. */
  public isManualAuthenticationRedirect(): boolean {
    return isReusableExternalAuthenticationUrl(this.#activePage.url(), this.#config);
  }

  public async currentUrl(): Promise<string> {
    this.#assertOperationAvailable();
    if (this.#nativeDialogEpoch > 0) {
      const currentUrl = this.#activePage.url();
      this.#observedUrl = currentUrl;
      this.#observedEpoch = this.#navigationEpochs.get(this.#activePage) ?? 0;
      this.#observedDialogEpoch = this.#nativeDialogEpoch;
      return currentUrl;
    }
    // The first observation after composer fill is part of the same submission
    // transaction. It must inspect the exact page that received the prompt, not
    // silently adopt a replacement tab with the same conversation URL.
    if (this.#filledPage !== undefined && !this.#postFillObservationSeen) {
      const page = this.#verifiedFilledPage();
      const currentUrl = page.url();
      this.#activePage = page;
      this.#observedUrl = currentUrl;
      this.#observedEpoch = this.#navigationEpochs.get(page) ?? 0;
      this.#observedDialogEpoch = this.#nativeDialogEpoch;
      this.#postFillObservationSeen = true;
      return currentUrl;
    }

    // A later observation means the prior filled draft was not activated. Drop
    // the transaction pin so an explicit retry can inspect the current context.
    if (this.#filledPage !== undefined) this.#clearFilledPagePin();

    const page = await this.focusActivePage();
    const currentUrl = page.url();
    this.#observedUrl = currentUrl;
    this.#observedEpoch = this.#navigationEpochs.get(page) ?? 0;
    this.#observedDialogEpoch = this.#nativeDialogEpoch;
    return currentUrl;
  }

  public async snapshot(group: LocatorGroup): Promise<GroupSnapshot> {
    this.#assertOperationAvailable();
    if (this.#nativeDialogEpoch > 0) return nativeDialogSnapshot(group);
    return this.#delegate(this.#activePage).snapshot(group);
  }

  /**
   * Fill is permitted only on the exact page and URL used by the trusted
   * observation. A successful fill starts a transaction pin that remains active
   * through the second trust observation and send activation.
   */
  public async fill(
    group: LocatorGroup,
    value: string,
    guard: SemanticActionGuard,
  ): Promise<void> {
    this.#assertOperationAvailable();
    const page = this.#verifiedObservedPage();
    const expectedUrl = this.#observedUrl!;
    const expectedEpoch = this.#observedEpoch!;
    const expectedDialogEpoch = this.#observedDialogEpoch!;
    const dispatchGuard = this.#composeDispatchGuard(guard, () => {
      if (this.#verifiedObservedPage() !== page) {
        throw new AgentError(
          "TRANSPORT_INDETERMINATE",
          "The observed Copilot page changed before composer dispatch",
          { diagnosticCode: "ACTIVE_PAGE_CHANGED_BEFORE_ACTION" },
        );
      }
    });
    await this.#delegate(page).fill(group, value, dispatchGuard);
    if (
      page.isClosed() ||
      page.url() !== expectedUrl ||
      (this.#navigationEpochs.get(page) ?? 0) !== expectedEpoch ||
      this.#nativeDialogEpoch !== expectedDialogEpoch
    ) {
      this.#clearFilledPagePin();
      throw new AgentError(
        "TRANSPORT_INDETERMINATE",
        "The observed Copilot page changed while the composer was being filled",
        { diagnosticCode: "ACTIVE_PAGE_CHANGED_DURING_FILL" },
      );
    }
    this.#filledPage = page;
    this.#filledUrl = expectedUrl;
    this.#filledEpoch = expectedEpoch;
    this.#filledDialogEpoch = expectedDialogEpoch;
    this.#filledGroup = group;
    this.#filledValue = value;
    this.#postFillObservationSeen = false;
  }

  /** Send activation requires a completed post-fill observation on the same page. */
  public async click(group: LocatorGroup, guard: SemanticActionGuard): Promise<void> {
    this.#assertOperationAvailable();
    // Composer re-verification and send dispatch are one semantic action. Give
    // both delegate operations the same absolute deadline rather than allowing
    // each to consume a fresh actionMs window.
    const deadline = performance.now() + this.#actionMs;
    const page = await this.#activationPageOrThrow(deadline);
    const dispatchGuard = this.#composeDispatchGuard(guard, () => {
      if (this.#verifiedFilledPage() !== page) {
        throw new AgentError(
          "TRANSPORT_INDETERMINATE",
          "The filled Copilot page changed before activation dispatch",
          { diagnosticCode: "ACTIVE_PAGE_CHANGED_AFTER_FILL" },
        );
      }
    });
    try {
      await this.#delegate(page).click(group, dispatchGuard, deadline);
      this.#verifiedFilledPage();
    } finally {
      this.#clearFilledPagePin();
    }
  }

  /**
   * Every failure before delegating click or Enter is conclusively
   * pre-dispatch. Preserve that fact for the adapter so a guarded failure
   * remains safely retryable instead of being treated as indeterminate.
   */
  async #activationPageOrThrow(deadline: number): Promise<Page> {
    try {
      return await this.#verifiedActivationPage(deadline);
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

  #composeDispatchGuard(
    guard: SemanticActionGuard,
    assertPinnedState: () => void,
  ): SemanticActionGuard {
    return () => {
      try {
        guard();
        assertPinnedState();
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
          "The Copilot dispatch guard blocked the browser action",
          { diagnosticCode, dispatchAttempted: false },
          { cause: error },
        );
      }
    };
  }

  #verifiedObservedPage(): Page {
    const selected = this.#selectCurrentPage(
      this.#context.pages(),
      this.#activePage,
    );
    const currentUrl = this.#activePage.url();
    if (
      selected !== this.#activePage ||
      this.#activePage.isClosed() ||
      this.#observedUrl === undefined ||
      this.#observedEpoch === undefined ||
      this.#observedDialogEpoch === undefined ||
      this.#observedDialogEpoch !== 0 ||
      currentUrl !== this.#observedUrl ||
      (this.#navigationEpochs.get(this.#activePage) ?? 0) !== this.#observedEpoch ||
      this.#nativeDialogEpoch !== this.#observedDialogEpoch
    ) {
      throw new AgentError(
        "TRANSPORT_INDETERMINATE",
        "The observed Copilot page changed before the browser action",
        {
          diagnosticCode: "ACTIVE_PAGE_CHANGED_BEFORE_ACTION",
          dispatchAttempted: false,
        },
      );
    }
    return this.#activePage;
  }

  async #verifiedActivationPage(deadline: number): Promise<Page> {
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
    const composer = await this.#delegate(page).snapshot(this.#filledGroup, deadline);
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
    const filledEpoch = this.#filledEpoch;
    const filledDialogEpoch = this.#filledDialogEpoch;
    if (
      filledPage === undefined ||
      filledUrl === undefined ||
      filledEpoch === undefined ||
      filledDialogEpoch === undefined
    ) {
      throw new AgentError(
        "TRANSPORT_INDETERMINATE",
        "The filled Copilot page transaction is unavailable",
        { diagnosticCode: "FILLED_PAGE_TRANSACTION_MISSING" },
      );
    }

    let selected: Page;
    try {
      selected = this.#selectCurrentPage(
        this.#context.pages(),
        filledPage,
      );
    } catch (error) {
      this.#clearFilledPagePin();
      throw error;
    }

    if (
      selected !== filledPage ||
      filledPage.isClosed() ||
      filledDialogEpoch !== 0 ||
      filledPage.url() !== filledUrl ||
      (this.#navigationEpochs.get(filledPage) ?? 0) !== filledEpoch ||
      this.#nativeDialogEpoch !== filledDialogEpoch
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

  #selectCurrentPage(
    pages: readonly Page[],
    preferred: Page = this.#activePage,
  ): Page {
    return selectActiveCopilotPage(pages, this.#config, preferred);
  }

  async #returnedConfiguredPage(
    pages: readonly Page[],
  ): Promise<ConfirmedAuthenticationHandoff | undefined> {
    const authenticationPage = this.#authenticationPage;
    if (authenticationPage === undefined) return undefined;

    // An open authentication page can change DOM state without any observable
    // navigation event. Never suppress it: the operator or Microsoft must close
    // the popup before the configured chat can regain consequential ownership.
    if (hasGenuineAuthenticationPage(pages, this.#config)) {
      return undefined;
    }

    const configuredPage = uniqueConfiguredCopilotPage(pages, this.#config.entryUrl);
    if (configuredPage === undefined) return undefined;

    const refreshedPages = this.#context.pages();
    if (hasGenuineAuthenticationPage(refreshedPages, this.#config)) return undefined;
    if (uniqueConfiguredCopilotPage(refreshedPages, this.#config.entryUrl) !== configuredPage) {
      return undefined;
    }
    try {
      return this.#selectCurrentPage(refreshedPages, configuredPage) === configuredPage
        ? { configuredPage }
        : undefined;
    } catch {
      return undefined;
    }
  }

  async #trackAuthenticationSelection(_pages: readonly Page[], selected: Page): Promise<void> {
    this.#authenticationPage = selected;
  }

  #handoffStillCurrent(
    handoff: ConfirmedAuthenticationHandoff,
    pages: readonly Page[],
  ): boolean {
    if (hasGenuineAuthenticationPage(pages, this.#config)) return false;
    if (uniqueConfiguredCopilotPage(pages, this.#config.entryUrl) !== handoff.configuredPage) {
      return false;
    }
    try {
      return this.#selectCurrentPage(pages, handoff.configuredPage) === handoff.configuredPage;
    } catch {
      return false;
    }
  }

  #clearAuthenticationTracking(): void {
    this.#authenticationPage = undefined;
  }

  #clearFilledPagePin(): void {
    this.#filledPage = undefined;
    this.#filledUrl = undefined;
    this.#filledEpoch = undefined;
    this.#filledDialogEpoch = undefined;
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
    if (typeof page.on === "function") {
      page.on("framenavigated", (frame) => {
        const mainFrame = typeof page.mainFrame === "function" ? page.mainFrame() : undefined;
        if (mainFrame !== undefined && frame !== mainFrame) return;
        this.#navigationEpochs.set(page, (this.#navigationEpochs.get(page) ?? 0) + 1);
      });
    }
    page.setDefaultTimeout(this.#actionMs);
    page.setDefaultNavigationTimeout(this.#actionMs);
    this.#configuredPages.add(page);
  }

  #delegate(page: Page): PlaywrightSemanticPage {
    const existing = this.#delegates.get(page);
    if (existing !== undefined) return existing;
    const created = new PlaywrightSemanticPage(
      page,
      () => {
        this.#nativeDialogEpoch += 1;
        // A dialog on any page can race a queued action on another target. Abort
        // the entire dedicated browser process first: target/context close
        // commands do not preempt an evaluate already queued on another page.
        if (this.#browser !== null && typeof this.#browser.close === "function") {
          void this.#browser.close().catch(() => undefined);
          return true;
        }
        if (typeof this.#activePage.close === "function") {
          void this.#activePage.close({ runBeforeUnload: false }).catch(() => undefined);
        }
        if (typeof this.#context.close === "function") {
          void this.#context.close().catch(() => undefined);
        }
        // Without an owning Browser, also let the delegate close the page that
        // raised the dialog. Mock/embedded contexts may not implement a context
        // close that actually tears down every target.
        return false;
      },
      this.#actionMs,
      () => this.#terminateTimedOutOperation(page),
      this.#operationTimeoutController.signal,
    );
    this.#delegates.set(page, created);
    return created;
  }

  #terminateTimedOutOperation(page: Page): Promise<void> {
    // Revoke the entire context synchronously before starting teardown. A
    // Browser.close() promise is allowed to stall, but no delegate or later
    // adapter retry may enter this session after the diagnostic is returned.
    this.#operationTimedOut = true;
    this.#operationTimeoutController.abort();
    // observeCopilotPage launches all signal snapshots concurrently. Cache one
    // teardown so simultaneous deadlines cannot race repeated Browser.close()
    // calls or let one delegate return before the shared owner is gone.
    this.#operationTermination ??= (async () => {
      // Default Playwright timeouts do not cover locator.count() or
      // ElementHandle.evaluate(). Terminate the captured process owner so a
      // timed-out renderer call cannot later disclose or activate anything.
      if (this.#browser !== null && typeof this.#browser.close === "function") {
        await this.#browser.close();
        return;
      }
      await Promise.all([
        page.close({ runBeforeUnload: false }).catch(() => undefined),
        this.#context.close().catch(() => undefined),
      ]);
    })();
    return this.#operationTermination;
  }

  #assertOperationAvailable(): void {
    if (!this.#operationTimedOut) return;
    throw new AgentError(
      "TRANSPORT_INDETERMINATE",
      "A browser operation timeout revoked the dedicated session",
      {
        diagnosticCode: "BROWSER_OPERATION_TIMEOUT",
        dispatchAttempted: false,
      },
    );
  }
}

function nativeDialogSnapshot(group: LocatorGroup): GroupSnapshot {
  const elements = group.signal === "modal"
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

function hasGenuineAuthenticationPage(
  pages: readonly Page[],
  config: CopilotPageSelectionConfig,
): boolean {
  return pages.some((page) =>
    !page.isClosed() && isGenuineManualAuthenticationUrl(page.url(), config));
}

/**
 * Any open genuine Microsoft authentication page outranks the configured chat.
 * DOM-only auth state changes have no synchronous epoch, so safe ownership can
 * return to chat only after the authentication page closes or leaves auth.
 */
export function selectActiveCopilotPage(
  pages: readonly Page[],
  config: CopilotPageSelectionConfig,
  preferred?: Page,
): Page {
  const openPages = pages.filter((page) => !page.isClosed());
  const authentication = openPages.filter((page) =>
    isGenuineManualAuthenticationUrl(page.url(), config));
  const newestAuthentication = authentication.at(-1);
  if (newestAuthentication !== undefined) return newestAuthentication;
  const configuredPage = uniqueConfiguredCopilotPage(openPages, config.entryUrl);
  if (configuredPage !== undefined) return configuredPage;

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
  const authentication = existing.filter((page) =>
    !page.isClosed() && isReusableExternalAuthenticationUrl(page.url(), config));
  let initial = authentication.at(-1);

  const approved = existing.filter((page) =>
    !page.isClosed() && isConfiguredCopilotUrl(page.url(), config.entryUrl));
  if (initial === undefined && approved.length > 1) {
    throw new AgentError("TRANSPORT_INDETERMINATE", "Multiple approved Copilot pages are open", {
      diagnosticCode: "AMBIGUOUS_COPILOT_PAGE",
      pageCount: approved.length,
    });
  }
  initial ??= approved[0];

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
