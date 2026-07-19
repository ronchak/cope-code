import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { CompletionClaim, CompletionVerification } from "../orchestrator/completion.js";
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
}

/**
 * Durable, integrity-protected terminal report. It is separate from audit and
 * transient browser artifacts because model prose may contain repository data.
 */
export class CompletionHandoffStore {
  public constructor(
    private readonly directory: string,
    private readonly sessionId: string,
    private readonly scanner: SecretScanner,
  ) {}

  public async save(
    claim: CompletionClaim,
    verification: CompletionVerification,
    createdAt = new Date().toISOString(),
  ): Promise<CompletionHandoffReference> {
    let redactionCount = 0;
    const redact = (value: string): string => {
      const result = this.scanner.redact(value);
      redactionCount += result.redactionCount;
      return result.content;
    };
    const safeClaim = redactClaim(claim, redact);
    const safeVerification = redactVerification(verification, redact);
    const body = {
      version: COMPLETION_HANDOFF_VERSION,
      sessionId: this.sessionId,
      createdAt,
      claim: safeClaim,
      verification: safeVerification,
      redactionCount,
    };
    const record: CompletionHandoffRecord = {
      ...body,
      integrity: sha256(stableJson(body)),
    };
    const serialized = `${stableJson(record)}\n`;
    if (Buffer.byteLength(serialized) > MAX_HANDOFF_BYTES) {
      throw new AgentError("BUDGET_EXCEEDED", "Completion handoff exceeds its durable storage bound");
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await atomicWrite(this.filename(), serialized);
    return {
      version: record.version,
      integrity: record.integrity,
      createdAt: record.createdAt,
      redactionCount: record.redactionCount,
    };
  }

  public async read(expected?: CompletionHandoffReference): Promise<CompletionHandoffRecord> {
    let raw: string;
    try {
      raw = await readFile(this.filename(), "utf8");
    } catch (error) {
      throw new AgentError("RECOVERY_REQUIRED", "Completion handoff is unavailable", {}, { cause: error });
    }
    if (Buffer.byteLength(raw) > MAX_HANDOFF_BYTES || !raw.endsWith("\n")) {
      throw new AgentError("RECOVERY_REQUIRED", "Completion handoff is oversized or partial");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new AgentError("RECOVERY_REQUIRED", "Completion handoff is not valid JSON", {}, { cause: error });
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

  private filename(): string {
    return path.join(this.directory, "completion.json");
  }
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

function isCompletionHandoffRecord(value: unknown): value is CompletionHandoffRecord {
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
  } finally {
    await rm(temporary, { force: true });
  }
}
