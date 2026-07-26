import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";

import type { CompletionClaim, CompletionVerification } from "../orchestrator/completion.js";
import { CURRENT_HOST_PLATFORM } from "../platform/index.js";
import { SecretScanner } from "../security/secrets.js";
import { newId, sha256, stableJson } from "../shared/crypto.js";
import { AgentError } from "../shared/errors.js";

export const COMPLETION_HANDOFF_VERSION = "completion-handoff/1" as const;
const MAX_HANDOFF_BYTES = 1024 * 1024;

export interface CompletionHandoffRecord {
  readonly version: typeof COMPLETION_HANDOFF_VERSION;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly claim: CompletionClaim;
  readonly verification: CompletionVerification;
  readonly redactionCount: number;
  readonly integrity: string;
}

export interface CompletionHandoffReference {
  readonly version: typeof COMPLETION_HANDOFF_VERSION;
  readonly integrity: string;
  readonly createdAt: string;
  readonly redactionCount: number;
  /**
   * Hosts that cannot durably flush a directory entry keep the handoff in the
   * same atomic session-state commit as this reference.
   */
  readonly inlineRecord?: CompletionHandoffRecord;
}

export interface CompletionHandoffFileSystem {
  readonly makeDirectory: (directory: string) => Promise<void>;
  readonly syncDirectory: (directory: string) => Promise<void>;
  readonly writeAtomically: (filename: string, content: string) => Promise<void>;
}

const DEFAULT_FILE_SYSTEM: CompletionHandoffFileSystem = {
  makeDirectory: async (directory) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  },
  syncDirectory,
  writeAtomically: atomicWrite,
};

/**
 * Durable, integrity-protected terminal report. It is separate from audit and
 * transient browser artifacts because model prose may contain repository data.
 */
export class CompletionHandoffStore {
  public constructor(
    private readonly directory: string,
    private readonly sessionId: string,
    private readonly scanner: SecretScanner,
    private readonly supportsDirectoryFsync = CURRENT_HOST_PLATFORM.supportsDirectoryFsync,
    private readonly fileSystem = DEFAULT_FILE_SYSTEM,
  ) {}

  public async save(
    claim: CompletionClaim,
    verification: CompletionVerification,
    createdAt = new Date().toISOString(),
  ): Promise<CompletionHandoffReference> {
    const safe = sanitizeHandoff(this.scanner, claim, verification);
    const body = {
      version: COMPLETION_HANDOFF_VERSION,
      sessionId: this.sessionId,
      createdAt,
      claim: safe.claim,
      verification: safe.verification,
      redactionCount: safe.redactionCount,
    };
    const record: CompletionHandoffRecord = {
      ...body,
      integrity: sha256(stableJson(body)),
    };
    const serialized = `${stableJson(record)}\n`;
    if (Buffer.byteLength(serialized) > MAX_HANDOFF_BYTES) {
      throw new AgentError("BUDGET_EXCEEDED", "Completion handoff exceeds its durable storage bound");
    }
    const reference: CompletionHandoffReference = {
      version: record.version,
      integrity: record.integrity,
      createdAt: record.createdAt,
      redactionCount: record.redactionCount,
    };
    if (!this.supportsDirectoryFsync) {
      // Windows cannot flush directory handles through Node. Keeping the
      // bounded record inline avoids a cross-file commit whose ordering could
      // otherwise expose a reference before its rename is durable.
      await CompletionHandoffStore.removeAt(this.directory, false);
      return { ...reference, inlineRecord: record };
    }
    await this.fileSystem.makeDirectory(this.directory);
    // Publishing a new handoff directory is a change to the session directory,
    // so flush that parent before a later session-state commit can reference a
    // file inside it. The atomic writer then flushes the handoff directory
    // after publishing completion.json.
    await this.fileSystem.syncDirectory(path.dirname(this.directory));
    await this.fileSystem.writeAtomically(this.filename(), serialized);
    return reference;
  }

