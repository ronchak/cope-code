import {
  matchesText,
  type CopilotPageObservation,
  type CopilotSignal,
  type CopilotUiContract,
  type GroupSnapshot,
  type SemanticPage,
  type TextPattern,
} from "./contracts.js";
import { isApprovedUrl, type ApprovedHost } from "./config.js";

export type CopilotPageState =
  | "ready"
  | "streaming"
  | "unapproved-host"
  | "sign-in-required"
  | "mfa-required"
  | "consent-required"
  | "throttled"
  | "service-error"
  | "blocking-modal"
  | "identity-unverified"
  | "protection-unverified"
  | "changed-selector"
  | "unknown";

export interface PageClassification {
  readonly state: CopilotPageState;
  readonly retryable: boolean;
  readonly diagnosticCode: string;
}

export interface ClassifierRequirements {
  readonly approvedHosts: readonly ApprovedHost[];
  readonly expectedIdentity: string | TextPattern;
  readonly requireProtectionIndicator: boolean;
}

const SIGNALS: readonly CopilotSignal[] = [
  "shell",
  "conversation",
  "composer",
  "send",
  "responses",
  "user-messages",
  "streaming",
  "identity",
  "protection",
  "signed-out",
  "mfa",
  "consent",
  "throttled",
  "service-error",
  "modal",
];

export async function observeCopilotPage(
  page: SemanticPage,
  contract: CopilotUiContract,
): Promise<CopilotPageObservation> {
  const url = await page.currentUrl();
  const entries = await Promise.all(
    SIGNALS.map(async (signal) => [signal, await page.snapshot(contract.groups[signal])] as const),
  );
  return { url, ...Object.fromEntries(entries) } as CopilotPageObservation;
}

export function classifyCopilotPage(
  observation: CopilotPageObservation,
  contract: CopilotUiContract,
  requirements: ClassifierRequirements,
): PageClassification {
  if (!isApprovedUrl(observation.url, requirements.approvedHosts)) {
    return result("unapproved-host", false, "HOST_NOT_APPROVED");
  }

  if (matches(observation, contract, "mfa")) {
    return result("mfa-required", true, "MANUAL_MFA_REQUIRED");
  }
  if (matches(observation, contract, "consent")) {
    return result("consent-required", true, "MANUAL_CONSENT_REQUIRED");
  }
  if (matches(observation, contract, "signed-out")) {
    return result("sign-in-required", true, "MANUAL_SIGN_IN_REQUIRED");
  }
  if (matches(observation, contract, "throttled")) {
    return result("throttled", true, "SERVICE_THROTTLED");
  }
  if (matches(observation, contract, "service-error")) {
    return result("service-error", true, "COPILOT_SERVICE_ERROR");
  }
  if (matches(observation, contract, "modal")) {
    return result("blocking-modal", false, "UNEXPECTED_BLOCKING_MODAL");
  }

  const shell = matches(observation, contract, "shell");
  const conversation = matches(observation, contract, "conversation");
  const composer = matches(observation, contract, "composer");
  const identity = matches(observation, contract, "identity");
  const expectedIdentity = identity && identityTextMatches(observation.identity, requirements.expectedIdentity);
  const protection = matches(observation, contract, "protection");

  if (
    conversation &&
    expectedIdentity &&
    (!requirements.requireProtectionIndicator || protection) &&
    matches(observation, contract, "streaming")
  ) {
    return result("streaming", true, "RESPONSE_STREAMING");
  }

  if (
    conversation &&
    composer &&
    expectedIdentity &&
    (!requirements.requireProtectionIndicator || protection)
  ) {
    return result("ready", true, "READY");
  }
  if (conversation && composer && !expectedIdentity) {
    return result("identity-unverified", false, "IDENTITY_NOT_VERIFIED");
  }
  if (conversation && composer && requirements.requireProtectionIndicator && !protection) {
    return result("protection-unverified", false, "PROTECTION_NOT_VERIFIED");
  }
  if (shell || conversation || composer || identity || protection) {
    return result("changed-selector", false, "UI_CONTRACT_QUORUM_FAILED");
  }
  return result("unknown", false, "UNKNOWN_PAGE_STATE");
}

export function groupMatches(snapshot: GroupSnapshot, minimumCandidateMatches: number): boolean {
  return (
    snapshot.matchedCandidates >= minimumCandidateMatches && snapshot.visibleElements > 0
  );
}

function matches(
  observation: CopilotPageObservation,
  contract: CopilotUiContract,
  signal: CopilotSignal,
): boolean {
  return groupMatches(observation[signal], contract.groups[signal].minimumCandidateMatches);
}

function identityTextMatches(snapshot: GroupSnapshot, expected: string | TextPattern): boolean {
  return snapshot.elements.some(
    (element) =>
      matchesText(expected, element.text) || matchesText(expected, element.accessibleLabel),
  );
}

function result(
  state: CopilotPageState,
  retryable: boolean,
  diagnosticCode: string,
): PageClassification {
  return { state, retryable, diagnosticCode };
}
