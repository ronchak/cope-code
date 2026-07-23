import { isAbsolute, resolve } from "node:path";

import { sha256 } from "../shared/crypto.js";
import {
  COPILOT_UI_CONTRACT_VERSION,
  pattern,
  type CopilotSignal,
  type CopilotUiContract,
  type LocatorGroup,
  type SemanticLocator,
  type TextPattern,
} from "./contracts.js";
import {
  BROWSER_CONTRACT_VERSION,
  isBrowserProduct,
  type BrowserProduct,
} from "./product.js";

export interface ApprovedHost {
  readonly hostname: string;
  readonly allowSubdomains?: boolean;
}

export interface BrowserWaitConfig {
  readonly actionMs: number;
  readonly submissionConfirmationMs: number;
  readonly responseMs: number;
  readonly manualReadinessMs: number;
  readonly pollMs: number;
  readonly stableSamples: number;
  readonly minimumStableMs: number;
}

export interface CopilotBrowserAdapterConfig {
  readonly entryUrl: string;
  readonly approvedHosts: readonly ApprovedHost[];
  /** Optional visible, manual-authentication redirect hosts; never valid for submission. */
  readonly manualAuthenticationHosts?: readonly ApprovedHost[];
  readonly uiContract: CopilotUiContract;
  /** Must identify the approved work/school account, never a credential. */
  readonly expectedIdentity: string | TextPattern;
  readonly requireProtectionIndicator: boolean;
  readonly maxMessageChars: number;
  readonly maxResponseChars: number;
  readonly waits: BrowserWaitConfig;
}

export interface BrowserLaunchConfig extends CopilotBrowserAdapterConfig {
  readonly product: BrowserProduct;
  readonly browserContractVersion: typeof BROWSER_CONTRACT_VERSION;
  /** Dedicated product-bound directory. Existing unmarked browser profiles are refused. */
  readonly profileDirectory: string;
  /** Explicit verified stable-browser binary selected by deployment configuration. */
  readonly browserExecutable: string;
  /** Recorded setup evidence. Legacy Edge v1 files acquire these in memory at load. */
  readonly browserVersion?: string;
  readonly browserExecutableSha256?: string;
}

/** @deprecated Compatibility alias for existing imports. */
export type EdgeLaunchConfig = BrowserLaunchConfig;

export const DEFAULT_BROWSER_WAITS: BrowserWaitConfig = Object.freeze({
  actionMs: 15_000,
  submissionConfirmationMs: 12_000,
  responseMs: 180_000,
  manualReadinessMs: 900_000,
  pollMs: 250,
  stableSamples: 3,
  minimumStableMs: 750,
});

const PROTECTION_ACCESSIBLE_NAME_PATTERN =
  "^(?:enterprise data protection|commercial data protection)$";
const ASSISTANT_MESSAGE_SELECTORS = [
  '[data-content="ai-message"]',
  '[data-author="assistant"]',
  '[data-testid*="assistant" i][data-testid*="message" i]',
  '[data-testid*="response" i][data-testid*="message" i]',
] as const;
const USER_MESSAGE_SELECTORS = [
  '[data-content="user-message"]',
  '[data-author="user"]',
  '[data-testid*="user" i][data-testid*="message" i]',
] as const;
const IDENTITY_CONTROL_SELECTORS = [
  'button[id*="mectrl" i]',
  '[role="button"][id*="mectrl" i]',
  'button[id*="mecontrol" i]',
  '[role="button"][id*="mecontrol" i]',
  'button[class*="mectrl" i]',
  '[role="button"][class*="mectrl" i]',
  'button[class*="me-control" i]',
  '[role="button"][class*="me-control" i]',
  'button[data-testid*="account-control" i]',
  '[role="button"][data-testid*="account-control" i]',
  'button[data-testid*="account-menu" i]',
  '[role="button"][data-testid*="account-menu" i]',
  'button[data-testid*="profile" i]',
  '[role="button"][data-testid*="profile" i]',
  'button[data-testid*="persona" i]',
  '[role="button"][data-testid*="persona" i]',
] as const;

/**
 * A conservative baseline. Deployments should certify and pin a replacement
 * when their approved Microsoft 365 Copilot surface differs.
 */
