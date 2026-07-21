import { setTimeout as delay } from "node:timers/promises";

import type { BrowserStateInspection } from "./copilot-browser-adapter.js";
import type { BrowserWaitConfig } from "./config.js";

export interface ManualReadinessDependencies {
  readonly monotonicNow?: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly isTerminalInspection?: (inspection: BrowserStateInspection) => boolean;
}

/**
 * Browser pages often expose only part of the certified surface while the app
 * hydrates. Continuous non-manual states receive one bounded hydration period,
 * even if their diagnostic classification changes while the page is unstable.
 * States that require operator action, including sign-in, MFA, consent, or a
 * visible blocking dialog, may consume the full manual-readiness window.
 */
export async function waitForStableManualReadiness(
  observe: (maxWaitMs: number, signal?: AbortSignal) => Promise<BrowserStateInspection>,
  waits: BrowserWaitConfig,
  requestedMaxWaitMs = waits.manualReadinessMs,
  signal?: AbortSignal,
  dependencies: ManualReadinessDependencies = {},
): Promise<BrowserStateInspection> {
  const maxWaitMs = Math.min(requestedMaxWaitMs, waits.manualReadinessMs);
  if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0) {
    throw new TypeError("Manual readiness wait must be positive and bounded");
  }
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const sleep = dependencies.sleep ?? sleepWithAbort;
  const isTerminalInspection = dependencies.isTerminalInspection ??
    ((inspection: BrowserStateInspection) =>
      isTerminalManualReadinessState(inspection.classification.state));
  const deadline = monotonicNow() + maxWaitMs;
  let lastInspection: BrowserStateInspection | undefined;
  let terminalPeriodSince = 0;
  let terminalPeriodSamples = 0;
  let stableKey: string | undefined;
  let stableKeySince = 0;
  let stableKeySamples = 0;
  let unsafePeriodSince = 0;
  let unsafeSamples = 0;
  let lastUnsafeInspection: BrowserStateInspection | undefined;

  for (;;) {
    const beforeObservation = monotonicNow();
    const remaining = deadline - beforeObservation;
    if (remaining <= 0 && lastInspection !== undefined) return lastInspection;
    const observationWindow = Math.max(1, Math.min(Math.max(remaining, 1), waits.pollMs));
    const inspection = await observe(observationWindow, signal);
    lastInspection = inspection;
    if (inspection.classification.state === "ready") return inspection;

    const observedAt = monotonicNow();
    const terminalInspection = isTerminalInspection(inspection);
    const immediatelyUnsafe = terminalInspection &&
      isImmediatelyUnsafe(inspection.classification.state);
    const hydrationMs = Math.min(
      Math.max(waits.minimumStableMs, waits.actionMs),
      maxWaitMs,
    );

    // Only a continuous immediately unsafe observation period is allowed to
    // consume the short unsafe window. Once the page reaches sign-in, MFA,
    // consent, or a recoverable dialog, stale host samples are discarded so
    // the operator receives the full manual-readiness window.
    if (immediatelyUnsafe) {
      if (unsafeSamples === 0) unsafePeriodSince = observedAt;
      unsafeSamples += 1;
      lastUnsafeInspection = inspection;
    } else {
      unsafePeriodSince = 0;
      unsafeSamples = 0;
      lastUnsafeInspection = undefined;
    }
    if (
      immediatelyUnsafe &&
      unsafeSamples >= waits.stableSamples &&
      observedAt - unsafePeriodSince >= hydrationMs
    ) {
      return lastUnsafeInspection ?? inspection;
    }

    if (terminalInspection) {
      if (terminalPeriodSamples === 0) terminalPeriodSince = observedAt;
      terminalPeriodSamples += 1;

      const nextKey = `${inspection.classification.state}:${inspection.classification.diagnosticCode}`;
      if (nextKey === stableKey) {
        stableKeySamples += 1;
      } else {
        stableKey = nextKey;
        stableKeySince = observedAt;
        stableKeySamples = 1;
      }

      if (immediatelyUnsafe) {
        const shortStableMs = Math.min(waits.minimumStableMs, maxWaitMs);
        if (
          stableKeySamples >= waits.stableSamples &&
          observedAt - stableKeySince >= shortStableMs
        ) {
          return inspection;
        }
      }

      // The action-bound fallback applies to every continuous non-manual
      // period, including states that alternate and therefore never satisfy the
      // same-diagnostic short quorum.
      if (
        terminalPeriodSamples >= waits.stableSamples &&
        observedAt - terminalPeriodSince >= hydrationMs
      ) {
        return inspection;
      }
    } else {
      terminalPeriodSince = 0;
      terminalPeriodSamples = 0;
      stableKey = undefined;
      stableKeySince = 0;
      stableKeySamples = 0;
    }

    const remainingAfterObservation = deadline - observedAt;
    if (remainingAfterObservation <= 0) return inspection;
    const observationElapsed = Math.max(0, observedAt - beforeObservation);
    const pause = Math.min(
      Math.max(0, waits.pollMs - observationElapsed),
      remainingAfterObservation,
    );
    if (pause > 0) await sleep(pause, signal);
  }
}

/**
 * Explicit authentication states and visible blocking dialogs remain open for
 * operator action. Every other non-ready state must recover during its bounded
 * hydration window or return a diagnostic instead of appearing hung.
 */
export function isTerminalManualReadinessState(
  state: BrowserStateInspection["classification"]["state"],
): boolean {
  return state !== "ready" &&
    state !== "sign-in-required" &&
    state !== "mfa-required" &&
    state !== "consent-required" &&
    state !== "blocking-modal";
}

function isImmediatelyUnsafe(
  state: BrowserStateInspection["classification"]["state"],
): boolean {
  return state === "unapproved-host";
}

async function sleepWithAbort(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) await delay(milliseconds);
  else await delay(milliseconds, undefined, { signal });
}
