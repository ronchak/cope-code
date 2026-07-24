import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  isCompatibleBrowserExecutableUpgrade,
  verifyBrowserExecutable,
  type BrowserIdentityVerifier,
} from "../browser/index.js";
import {
  parseBrowserConfig,
  verifiedBrowserIdentityHashes,
} from "../config/loader.js";
import { CURRENT_HOST_PLATFORM, type HostPlatform } from "../platform/index.js";
import { SessionStore } from "../session/store.js";
import { isTerminal } from "../session/state-machine.js";
import type { SessionState, SessionStatus } from "../session/types.js";
import { sha256, stableJson } from "../shared/crypto.js";
import { readRuntimeManifest, type SessionRuntimeManifest } from "./session-files.js";

export type SessionRecoveryDisposition =
  | "terminal"
  | "resume_candidate"
  | "abort_required"
  | "reconcile_required";

export type SessionRecoveryReason =
  | "SESSION_STARTUP_INCOMPLETE"
  | "BROWSER_CONFIG_MISSING"
  | "BROWSER_CONFIG_INVALID"
  | "BROWSER_CONFIG_CHANGED"
  | "BROWSER_IDENTITY_CHANGED"
  | "RUNTIME_MANIFEST_UNREADABLE"
  | "MUTATION_EVIDENCE_PRESENT";

export interface SessionRecoveryAssessment {
  readonly sessionId: string;
  readonly objective: string;
  readonly repositoryRoot: string;
  readonly status: SessionStatus;
  readonly transport?: SessionRuntimeManifest["transport"];
  readonly disposition: SessionRecoveryDisposition;
  readonly reason?: SessionRecoveryReason;
  readonly next?: string;
}

export interface BrowserConfigurationEvidence {
  readonly status: "missing" | "invalid" | "identity_invalid" | "valid";
  readonly hash?: string;
  readonly identityHash?: string;
  readonly identityAliases?: readonly string[];
}

type BrowserConfigurationEvidenceSource =
  | BrowserConfigurationEvidence
  | (() => Promise<BrowserConfigurationEvidence>);

/**
 * A static, source-free preflight. A resume candidate still goes through the
 * authoritative configuration, repository, grant, audit, and lock checks in
 * the resume command.
 */
export async function assessSessionRecovery(
  stateHome: string,
  state: SessionState,
  browserEvidence?: BrowserConfigurationEvidenceSource,
  host: HostPlatform = CURRENT_HOST_PLATFORM,
  browserIdentityVerifier?: BrowserIdentityVerifier,
): Promise<SessionRecoveryAssessment> {
  const base = {
    sessionId: state.sessionId,
    objective: state.objective,
    repositoryRoot: state.repositoryRoot,
    status: state.status,
  } as const;
  if (isTerminal(state.status)) {
    return { ...base, disposition: "terminal" };
  }
  if (state.status === "created" || state.status === "preflight") {
    return recoveryBlocked(
      base,
      state,
      stateHome,
      host,
      "SESSION_STARTUP_INCOMPLETE",
    );
  }

  let manifest: SessionRuntimeManifest;
  try {
    manifest = await readRuntimeManifest(path.join(stateHome, "sessions", state.sessionId));
  } catch {
    return {
      ...base,
      disposition: "reconcile_required",
      reason: "RUNTIME_MANIFEST_UNREADABLE",
      next: `Run ${recoveryCommand(stateHome, host, "status", state.sessionId)} and verify its audit before changing browser setup.`,
    };
  }
  if (manifest.transport !== "edge") {
    return {
      ...base,
      transport: manifest.transport,
      disposition: "resume_candidate",
      next: recoveryCommand(stateHome, host, "resume", state.sessionId),
    };
  }

  const browser = browserEvidence === undefined
    ? await readBrowserConfigurationEvidence(stateHome, host, browserIdentityVerifier)
    : typeof browserEvidence === "function"
      ? await browserEvidence()
      : browserEvidence;
  if (browser.status === "missing") {
    return recoveryBlocked(
      { ...base, transport: manifest.transport },
      state,
      stateHome,
      host,
      "BROWSER_CONFIG_MISSING",
    );
  }
  if (browser.status === "invalid") {
    return recoveryBlocked(
      { ...base, transport: manifest.transport },
      state,
      stateHome,
      host,
      "BROWSER_CONFIG_INVALID",
    );
  }
  if (browser.status === "identity_invalid") {
    return recoveryBlocked(
      { ...base, transport: manifest.transport },
      state,
      stateHome,
      host,
      "BROWSER_IDENTITY_CHANGED",
    );
  }
  if (
    manifest.browser_config_sha256 === undefined ||
    manifest.browser_config_sha256 !== browser.hash
  ) {
    return recoveryBlocked(
      { ...base, transport: manifest.transport },
      state,
      stateHome,
      host,
      "BROWSER_CONFIG_CHANGED",
    );
  }
  if (
    manifest.browser_identity_sha256 !== undefined &&
    manifest.browser_identity_sha256 !== browser.identityHash &&
    !(browser.identityAliases ?? []).includes(manifest.browser_identity_sha256)
  ) {
    return recoveryBlocked(
      { ...base, transport: manifest.transport },
      state,
      stateHome,
      host,
      "BROWSER_IDENTITY_CHANGED",
    );
  }
  return {
    ...base,
    transport: manifest.transport,
    disposition: "resume_candidate",
    next: recoveryCommand(stateHome, host, "resume", state.sessionId),
  };
}