export function createBaselineCopilotUiContract(
  _expectedIdentity: string | TextPattern,
): CopilotUiContract {
  const groups: Record<CopilotSignal, LocatorGroup> = {
    shell: group(
      "shell",
      [
        { kind: "role", role: "main" },
        { kind: "css", selector: 'main, [role="main"]' },
      ],
      "presence",
    ),
    conversation: group(
      "conversation",
      [
        { kind: "role", role: "main" },
        { kind: "test-id", testId: pattern("chat|conversation") },
        {
          kind: "css",
          selector: 'main, [role="main"], [data-testid*="chat" i], [data-testid*="conversation" i]',
        },
      ],
      "presence",
    ),
    composer: group(
      "composer",
      [
        { kind: "role", role: "textbox", name: pattern("message|ask|copilot|prompt") },
        { kind: "placeholder", placeholder: pattern("message|ask|copilot|prompt") },
        { kind: "label", label: pattern("message|ask|copilot|prompt") },
        {
          kind: "css",
          selector: [
            'textarea[placeholder*="message" i]',
            'textarea[placeholder*="ask" i]',
            'textarea[placeholder*="copilot" i]',
            '[contenteditable="true"][role="textbox"][aria-label*="message" i]',
            '[contenteditable="true"][role="textbox"][aria-label*="ask" i]',
            '[contenteditable="true"][role="textbox"][aria-label*="copilot" i]',
          ].join(", "),
        },
      ],
      "value-and-text",
    ),
    send: group(
      "send",
      [
        { kind: "role", role: "button", name: pattern("send|submit") },
        {
          kind: "css",
          selector: 'button[aria-label*="send" i], [role="button"][aria-label*="send" i], button[data-testid*="send" i], [role="button"][data-testid*="send" i]',
        },
      ],
      "presence",
    ),
    responses: group(
      "responses",
      [
        {
          kind: "css",
          selector: ASSISTANT_MESSAGE_SELECTORS.join(", "),
        },
      ],
      "text",
      200,
    ),
    "user-messages": group(
      "user-messages",
      [
        {
          kind: "css",
          selector: USER_MESSAGE_SELECTORS.join(", "),
        },
      ],
      "text",
      200,
    ),
    streaming: group(
      "streaming",
      [
        { kind: "role", role: "progressbar" },
        { kind: "css", selector: '[aria-busy="true"]' },
      ],
      "presence",
    ),
    identity: group(
      "identity",
      [
        {
          kind: "css",
          selector: IDENTITY_CONTROL_SELECTORS.join(", "),
        },
      ],
      "text",
      50,
    ),
    protection: group(
      "protection",
      [
        {
          kind: "role",
          role: "status",
          name: pattern(PROTECTION_ACCESSIBLE_NAME_PATTERN),
        },
        {
          kind: "role",
          role: "img",
          name: pattern(PROTECTION_ACCESSIBLE_NAME_PATTERN),
        },
      ],
      "text",
    ),
    "signed-out": group(
      "signed-out",
      [
        { kind: "role", role: "button", name: pattern("sign in|log in|use another account") },
        { kind: "test-id", testId: pattern("sign.?in|login|account.?picker") },
        {
          kind: "css",
          selector: [
            'button[aria-label*="sign in" i]',
            'button[aria-label*="log in" i]',
            '[role="button"][aria-label*="sign in" i]',
            '[role="button"][aria-label*="log in" i]',
            'button[data-testid*="sign-in" i]',
            'button[data-testid*="signin" i]',
            '[role="button"][data-testid*="sign-in" i]',
            '[role="button"][data-testid*="signin" i]',
          ].join(", "),
        },
      ],
      "presence",
    ),
    mfa: group(
      "mfa",
      [
        { kind: "role", role: "textbox", name: pattern("verification code|security code|one.time code|passcode") },
        { kind: "label", label: pattern("verification code|security code|one.time code|passcode") },
        { kind: "placeholder", placeholder: pattern("verification code|security code|one.time code|passcode") },
        { kind: "role", role: "status", name: pattern("approve sign.in|check your authenticator|verification required") },
        { kind: "test-id", testId: pattern("mfa|multi.factor|verification.code|one.time.code|otp") },
        {
          kind: "css",
          selector: [
            'input[autocomplete="one-time-code"]',
            'input[name*="otp" i]',
            'input[name*="verification" i]',
            'input[id*="verification" i]',
            '[aria-label*="verification code" i]',
            '[aria-label*="security code" i]',
            '[data-testid*="mfa" i]',
            '[data-testid*="otp" i]',
          ].join(", "),
        },
      ],
      "presence",
    ),
    consent: group(
      "consent",
      [
        { kind: "role", role: "dialog", name: pattern("permissions requested|consent|review permissions|allow access") },
        { kind: "test-id", testId: pattern("consent|permissions") },
        {
          kind: "css",
          selector: [
            'form[action*="consent" i]',
            '[data-testid*="consent" i]',
            '[data-testid*="permission" i]',
            '[aria-label*="permissions requested" i]',
            '[aria-label*="consent" i]',
          ].join(", "),
        },
      ],
      "presence",
    ),
    throttled: group(
      "throttled",
      [{ kind: "text", text: pattern("too many requests|try again later|rate limit") }],
      "presence",
    ),
    "service-error": group(
      "service-error",
      [{ kind: "text", text: pattern("something went wrong|service unavailable|couldn't respond") }],
      "presence",
    ),
    modal: group("modal", [{ kind: "role", role: "dialog" }], "presence"),
  };
  return {
    version: `${COPILOT_UI_CONTRACT_VERSION}:m365-2026-07`,
    certifiedSurface: "Microsoft 365 Copilot Chat web",
    submissionStrategy: "send-control",
    groups,
  };
}