  public async read(expected?: CompletionHandoffReference): Promise<CompletionHandoffRecord> {
    let parsed: unknown = expected?.inlineRecord;
    if (parsed === undefined) {
      let raw: string;
      try {
        raw = await readFile(this.filename(), "utf8");
      } catch (error) {
        throw new AgentError("RECOVERY_REQUIRED", "Completion handoff is unavailable", {}, { cause: error });
      }
      if (Buffer.byteLength(raw) > MAX_HANDOFF_BYTES || !raw.endsWith("\n")) {
        throw new AgentError("RECOVERY_REQUIRED", "Completion handoff is oversized or partial");
      }
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (error) {
        throw new AgentError("RECOVERY_REQUIRED", "Completion handoff is not valid JSON", {}, { cause: error });
      }
    }
    if (!isCompletionHandoffRecord(parsed) || parsed.sessionId !== this.sessionId) {
      throw new AgentError("RECOVERY_REQUIRED", "Completion handoff identity or schema is invalid");
    }
    const { integrity, ...body } = parsed;
    if (sha256(stableJson(body)) !== integrity) {
      throw new AgentError("RECOVERY_REQUIRED", "Completion handoff integrity check failed");
    }
    if (
      expected !== undefined &&
      (expected.version !== parsed.version ||
        expected.integrity !== parsed.integrity ||
        expected.createdAt !== parsed.createdAt ||
        expected.redactionCount !== parsed.redactionCount)
    ) {
      throw new AgentError("RECOVERY_REQUIRED", "Completion handoff does not match session state");
    }
    return parsed;
  }

  public async assertReusable(
    expected: CompletionHandoffReference,
    claim: CompletionClaim,
    verification: CompletionVerification,
  ): Promise<void> {
    const record = await this.read(expected);
    const safe = sanitizeHandoff(this.scanner, claim, verification);
    if (
      record.redactionCount !== safe.redactionCount ||
      stableJson(record.claim) !== stableJson(safe.claim) ||
      stableJson(record.verification) !== stableJson(safe.verification)
    ) {
      throw new AgentError(
        "STALE_STATE",
        "Completion handoff does not match the current accepted completion evidence",
      );
    }
  }

  public async remove(): Promise<void> {
    await CompletionHandoffStore.removeAt(this.directory, this.supportsDirectoryFsync);
  }

