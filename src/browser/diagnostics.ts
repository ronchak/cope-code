import type { CopilotPageObservation, CopilotSignal, CopilotUiContract } from "./contracts.js";
import type { PageClassification } from "./classifier.js";

export interface MinimalBrowserDiagnostic {
  readonly uiContractVersion: string;
  readonly state: PageClassification["state"];
  readonly diagnosticCode: string;
  readonly locatorQuorum: Readonly<Record<CopilotSignal, boolean>>;
  readonly summary?: string;
  readonly next?: string;
  readonly missingSignals?: readonly CopilotSignal[];
}

export interface BrowserReadinessGuidance {
  readonly summary?: string;
  readonly next?: string;
  readonly missingSignals?: readonly CopilotSignal[];
}

/** Never includes URL, page text, prompt/response content, or identity values. */
export function minimalBrowserDiagnostic(
  observation: CopilotPageObservation,
  contract: CopilotUiContract,
  classification: PageClassification,
): MinimalBrowserDiagnostic {
  const entries = Object.entries(contract.groups).map(([signal, group]) => [
    signal,
    observation[group.signal].matchedCandidates >= group.minimumCandidateMatches &&
      observation[group.signal].visibleElements > 0,
  ]);
  const locatorQuorum = Object.fromEntries(entries) as Readonly<Record<CopilotSignal, boolean>>;
  return {
    uiContractVersion: contract.version,
    state: classification.state,
    diagnosticCode: classification.diagnosticCode,
    locatorQuorum,
    ...browserReadinessGuidance(classification, locatorQuorum),
  };
}

export function browserReadinessGuidance(
  classification: PageClassification,
  locatorQuorum: Readonly<Record<CopilotSignal, boolean>>,
): BrowserReadinessGuidance {
  switch (classification.state) {
    case "ready":
      return {};
    case "identity-unverified":
      return {
        summary: "Copilot loaded, but Cope could not verify the configured work account.",
        next: "Run cope setup --force and enter the exact work-account name or email visibly shown in Copilot, then retry.",
        missingSignals: ["identity"],
      };
    case "protection-unverified":
      return {
        summary: "Copilot loaded, but the required enterprise-data-protection indicator was not verified.",
        next: "Confirm the approved work tenant shows its protection indicator. Change this requirement only through cope setup --force.",
        missingSignals: ["protection"],
      };
    case "changed-selector": {
      const missingSignals = coreMissingSignals(locatorQuorum);
      return {
        summary: "The visible Copilot page did not match Cope's certified control contract.",
        next: "Run cope setup --force to remove a stale pinned UI contract. If this persists, report the diagnostic code and missing signal names.",
        ...(missingSignals.length === 0 ? {} : { missingSignals }),
      };
    }
    case "unapproved-host":
      return {
        summary: "The dedicated Edge context did not expose an approved Copilot or Microsoft authentication page.",
        next: "Close stray blank tabs in the dedicated Edge window and retry. If Microsoft sign-in appears, complete it manually and wait for Copilot Chat to return.",
      };
    case "blocking-modal":
      return {
        summary: "An unexpected visible dialog blocked the certified Copilot controls.",
        next: "Close or complete the dialog in Edge, then retry the task.",
      };
    case "sign-in-required":
      return {
        summary: "The dedicated Edge profile still requires manual Microsoft sign-in.",
        next: "Complete sign-in in the visible Edge window, then retry.",
      };
    case "mfa-required":
      return {
        summary: "The dedicated Edge profile is waiting for manual multi-factor authentication.",
        next: "Complete MFA in the visible Edge window, then retry.",
      };
    case "consent-required":
      return {
        summary: "The dedicated Edge profile is waiting for a manual consent decision.",
        next: "Review and complete the consent prompt in the visible Edge window, then retry.",
      };
    case "throttled":
      return {
        summary: "Microsoft 365 Copilot reported temporary throttling.",
        next: "Retry after the service allows requests again.",
      };
    case "service-error":
      return {
        summary: "Microsoft 365 Copilot displayed a service error.",
        next: "Reload Copilot in the dedicated Edge window and retry after the service recovers.",
      };
    case "streaming":
      return {
        summary: "The selected Copilot conversation remained busy generating a response.",
        next: "Let the visible response finish or stop it, then retry.",
      };
    case "unknown": {
      const missingSignals = coreMissingSignals(locatorQuorum);
      return {
        summary: "Cope reached the approved site, but no certified Copilot chat controls appeared within the bounded hydration window.",
        next: "Retry once with the Copilot conversation visibly open. If this persists, report the diagnostic code and missing signal names.",
        ...(missingSignals.length === 0 ? {} : { missingSignals }),
      };
    }
  }
}

function coreMissingSignals(
  locatorQuorum: Readonly<Record<CopilotSignal, boolean>>,
): readonly CopilotSignal[] {
  return (["shell", "conversation", "composer", "identity", "protection"] as const)
    .filter((signal) => !locatorQuorum[signal]);
}
