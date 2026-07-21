import { setTimeout as delay } from "node:timers/promises";

import type { BrowserContext, Page } from "playwright-core";

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

interface AuthenticationPageStamp {
  readonly page: Page;
  readonly url: string;
  readonly navigationEpoch: number;
  readonly dialogEpoch: number;
}

interface ConfirmedAuthenticationHandoff {
  readonly configuredPage: Page;
  readonly authenticationPages: readonly AuthenticationPageStamp[];
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
  readonly #staleAuthenticationPages = new WeakMap<Page, AuthenticationPageStamp>();
  #activePage: Page;
  #observedUrl: string | undefined;
  #observedEpoch: number | undefined;
  #filledPage: Page | undefined;
  #filledUrl: string | undefined;
  #filledEpoch: number | undefined;
  #filledGroup: LocatorGroup | undefined;
  #filledValue: string | undefined;
  #postFillObservationSeen = false;
  #authenticationPage: Page | undefined;
  #configuredPageBeforeAuthentication: Page | undefined;
  #configuredUrlBeforeAuthentication: string | undefined;
  #configuredEpochBeforeAuthentication = 0;
  #configuredComposerObservedNonActionable = false;

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
      this.#markConfirmedAuthenticationPagesStale(handoff.authenticationPages);
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
    // The first observation after composer fill is part of the same submission
    // transaction. It must inspect the exact page that received the prompt, not
    // silently adopt a replacement tab with the same conversation URL.
    if (this.#filledPage !== undefined && !this.#postFillObservationSeen) {
      const page = this.#verifiedFilledPage();
      const currentUrl = page.url();
      this.#activePage = page;
      this.#observedUrl = currentUrl;
      this.#observedEpoch = this.#navigationEpochs.get(page) ?? 0;
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
  public async fill(
    group: LocatorGroup,
    value: string,
    guard: SemanticActionGuard,
  ): Promise<void> {
    const page = this.#verifiedObservedPage();
    const expectedUrl = this.#observedUrl!;
    const expectedEpoch = this.#observedEpoch!;
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
      (this.#navigationEpochs.get(page) ?? 0) !== expectedEpoch
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
    this.#filledGroup = group;
    this.#filledValue = value;
    this.#postFillObservationSeen = false;
  }

  /** Send activation requires a completed post-fill observation on the same page. */
  public async click(group: LocatorGroup, guard: SemanticActionGuard): Promise<void> {
    const page = await this.#activationPageOrThrow();
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
      await this.#delegate(page).click(group, dispatchGuard);
    } finally {
      this.#clearFilledPagePin();
    }
  }

  /** Enter activation follows the same post-fill page-identity requirements. */
  public async press(
    group: LocatorGroup,
    key: "Enter",
    guard: SemanticActionGuard,
  ): Promise<void> {
    const page = await this.#activationPageOrThrow();
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
      await this.#delegate(page).press(group, key, dispatchGuard);
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
      currentUrl !== this.#observedUrl ||
      (this.#navigationEpochs.get(this.#activePage) ?? 0) !== this.#observedEpoch
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
    const filledEpoch = this.#filledEpoch;
    if (
      filledPage === undefined ||
      filledUrl === undefined ||
      filledEpoch === undefined
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
      filledPage.url() !== filledUrl ||
      (this.#navigationEpochs.get(filledPage) ?? 0) !== filledEpoch
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
    const selectablePages = pages.filter((page) =>
      !this.#isStaleAuthenticationPage(page) ||
      !isGenuineManualAuthenticationUrl(page.url(), this.#config)
    );
    return selectActiveCopilotPage(selectablePages, this.#config, preferred);
  }

  async #returnedConfiguredPage(
    pages: readonly Page[],
  ): Promise<ConfirmedAuthenticationHandoff | undefined> {
    const authenticationPage = this.#authenticationPage;
    if (authenticationPage === undefined) return undefined;

    const configuredPage = uniqueConfiguredCopilotPage(pages, this.#config.entryUrl);
    if (configuredPage === undefined) return undefined;

    const authenticationUrl = authenticationPage.url();
    const authenticationEpoch = this.#navigationEpochs.get(authenticationPage) ?? 0;
    if (
      !authenticationPage.isClosed() &&
      pages.includes(authenticationPage) &&
      await this.#hasBlockingAuthenticationDialog(authenticationPage)
    ) {
      return undefined;
    }

    if (authenticationPage.isClosed() || !pages.includes(authenticationPage)) {
      const authenticationPages = await this.#confirmedAuthenticationHandoff(
        configuredPage,
        authenticationPage,
        authenticationUrl,
        authenticationEpoch,
      );
      return authenticationPages === undefined
        ? undefined
        : { configuredPage, authenticationPages };
    }

    const priorConfiguredPage = this.#configuredPageBeforeAuthentication;
    let handoffCandidate: Page | undefined;
    if (priorConfiguredPage === undefined || configuredPage !== priorConfiguredPage) {
      handoffCandidate = configuredPage;
    } else if (configuredPage.url() !== this.#configuredUrlBeforeAuthentication) {
      handoffCandidate = configuredPage;
    } else {
      const currentEpoch = this.#navigationEpochs.get(configuredPage) ?? 0;
      if (currentEpoch > this.#configuredEpochBeforeAuthentication) {
        handoffCandidate = configuredPage;
      }
    }

    if (handoffCandidate !== undefined) {
      const authenticationPages = await this.#confirmedAuthenticationHandoff(
        handoffCandidate,
        authenticationPage,
        authenticationUrl,
        authenticationEpoch,
      );
      return authenticationPages === undefined
        ? undefined
        : { configuredPage: handoffCandidate, authenticationPages };
    }

    // Microsoft can complete popup authentication by hydrating the original
    // chat in place, without changing its Page, URL, or main-frame navigation
    // epoch. Probe only the configured contract's composer, read-only, and
    // prefer the chat once that exact action surface becomes enabled. The full
    // classifier still verifies identity, protection, and every other trust
    // gate before any prompt content can be disclosed.
    const composer = this.#config.uiContract?.groups.composer;
    if (composer === undefined) return undefined;
    const actionable = await this.#composerActionable(configuredPage, composer);
    if (actionable === false) {
      this.#configuredComposerObservedNonActionable = true;
      return undefined;
    }
    if (actionable !== true || !this.#configuredComposerObservedNonActionable) {
      return undefined;
    }
    const authenticationPages = await this.#confirmedAuthenticationHandoff(
      configuredPage,
      authenticationPage,
      authenticationUrl,
      authenticationEpoch,
    );
    return authenticationPages === undefined
      ? undefined
      : { configuredPage, authenticationPages };
  }

  async #trackAuthenticationSelection(pages: readonly Page[], selected: Page): Promise<void> {
    if (this.#authenticationPage === selected) {
      return;
    }
    const configuredPage = uniqueConfiguredCopilotPage(pages, this.#config.entryUrl);
    this.#authenticationPage = selected;
    this.#configuredPageBeforeAuthentication = configuredPage;
    this.#configuredUrlBeforeAuthentication = configuredPage?.url();
    this.#configuredEpochBeforeAuthentication = configuredPage === undefined
      ? 0
      : this.#navigationEpochs.get(configuredPage) ?? 0;
    await this.#captureConfiguredComposerBaseline(pages);
  }

  async #captureConfiguredComposerBaseline(pages: readonly Page[]): Promise<void> {
    this.#configuredComposerObservedNonActionable = false;
    const configuredPage = this.#configuredPageBeforeAuthentication;
    const composer = this.#config.uiContract?.groups.composer;
    if (
      configuredPage === undefined ||
      composer === undefined ||
      configuredPage.isClosed() ||
      !pages.includes(configuredPage)
    ) {
      return;
    }
    const actionable = await this.#composerActionable(configuredPage, composer);
    this.#configuredComposerObservedNonActionable = actionable === false;
  }

  async #composerActionable(
    page: Page,
    composer: LocatorGroup,
  ): Promise<boolean | undefined> {
    try {
      const snapshot = await this.#delegate(page).snapshot(composer);
      return snapshot.matchedCandidates >= composer.minimumCandidateMatches &&
        snapshot.enabledElements > 0;
    } catch {
      return undefined;
    }
  }

  async #hasBlockingAuthenticationDialog(page: Page): Promise<boolean> {
    const modal = this.#config.uiContract?.groups.modal;
    if (modal === undefined) return false;
    try {
      const snapshot = await this.#delegate(page).snapshot(modal);
      return snapshot.matchedCandidates >= modal.minimumCandidateMatches &&
        snapshot.visibleElements > 0;
    } catch {
      // A failed read does not prove that an authentication surface is safe to
      // retire, so keep it selected.
      return true;
    }
  }