  public static async removeAt(
    directory: string,
    supportsDirectoryFsync = CURRENT_HOST_PLATFORM.supportsDirectoryFsync,
  ): Promise<void> {
    let handoffWasMissing = false;
    try {
      await unlink(path.join(directory, "completion.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      handoffWasMissing = true;
    }
    if (!supportsDirectoryFsync) {
      // New records are inline on this host, so this can only be legacy file
      // cleanup. Non-completed terminal state is a durable tombstone and every
      // later load retries the unlink if a power loss restores the entry.
      return;
    }
    try {
      // Sync even when the file is already absent. A previous unlink may have
      // succeeded while its directory fsync failed, so the retry must finish
      // making that deletion durable before session cleanup may proceed.
      await syncDirectory(directory);
    } catch (error) {
      if (handoffWasMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private filename(): string {
    return path.join(this.directory, "completion.json");
  }
}

function sanitizeHandoff(
  scanner: SecretScanner,
  claim: CompletionClaim,
  verification: CompletionVerification,
): {
  readonly claim: CompletionClaim;
  readonly verification: CompletionVerification;
  readonly redactionCount: number;
} {
  let redactionCount = 0;
  const redact = (value: string): string => {
    const result = scanner.redact(value);
    redactionCount += result.redactionCount;
    return result.content;
  };
  const safeClaim = redactClaim(claim, redact);
  const safeVerification = redactVerification(verification, redact);
  return { claim: safeClaim, verification: safeVerification, redactionCount };
}

function redactClaim(claim: CompletionClaim, redact: (value: string) => string): CompletionClaim {
  return {
    summary: redact(claim.summary),
    acceptanceCriteria: claim.acceptanceCriteria.map((entry) => ({
      criterion: redact(entry.criterion),
      status: entry.status,
      ...(entry.evidence === undefined ? {} : { evidence: redact(entry.evidence) }),
    })),
    validation: claim.validation.map((entry) => ({
      commandId: entry.commandId,
      status: entry.status,
      summary: redact(entry.summary),
    })),
    skippedValidation: claim.skippedValidation.map(redact),
    remainingRisks: claim.remainingRisks.map(redact),
    recommendedFollowUp: claim.recommendedFollowUp.map(redact),
  };
}

function redactVerification(
  verification: CompletionVerification,
  redact: (value: string) => string,
): CompletionVerification {
  return {
    accepted: verification.accepted,
    reasons: verification.reasons.map(redact),
    actual: {
      changedPaths: verification.actual.changedPaths.map(redact),
      agentChangedPaths: verification.actual.agentChangedPaths.map(redact),
      preExistingPaths: verification.actual.preExistingPaths.map(redact),
      successfulCommands: [...verification.actual.successfulCommands],
      failedCommands: [...verification.actual.failedCommands],
      ...(verification.actual.checkpointId === undefined
        ? {}
        : { checkpointId: verification.actual.checkpointId }),
      gitStatusSummary: redact(verification.actual.gitStatusSummary),
      repositoryFingerprint: verification.actual.repositoryFingerprint,
    },
  };
}

export function isCompletionHandoffRecord(value: unknown): value is CompletionHandoffRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<CompletionHandoffRecord>;
  return candidate.version === COMPLETION_HANDOFF_VERSION &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.createdAt === "string" &&
    Number.isSafeInteger(candidate.redactionCount) &&
    (candidate.redactionCount ?? -1) >= 0 &&
    typeof candidate.integrity === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.integrity) &&
    isCompletionClaim(candidate.claim) &&
    isCompletionVerification(candidate.verification) &&
    hasExactKeys(candidate as unknown as Record<string, unknown>, [
      "version", "sessionId", "createdAt", "claim", "verification", "redactionCount", "integrity",
    ]);
}

export function isCompletionHandoffReference(
  value: unknown,
  expectedSessionId: string,
): value is CompletionHandoffReference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<CompletionHandoffReference>;
  if (
    !hasExactKeys(
      candidate as unknown as Record<string, unknown>,
      ["version", "integrity", "createdAt", "redactionCount", "inlineRecord"],
      true,
    ) ||
    candidate.version !== COMPLETION_HANDOFF_VERSION ||
    typeof candidate.integrity !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.integrity) ||
    !isIsoTimestamp(candidate.createdAt) ||
    !Number.isSafeInteger(candidate.redactionCount) ||
    (candidate.redactionCount ?? -1) < 0
  ) {
    return false;
  }
  if (candidate.inlineRecord === undefined) return true;
  if (!isCompletionHandoffRecord(candidate.inlineRecord)) return false;
  if (Buffer.byteLength(`${stableJson(candidate.inlineRecord)}\n`) > MAX_HANDOFF_BYTES) return false;
  const { integrity, ...body } = candidate.inlineRecord;
  return candidate.inlineRecord.sessionId === expectedSessionId &&
    sha256(stableJson(body)) === integrity &&
    candidate.version === candidate.inlineRecord.version &&
    candidate.integrity === candidate.inlineRecord.integrity &&
    candidate.createdAt === candidate.inlineRecord.createdAt &&
    candidate.redactionCount === candidate.inlineRecord.redactionCount;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 20 || value.length > 64) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isCompletionClaim(value: unknown): value is CompletionClaim {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<CompletionClaim>;
  return typeof candidate.summary === "string" &&
    Array.isArray(candidate.acceptanceCriteria) &&
    candidate.acceptanceCriteria.every((entry) =>
      typeof entry.criterion === "string" &&
      ["satisfied", "not_satisfied", "unknown"].includes(entry.status) &&
      (entry.evidence === undefined || typeof entry.evidence === "string") &&
      hasExactKeys(entry as unknown as Record<string, unknown>, ["criterion", "status", "evidence"], true)) &&
    Array.isArray(candidate.validation) &&
    candidate.validation.every((entry) =>
      typeof entry.commandId === "string" &&
      ["passed", "failed", "not_run"].includes(entry.status) &&
      typeof entry.summary === "string" &&
      hasExactKeys(entry as unknown as Record<string, unknown>, ["commandId", "status", "summary"])) &&
    stringArray(candidate.skippedValidation) &&
    stringArray(candidate.remainingRisks) &&
    stringArray(candidate.recommendedFollowUp) &&
    hasExactKeys(candidate as unknown as Record<string, unknown>, [
      "summary", "acceptanceCriteria", "validation", "skippedValidation", "remainingRisks", "recommendedFollowUp",
    ]);
}

function isCompletionVerification(value: unknown): value is CompletionVerification {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<CompletionVerification>;
  if (typeof candidate.accepted !== "boolean" || !stringArray(candidate.reasons)) return false;
  const actual = candidate.actual;
  if (actual === undefined || actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  return stringArray(actual.changedPaths) &&
    stringArray(actual.agentChangedPaths) &&
    stringArray(actual.preExistingPaths) &&
    stringArray(actual.successfulCommands) &&
    stringArray(actual.failedCommands) &&
    (actual.checkpointId === undefined || typeof actual.checkpointId === "string") &&
    typeof actual.gitStatusSummary === "string" &&
    typeof actual.repositoryFingerprint === "string" &&
    hasExactKeys(actual as unknown as Record<string, unknown>, [
      "changedPaths", "agentChangedPaths", "preExistingPaths", "successfulCommands", "failedCommands",
      "checkpointId", "gitStatusSummary", "repositoryFingerprint",
    ], true);
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function hasExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  allowMissingOptional = false,
): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) &&
    (allowMissingOptional || allowed.every((key) => keys.includes(key)));
}

async function atomicWrite(filename: string, content: string): Promise<void> {
  const temporary = `${filename}.${newId("write")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, filename);
    await syncDirectory(path.dirname(filename));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