export async function scanSessionRecovery(
  stateHome: string,
  host: HostPlatform = CURRENT_HOST_PLATFORM,
  browserEvidenceOverride?: BrowserConfigurationEvidence,
  browserIdentityVerifier?: BrowserIdentityVerifier,
): Promise<readonly SessionRecoveryAssessment[]> {
  const sessionsDirectory = path.join(stateHome, "sessions");
  let entries;
  try {
    entries = await readdir(sessionsDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let browserEvidencePromise: Promise<BrowserConfigurationEvidence> | undefined;
  const browserEvidence: BrowserConfigurationEvidenceSource =
    browserEvidenceOverride ?? (() => {
      browserEvidencePromise ??= readBrowserConfigurationEvidence(
        stateHome,
        host,
        browserIdentityVerifier,
      );
      return browserEvidencePromise;
    });
  const store = new SessionStore(stateHome);
  const assessments: SessionRecoveryAssessment[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    try {
      const state = await store.read(entry.name);
      assessments.push(await assessSessionRecovery(stateHome, state, browserEvidence, host));
    } catch {
      assessments.push({
        sessionId: entry.name,
        objective: "Unreadable session",
        repositoryRoot: "",
        status: "recovering",
        disposition: "reconcile_required",
        reason: "RUNTIME_MANIFEST_UNREADABLE",
        next: `Inspect ${entry.name} with trusted recovery tooling before changing browser setup.`,
      });
    }
  }
  return assessments;
}

export function liveBrowserSetupBlockers(
  assessments: readonly SessionRecoveryAssessment[],
): readonly SessionRecoveryAssessment[] {
  return assessments.filter((assessment) =>
    assessment.disposition !== "terminal" &&
    (assessment.transport === "edge" || assessment.transport === undefined));
}

export function recoveryReasonSummary(reason: SessionRecoveryReason | undefined): string {
  switch (reason) {
    case "SESSION_STARTUP_INCOMPLETE":
      return "session startup stopped before the initial grant became resumable";
    case "BROWSER_CONFIG_MISSING":
      return "the browser configuration required by this session is missing";
    case "BROWSER_CONFIG_INVALID":
      return "the browser configuration required by this session is invalid";
    case "BROWSER_CONFIG_CHANGED":
      return "the browser configuration no longer matches the session";
    case "BROWSER_IDENTITY_CHANGED":
      return "the verified browser executable no longer matches the session";
    case "RUNTIME_MANIFEST_UNREADABLE":
      return "the session recovery manifest is unreadable";
    case "MUTATION_EVIDENCE_PRESENT":
      return "the session contains mutation evidence that must be reconciled";
    default:
      return "the session is ready for a normal resume";
  }
}

export function browserSetupBlockedErrorDetails(
  blockers: readonly SessionRecoveryAssessment[],
): Readonly<Record<string, unknown>> {
  const first = blockers[0];
  return {
    diagnosticCode: "BROWSER_CONFIG_RECOVERY_BLOCKED",
    problems: blockers.map((blocker) =>
      `${blocker.sessionId} (${blocker.status}): ${recoveryReasonSummary(blocker.reason)}. ` +
      `Next: ${blocker.next ?? "inspect and reconcile this session"}`),
    sessions: blockers.map((blocker) => ({
      sessionId: blocker.sessionId,
      status: blocker.status,
      disposition: blocker.disposition,
      ...(blocker.reason === undefined ? {} : { reason: blocker.reason }),
      ...(blocker.next === undefined ? {} : { next: blocker.next }),
    })),
    ...(first === undefined ? {} : {
      sessionId: first.sessionId,
      next: first.next ?? "Resolve the listed session before changing browser setup.",
    }),
  };
}

async function readBrowserConfigurationEvidence(
  stateHome: string,
  host: HostPlatform,
  browserIdentityVerifier?: BrowserIdentityVerifier,
): Promise<BrowserConfigurationEvidence> {
  let raw: unknown;
  let parsed: ReturnType<typeof parseBrowserConfig>;
  try {
    raw = JSON.parse(
      await readFile(path.join(stateHome, "config", "browser.json"), "utf8"),
    ) as unknown;
    parsed = parseBrowserConfig(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "invalid" };
  }
  const hash = sha256(stableJson(raw));
  try {
    const verified = await (browserIdentityVerifier ?? ((product, executablePath) =>
      verifyBrowserExecutable(product, executablePath, { host })))(
      parsed.config.product,
      parsed.config.browserExecutable,
    );
    const configuredCanonicalExecutable =
      await realpath(parsed.config.browserExecutable).catch(() => undefined);
    if (
      verified.product !== parsed.config.product ||
      configuredCanonicalExecutable === undefined ||
      verified.executablePath !== configuredCanonicalExecutable ||
      !isCompatibleBrowserExecutableUpgrade(
        parsed.config.browserVersion,
        parsed.config.browserExecutableSha256,
        verified.version,
        verified.executableSha256,
      )
    ) {
      return { status: "identity_invalid", hash };
    }
    const identities = verifiedBrowserIdentityHashes(
      parsed.file,
      parsed.config,
      verified,
    );
    return {
      status: "valid",
      hash,
      identityHash: identities.primary,
      ...(identities.aliases === undefined ? {} : { identityAliases: identities.aliases }),
    };
  } catch {
    return { status: "identity_invalid", hash };
  }
}

function recoveryBlocked(
  base: {
    readonly sessionId: string;
    readonly objective: string;
    readonly repositoryRoot: string;
    readonly status: SessionStatus;
    readonly transport?: SessionRuntimeManifest["transport"];
  },
  state: SessionState,
  stateHome: string,
    host: HostPlatform,
  reason: Exclude<SessionRecoveryReason, "MUTATION_EVIDENCE_PRESENT">,
): SessionRecoveryAssessment {
  const mutationEvidence =
    state.mutationSequence > 0 ||
    state.mutations.length > 0 ||
    state.pendingOperations.some((operation) => operation.mutating);
  if (mutationEvidence) {
    return {
      ...base,
      disposition: "reconcile_required",
      reason: "MUTATION_EVIDENCE_PRESENT",
      next: `Run ${recoveryCommand(stateHome, host, "status", state.sessionId)} and reconcile or roll back the recorded mutation before setup.`,
    };
  }
  return {
    ...base,
    disposition: "abort_required",
    reason,
    next: recoveryCommand(
      stateHome,
      host,
      "abort",
      state.sessionId,
      "--reason",
      "Discard interrupted session that cannot resume",
    ),
  };
}

function recoveryCommand(
  stateHome: string,
  host: HostPlatform,
  ...arguments_: readonly string[]
): string {
  return ["cope", ...arguments_, "--state-home", stateHome]
    .map((argument) => quoteCommandArgument(argument, host))
    .join(" ");
}

function quoteCommandArgument(value: string, host: HostPlatform): string {
  if (/^[A-Za-z0-9_./:@=-]+$/u.test(value)) return value;
  if (host.platform === "win32") {
    return `'${value.replaceAll("'", "''")}'`;
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