export function validateBrowserConfig(config: CopilotBrowserAdapterConfig): void {
  assertExactKeys(config, [
    "entryUrl",
    "approvedHosts",
    "manualAuthenticationHosts",
    "uiContract",
    "expectedIdentity",
    "requireProtectionIndicator",
    "maxMessageChars",
    "maxResponseChars",
    "waits",
  ], "browser adapter configuration");
  validateBrowserConfigContents(config);
}

function validateBrowserConfigContents(config: CopilotBrowserAdapterConfig): void {
  const entry = parseHttpsUrl(config.entryUrl, "entryUrl");
  if (!Array.isArray(config.approvedHosts) || config.approvedHosts.length === 0) {
    throw new TypeError("At least one approved host is required");
  }
  for (const approved of config.approvedHosts) validateApprovedHost(approved);
  if (config.manualAuthenticationHosts !== undefined && !Array.isArray(config.manualAuthenticationHosts)) {
    throw new TypeError("manualAuthenticationHosts must be an array");
  }
  for (const authenticationHost of config.manualAuthenticationHosts ?? []) {
    validateApprovedHost(authenticationHost);
  }
  if (!isApprovedUrl(entry, config.approvedHosts)) {
    throw new TypeError("entryUrl is not on an approved host");
  }
  validateTextValue(config.expectedIdentity, "expectedIdentity");
  if (typeof config.requireProtectionIndicator !== "boolean") {
    throw new TypeError("requireProtectionIndicator must be boolean");
  }
  if (
    !Number.isSafeInteger(config.maxMessageChars) ||
    !Number.isSafeInteger(config.maxResponseChars) ||
    config.maxMessageChars < 1 ||
    config.maxResponseChars < 1
  ) {
    throw new TypeError("Message and response bounds must be positive");
  }
  validateWaits(config.waits);
  validateUiContract(config.uiContract);
}

