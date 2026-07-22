import {
  matchesText,
  type CopilotPageObservation,
  type CopilotSignal,
  type CopilotUiContract,
  type ElementSnapshot,
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

// Setup/manual readiness proves whether the current page is safe and actionable;
// it never consumes historical prompt or response text. Keep transcript capture
// out of this path so a large authenticated conversation cannot turn an
// otherwise ready page into a session-revoking observation timeout. Submission
// and response correlation continue to use the full SIGNALS observation below.
const READINESS_SIGNALS: readonly CopilotSignal[] = SIGNALS.filter(
  (signal) => signal !== "responses" && signal !== "user-messages",
);

export async function observeCopilotPage(
  page: SemanticPage,
  contract: CopilotUiContract,
): Promise<CopilotPageObservation> {
  return observeSignals(page, contract, SIGNALS);
}

export async function observeCopilotReadinessPage(
  page: SemanticPage,
  contract: CopilotUiContract,
): Promise<CopilotPageObservation> {
  return observeSignals(page, contract, READINESS_SIGNALS);
}

async function observeSignals(
  page: SemanticPage,
  contract: CopilotUiContract,
  signals: readonly CopilotSignal[],
): Promise<CopilotPageObservation> {
  const url = await page.currentUrl();
  const entries = await Promise.all(
    signals.map(async (signal) => [signal, await page.snapshot(contract.groups[signal])] as const),
  );
  const emptyEntries = SIGNALS.map((signal) => [signal, emptySnapshot(signal)] as const);
  return {
    url,
    ...Object.fromEntries(emptyEntries),
    ...Object.fromEntries(entries),
  } as CopilotPageObservation;
}

function emptySnapshot(signal: CopilotSignal): GroupSnapshot {
  return {
    signal,
    matchedCandidates: 0,
    visibleElements: 0,
    enabledElements: 0,
    elements: [],
  };
}

export function classifyCopilotPage(
  observation: CopilotPageObservation,
  contract: CopilotUiContract,
  requirements: ClassifierRequirements,
): PageClassification {
  const modal = matches(observation, contract, "modal");
  if (modal && observation.modal.enabledElements === 0) {
    // Native JavaScript dialogs are sticky for the lifetime of the page because
    // Cope never accepts or dismisses them. Classify them before host and
    // configured-surface gates so a dialog on a Microsoft authentication page
    // cannot inherit the long manual-authentication window.
    return result("blocking-modal", false, "NATIVE_BROWSER_DIALOG_DETECTED");
  }

  if (!isApprovedUrl(observation.url, requirements.approvedHosts)) {
    return result("unapproved-host", false, "HOST_NOT_APPROVED");
  }

  const withinConfiguredSurface = isWithinConfiguredCopilotPath(
    observation.url,
    requirements.entryUrl,
  );
  const sameOriginAuthentication = !withinConfiguredSurface &&
    isSameOriginAuthenticationUrl(observation.url, requirements.entryUrl);

  // Generic sign-in, MFA, and consent text on an unrelated approved-host page
  // must not buy the ten-minute manual window. Outside the configured chat path,
  // the URL itself must also have a genuine authentication shape.
  if (!withinConfiguredSurface && !sameOriginAuthentication) {
    return result("unapproved-host", false, "COPILOT_SURFACE_NOT_APPROVED");
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

  // On an already actionable configured chat, manual-authentication phrases or
  // links can be ordinary conversation content. They only override that surface
  // when the composer is not actionable or a real blocking dialog is visible.
  const manualEvidenceCanOverride = !withinConfiguredSurface || !actionableComposer || modal;
  if (manualEvidenceCanOverride && matches(observation, contract, "mfa")) {
    return result("mfa-required", true, "MANUAL_MFA_REQUIRED");
  }
  if (manualEvidenceCanOverride && matches(observation, contract, "consent")) {
    return result("consent-required", true, "MANUAL_CONSENT_REQUIRED");
  }
  if (manualEvidenceCanOverride && matches(observation, contract, "signed-out")) {
    return result("sign-in-required", true, "MANUAL_SIGN_IN_REQUIRED");
  }

  // A same-origin authentication-shaped URL without explicit visible manual
  // evidence stays bounded. External Microsoft login hosts are handled by the
  // Edge transport's separately validated authentication-redirect exception.
  if (!withinConfiguredSurface) {
    return result("unapproved-host", false, "COPILOT_SURFACE_NOT_APPROVED");
  }

  if (modal) {
    // Recoverable DOM dialogs remain visible to the operator. Cope never
    // interacts with or submits through them, and readiness may recover after
    // the operator closes or completes the dialog. Dialog ownership takes
    // precedence over generic page-wide throttling or service-error text.
    return result("blocking-modal", false, "UNEXPECTED_BLOCKING_MODAL");
  }
  if (matches(observation, contract, "throttled")) {
    return result("throttled", true, "SERVICE_THROTTLED");
  }
  if (matches(observation, contract, "service-error")) {
    return result("service-error", true, "COPILOT_SERVICE_ERROR");
  }

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
  if (snapshot.elements.length === 0) return false;
  const snapshotAddresses = new Set(
    snapshot.elements.flatMap((element) =>
      [element.text, element.accessibleLabel]
        .map((channel) => channel.normalize("NFKC").trim())
        .filter((channel) => channel !== "")
        .flatMap((channel) => extractEmailAddresses(channel))),
  );
  // Conflicting explicit accounts remain ambiguous even when a trusted pattern
  // happens to match every address independently.
  if (snapshotAddresses.size > 1) return false;
  // The canonical ownership locator can see both the current account button
  // and alternate-profile controls in an open account menu. Never accept the
  // expected identity merely because it appears somewhere in that set: every
  // visible account control must consistently identify the configured account.
  const elementIdentities = snapshot.elements.map((element) =>
    identityElementIdentity(element, expected));
  return elementIdentities.every((identity) => identity !== undefined) &&
    new Set(elementIdentities).size === 1;
}

function identityElementIdentity(
  element: ElementSnapshot,
  expected: string | TextPattern,
): string | undefined {
  const channels = [element.text, element.accessibleLabel]
    .map((channel) => channel.normalize("NFKC").trim())
    .filter((channel) => channel !== "");
  if (channels.length === 0) return undefined;

  const addresses = new Set(channels.flatMap((channel) => extractEmailAddresses(channel)));
  if (addresses.size > 1) return undefined;

  const evidence = channels.map((channel) => ({
    channel,
    subject: identityChannelSubject(channel),
  }));
  // Unparseable or mixed name/email payloads are explicit ambiguity, not
  // generic chrome. Only exact allowlisted UI labels may be ignored.
  if (evidence.some((entry) => entry.subject === undefined)) return undefined;
  const explicit = evidence.filter(
    (entry): entry is { channel: string; subject: IdentitySubject } =>
      entry.subject !== undefined && entry.subject !== GENERIC_IDENTITY_LABEL,
  );
  if (explicit.length === 0) return undefined;

  if (typeof expected === "string") {
    // Every explicit text/ARIA channel must independently verify the literal
    // identity. One matching channel can never override another person's name.
    if (!explicit.every((entry) => identityStringMatches(entry.channel, expected))) {
      return undefined;
    }
    const expectedComparable = expected.normalize("NFKC").trim().toLowerCase();
    return expectedComparable.includes("@")
      ? `email:${expectedComparable}`
      : `literal:${[...identityTokens(expectedComparable)].sort().join("\u0000")}`;
  }

  // Patterns apply only to the parsed identity subject, never account/profile
  // wrapper words. Every explicit channel must match and identify one account.
  if (!explicit.every((entry) => matchesText(expected, entry.subject.subject))) {
    return undefined;
  }
  const keys = new Set(explicit.map((entry) => entry.subject.key));
  return keys.size === 1 ? explicit[0]!.subject.key : undefined;
}

interface IdentitySubject {
  readonly subject: string;
  readonly key: string;
}

const GENERIC_IDENTITY_LABEL = Symbol("generic-identity-label");

const GENERIC_IDENTITY_LABELS = new Set([
  "account",
  "account manager",
  "account menu",
  "current account",
  "manage account",
  "microsoft account",
  "personal account",
  "profile",
  "profile menu",
  "switch account",
  "user account",
  "work account",
]);

const IDENTITY_PREFIX_PHRASES: readonly (readonly string[])[] = [
  ["current", "account"],
  ["account", "manager"],
  ["manage", "account"],
  ["microsoft", "account"],
  ["personal", "account"],
  ["switch", "account"],
  ["switch", "to"],
  ["user", "account"],
  ["work", "account"],
  ["account"],
  ["profile"],
];

const IDENTITY_SUFFIX_PHRASES: readonly (readonly string[])[] = [
  ["account", "manager"],
  ["account", "menu"],
  ["profile", "menu"],
  ["microsoft", "account"],
  ["personal", "account"],
  ["user", "account"],
  ["work", "account"],
  ["account"],
  ["profile"],
];

function identityChannelSubject(
  channel: string,
): IdentitySubject | typeof GENERIC_IDENTITY_LABEL | undefined {
  const comparable = channel.normalize("NFKC").trim();
  const lowerComparable = comparable.toLowerCase();
  if (GENERIC_IDENTITY_LABELS.has(lowerComparable)) return GENERIC_IDENTITY_LABEL;

  const addresses = extractEmailAddresses(channel);
  if (addresses.length > 1) return undefined;
  if (addresses.length === 1) {
    const match = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/iu.exec(comparable);
    if (match === null || match.index === undefined) return undefined;
    const prefixTokens = identityTokens(comparable.slice(0, match.index));
    const suffixTokens = identityTokens(comparable.slice(match.index + match[0].length));
    if (
      !isEmptyOrExactWrapper(prefixTokens, IDENTITY_PREFIX_PHRASES) ||
      !isEmptyOrExactWrapper(suffixTokens, IDENTITY_SUFFIX_PHRASES)
    ) {
      return undefined;
    }
    return { subject: addresses[0]!, key: `email:${addresses[0]}` };
  }

  const channelTokens = comparable.match(/[\p{L}\p{N}]+/gu) ?? [];
  const subjectTokens = stripBoundaryWrapperPhrases(channelTokens);
  if (subjectTokens.length === 0) return undefined;
  const keyTokens = subjectTokens.map((token) =>
    token.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase());
  return {
    subject: subjectTokens.join(" "),
    key: `name:${keyTokens.join("\u0000")}`,
  };
}

function isEmptyOrExactWrapper(
  tokens: readonly string[],
  phrases: readonly (readonly string[])[],
): boolean {
  return tokens.length === 0 || phrases.some((phrase) => equalTokenSequence(tokens, phrase));
}

function stripBoundaryWrapperPhrases(tokens: readonly string[]): readonly string[] {
  let start = 0;
  let end = tokens.length;
  const lower = tokens.map((token) => token.toLowerCase());
  const prefix = IDENTITY_PREFIX_PHRASES.find((phrase) =>
    phrase.length <= end && equalTokenSequence(lower.slice(0, phrase.length), phrase));
  if (prefix !== undefined) start += prefix.length;
  const suffix = IDENTITY_SUFFIX_PHRASES.find((phrase) =>
    phrase.length <= end - start &&
    equalTokenSequence(lower.slice(end - phrase.length, end), phrase));
  if (suffix !== undefined) end -= suffix.length;
  return tokens.slice(start, end);
}

/**
 * Microsoft account controls commonly render a display name in surname-first
 * order or wrap the configured email in additional account text. Matching is
 * limited to exactly one complete email address or contiguous display-name
 * token order, including the common last-name-first rotation. Display names
 * must occupy the entire account-control value so labels for another account
 * cannot satisfy the identity gate by merely containing the expected name.
 */
function identityStringMatches(candidate: string, expected: string): boolean {
  const expectedComparable = expected.normalize("NFKC").trim().toLowerCase();
  const candidateComparable = candidate.normalize("NFKC").trim().toLowerCase();
  if (expectedComparable === "" || candidateComparable === "") return false;

  if (expectedComparable.includes("@")) {
    const addresses = extractEmailAddresses(candidateComparable);
    return addresses.length === 1 && addresses[0] === expectedComparable;
  }

  const expectedTokens = identityTokens(expectedComparable);
  const candidateTokens = identityTokens(candidateComparable);
  if (expectedTokens.length === 0) return false;
  const surnameFirst = expectedTokens.length < 2
    ? expectedTokens
    : [expectedTokens.at(-1)!, ...expectedTokens.slice(0, -1)];
  return equalTokenSequence(candidateTokens, expectedTokens) ||
    equalTokenSequence(candidateTokens, surnameFirst);
}

function extractEmailAddresses(value: string): readonly string[] {
  return value.match(
    /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/giu,
  )?.map((entry) => entry.toLowerCase()) ?? [];
}

function identityTokens(value: string): readonly string[] {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function equalTokenSequence(
  candidate: readonly string[],
  expected: readonly string[],
): boolean {
  return candidate.length === expected.length &&
    expected.every((token, index) => candidate[index] === token);
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

function isSameOriginAuthenticationUrl(value: string, entryValue: string): boolean {
  let actual: URL;
  let entry: URL;
  try {
    actual = new URL(value);
    entry = new URL(entryValue);
  } catch {
    return false;
  }
  if (actual.origin !== entry.origin) return false;

  const path = normalizedPath(actual.pathname).toLowerCase();
  if (/(?:^|\/)(?:auth|authorize|federation|kmsi|login|oauth2?|ppsecure|sas|signin)(?:\/|$|\.)/iu.test(path)) {
    return true;
  }

  const oauthCoreCount = [
    "client_id",
    "code_challenge",
    "redirect_uri",
    "response_type",
  ].filter((key) => actual.searchParams.has(key)).length;
  const oauthSupportCount = [
    "login_hint",
    "prompt",
    "sso_reload",
    "state",
  ].filter((key) => actual.searchParams.has(key)).length;
  return oauthCoreCount >= 2 || (oauthCoreCount >= 1 && oauthSupportCount >= 1);
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