  async #confirmedAuthenticationHandoff(
    configuredPage: Page,
    authenticationPage: Page,
    authenticationUrl: string,
    authenticationEpoch: number,
  ): Promise<readonly AuthenticationPageStamp[] | undefined> {
    const dialogEpoch = this.#delegate(authenticationPage).nativeDialogEpoch();
    if (
      !authenticationPage.isClosed() &&
      await this.#hasBlockingAuthenticationDialog(authenticationPage)
    ) {
      return undefined;
    }
    if (this.#delegate(authenticationPage).nativeDialogEpoch() !== dialogEpoch) {
      return undefined;
    }

    const pages = this.#context.pages();
    if (uniqueConfiguredCopilotPage(pages, this.#config.entryUrl) !== configuredPage) {
      return undefined;
    }
    if (authenticationPage.isClosed() || !pages.includes(authenticationPage)) {
      return this.#selectCurrentPage(pages, configuredPage) === configuredPage
        ? this.#authenticationPageStamps(pages)
        : undefined;
    }
    if (
      this.#authenticationPage !== authenticationPage ||
      authenticationPage.url() !== authenticationUrl ||
      (this.#navigationEpochs.get(authenticationPage) ?? 0) !== authenticationEpoch
    ) {
      return undefined;
    }
    // A newer auth popup appearing during either read must win the next sample.
    return this.#selectCurrentPage(pages, authenticationPage) === authenticationPage
      ? this.#authenticationPageStamps(pages)
      : undefined;
  }

  #authenticationPageStamps(pages: readonly Page[]): readonly AuthenticationPageStamp[] {
    return pages
      .filter((page) =>
        !page.isClosed() &&
        !this.#isStaleAuthenticationPage(page) &&
        isGenuineManualAuthenticationUrl(page.url(), this.#config))
      .map((page) => ({
        page,
        url: page.url(),
        navigationEpoch: this.#navigationEpochs.get(page) ?? 0,
        dialogEpoch: this.#delegate(page).nativeDialogEpoch(),
      }));
  }

  #handoffStillCurrent(
    handoff: ConfirmedAuthenticationHandoff,
    pages: readonly Page[],
  ): boolean {
    if (uniqueConfiguredCopilotPage(pages, this.#config.entryUrl) !== handoff.configuredPage) {
      return false;
    }
    const current = this.#authenticationPageStamps(pages);
    return current.length === handoff.authenticationPages.length &&
      handoff.authenticationPages.every((confirmed) =>
        current.some((candidate) =>
          candidate.page === confirmed.page &&
          candidate.url === confirmed.url &&
          candidate.navigationEpoch === confirmed.navigationEpoch &&
          candidate.dialogEpoch === confirmed.dialogEpoch));
  }

  #markConfirmedAuthenticationPagesStale(
    authenticationPages: readonly AuthenticationPageStamp[],
  ): void {
    for (const stamp of authenticationPages) {
      this.#staleAuthenticationPages.set(stamp.page, stamp);
    }
    this.#clearAuthenticationTracking();
  }

  #isStaleAuthenticationPage(page: Page): boolean {
    const stamp = this.#staleAuthenticationPages.get(page);
    if (stamp === undefined) return false;
    const unchanged = !page.isClosed() &&
      page.url() === stamp.url &&
      (this.#navigationEpochs.get(page) ?? 0) === stamp.navigationEpoch &&
      this.#delegate(page).nativeDialogEpoch() === stamp.dialogEpoch;
    if (!unchanged) this.#staleAuthenticationPages.delete(page);
    return unchanged;
  }

  #clearAuthenticationTracking(): void {
    this.#authenticationPage = undefined;
    this.#configuredPageBeforeAuthentication = undefined;
    this.#configuredUrlBeforeAuthentication = undefined;
    this.#configuredEpochBeforeAuthentication = 0;
    this.#configuredComposerObservedNonActionable = false;
  }

  #clearFilledPagePin(): void {
    this.#filledPage = undefined;
    this.#filledUrl = undefined;
    this.#filledEpoch = undefined;
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
        // A popup that navigates again is no longer the stale auth surface that
        // was left behind by the prior completed handoff.
        this.#staleAuthenticationPages.delete(page);
      });
    }
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