export function validateBrowserLaunchConfig(config: BrowserLaunchConfig): void {
  assertExactKeys(config, [
    "entryUrl",
    "approvedHosts",
    "manualAuthenticationHosts",
    "uiContract",
    "expectedIdentity",
    "requireProtectionIndicator",
    "maxMessageChars",
    "maxResponseChars",
    "waits",
    "product",
    "browserContractVersion",
    "profileDirectory",
    "browserExecutable",
    "browserVersion",
    "browserExecutableSha256",
  ], "browser launch configuration");
  validateBrowserConfigContents(config);
  if (!isBrowserProduct(config.product)) throw new TypeError("product must be edge or chrome");
  if (config.browserContractVersion !== BROWSER_CONTRACT_VERSION) {
    throw new TypeError(`Unsupported browser contract version: ${config.browserContractVersion}`);
  }
  validateBrowserProfileDirectoryPath(config.profileDirectory);
  if (!isAbsolute(config.browserExecutable)) {
    throw new TypeError("browserExecutable must be an absolute stable-browser path");
  }
  if (config.browserVersion !== undefined && !/^\d+(?:\.\d+){1,3}$/u.test(config.browserVersion)) {
    throw new TypeError("browserVersion is invalid");
  }
  if (
    config.browserExecutableSha256 !== undefined &&
    !/^[a-f0-9]{64}$/u.test(config.browserExecutableSha256)
  ) {
    throw new TypeError("browserExecutableSha256 is invalid");
  }
}

/** @deprecated Compatibility alias for existing imports. */
export function validateEdgeLaunchConfig(config: EdgeLaunchConfig): void {
  validateBrowserLaunchConfig(config);
}

/**
 * Reject path namespaces that can bypass ordinary local-path assumptions. The
 * canonical/prospective containment check is performed while loading live
 * configuration, once the repository and state roots are known.
 */
export function validateBrowserProfileDirectoryPath(profileDirectory: string): void {
  if (profileDirectory.includes("\0")) {
    throw new TypeError("profileDirectory must not contain NUL characters");
  }
  const windowsForm = profileDirectory.replaceAll("\\", "/");
  if (
    windowsForm.startsWith("//") ||
    /^\/(?:\?\?|device)\//iu.test(windowsForm)
  ) {
    throw new TypeError("profileDirectory must be local; UNC, device, and shared paths are not allowed");
  }
  if (!isAbsolute(profileDirectory)) {
    throw new TypeError("profileDirectory must be an absolute dedicated path");
  }
  if (resolve(profileDirectory) === resolve(profileDirectory, "..")) {
    throw new TypeError("profileDirectory is not a usable dedicated path");
  }
}

/** @deprecated Compatibility alias for existing imports. */
export function validateEdgeProfileDirectoryPath(profileDirectory: string): void {
  validateBrowserProfileDirectoryPath(profileDirectory);
}

export function isApprovedUrl(url: URL | string, hosts: readonly ApprovedHost[]): boolean {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.port !== "" && parsed.port !== "443")
  ) return false;
  const actual = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  return hosts.some((approved) => {
    const expected = approved.hostname.toLowerCase().replace(/\.$/u, "");
    return actual === expected || (approved.allowSubdomains === true && actual.endsWith(`.${expected}`));
  });
}

/** Local-only identifier; diagnostics must not expose it. */
export function conversationIdFromUrl(value: string): string {
  const url = new URL(value);
  return `browser-conversation:${sha256(`${url.origin}${url.pathname}${url.search}`).slice(0, 32)}`;
}

function parseHttpsUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${field} must be an absolute URL`);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new TypeError(`${field} must be an HTTPS URL without embedded credentials`);
  }
  return url;
}

function validateApprovedHost(host: ApprovedHost): void {
  assertExactKeys(host, ["hostname", "allowSubdomains"], "approved host");
  if (host.allowSubdomains !== undefined && typeof host.allowSubdomains !== "boolean") {
    throw new TypeError("Approved-host allowSubdomains must be boolean");
  }
  if (typeof host.hostname !== "string") throw new TypeError("Approved hostname must be a string");
  const normalized = host.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    normalized.length === 0 ||
    normalized.length > 253 ||
    normalized.includes("/") ||
    normalized.includes(":") ||
    normalized.includes("*") ||
    normalized.startsWith(".") ||
    normalized.includes("..") ||
    !normalized.split(".").every((label) =>
      label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))
  ) {
    throw new TypeError(`Invalid approved hostname: ${host.hostname}`);
  }
}

function validateWaits(waits: BrowserWaitConfig): void {
  assertExactKeys(waits, [
    "actionMs",
    "submissionConfirmationMs",
    "responseMs",
    "manualReadinessMs",
    "pollMs",
    "stableSamples",
    "minimumStableMs",
  ], "browser waits");
  const finitePositive = Object.entries(waits).every(
    ([, value]) => Number.isSafeInteger(value) && value > 0,
  );
  if (!finitePositive || waits.pollMs > waits.responseMs || waits.stableSamples < 2) {
    throw new TypeError("Browser waits must be positive, bounded, and use at least two stable samples");
  }
}

function validateUiContract(contract: CopilotUiContract): void {
  assertExactKeys(contract, ["version", "certifiedSurface", "submissionStrategy", "groups"], "UI contract");
  if (
    typeof contract.version !== "string" ||
    contract.version.length > 256 ||
    contract.version !== COPILOT_UI_CONTRACT_VERSION &&
    !contract.version.startsWith(`${COPILOT_UI_CONTRACT_VERSION}:`)
  ) {
    throw new TypeError(`Unsupported UI contract version: ${contract.version}`);
  }
  if (
    typeof contract.certifiedSurface !== "string" ||
    contract.certifiedSurface.trim() === "" ||
    contract.certifiedSurface.length > 4_096
  ) {
    throw new TypeError("UI contract certified surface is invalid");
  }
  if (contract.submissionStrategy !== "send-control") {
    throw new TypeError("Only the send-control UI submission strategy is supported");
  }
  const expectedSignals: readonly CopilotSignal[] = [
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
  assertExactKeys(contract.groups, expectedSignals, "UI contract groups");
  for (const signal of expectedSignals) {
    const groupValue = contract.groups[signal];
    assertExactKeys(
      groupValue,
      ["signal", "candidates", "minimumCandidateMatches", "maximumElements", "capture"],
      `locator group ${signal}`,
    );
    if (
      groupValue.signal !== signal ||
      !Array.isArray(groupValue.candidates) ||
      groupValue.candidates.length === 0 ||
      groupValue.candidates.length > 64 ||
      !Number.isSafeInteger(groupValue.minimumCandidateMatches) ||
      groupValue.minimumCandidateMatches < 1 ||
      groupValue.minimumCandidateMatches > groupValue.candidates.length ||
      !Number.isSafeInteger(groupValue.maximumElements) ||
      groupValue.maximumElements < 1 ||
      groupValue.maximumElements > 500
    ) {
      throw new TypeError(`Invalid locator group: ${signal}`);
    }
    if (!( ["presence", "text", "value-and-text"] as const).includes(groupValue.capture)) {
      throw new TypeError(`Invalid locator group capture: ${signal}`);
    }
    for (const candidate of groupValue.candidates) validateLocator(candidate);
    if (signal === "protection") validateProtectionLocators(groupValue.candidates);
    if (signal === "identity") {
      validateImmutableOwnedLocatorGroup(groupValue, canonicalIdentityGroup());
    }
    if (signal === "responses") {
      validateImmutableOwnedLocatorGroup(groupValue, canonicalResponsesGroup());
    }
    if (signal === "user-messages") {
      validateImmutableOwnedLocatorGroup(groupValue, canonicalUserMessagesGroup());
    }
  }
}

function validateImmutableOwnedLocatorGroup(
  groupValue: LocatorGroup,
  canonical: LocatorGroup,
): void {
  const candidate = groupValue.candidates[0];
  const canonicalCandidate = canonical.candidates[0];
  if (
    groupValue.signal !== canonical.signal ||
    groupValue.minimumCandidateMatches !== canonical.minimumCandidateMatches ||
    groupValue.maximumElements !== canonical.maximumElements ||
    groupValue.capture !== canonical.capture ||
    groupValue.candidates.length !== 1 ||
    candidate?.kind !== "css" ||
    canonicalCandidate?.kind !== "css" ||
    candidate.selector !== canonicalCandidate.selector
  ) {
    throw new TypeError(
      `${canonical.signal} locator group is an immutable ownership boundary`,
    );
  }
}

function canonicalIdentityGroup(): LocatorGroup {
  return group("identity", [{ kind: "css", selector: IDENTITY_CONTROL_SELECTORS.join(", ") }], "text", 50);
}

function canonicalResponsesGroup(): LocatorGroup {
  return group("responses", [{ kind: "css", selector: ASSISTANT_MESSAGE_SELECTORS.join(", ") }], "text", 200);
}

function canonicalUserMessagesGroup(): LocatorGroup {
  return group("user-messages", [{ kind: "css", selector: USER_MESSAGE_SELECTORS.join(", ") }], "text", 200);
}

function validateProtectionLocators(candidates: readonly SemanticLocator[]): void {
  for (const candidate of candidates) {
    if (
      candidate.kind !== "role" ||
      (candidate.role !== "status" && candidate.role !== "img") ||
      candidate.name === undefined
    ) {
      throw new TypeError(
        "Protection locators must use status or img roles with an exact positive accessible name",
      );
    }
    if (typeof candidate.name === "string") {
      const normalized = candidate.name.trim().toLowerCase();
      if (
        candidate.exact !== true ||
        (normalized !== "enterprise data protection" &&
          normalized !== "commercial data protection")
      ) {
        throw new TypeError("Protection accessible names must be exact and positive");
      }
      continue;
    }
    if (candidate.name.source !== PROTECTION_ACCESSIBLE_NAME_PATTERN) {
      throw new TypeError("Protection accessible-name patterns must be anchored and positive");
    }
  }
}

function validateLocator(locator: SemanticLocator): void {
  switch (locator.kind) {
    case "role":
      assertExactKeys(locator, ["kind", "role", "name", "exact"], "role locator");
      if (typeof locator.role !== "string" || locator.role.trim() === "" || locator.role.length > 256) {
        throw new TypeError("Role locator role is invalid");
      }
      if (locator.name !== undefined) validateTextValue(locator.name, "role locator name");
      validateOptionalExact(locator.exact, "role locator");
      return;
    case "label":
      assertExactKeys(locator, ["kind", "label", "exact"], "label locator");
      validateTextValue(locator.label, "label locator label");
      validateOptionalExact(locator.exact, "label locator");
      return;
    case "placeholder":
      assertExactKeys(locator, ["kind", "placeholder", "exact"], "placeholder locator");
      validateTextValue(locator.placeholder, "placeholder locator value");
      validateOptionalExact(locator.exact, "placeholder locator");
      return;
    case "test-id":
      assertExactKeys(locator, ["kind", "testId"], "test-id locator");
      validateTextValue(locator.testId, "test-id locator value");
      return;
    case "text":
      assertExactKeys(locator, ["kind", "text", "exact"], "text locator");
      validateTextValue(locator.text, "text locator value");
      validateOptionalExact(locator.exact, "text locator");
      return;
    case "css":
      assertExactKeys(locator, ["kind", "selector"], "CSS locator");
      if (
        typeof locator.selector !== "string" ||
        locator.selector.trim().length === 0 ||
        locator.selector.length > 4_096 ||
        locator.selector.includes("xpath=")
      ) {
        throw new TypeError("CSS fallback must be non-empty and cannot contain XPath");
      }
      return;
    default:
      throw new TypeError("Unsupported semantic locator kind");
  }
}

function validateTextValue(value: string | TextPattern, label: string): void {
  if (typeof value === "string") {
    if (value.trim() === "" || value.length > 4_096) throw new TypeError(`${label} is empty or oversized`);
    return;
  }
  assertExactKeys(value, ["source", "flags"], `${label} pattern`);
  if (typeof value.source !== "string" || value.source.length === 0 || value.source.length > 4_096) {
    throw new TypeError(`${label} pattern source is invalid`);
  }
  if (value.flags !== undefined && !( ["i", "u", "iu"] as const).includes(value.flags)) {
    throw new TypeError(`${label} pattern flags are invalid`);
  }
  try {
    void new RegExp(value.source, value.flags ?? "u");
  } catch {
    throw new TypeError(`${label} pattern is invalid`);
  }
}

function validateOptionalExact(value: boolean | undefined, label: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new TypeError(`${label} exact flag is invalid`);
  }
}

function assertExactKeys(
  value: object,
  allowed: readonly string[],
  label: string,
): void {
  if (value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new TypeError(`${label} contains unknown fields: ${unknown.join(", ")}`);
}

function group(
  signal: CopilotSignal,
  candidates: readonly SemanticLocator[],
  capture: LocatorGroup["capture"],
  maximumElements = 20,
): LocatorGroup {
  return { signal, candidates, minimumCandidateMatches: 1, maximumElements, capture };
}
