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
  readonly entryUrl: string;
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

  // Same-host Microsoft transitions can temporarily leave the configured chat
  // path. Keep only explicit manual-authentication evidence retryable; arbitrary
  // approved-host pages still fail the path check below.
  if (matches(observation, contract, "mfa")) {
    return result("mfa-required", true, "MANUAL_MFA_REQUIRED");
  }
  if (matches(observation, contract, "consent")) {
    return result("consent-required", true, "MANUAL_CONSENT_REQUIRED");
  }
  if (matches(observation, contract, "signed-out")) {
    return result("sign-in-required", true, "MANUAL_SIGN_IN_REQUIRED");
  }

  if (!isWithinConfiguredCopilotPath(observation.url, requirements.entryUrl)) {
    return result("unapproved-host", false, "COPILOT_SURFACE_NOT_APPROVED");
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
  const actionableComposer = groupActionable(
    observation.composer,
    contract.groups.composer.minimumCandidateMatches,
  );
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
    actionableComposer &&
    expectedIdentity &&
    (!requirements.requireProtectionIndicator || protection)
  ) {
    return result("ready", true, "READY");
  }
  if (conversation && actionableComposer && !expectedIdentity) {
    return result("identity-unverified", false, "IDENTITY_NOT_VERIFIED");
  }
  if (
    conversation &&
    actionableComposer &&
    requirements.requireProtectionIndicator &&
    !protection
  ) {
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

function groupActionable(snapshot: GroupSnapshot, minimumCandidateMatches: number): boolean {
  return snapshot.matchedCandidates >= minimumCandidateMatches && snapshot.enabledElements > 0;
}

function matches(
  observation: CopilotPageObservation,
  contract: CopilotUiContract,
  signal: CopilotSignal,
): boolean {
  return groupMatches(observation[signal], contract.groups[signal].minimumCandidateMatches);
}

function identityTextMatches(snapshot: GroupSnapshot, expected: string | TextPattern): boolean {
  if (typeof expected !== "string") {
    return snapshot.elements.some(
      (element) =>
        matchesText(expected, element.text) || matchesText(expected, element.accessibleLabel),
    );
  }
  return snapshot.elements.some(
    (element) =>
      identityStringMatches(element.text, expected) ||
      identityStringMatches(element.accessibleLabel, expected),
  );
}

/**
 * Microsoft account controls commonly render a display name in surname-first
 * order or wrap the configured email in additional account text. Matching is
 * limited to complete email addresses or contiguous display-name token order,
 * including the common last-name-first rotation.
 */
function identityStringMatches(candidate: string, expected: string): boolean {
  const expectedComparable = expected.normalize("NFKC").trim().toLocaleLowerCase();
  const candidateComparable = candidate.normalize("NFKC").trim().toLocaleLowerCase();
  if (expectedComparable === "" || candidateComparable === "") return false;

  if (expectedComparable.includes("@")) {
    return extractEmailAddresses(candidateComparable).includes(expectedComparable);
  }

  const expectedTokens = identityTokens(expectedComparable);
  const candidateTokens = identityTokens(candidateComparable);
  if (expectedTokens.length === 0) return false;
  const surnameFirst = expectedTokens.length < 2
    ? expectedTokens
    : [expectedTokens.at(-1)!, ...expectedTokens.slice(0, -1)];
  return containsTokenSequence(candidateTokens, expectedTokens) ||
    containsTokenSequence(candidateTokens, surnameFirst);
}

function extractEmailAddresses(value: string): readonly string[] {
  return value.match(
    /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/giu,
  )?.map((entry) => entry.toLocaleLowerCase()) ?? [];
}

function identityTokens(value: string): readonly string[] {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function containsTokenSequence(
  candidate: readonly string[],
  expected: readonly string[],
): boolean {
  if (expected.length === 0 || expected.length > candidate.length) return false;
  for (let start = 0; start <= candidate.length - expected.length; start += 1) {
    if (expected.every((token, offset) => candidate[start + offset] === token)) return true;
  }
  return false;
}

/**
 * Broad host approval is not enough once the UI contract includes semantic
 * fallbacks. Submission-capable classification is limited to the configured
 * Copilot origin and entry path, including descendants such as
 * /chat/conversation/... .
 */
function isWithinConfiguredCopilotPath(value: string, entryValue: string): boolean {
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

function normalizedPath(value: string): string {
  const withoutTrailingSlash = value.replace(/\/+$/u, "");
  return withoutTrailingSlash === "" ? "/" : withoutTrailingSlash;
}

function result(
  state: CopilotPageState,
  retryable: boolean,
  diagnosticCode: string,
): PageClassification {
  return { state, retryable, diagnosticCode };
}
