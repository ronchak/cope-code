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
 * hydrates. Non-manual states therefore have to remain unchanged for a bounded
 * quorum before launch treats them as final. Only states that genuinely require
 * the operator to sign in, complete MFA, or grant consent may consume the full
 * manual-readiness window.
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
  let terminalKey: string | undefined;
  let terminalSamples = 0;
  let terminalSince = 0;

  for (;;) {
    const beforeObservation = monotonicNow();
    const remaining = deadline - beforeObservation;
    if (remaining <= 0 && lastInspection !== undefined) return lastInspection;
    const observationWindow = Math.max(1, Math.min(Math.max(remaining, 1), waits.pollMs));
    const inspection = await observe(observationWindow, signal);
    lastInspection = inspection;
    if (inspection.classification.state === "ready") return inspection;

    const observedAt = monotonicNow();
    if (isTerminalInspection(inspection)) {
      const nextKey = `${inspection.classification.state}:${inspection.classification.diagnosticCode}`;
      if (nextKey === terminalKey) {
        terminalSamples += 1;
      } else {
        terminalKey = nextKey;
        terminalSamples = 1;
        terminalSince = observedAt;
      }
      const requiredStableMs = terminalStabilityMs(
        inspection.classification.state,
        waits,
        maxWaitMs,
      );
      if (
        terminalSamples >= waits.stableSamples &&
        observedAt - terminalSince >= requiredStableMs
      ) {
        return inspection;
      }
    } else {
      terminalKey = undefined;
      terminalSamples = 0;
      terminalSince = 0;
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
 * Only explicit manual-authentication states remain open-ended. Every other
 * non-ready state must either recover during its bounded hydration window or
 * return a diagnostic instead of leaving the terminal apparently hung.
 */
export function isTerminalManualReadinessState(
  state: BrowserStateInspection["classification"]["state"],
): boolean {
  return state !== "ready" &&
    state !== "sign-in-required" &&
    state !== "mfa-required" &&
    state !== "consent-required";
}

function terminalStabilityMs(
  state: BrowserStateInspection["classification"]["state"],
  waits: BrowserWaitConfig,
  maxWaitMs: number,
): number {
  const immediatelyUnsafe = state === "unapproved-host" || state === "blocking-modal";
  const desired = immediatelyUnsafe
    ? waits.minimumStableMs
    : Math.max(waits.minimumStableMs, waits.actionMs);
  return Math.min(desired, maxWaitMs);
}

async function sleepWithAbort(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) await delay(milliseconds);
  else await delay(milliseconds, undefined, { signal });
}
