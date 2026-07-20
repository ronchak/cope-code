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

export interface EdgeLaunchConfig extends CopilotBrowserAdapterConfig {
  /** Dedicated directory. Existing unmarked browser profiles are refused. */
  readonly profileDirectory: string;
  /** Explicit system Edge binary selected by deployment configuration. */
  readonly edgeExecutable?: string;
}

export const DEFAULT_BROWSER_WAITS: BrowserWaitConfig = Object.freeze({
  actionMs: 15_000,
  submissionConfirmationMs: 12_000,
  responseMs: 180_000,
  manualReadinessMs: 600_000,
  pollMs: 250,
  stableSamples: 3,
  minimumStableMs: 750,
});

/**
 * A conservative baseline. Deployments should certify and pin a replacement
 * when their approved Microsoft 365 Copilot surface differs.
 */
export function createBaselineCopilotUiContract(
  expectedIdentity: string | TextPattern,
): CopilotUiContract {
  const flexibleIdentity = identityLocatorPattern(expectedIdentity);
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
          selector: 'button[aria-label*="send" i], [role="button"][aria-label*="send" i], [data-testid*="send" i]',
        },
      ],
      "presence",
    ),
    responses: group(
      "responses",
      [
        { kind: "test-id", testId: pattern("assistant.*message|ai.*message|response.*message|message.*response") },
        {
          kind: "css",
          selector: '[data-content="ai-message"], [data-author="assistant"], [data-testid*="assistant" i][data-testid*="message" i], [data-testid*="response" i][data-testid*="message" i]',
        },
      ],
      "text",
      200,
    ),
    "user-messages": group(
      "user-messages",
      [
        { kind: "test-id", testId: pattern("user.*message") },
        {
          kind: "css",
          selector: '[data-content="user-message"], [data-author="user"], [data-testid*="user" i][data-testid*="message" i]',
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
        { kind: "role", role: "button", name: expectedIdentity },
        { kind: "role", role: "button", name: flexibleIdentity },
        { kind: "role", role: "link", name: expectedIdentity },
        { kind: "role", role: "link", name: flexibleIdentity },
      ],
      "text",
      50,
    ),
    protection: group(
      "protection",
      [
        { kind: "text", text: pattern("enterprise data protection|protected") },
        { kind: "test-id", testId: pattern("protection|commercial-data-protection") },
      ],
      "text",
    ),
    "signed-out": group(
      "signed-out",
      [
        { kind: "role", role: "button", name: pattern("sign in|log in") },
        { kind: "role", role: "link", name: pattern("sign in|log in") },
      ],
      "presence",
    ),
    mfa: group(
      "mfa",
      [{ kind: "text", text: pattern("approve sign.in|verification code|multi.factor") }],
      "presence",
    ),
    consent: group(
      "consent",
      [{ kind: "text", text: pattern("permissions requested|consent|accept") }],
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

export function validateEdgeLaunchConfig(config: EdgeLaunchConfig): void {
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
    "profileDirectory",
    "edgeExecutable",
  ], "Edge launch configuration");
  validateBrowserConfigContents(config);
  validateEdgeProfileDirectoryPath(config.profileDirectory);
  if (config.edgeExecutable !== undefined && !isAbsolute(config.edgeExecutable)) {
    throw new TypeError("edgeExecutable must be an absolute system Edge path");
  }
}

/**
 * Reject path namespaces that can bypass ordinary local-path assumptions. The
 * canonical/prospective containment check is performed while loading live
 * configuration, once the repository and state roots are known.
 */
export function validateEdgeProfileDirectoryPath(profileDirectory: string): void {
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
  if (
    contract.submissionStrategy !== "send-control" &&
    contract.submissionStrategy !== "composer-enter"
  ) {
    throw new TypeError("UI contract submission strategy is invalid");
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
      groupValue.maximumElements < 1
    ) {
      throw new TypeError(`Invalid locator group: ${signal}`);
    }
    if (!( ["presence", "text", "value-and-text"] as const).includes(groupValue.capture)) {
      throw new TypeError(`Invalid locator group capture: ${signal}`);
    }
    for (const candidate of groupValue.candidates) validateLocator(candidate);
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

function identityLocatorPattern(expectedIdentity: string | TextPattern): TextPattern {
  if (typeof expectedIdentity !== "string") return expectedIdentity;
  const comparable = expectedIdentity.normalize("NFKD").replace(/\p{M}/gu, "").trim();
  if (comparable.includes("@")) return pattern(escapeRegExp(comparable));
  const tokens = comparable.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return pattern(escapeRegExp(expectedIdentity));
  return pattern(tokens.map((token) => `(?=.*${escapeRegExp(token)})`).join("") + ".*");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
