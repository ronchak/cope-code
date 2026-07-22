import type { ElementHandle, Locator, Page } from "playwright-core";

import { AgentError } from "../shared/errors.js";
import {
  toRegExp,
  type ElementSnapshot,
  type GroupSnapshot,
  type LocatorGroup,
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
    return this.#page.url();
  }

  public async completeObservation(): Promise<SemanticObservationCompletion> {
    return { nativeDialogDetected: this.#nativeDialogDetected };
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
    deadline = performance.now() + this.#actionMs,
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
    const trace = operationTrace(group.signal, "actionable-locator.search");
    await this.#runBounded(async (assertWithinDeadline) => {
      this.#assertNoNativeDialog();
      const element = await this.#firstActionableOrThrow(group, trace);
      this.#assertNoNativeDialog();
      guard();
      this.#assertNoNativeDialog();
      assertWithinDeadline();
      dispatchAttempted = true;
      const dispatchStatus = await traceOperation(
        trace,
        "dispatch",
        { operation: "element.evaluate.click" },
        () => element.evaluate((node): "pre-dispatch" | "dispatched" => {
      if (!(node instanceof HTMLElement) || !node.isConnected) {
        return "pre-dispatch";
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
          // Keep the dispatch bound to this node while preserving the essential
          // Playwright click actionability checks. These checks and click execute
          // in one page task, so no Locator can auto-wait into a replacement DOM.
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
      if (!actionable) return "pre-dispatch";
      // Keep this outside the preflight catch: an exception at the click
      // boundary cannot prove whether page code observed a dispatch.
      node.click();
      return "dispatched";
        }),
      );
      this.#assertNoNativeDialog(true);
      if (dispatchStatus === "pre-dispatch") {
        throw new AgentError(
          "TRANSPORT_INDETERMINATE",
          "The bound send element changed before browser dispatch",
          {
            diagnosticCode: "ACTIONABLE_ELEMENT_CHANGED_BEFORE_DISPATCH",
            dispatchAttempted: false,
          },
        );
      }
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
        const enabled = await safeBoolean(async () => {
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
        const text = captureText
          ? await safeString(() => traceOperation(
              trace,
              traceKey,
              point("locator.innerText", index),
              () => item.innerText(),
            ))
          : "";
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
        snapshots.push({ visible, enabled, text, value, accessibleLabel });
      }
      return snapshots;
    } catch {
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
