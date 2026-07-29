import { randomUUID } from "node:crypto";

import type { ElementHandle, Locator, Page } from "playwright-core";

import {
  DEFAULT_MAX_PROTOCOL_INPUT_BYTES,
  extractCbaEnvelope,
} from "../protocol/parser.js";
import { AgentError } from "../shared/errors.js";
import {
  RESPONSE_CAPTURE_CONTRACT_VERSION,
  toRegExp,
  type ElementSnapshot,
  type GroupSnapshot,
  type LocatorGroup,
  type ResponseCaptureEvidence,
  type SemanticActionGuard,
  type SemanticLocator,
  type SemanticObservationCompletion,
  type SemanticPage,
  type TextPattern,
} from "./contracts.js";

export interface BrowserOperationTimeoutOrigin {
  readonly semanticGroup: string;
  readonly semanticOperation: string;
  readonly locatorKind?: SemanticLocator["kind"];
  readonly locatorCandidateIndex?: number;
  readonly elementIndex?: number;
  readonly pendingSemanticOperations?: readonly BrowserOperationTimeoutPoint[];
}

interface BrowserOperationTimeoutPoint {
  readonly operation: string;
  readonly locatorKind?: SemanticLocator["kind"];
  readonly locatorCandidateIndex?: number;
  readonly elementIndex?: number;
}

const RESPONSE_PROTOCOL_DESCRIPTORS = [
  {
    version: "cba-agent/1",
    banner: "cba-agent/1 isn’t fully supported. Syntax highlighting is based on Plain Text.",
  },
  {
    version: "cba/1",
    banner: "cba/1 isn’t fully supported. Syntax highlighting is based on Plain Text.",
  },
] as const;

interface PageProtocolBlockCapture {
  readonly version: string;
  readonly bannerContract: "supported" | "unsupported_version" | "changed_supported_banner";
  readonly code: string;
  readonly editorCount: number;
  readonly bannerCount: number;
  readonly lineCount: number;
  readonly lineIndicesValid: boolean;
  readonly contentBytes: number;
  readonly contentBoundExceeded: boolean;
}

interface PageResponseCapture {
  readonly renderedText: string;
  readonly codeBlockCount: number;
  readonly editorCount: number;
  readonly bannerCount: number;
  readonly unownedProtocolFenceCount: number;
  /** Exact v0.1.8 DOM-order reconstruction output, before joining. */
  readonly legacyProtocolBlocks: readonly string[];
  readonly protocolBlocks: readonly PageProtocolBlockCapture[];
}

interface NormalizedResponseCapture {
  readonly text: string;
  readonly correlationText: string;
  readonly evidence: ResponseCaptureEvidence;
}

/** The only module that translates the UI contract into Playwright locators. */
export class PlaywrightSemanticPage implements SemanticPage {
  readonly #page: Page;
  readonly #actionMs: number;
  readonly #onOperationTimeout:
    ((origin: BrowserOperationTimeoutOrigin) => Promise<void>) | undefined;
  readonly #operationTimeoutSignal: AbortSignal | undefined;
  readonly #operationTimeoutOrigin: (() => BrowserOperationTimeoutOrigin | undefined) | undefined;
  #operationTermination: Promise<void> | undefined;
  #operationTimedOut = false;
  #nativeDialogDetected = false;
  #nativeDialogEpoch = 0;
  #observationDeadline: number | undefined;

  public constructor(
    page: Page,
    onNativeDialog?: () => boolean | void,
    actionMs = 15_000,
    onOperationTimeout?: (origin: BrowserOperationTimeoutOrigin) => Promise<void>,
    operationTimeoutSignal?: AbortSignal,
    operationTimeoutOrigin?: () => BrowserOperationTimeoutOrigin | undefined,
  ) {
    if (!Number.isSafeInteger(actionMs) || actionMs <= 0) {
      throw new TypeError("Playwright operation timeout must be a positive integer");
    }
    this.#page = page;
    this.#actionMs = actionMs;
    this.#onOperationTimeout = onOperationTimeout;
    this.#operationTimeoutSignal = operationTimeoutSignal;
    this.#operationTimeoutOrigin = operationTimeoutOrigin;
    // Do not accept, dismiss, inspect, or automate unknown browser dialogs.
    // Leaving the dialog visible blocks consequential actions and the sticky
    // signal makes the adapter fail closed until the session is restarted.
    if (typeof page.on === "function") {
      page.on("dialog", () => {
        this.#nativeDialogDetected = true;
        this.#nativeDialogEpoch += 1;
        const teardownOwned = onNativeDialog?.() === true;
        // A native dialog can queue an already-authorized evaluate call behind
        // the browser modal. Tear down the target immediately so dismissing the
        // dialog cannot release a stale fill or click into the page.
        if (!teardownOwned && typeof page.close === "function") {
          void page.close({ runBeforeUnload: false }).catch(() => undefined);
        }
      });
    }
  }

  /** Monotonic evidence used to pin cross-page handoff decisions. */
  public nativeDialogEpoch(): number {
    return this.#nativeDialogEpoch;
  }

  public async currentUrl(): Promise<string> {
    this.#observationDeadline = performance.now() + this.#actionMs;
    return this.#page.url();
  }

  public async completeObservation(): Promise<SemanticObservationCompletion> {
    try {
      return { nativeDialogDetected: this.#nativeDialogDetected };
    } finally {
      this.#observationDeadline = undefined;
    }
  }

  public async bringToFront(
    deadline = performance.now() + this.#actionMs,
  ): Promise<void> {
    const trace = operationTrace("page", "page.bringToFront");
    await this.#runBounded(async (assertWithinDeadline) => {
      // Page.bringToFront() has no Playwright timeout option. Check the shared
      // absolute deadline before issuing it, then let #runBounded race the raw
      // protocol promise against the Context-wide terminal timeout signal.
      assertWithinDeadline();
      await traceOperation(trace, "page", { operation: "page.bringToFront" }, () =>
        this.#page.bringToFront());
    }, () => false, deadline, trace);
  }

  public async snapshot(
    group: LocatorGroup,
    deadline = this.#observationDeadline ?? performance.now() + this.#actionMs,
  ): Promise<GroupSnapshot> {
    const trace = operationTrace(group.signal, "snapshot.aggregate");
    return this.#runBounded(async () => {
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
        group.candidates.map(async (candidate, candidateIndex) =>
          this.#snapshotCandidate(candidate, candidateIndex, group, trace)),
      );
      const matched = candidateSnapshots.filter((entry) => entry.length > 0);
      const richest = matched.reduce<readonly ElementSnapshot[]>(
        (best, current) => (current.length > best.length ? current : best),
        [],
      );
      const firstActionable = matched.find((entry) =>
        entry.some((element) => element.visible && element.enabled));
      // Composer and send snapshots must expose the same first actionable
      // candidate that fill/click will use. Other content-bearing groups
      // retain the richest successful candidate to avoid duplicate text capture.
      const elements =
        (group.signal === "composer" || group.signal === "send") && firstActionable !== undefined
          ? firstActionable
          : richest;
      const allElements = matched.flat();
      return {
        signal: group.signal,
        matchedCandidates: matched.length,
        visibleElements: allElements.filter((element) => element.visible).length,
        enabledElements: allElements.filter((element) => element.visible && element.enabled).length,
        elements,
      };
    }, () => false, deadline, trace);
  }

  public async fill(
    group: LocatorGroup,
    value: string,
    guard: SemanticActionGuard,
    deadline = performance.now() + this.#actionMs,
  ): Promise<void> {
    let dispatchAttempted = false;
    const trace = operationTrace(group.signal, "actionable-locator.search");
    await this.#runBounded(async (assertWithinDeadline) => {
      this.#assertNoNativeDialog();
      const element = await this.#firstActionableOrThrow(group, trace);
      this.#assertNoNativeDialog();
      guard();
      this.#assertNoNativeDialog();
      // A timeout can fire while locator discovery is resolving during owner
      // teardown. Check the sticky deadline synchronously at the last possible
      // boundary so no late evaluate can follow a timed-out discovery.
      assertWithinDeadline();
      dispatchAttempted = true;
      await traceOperation(trace, "dispatch", { operation: "element.evaluate.fill" }, () =>
        element.evaluate((node, nextValue) => {
      if (!(node instanceof HTMLElement) || !node.isConnected) {
        throw new Error("The bound composer element is no longer connected");
      }
      const style = node.ownerDocument.defaultView?.getComputedStyle(node);
      if (
        style === undefined ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        !Array.from(node.getClientRects()).some(
          (rectangle) => rectangle.width > 0 && rectangle.height > 0,
        )
      ) {
        throw new Error("The bound composer element is no longer visible");
      }
      let composedAncestor: Element | null = node;
      while (composedAncestor !== null) {
        if (composedAncestor.getAttribute("aria-disabled")?.trim().toLowerCase() === "true") {
          throw new Error("The bound composer is inside a disabled control");
        }
        if (composedAncestor.parentElement !== null) {
          composedAncestor = composedAncestor.parentElement;
          continue;
        }
        const root = composedAncestor.getRootNode();
        composedAncestor = root instanceof ShadowRoot ? root.host : null;
      }
      if (
        node.matches(":disabled") ||
        node.getAttribute("aria-readonly")?.trim().toLowerCase() === "true"
      ) {
        throw new Error("The bound composer is no longer editable");
      }
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
        if (node.disabled || node.readOnly) {
          throw new Error("The bound composer is no longer editable");
        }
        if (
          node instanceof HTMLInputElement &&
          ![
            "",
            "date",
            "datetime-local",
            "email",
            "month",
            "number",
            "password",
            "search",
            "tel",
            "text",
            "time",
            "url",
            "week",
          ].includes(node.type.toLowerCase())
        ) {
          throw new Error("The bound composer input type is not fillable");
        }
        const prototype = node instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (valueSetter === undefined) {
          throw new Error("The bound composer has no native value setter");
        }
        valueSetter.call(node, nextValue);
      } else if (
        node.isContentEditable &&
        node.getAttribute("aria-readonly")?.trim().toLowerCase() !== "true" &&
        node.getAttribute("aria-disabled")?.trim().toLowerCase() !== "true"
      ) {
        node.textContent = nextValue;
      } else {
        throw new Error("The bound composer is not an editable element");
      }
      const inputEvent = typeof InputEvent === "function"
        ? new InputEvent("input", {
            bubbles: true,
            data: nextValue,
            inputType: "insertText",
          })
        : new Event("input", { bubbles: true });
      node.dispatchEvent(inputEvent);
        }, value));
      this.#assertNoNativeDialog(true);
    }, () => dispatchAttempted, deadline, trace);
  }

  public async click(
    group: LocatorGroup,
    guard: SemanticActionGuard,
    deadline = performance.now() + this.#actionMs,
  ): Promise<void> {
    let dispatchAttempted = false;
    const clickGuardToken = `__cope_trusted_click_${randomUUID().replaceAll("-", "")}`;
    const trace = operationTrace(group.signal, "actionable-locator.search");
    await this.#runBounded(async (assertWithinDeadline) => {
      this.#assertNoNativeDialog();
      const element = await this.#firstActionableOrThrow(group, trace);
      this.#assertNoNativeDialog();
      guard();
      this.#assertNoNativeDialog();
      assertWithinDeadline();
      const actionable = await traceOperation(
        trace,
        "dispatch-preflight",
        { operation: "element.evaluate.click-preflight" },
        () => element.evaluate((node): boolean => {
      if (!(node instanceof HTMLElement) || !node.isConnected) {
        return false;
      }
      const actionable = (() => {
        try {
          let composedAncestor: Element | null = node;
          while (composedAncestor !== null) {
            if (composedAncestor.getAttribute("aria-disabled")?.trim().toLowerCase() === "true") {
              throw new Error("The bound send element is inside a disabled control");
            }
            if (composedAncestor.parentElement !== null) {
              composedAncestor = composedAncestor.parentElement;
              continue;
            }
            const root = composedAncestor.getRootNode();
            composedAncestor = root instanceof ShadowRoot ? root.host : null;
          }
          if (
            node.matches(":disabled")
          ) {
            throw new Error("The bound send element is disabled");
          }
          // Perform a fail-closed hit-test before the protocol-bound click.
          // The later ElementHandle dispatch cannot re-resolve into replacement
          // DOM, unlike a Locator.
          node.scrollIntoView({ block: "center", inline: "center" });
          if (!node.isConnected) {
            throw new Error("The bound send element detached while becoming actionable");
          }
          const view = node.ownerDocument.defaultView;
          const style = view?.getComputedStyle(node);
          if (
            view === null ||
            view === undefined ||
            style === undefined ||
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            style.pointerEvents === "none"
          ) {
            throw new Error("The bound send element is not hit-testable");
          }
          const rectangles = Array.from(node.getClientRects()).filter(
            (rectangle) => rectangle.width > 0 && rectangle.height > 0,
          );
          const hitTarget = rectangles
            .map((rectangle) => {
              const left = Math.max(0, rectangle.left);
              const right = Math.min(view.innerWidth, rectangle.right);
              const top = Math.max(0, rectangle.top);
              const bottom = Math.min(view.innerHeight, rectangle.bottom);
              if (right <= left || bottom <= top) return null;
              const x = left + (right - left) / 2;
              const y = top + (bottom - top) / 2;
              let target = node.ownerDocument.elementFromPoint(
                x,
                y,
              );
              // Document hit-testing stops at a shadow host. Descend only through
              // open roots reached by that same top-level hit, preserving overlay
              // rejection while supporting a configured control in open shadow DOM.
              while (target?.shadowRoot !== null && target?.shadowRoot !== undefined) {
                const nestedTarget = target.shadowRoot.elementFromPoint(x, y);
                if (nestedTarget === null || nestedTarget === target) break;
                target = nestedTarget;
              }
              return target;
            })
            .find((target) => {
              let composedTarget: Element | null = target;
              while (composedTarget !== null) {
                if (composedTarget === node) return true;
                if (composedTarget.parentElement !== null) {
                  composedTarget = composedTarget.parentElement;
                  continue;
                }
                const root = composedTarget.getRootNode();
                composedTarget = root instanceof ShadowRoot ? root.host : null;
              }
              return false;
            });
          if (hitTarget === undefined) {
            throw new Error("The bound send element does not receive pointer events");
          }
          return true;
        } catch {
          return false;
        }
      })();
      return actionable;
        }),
      );
      this.#assertNoNativeDialog(true);
      if (!actionable) {
        dispatchAttempted = false;
        throw new AgentError(
          "TRANSPORT_INDETERMINATE",
          "The bound send element changed before browser dispatch",
          {
            diagnosticCode: "ACTIONABLE_ELEMENT_CHANGED_BEFORE_DISPATCH",
            dispatchAttempted: false,
          },
        );
      }
      // M365's current Fluent send control ignores HTMLElement.click(), which
      // emits only an untrusted synthetic click. Dispatch through Playwright's
      // protocol on the already-bound ElementHandle so pointer events are
      // trusted without allowing a Locator to re-resolve into replacement DOM.
      //
      // Keep Playwright's receives-events enforcement enabled. A forced click
      // is still coordinate-targeted and can activate an overlay that appears
      // after preflight (including one mounted by mousemove). The capture guard
      // is a second fail-closed boundary: it cancels any trusted activation
      // event whose composed path does not contain this exact bound element,
      // and proves that exactly one trusted click reached it.
      guard();
      this.#assertNoNativeDialog();
      assertWithinDeadline();
      const clickGuardInstalled = await traceOperation(
        trace,
        "dispatch-guard",
        { operation: "element.evaluate.install-click-guard" },
        () => element.evaluate((node, token): boolean => {
          if (!(node instanceof HTMLElement) || !node.isConnected) return false;
          const view = node.ownerDocument.defaultView;
          if (view === null || Object.prototype.hasOwnProperty.call(view, token)) return false;
          const state = {
            matchedClicks: 0,
            mismatchedActivation: false,
            cleanup: (): void => undefined,
          };
          const activationTypes = [
            "pointerdown",
            "mousedown",
            "pointerup",
            "mouseup",
            "click",
          ];
          const listener = (event: Event): void => {
            if (!event.isTrusted) return;
            const targetsBoundElement = event.composedPath().includes(node);
            if (targetsBoundElement) {
              if (event.type === "click") state.matchedClicks += 1;
              return;
            }
            state.mismatchedActivation = true;
            event.preventDefault();
            event.stopImmediatePropagation();
          };
          state.cleanup = () => {
            for (const type of activationTypes) {
              view.removeEventListener(type, listener, true);
            }
          };
          for (const type of activationTypes) {
            view.addEventListener(type, listener, true);
          }
          // Store cleanup on the Window rather than the bound element. M365
          // may synchronously replace Send inside its click handler, but the
          // document-level guard must still be removable after that node has
          // detached.
          Object.defineProperty(view, token, {
            configurable: true,
            enumerable: false,
            value: state,
          });
          return true;
        }, clickGuardToken),
      );
      if (!clickGuardInstalled) {
        throw new AgentError(
          "TRANSPORT_INDETERMINATE",
          "The bound send element changed before trusted-click guarding",
          {
            diagnosticCode: "ACTIONABLE_ELEMENT_CHANGED_BEFORE_DISPATCH",
            dispatchAttempted: false,
          },
        );
      }
      dispatchAttempted = true;
      let clickError: unknown;
      try {
        await traceOperation(
          trace,
          "dispatch",
          { operation: "element.click" },
          () => element.click({
            noWaitAfter: true,
            timeout: Math.max(1, Math.ceil(deadline - performance.now())),
          }),
        );
      } catch (error) {
        clickError = error;
      }
      const clickProof = await traceOperation(
        trace,
        "dispatch-proof",
        { operation: "page.evaluate.verify-click-target" },
        () => this.#page.evaluate((token): {
          readonly matchedClicks: number;
          readonly mismatchedActivation: boolean;
        } => {
          const state = (window as unknown as Record<string, {
            matchedClicks: number;
            mismatchedActivation: boolean;
            cleanup: () => void;
          }>)[token];
          if (state === undefined) {
            return { matchedClicks: 0, mismatchedActivation: true };
          }
          state.cleanup();
          delete (window as unknown as Record<string, unknown>)[token];
          return {
            matchedClicks: state.matchedClicks,
            mismatchedActivation: state.mismatchedActivation,
          };
        }, clickGuardToken),
      );
      if (clickError !== undefined) throw clickError;
      if (clickProof.mismatchedActivation || clickProof.matchedClicks !== 1) {
        throw new AgentError(
          "TRANSPORT_INDETERMINATE",
          "Trusted browser activation did not remain pinned to the bound send element",
          {
            diagnosticCode: "CLICK_TARGET_CHANGED_DURING_DISPATCH",
            dispatchAttempted: true,
          },
        );
      }
      this.#assertNoNativeDialog(true);
    }, () => dispatchAttempted, deadline, trace);
  }

  async #runBounded<T>(
    operation: (assertWithinDeadline: () => void) => Promise<T>,
    dispatchAttempted: () => boolean,
    deadline: number,
    trace: BrowserOperationTrace,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timerFired = false;
    let timedOut = false;
    let termination: Promise<void> | undefined;
    const timeoutError = (cause?: unknown) => new AgentError(
      "TRANSPORT_INDETERMINATE",
      "The browser operation exceeded its configured action timeout",
      {
        diagnosticCode: "BROWSER_OPERATION_TIMEOUT",
        dispatchAttempted: dispatchAttempted(),
        stage: "browser_operation",
        repairable: true,
        next: "Run cope sessions --all, then resume the exact paused session after the dedicated browser closes.",
        suggestedAction: "resume_exact_session",
        ...(this.#operationTimeoutOrigin?.() ?? operationTraceDetails(trace)),
      },
      cause === undefined ? undefined : { cause },
    );
    // A timeout permanently revokes this delegate. The original renderer call
    // may still be unwinding while owner termination continues in background;
    // no later operation may enter that session.
    const sessionTimedOut = () =>
      this.#operationTimedOut || this.#operationTimeoutSignal?.aborted === true;
    if (sessionTimedOut()) throw timeoutError();
    const expire = () => {
      if (timedOut) return;
      timedOut = true;
      this.#operationTimedOut = true;
      termination = this.#terminateTimedOutOperation(operationTraceDetails(trace));
      void termination.catch(() => undefined);
    };
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timerFired = true;
        // Set this before starting teardown. If the renderer operation settles
        // during termination, it must not win the race and report success.
        expire();
        // Diagnostic settlement is bounded independently of Browser.close().
        // Safety comes from the sticky terminal latch plus the last-boundary
        // deadline check; teardown continues but is never awaited here.
        reject(timeoutError());
      }, Math.max(0, deadline - performance.now()));
    });
    let sessionTimeoutListener: (() => void) | undefined;
    const sessionTimeout = new Promise<never>((_resolve, reject) => {
      if (this.#operationTimeoutSignal === undefined) return;
      sessionTimeoutListener = () => {
        expire();
        reject(timeoutError());
      };
      if (this.#operationTimeoutSignal.aborted) {
        sessionTimeoutListener();
        return;
      }
      this.#operationTimeoutSignal.addEventListener("abort", sessionTimeoutListener, {
        once: true,
      });
    });
    const assertWithinDeadline = () => {
      if (!sessionTimedOut() && performance.now() < deadline) return;
      expire();
      throw timeoutError();
    };

    try {
      const result = await Promise.race([
        operation(assertWithinDeadline),
        timeout,
        sessionTimeout,
      ]);
      // Resolved-Promise microtasks or synchronous renderer work can starve the
      // timer callback past the absolute deadline. The operation still loses:
      // expire from the monotonic clock before accepting its result.
      if (!timedOut && (sessionTimedOut() || performance.now() >= deadline)) expire();
      if (timedOut) {
        throw timeoutError();
      }
      return result;
    } catch (error) {
      if (!timedOut && (sessionTimedOut() || performance.now() >= deadline)) expire();
      if (!timedOut) throw error;
      if (
        error instanceof AgentError &&
        error.details.diagnosticCode === "BROWSER_OPERATION_TIMEOUT"
      ) {
        throw error;
      }
      throw timeoutError(error);
    } finally {
      if (!timerFired && timer !== undefined) clearTimeout(timer);
      if (sessionTimeoutListener !== undefined) {
        this.#operationTimeoutSignal?.removeEventListener("abort", sessionTimeoutListener);
      }
    }
  }

  #terminateTimedOutOperation(origin: BrowserOperationTimeoutOrigin): Promise<void> {
    this.#operationTermination ??= this.#performTimedOutTermination(origin);
    return this.#operationTermination;
  }

  async #performTimedOutTermination(origin: BrowserOperationTimeoutOrigin): Promise<void> {
    if (this.#onOperationTimeout !== undefined) {
      await this.#onOperationTimeout(origin);
      return;
    }
    const context = this.#page.context();
    const browser = context.browser();
    if (browser !== null) {
      await browser.close();
      return;
    }
    await Promise.all([
      this.#page.close({ runBeforeUnload: false }).catch(() => undefined),
      context.close().catch(() => undefined),
    ]);
  }

  async #snapshotCandidate(
    candidate: SemanticLocator,
    candidateIndex: number,
    group: LocatorGroup,
    trace: BrowserOperationTrace,
  ): Promise<readonly ElementSnapshot[]> {
    const traceKey = `candidate:${candidateIndex}`;
    const point = (operation: string, elementIndex?: number): BrowserOperationTracePoint => ({
      operation,
      locatorKind: candidate.kind,
      locatorCandidateIndex: candidateIndex + 1,
      ...(elementIndex === undefined ? {} : { elementIndex: elementIndex + 1 }),
    });
    try {
      const locator = this.#locator(candidate);
      const locatorCount = await traceOperation(
        trace,
        traceKey,
        point("locator.count"),
        () => locator.count(),
      );
      // Identity is an ownership boundary, not content capture. Truncating a
      // larger result set could hide the conflicting current account after a
      // prefix of alternate-profile controls, so overflow contributes no quorum.
      if (group.signal === "identity" && locatorCount > group.maximumElements) return [];
      const count = Math.min(locatorCount, group.maximumElements);
      const snapshots: ElementSnapshot[] = [];
      for (let index = 0; index < count; index += 1) {
        const item = locator.nth(index);
        const visible = await safeBoolean(() => traceOperation(
          trace,
          traceKey,
          point("locator.isVisible", index),
          () => item.isVisible(),
        ));
        if (!visible) continue;
        const requiresActionability =
          group.signal === "composer" ||
          group.signal === "send" ||
          group.signal === "modal";
        const enabled = !requiresActionability || await safeBoolean(async () => {
          if (!await traceOperation(
            trace,
            traceKey,
            point("locator.isEnabled", index),
            () => item.isEnabled(),
          )) return false;
          if (group.signal !== "composer") return true;
          if (!await traceOperation(
            trace,
            traceKey,
            point("locator.isEditable", index),
            () => item.isEditable(),
          )) return false;
          return (await traceOperation(
            trace,
            traceKey,
            point("locator.getAttribute", index),
            () => item.getAttribute("aria-readonly"),
          ))?.trim().toLowerCase() !== "true";
        });
        const captureText = group.capture !== "presence";
        let text = "";
        let correlationText: string | undefined;
        let responseCapture: ResponseCaptureEvidence | undefined;
        if (captureText) {
          if (group.signal === "responses" && typeof item.evaluate === "function") {
            let normalized: NormalizedResponseCapture;
            try {
              normalized = await traceOperation(
                trace,
                traceKey,
                point("locator.responseCapture", index),
                async () => {
                  const renderedText = await item.innerText();
                  try {
                    const pageCapture = await item.evaluate<
                      PageResponseCapture,
                      {
                        readonly renderedText: string;
                        readonly descriptors: typeof RESPONSE_PROTOCOL_DESCRIPTORS;
                        readonly maximumProtocolBytes: number;
                      }
                    >((node, input) => {
                    if (!(node instanceof HTMLElement)) {
                      return {
                        renderedText: node.textContent ?? input.renderedText,
                        codeBlockCount: 0,
                        editorCount: 0,
                        bannerCount: 0,
                        unownedProtocolFenceCount: 0,
                        legacyProtocolBlocks: [],
                        protocolBlocks: [],
                      };
                    }
                    const codeBlocks = Array.from(
                      node.querySelectorAll<HTMLElement>(".scriptor-component-code-block"),
                    );
                    const allEditors = Array.from(
                      node.querySelectorAll<HTMLElement>(
                        '[role="textbox"][aria-readonly="true"][aria-label="Code editor"]',
                      ),
                    );
                    const allBanners = Array.from(
                      node.querySelectorAll<HTMLElement>(
                        '[data-testid="message-bar-body-info"]',
                      ),
                    );
                    const protocolBanner = (banner: HTMLElement): {
                      readonly version: string;
                      readonly value: string;
                      readonly bannerContract:
                        | "supported"
                        | "unsupported_version"
                        | "changed_supported_banner";
                    } | undefined => {
                      const value = banner.textContent?.trim() ?? "";
                      const match = /^((?:cba|cba-agent)\/[^\s`~]+)(?:\s|$)/u.exec(value);
                      const version = match?.[1];
                      if (version === undefined) return undefined;
                      const descriptor = input.descriptors.find((entry) =>
                        entry.version === version
                      );
                      return {
                        version,
                        value,
                        bannerContract: descriptor === undefined
                          ? "unsupported_version"
                          : descriptor.banner === value
                            ? "supported"
                            : "changed_supported_banner",
                      };
                    };
                    const familyBanners = allBanners
                      .map(protocolBanner)
                      .filter((value) => value !== undefined);
                    const legacyDescriptor = input.descriptors.find((descriptor) =>
                      descriptor.version === "cba/1"
                    );
                    const legacyProtocolBlocks: string[] = [];
                    if (legacyDescriptor !== undefined) {
                      for (const editor of allEditors) {
                        const codeBlock = editor.closest<HTMLElement>(
                          ".scriptor-component-code-block",
                        );
                        if (
                          codeBlock === null ||
                          !node.contains(codeBlock) ||
                          codeBlock.querySelectorAll(
                            '[role="textbox"][aria-readonly="true"][aria-label="Code editor"]',
                          ).length !== 1
                        ) {
                          continue;
                        }
                        const exactLegacyBanners = Array.from(
                          codeBlock.querySelectorAll<HTMLElement>(
                            '[data-testid="message-bar-body-info"]',
                          ),
                        ).filter((banner) =>
                          banner.textContent?.trim() === legacyDescriptor.banner
                        );
                        if (exactLegacyBanners.length !== 1) continue;
                        const lines = Array.from(
                          editor.querySelectorAll<HTMLElement>("[data-line-index]"),
                        );
                        const legacyCode = (
                          lines.length > 0
                            ? lines.map((line) => line.textContent ?? "").join("\n")
                            : editor.textContent ?? ""
                        ).trim();
                        try {
                          const decoded = JSON.parse(legacyCode) as unknown;
                          if (
                            decoded !== null &&
                            typeof decoded === "object" &&
                            !Array.isArray(decoded) &&
                            (decoded as Readonly<Record<string, unknown>>).protocol ===
                              "cba/1"
                          ) {
                            legacyProtocolBlocks.push(legacyCode);
                          }
                        } catch {
                          // Preserve the exact v0.1.8 rendered-text fallback.
                        }
                      }
                    }
                    const protocolOwnedEditors = new Set<HTMLElement>();
                    const protocolBlocks: PageProtocolBlockCapture[] = [];
                    for (const codeBlock of codeBlocks) {
                      const editors = Array.from(
                        codeBlock.querySelectorAll<HTMLElement>(
                          '[role="textbox"][aria-readonly="true"][aria-label="Code editor"]',
                        ),
                      );
                      const banners = Array.from(
                        codeBlock.querySelectorAll<HTMLElement>(
                          '[data-testid="message-bar-body-info"]',
                        ),
                      );
                      const ownedProtocolBanners = banners
                        .map(protocolBanner)
                        .filter((value) => value !== undefined);
                      if (ownedProtocolBanners.length === 0) continue;
                      for (const editor of editors) protocolOwnedEditors.add(editor);
                      for (const banner of ownedProtocolBanners) {
                        const editor = editors[0];
                        const lines = editor === undefined
                          ? []
                          : Array.from(
                              editor.querySelectorAll<HTMLElement>("[data-line-index]"),
                            );
                        const indexedLines = lines.map((line) => ({
                          index: Number(line.getAttribute("data-line-index")),
                          text: line.textContent ?? "",
                        }));
                        const sortedLines = [...indexedLines].sort(
                          (left, right) => left.index - right.index,
                        );
                        const firstLineIndex = sortedLines[0]?.index;
                        const lineIndicesValid =
                          lines.length > 0 &&
                          firstLineIndex !== undefined &&
                          Number.isSafeInteger(firstLineIndex) &&
                          firstLineIndex >= 0 &&
                          sortedLines.every((line, lineOffset) =>
                            Number.isSafeInteger(line.index) &&
                            line.index === firstLineIndex + lineOffset
                          );
                        const rawCode = sortedLines.map((line) => line.text).join("\n");
                        const contentBytes = new TextEncoder().encode(rawCode).byteLength;
                        protocolBlocks.push({
                          version: banner.version,
                          bannerContract: banner.bannerContract,
                          code: contentBytes <= input.maximumProtocolBytes ? rawCode : "",
                          editorCount: editors.length,
                          bannerCount: ownedProtocolBanners.length,
                          lineCount: lines.length,
                          lineIndicesValid,
                          contentBytes,
                          contentBoundExceeded:
                            contentBytes > input.maximumProtocolBytes,
                        });
                      }
                    }
                    const renderedProtocolFenceCount = input.renderedText
                      .split(/\r\n|\n/u)
                      .filter((line) =>
                        /^\s*```(?:cba|cba-agent)\/[^\s`~]+\s*$/u.test(line)
                      ).length;
                    const unownedEditorProtocolFenceCount = allEditors
                      .filter((editor) => !protocolOwnedEditors.has(editor))
                      .reduce((count, editor) => {
                        const lines = Array.from(
                          editor.querySelectorAll<HTMLElement>("[data-line-index]"),
                        );
                        const editorText = lines.length > 0
                          ? lines.map((line) => line.textContent ?? "").join("\n")
                          : editor.textContent ?? "";
                        return count + editorText.split(/\r\n|\n/u).filter((line) =>
                          /^\s*```(?:cba|cba-agent)\/[^\s`~]+\s*$/u.test(line)
                        ).length;
                      }, 0);
                    return {
                      renderedText: input.renderedText,
                      codeBlockCount: codeBlocks.length,
                      editorCount: allEditors.length,
                      bannerCount: familyBanners.length,
                      unownedProtocolFenceCount:
                        renderedProtocolFenceCount + unownedEditorProtocolFenceCount,
                      legacyProtocolBlocks,
                      protocolBlocks,
                    };
                    }, {
                      renderedText,
                      descriptors: RESPONSE_PROTOCOL_DESCRIPTORS,
                      maximumProtocolBytes: DEFAULT_MAX_PROTOCOL_INPUT_BYTES,
                    });
                    return normalizeResponseCapture(pageCapture);
                  } catch {
                    return failedResponseCapture(renderedText);
                  }
                },
              );
            } catch (error) {
              if (!(error instanceof AgentError)) {
                normalized = failedResponseCapture("");
              } else {
              throw new AgentError(
                "TRANSPORT_INDETERMINATE",
                "The assistant response widget could not be captured safely",
                {
                  diagnosticCode: "PROTOCOL_WIDGET_CAPTURE_FAILED",
                  diagnosticStage: "browser_response_capture",
                  dispatchAttempted: false,
                },
                { cause: error },
              );
              }
            }
            text = normalized.text;
            correlationText = normalized.correlationText;
            responseCapture = normalized.evidence;
          } else {
            text = await safeString(() => traceOperation(
              trace,
              traceKey,
              point("locator.innerText", index),
              () => item.innerText(),
            ));
          }
        }
        const accessibleLabel = captureText
          ? await safeString(async () => (await traceOperation(
              trace,
              traceKey,
              point("locator.getAttribute", index),
              () => item.getAttribute("aria-label"),
            )) ?? "")
          : "";
        const value =
          group.capture === "value-and-text"
            ? await safeString(() => traceOperation(
                trace,
                traceKey,
                point("locator.inputValue", index),
                () => item.inputValue(),
              ))
            : "";
        snapshots.push({
          visible,
          enabled,
          text,
          ...(correlationText === undefined ? {} : { correlationText }),
          ...(responseCapture === undefined ? {} : { responseCapture }),
          value,
          accessibleLabel,
        });
      }
      return snapshots;
    } catch (error) {
      if (error instanceof AgentError) throw error;
      // A stale candidate contributes no quorum. Other strategies can still
      // identify the surface; total quorum failure becomes changed-selector.
      return [];
    }
  }

  async #firstActionableOrThrow(
    group: LocatorGroup,
    trace: BrowserOperationTrace,
  ): Promise<ElementHandle> {
    try {
      return await this.#firstActionable(group, trace);
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError(
        "TRANSPORT_INDETERMINATE",
        "No actionable element remained at the browser dispatch boundary",
        {
          diagnosticCode: "ACTIONABLE_LOCATOR_NOT_FOUND",
          dispatchAttempted: false,
        },
        { cause: error },
      );
    }
  }

  #assertNoNativeDialog(dispatchAttempted = false): void {
    if (!this.#nativeDialogDetected) return;
    throw new AgentError(
      "TRANSPORT_INDETERMINATE",
      "A native browser dialog revoked the trusted browser action",
      {
        diagnosticCode: "NATIVE_BROWSER_DIALOG_DETECTED",
        dispatchAttempted,
      },
    );
  }

  async #firstActionable(
    group: LocatorGroup,
    trace: BrowserOperationTrace,
  ): Promise<ElementHandle> {
    for (const [candidateIndex, candidate] of group.candidates.entries()) {
      const traceKey = `candidate:${candidateIndex}`;
      const point = (operation: string, elementIndex?: number): BrowserOperationTracePoint => ({
        operation,
        locatorKind: candidate.kind,
        locatorCandidateIndex: candidateIndex + 1,
        ...(elementIndex === undefined ? {} : { elementIndex: elementIndex + 1 }),
      });
      try {
        this.#assertNoNativeDialog();
        const locator = this.#locator(candidate);
        const locatorCount = await traceOperation(
          trace,
          traceKey,
          point("locator.count"),
          () => locator.count(),
        );
        this.#assertNoNativeDialog();
        const count = Math.min(locatorCount, group.maximumElements);
        for (let index = 0; index < count; index += 1) {
          const item = locator.nth(index);
          // Bind the concrete DOM node before actionability checks. A Locator
          // may re-resolve into a new document during Playwright auto-wait;
          // an ElementHandle instead fails if navigation detaches this node.
          const element = await traceOperation(
            trace,
            traceKey,
            point("locator.elementHandle", index),
            () => item.elementHandle(),
          );
          this.#assertNoNativeDialog();
          if (element === null) continue;
          const visible = await safeBoolean(() => traceOperation(
            trace,
            traceKey,
            point("element.isVisible", index),
            () => element.isVisible(),
          ));
          this.#assertNoNativeDialog();
          if (!visible) continue;
          const enabled = await safeBoolean(() => traceOperation(
            trace,
            traceKey,
            point("element.isEnabled", index),
            () => element.isEnabled(),
          ));
          this.#assertNoNativeDialog();
          if (!enabled) continue;
          if (group.signal === "composer") {
            const editable = await safeBoolean(() => traceOperation(
              trace,
              traceKey,
              point("element.isEditable", index),
              () => element.isEditable(),
            ));
            this.#assertNoNativeDialog();
            if (!editable) continue;
            const readonly = await traceOperation(
              trace,
              traceKey,
              point("element.getAttribute", index),
              () => element.getAttribute("aria-readonly"),
            ).catch(() => undefined);
            this.#assertNoNativeDialog();
            if (readonly?.trim().toLowerCase() === "true") continue;
          }
          return element;
        }
      } catch (error) {
        if (error instanceof AgentError) throw error;
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

interface BrowserOperationTracePoint {
  readonly operation: string;
  readonly locatorKind?: SemanticLocator["kind"];
  readonly locatorCandidateIndex?: number;
  readonly elementIndex?: number;
}

interface BrowserOperationTrace {
  readonly semanticGroup: string;
  readonly pending: Map<string, BrowserOperationTracePoint>;
  last: BrowserOperationTracePoint;
}

function operationTrace(
  semanticGroup: string,
  initialOperation: string,
): BrowserOperationTrace {
  return {
    semanticGroup,
    pending: new Map(),
    last: { operation: initialOperation },
  };
}

async function traceOperation<T>(
  trace: BrowserOperationTrace,
  key: string,
  point: BrowserOperationTracePoint,
  operation: () => Promise<T>,
): Promise<T> {
  trace.last = point;
  trace.pending.set(key, point);
  try {
    return await operation();
  } finally {
    if (trace.pending.get(key) === point) trace.pending.delete(key);
  }
}

function operationTraceDetails(trace: BrowserOperationTrace): BrowserOperationTimeoutOrigin {
  const active = [...trace.pending.values()].sort(compareTracePoints);
  const primary = active[0] ?? trace.last;
  return {
    semanticGroup: trace.semanticGroup,
    semanticOperation: primary.operation,
    ...(primary.locatorKind === undefined ? {} : { locatorKind: primary.locatorKind }),
    ...(primary.locatorCandidateIndex === undefined
      ? {}
      : { locatorCandidateIndex: primary.locatorCandidateIndex }),
    ...(primary.elementIndex === undefined ? {} : { elementIndex: primary.elementIndex }),
    ...(active.length <= 1
      ? {}
      : {
          pendingSemanticOperations: active.map((point) => ({
            operation: point.operation,
            ...(point.locatorKind === undefined ? {} : { locatorKind: point.locatorKind }),
            ...(point.locatorCandidateIndex === undefined
              ? {}
              : { locatorCandidateIndex: point.locatorCandidateIndex }),
            ...(point.elementIndex === undefined ? {} : { elementIndex: point.elementIndex }),
          })),
        }),
  };
}

function compareTracePoints(
  left: BrowserOperationTracePoint,
  right: BrowserOperationTracePoint,
): number {
  return (left.locatorCandidateIndex ?? 0) - (right.locatorCandidateIndex ?? 0) ||
    (left.elementIndex ?? 0) - (right.elementIndex ?? 0) ||
    left.operation.localeCompare(right.operation);
}

function failedResponseCapture(renderedText: string): NormalizedResponseCapture {
  return {
    text: renderedText,
    correlationText: renderedText,
    evidence: {
      contractVersion: RESPONSE_CAPTURE_CONTRACT_VERSION,
      status: "protocol_widget_capture_failed",
      reasonCode: "PROTOCOL_WIDGET_CAPTURE_FAILED",
      codeBlockCount: 0,
      protocolBlockCount: 0,
      editorCount: 0,
      bannerCount: 0,
      lineCount: 0,
      contentBytes: Buffer.byteLength(renderedText, "utf8"),
    },
  };
}

/**
 * Read-only doctor probe for the host-side executable-envelope boundary.
 * This intentionally uses a fixed synthetic fixture: it neither opens a
 * conversation nor reads or submits any live chat content.
 */
export function probeResponseCaptureNormalizer(): ResponseCaptureEvidence {
  const code = JSON.stringify({
    kind: "agent_progress",
    phase: "discovering",
    summary: "capture contract probe",
  });
  const normalized = normalizeResponseCapture({
    renderedText: code,
    codeBlockCount: 1,
    editorCount: 1,
    bannerCount: 1,
    unownedProtocolFenceCount: 0,
    legacyProtocolBlocks: [],
    protocolBlocks: [{
      version: "cba-agent/1",
      bannerContract: "supported",
      code,
      editorCount: 1,
      bannerCount: 1,
      lineCount: 1,
      lineIndicesValid: true,
      contentBytes: Buffer.byteLength(code, "utf8"),
      contentBoundExceeded: false,
    }],
  });
  if (
    normalized.evidence.status !== "protocol_reconstructed" ||
    normalized.evidence.protocolVersion !== "cba-agent/1" ||
    !normalized.text.startsWith("```cba-agent/1\n")
  ) {
    throw new Error("The response-capture normalizer failed its synthetic contract probe");
  }
  return normalized.evidence;
}

function normalizeResponseCapture(capture: PageResponseCapture): NormalizedResponseCapture {
  const sharedEvidence = {
    contractVersion: RESPONSE_CAPTURE_CONTRACT_VERSION,
    codeBlockCount: capture.codeBlockCount,
    protocolBlockCount: capture.protocolBlocks.length,
    editorCount: capture.editorCount,
    bannerCount: capture.bannerCount,
  } as const;
  const renderedContentBytes = Buffer.byteLength(capture.renderedText, "utf8");
  const correlationText = v018ResponseCorrelationText(capture);
  if (capture.unownedProtocolFenceCount > 0) {
    return {
      text: capture.renderedText,
      correlationText,
      evidence: {
        ...sharedEvidence,
        status: "protocol_widget_ambiguous",
        reasonCode: "UNOWNED_PROTOCOL_FENCE",
        lineCount: 0,
        contentBytes: renderedContentBytes,
      },
    };
  }
  if (capture.protocolBlocks.length === 0) {
    if (capture.bannerCount > 0) {
      return {
        text: capture.renderedText,
        correlationText,
        evidence: {
          ...sharedEvidence,
          status: "unsupported_capture_contract",
          reasonCode: "PROTOCOL_WIDGET_NOT_OWNED",
          lineCount: 0,
          contentBytes: renderedContentBytes,
        },
      };
    }
    return {
      text: capture.renderedText,
      correlationText,
      evidence: {
        ...sharedEvidence,
        status: "rendered_text",
        lineCount: 0,
        contentBytes: renderedContentBytes,
      },
    };
  }

  const changedBanner = capture.protocolBlocks.find((block) =>
    block.bannerContract === "changed_supported_banner"
  );
  if (changedBanner !== undefined) {
    return {
      text: capture.renderedText,
      correlationText,
      evidence: {
        ...sharedEvidence,
        status: "unsupported_capture_contract",
        protocolVersion: changedBanner.version,
        reasonCode: "PROTOCOL_WIDGET_BANNER_CONTRACT_CHANGED",
        lineCount: changedBanner.lineCount,
        contentBytes: changedBanner.contentBytes,
      },
    };
  }

  const incompleteBlock = capture.protocolBlocks.find((block) =>
    block.editorCount === 0 || block.lineCount === 0
  );
  if (incompleteBlock !== undefined) {
    return {
      text: capture.renderedText,
      correlationText,
      evidence: {
        ...sharedEvidence,
        status: "protocol_widget_incomplete",
        protocolVersion: incompleteBlock.version,
        reasonCode: incompleteBlock.editorCount === 0
          ? "PROTOCOL_WIDGET_EDITOR_PENDING"
          : "PROTOCOL_WIDGET_LINES_PENDING",
        lineCount: incompleteBlock.lineCount,
        contentBytes: incompleteBlock.contentBytes,
      },
    };
  }

  const unsafeBlock = capture.protocolBlocks.find((block) =>
    block.editorCount !== 1 ||
    !block.lineIndicesValid ||
    block.contentBoundExceeded ||
    block.contentBytes > DEFAULT_MAX_PROTOCOL_INPUT_BYTES ||
    Buffer.byteLength(block.code, "utf8") !== block.contentBytes ||
    block.code.includes("```")
  );
  if (unsafeBlock !== undefined) {
    const reasonCode = unsafeBlock.editorCount !== 1
      ? "PROTOCOL_WIDGET_EDITOR_COUNT"
      : !unsafeBlock.lineIndicesValid
        ? "PROTOCOL_WIDGET_LINE_INDEX_INVALID"
        : unsafeBlock.contentBoundExceeded ||
            unsafeBlock.contentBytes > DEFAULT_MAX_PROTOCOL_INPUT_BYTES
          ? "PROTOCOL_WIDGET_CONTENT_BOUND"
          : Buffer.byteLength(unsafeBlock.code, "utf8") !== unsafeBlock.contentBytes
            ? "PROTOCOL_WIDGET_BYTE_COUNT_MISMATCH"
            : "PROTOCOL_WIDGET_FENCE_COLLISION";
    return {
      text: capture.renderedText,
      correlationText,
      evidence: {
        ...sharedEvidence,
        status: "protocol_widget_ambiguous",
        protocolVersion: unsafeBlock.version,
        reasonCode,
        lineCount: unsafeBlock.lineCount,
        contentBytes: unsafeBlock.contentBytes,
      },
    };
  }

  if (capture.protocolBlocks.length !== 1) {
    return modelProtocolMalformed(
      capture,
      sharedEvidence,
      "MULTIPLE_ENVELOPES",
      "MODEL_PROTOCOL_MULTIPLE_ENVELOPES",
    );
  }

  const block = capture.protocolBlocks[0]!;
  if (block.bannerContract === "unsupported_version") {
    return modelProtocolMalformed(
      capture,
      sharedEvidence,
      "UNSUPPORTED_VERSION",
      "MODEL_PROTOCOL_UNSUPPORTED_VERSION",
      block,
    );
  }
  if (block.contentBytes === 0) {
    return modelProtocolMalformed(
      capture,
      sharedEvidence,
      "EMPTY_ENVELOPE",
      "MODEL_PROTOCOL_EMPTY_ENVELOPE",
      block,
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(block.code) as unknown;
  } catch {
    return modelProtocolMalformed(
      capture,
      sharedEvidence,
      "INVALID_JSON",
      "MODEL_PROTOCOL_INVALID_JSON",
      block,
    );
  }
  if (!bodyMatchesDialect(decoded, block.version)) {
    return modelProtocolMalformed(
      capture,
      sharedEvidence,
      "SCHEMA_INVALID",
      "MODEL_PROTOCOL_DIALECT_MISMATCH",
      block,
    );
  }

  const contentBytes = block.contentBytes;
  const normalizedText = `\`\`\`${block.version}\n${block.code}\n\`\`\``;
  try {
    const verified = extractCbaEnvelope(normalizedText, block.version);
    if (verified.json !== block.code) {
      throw new Error("Reconstructed protocol bytes changed during host verification");
    }
  } catch {
    return {
      text: capture.renderedText,
      correlationText,
      evidence: {
        ...sharedEvidence,
        status: "protocol_widget_ambiguous",
        protocolVersion: block.version,
        reasonCode: "PROTOCOL_WIDGET_HOST_VERIFICATION_FAILED",
        lineCount: block.lineCount,
        contentBytes,
      },
    };
  }
  return {
    text: normalizedText,
    correlationText,
    evidence: {
      ...sharedEvidence,
      status: "protocol_reconstructed",
      protocolVersion: block.version,
      lineCount: block.lineCount,
      contentBytes,
    },
  };
}

function modelProtocolMalformed(
  capture: PageResponseCapture,
  sharedEvidence: Pick<
    ResponseCaptureEvidence,
    | "contractVersion"
    | "codeBlockCount"
    | "protocolBlockCount"
    | "editorCount"
    | "bannerCount"
  >,
  protocolErrorCode: string,
  reasonCode: string,
  block = capture.protocolBlocks[0],
): NormalizedResponseCapture {
  return {
    text: capture.renderedText,
    correlationText: v018ResponseCorrelationText(capture),
    evidence: {
      ...sharedEvidence,
      status: "model_protocol_malformed",
      ...(block === undefined ? {} : { protocolVersion: block.version }),
      reasonCode,
      protocolErrorCode,
      lineCount: block?.lineCount ?? 0,
      contentBytes: block?.contentBytes ??
        Buffer.byteLength(capture.renderedText, "utf8"),
    },
  };
}

function bodyMatchesDialect(value: unknown, version: string): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Readonly<Record<string, unknown>>;
  if (version === "cba/1") return object.protocol === "cba/1";
  if (version !== "cba-agent/1") return false;
  return (
    object.kind === "agent_intent" ||
    object.kind === "agent_answer" ||
    object.kind === "agent_blocked" ||
    object.kind === "agent_progress"
  );
}

function v018ResponseCorrelationText(capture: PageResponseCapture): string {
  return capture.legacyProtocolBlocks.length > 0
    ? capture.legacyProtocolBlocks
      .map((code) => `\`\`\`cba/1\n${code}\n\`\`\``)
      .join("\n\n")
    : capture.renderedText;
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
