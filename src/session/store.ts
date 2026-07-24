import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { AgentError, errorMessage } from "../shared/errors.js";
import { newId, stableJson } from "../shared/crypto.js";
import { isOperationId } from "../shared/operation-id.js";
import { currentHost, workspaceKey } from "./paths.js";
import { SESSION_SCHEMA_VERSION, type SessionState } from "./types.js";
import { allowedTransitions } from "./state-machine.js";
import { COMPLETION_HANDOFF_VERSION } from "./completion-handoff-store.js";
import { CURRENT_HOST_PLATFORM } from "../platform/index.js";

const MAX_SESSION_BYTES = 4 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const SESSION_KEYS = [
  "schemaVersion",
  "protocolVersion",
  "sessionId",
  "taskId",
  "repositoryRoot",
  "repositoryFingerprintAtStart",
  "repositoryExcludedStateAtStart",
  "repositoryBranchAtStart",
  "repositoryHeadAtStart",
  "preExistingChanges",
  "preExistingChangeStates",
  "objective",
  "acceptanceCriteria",
  "mode",
  "status",
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "pauseReason",
  "failure",
  "policyHashes",
  "budgetLimits",
  "budgetUsage",
  "turnSequence",
  "mutationSequence",
  "pendingOperations",
  "completedOperationIds",
  "submission",
  "transportConversationId",
  "queuedOutbound",
  "mutations",
  "validations",
  "lastCheckpointId",
  "lastModelSummaryHash",
  "plan",
  "completionHandoff",
  "protocolRepairStreak",
] as const;

interface LockRecord {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly host: string;
  readonly sessionId: string;
  readonly repositoryRoot: string;
  readonly createdAt: string;
}

export class SessionStore {
  public constructor(private readonly stateHome: string) {}

  public sessionDirectory(sessionId: string): string {
    assertSafeId(sessionId);
    return path.join(this.stateHome, "sessions", sessionId);
  }

  public async create(state: SessionState): Promise<void> {
    if (state.schemaVersion !== SESSION_SCHEMA_VERSION) {
      throw new AgentError("CONFIG_INVALID", "Unsupported session schema version");
    }
    const directory = this.sessionDirectory(state.sessionId);
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    await mkdir(directory, { recursive: false, mode: 0o700 });
    await this.write(state);
  }

  public async write(state: SessionState): Promise<void> {
    assertValidSessionState(state);
    const directory = this.sessionDirectory(state.sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(directory, "session.json");
    const temporary = path.join(directory, `session.${newId("write")}.tmp`);
    const serialized = `${stableJson(state)}\n`;
    if (Buffer.byteLength(serialized) > MAX_SESSION_BYTES) {
      throw new AgentError("BUDGET_EXCEEDED", "Session state exceeds its durable storage bound");
    }
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    await syncDirectory(directory);
  }

  public async read(sessionId: string): Promise<SessionState> {
    const filename = path.join(this.sessionDirectory(sessionId), "session.json");
    let raw: string;
    try {
      const bytes = await readFile(filename);
      if (bytes.length > MAX_SESSION_BYTES || bytes.length === 0) {
        throw new AgentError("RECOVERY_REQUIRED", "Session state is empty or oversized", { sessionId });
      }
      raw = bytes.toString("utf8");
      if (raw.charCodeAt(0) === 0xfeff || !raw.endsWith("\n")) {
        throw new AgentError("RECOVERY_REQUIRED", "Session state is partial or contains an unsupported BOM", { sessionId });
      }
    } catch (error) {
      throw new AgentError("RECOVERY_REQUIRED", `Cannot read session ${sessionId}: ${errorMessage(error)}`, {}, {
        cause: error,
      });
    }
    let parsed: Partial<SessionState>;
    try {
      parsed = JSON.parse(raw) as Partial<SessionState>;
    } catch (error) {
      throw new AgentError("RECOVERY_REQUIRED", "Session state is not valid JSON", { sessionId }, { cause: error });
    }
    if (parsed.schemaVersion !== SESSION_SCHEMA_VERSION || parsed.sessionId !== sessionId) {
      throw new AgentError("RECOVERY_REQUIRED", "Session identity or schema does not match", {
        requested: sessionId,
        actual: parsed.sessionId,
        schemaVersion: parsed.schemaVersion,
      });
    }
    assertValidSessionState(parsed);
    return parsed;
  }

  public async acquireWorkspaceLock(
    repositoryRoot: string,
    sessionId: string,
    now: string,
  ): Promise<WorkspaceLock> {
    const directory = path.join(this.stateHome, "locks");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, `${workspaceKey(repositoryRoot)}.lock`);
    const record: LockRecord = {
      schemaVersion: 1,
      pid: process.pid,
      host: currentHost(),
      sessionId,
      repositoryRoot,
      createdAt: now,
    };

    try {
      const handle = await open(filename, "wx", 0o600);
      await handle.writeFile(`${stableJson(record)}\n`, "utf8");
      await handle.sync();
      return new WorkspaceLock(filename, handle);
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      const existing = await readLock(filename);
      if (existing.host === currentHost() && !isProcessAlive(existing.pid)) {
        await unlink(filename);
        return this.acquireWorkspaceLock(repositoryRoot, sessionId, now);
      }
      throw new AgentError("RECOVERY_REQUIRED", "Another agent session owns this repository workspace", {
        sessionId: existing.sessionId,
        pid: existing.pid,
        host: existing.host,
        createdAt: existing.createdAt,
      });
    }
  }
}

export class WorkspaceLock {
  private released = false;

  public constructor(
    private readonly filename: string,
    private readonly handle: Awaited<ReturnType<typeof open>>,
  ) {}

  public async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.handle.close();
    await unlink(this.filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function readLock(filename: string): Promise<LockRecord> {
  try {
    const bytes = await readFile(filename);
    if (bytes.length === 0 || bytes.length > 64 * 1024) throw new Error("invalid lock record size");
    const raw = bytes.toString("utf8");
    if (!raw.endsWith("\n") || raw.charCodeAt(0) === 0xfeff) throw new Error("partial lock record");
    const parsed = JSON.parse(raw) as Partial<LockRecord>;
    if (
      !hasExactKeys(parsed, ["schemaVersion", "pid", "host", "sessionId", "repositoryRoot", "createdAt"]) ||
      parsed.schemaVersion !== 1 ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid ?? 0) <= 0 ||
      typeof parsed.host !== "string" || parsed.host.length === 0 || parsed.host.length > 1_024 ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.repositoryRoot !== "string" ||
      !isIsoTimestamp(parsed.createdAt)
    ) {
      throw new Error("invalid lock record");
    }
    return parsed as LockRecord;
  } catch (error) {
    throw new AgentError("RECOVERY_REQUIRED", "Workspace lock is corrupt and requires manual inspection", {
      filename,
      error: errorMessage(error),
    });
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function assertSafeId(value: string): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new AgentError("CONFIG_INVALID", "Unsafe session identifier");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (!CURRENT_HOST_PLATFORM.supportsDirectoryFsync) return;
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function fileExists(filename: string): Promise<boolean> {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

function assertValidSessionState(value: Partial<SessionState>): asserts value is SessionState {
  const statuses = [
    "created",
    "preflight",
    "grant_pending",
    "transport_starting",
    "initializing_model",
    "awaiting_model",
    "executing_tools",
    "returning_results",
    "awaiting_user",
    "paused",
    "validating_completion",
    "recovering",
    "completed",
    "rolled_back",
    "blocked",
    "aborted",
    "failed",
  ] as const;
  if (
    !hasExactKeys(value, SESSION_KEYS, true) ||
    value.schemaVersion !== SESSION_SCHEMA_VERSION ||
    value.protocolVersion !== "cba/1" ||
    typeof value.sessionId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(value.sessionId) ||
    typeof value.taskId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(value.taskId) ||
    typeof value.repositoryRoot !== "string" || value.repositoryRoot.length === 0 || value.repositoryRoot.length > 32_768 ||
    (!path.isAbsolute(value.repositoryRoot) && !path.win32.isAbsolute(value.repositoryRoot)) ||
    typeof value.repositoryFingerprintAtStart !== "string" ||
    !HASH_PATTERN.test(value.repositoryFingerprintAtStart) ||
    typeof value.repositoryExcludedStateAtStart !== "string" ||
    !HASH_PATTERN.test(value.repositoryExcludedStateAtStart) ||
    (value.repositoryBranchAtStart !== undefined &&
      value.repositoryBranchAtStart !== null &&
      typeof value.repositoryBranchAtStart !== "string") ||
    (value.repositoryHeadAtStart !== undefined &&
      value.repositoryHeadAtStart !== null &&
      typeof value.repositoryHeadAtStart !== "string") ||
    !boundedStringArray(value.preExistingChanges, 100_000, 32_768) ||
    !isOptionalPathStateRecord(value.preExistingChangeStates) ||
    typeof value.objective !== "string" || value.objective.length === 0 || value.objective.length > 1_000_000 ||
    !boundedStringArray(value.acceptanceCriteria, 1_024, 64 * 1024) ||
    !["inspect", "edit", "auto"].includes(value.mode ?? "" as never) ||
    !isSessionStatus(value.status) ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    !isIsoTimestamp(value.startedAt) ||
    !isExactIntegerRecord(value.budgetLimits, [
      "maxTurns",
      "maxOperations",
      "maxElapsedMs",
      "maxReadFiles",
      "maxDisclosedBytes",
      "maxChangedFiles",
      "maxChangedLines",
      "maxCommands",
      "maxCommandOutputBytes",
      "maxProtocolRepairs",
    ]) ||
    !isExactIntegerRecord(value.budgetUsage, [
      "turns",
      "operations",
      "readFiles",
      "disclosedBytes",
      "changedFiles",
      "changedLines",
      "commands",
      "commandOutputBytes",
      "protocolRepairs",
    ]) ||
    !Number.isSafeInteger(value.turnSequence) ||
    (value.turnSequence ?? -1) < 0 ||
    !Number.isSafeInteger(value.mutationSequence) ||
    (value.mutationSequence ?? -1) < 0 ||
    !Array.isArray(value.pendingOperations) || value.pendingOperations.length > 100_000 ||
    !Array.isArray(value.completedOperationIds) || value.completedOperationIds.length > 100_000 ||
    !Array.isArray(value.mutations) || value.mutations.length > 100_000 ||
    !Array.isArray(value.validations) || value.validations.length > 100_000 ||
    !Number.isSafeInteger(value.protocolRepairStreak) ||
    (value.protocolRepairStreak ?? -1) < 0
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Session state failed structural validation");
  }
  if (
    !isHashRecord(value.policyHashes) ||
    !value.pendingOperations.every(isPendingOperation) ||
    !value.completedOperationIds.every(isOperationId) ||
    new Set(value.completedOperationIds).size !== value.completedOperationIds.length ||
    !value.mutations.every(isMutationRecord) ||
    !value.validations.every(isValidationRecord)
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Session state contains malformed durable records");
  }
  if (
    value.completionHandoff !== undefined &&
    (!hasExactKeys(value.completionHandoff, ["version", "integrity", "createdAt", "redactionCount"]) ||
      value.completionHandoff.version !== COMPLETION_HANDOFF_VERSION ||
      !/^[a-f0-9]{64}$/u.test(value.completionHandoff.integrity) ||
      !isIsoTimestamp(value.completionHandoff.createdAt) ||
      !Number.isSafeInteger(value.completionHandoff.redactionCount) ||
      value.completionHandoff.redactionCount < 0)
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Session completion-handoff reference is malformed");
  }
  // This also guarantees that a status is a recognized key in the transition table.
  const status = value.status;
  allowedTransitions(status);
  const operationIds = value.pendingOperations.map((operation) => operation.operationId);
  if (new Set(operationIds).size !== operationIds.length) {
    throw new AgentError("RECOVERY_REQUIRED", "Session contains duplicate pending operation identifiers");
  }
  if (operationIds.some((operationId) => value.completedOperationIds?.includes(operationId))) {
    throw new AgentError("RECOVERY_REQUIRED", "An operation is both pending and completed");
  }
  if (
    value.submission !== undefined &&
    (!hasExactKeys(value.submission, [
      "submissionId", "turnId", "messageHash", "marker", "state", "preparedAt", "submittedAt", "answeredAt",
    ], true) ||
      typeof value.submission.submissionId !== "string" ||
      typeof value.submission.turnId !== "string" ||
      typeof value.submission.messageHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.submission.messageHash) ||
      typeof value.submission.marker !== "string" ||
      !isIsoTimestamp(value.submission.preparedAt) ||
      (value.submission.submittedAt !== undefined && !isIsoTimestamp(value.submission.submittedAt)) ||
      (value.submission.answeredAt !== undefined && !isIsoTimestamp(value.submission.answeredAt)) ||
      !["prepared", "submitted", "indeterminate", "answered"].includes(value.submission.state))
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Session submission intent is malformed");
  }
  if (value.transportConversationId !== undefined && typeof value.transportConversationId !== "string") {
    throw new AgentError("RECOVERY_REQUIRED", "Session transport conversation identifier is malformed");
  }
  if (
    value.queuedOutbound !== undefined &&
    (!hasExactKeys(value.queuedOutbound, ["turnId", "artifactId", "messageHash", "createdAt"]) ||
      typeof value.queuedOutbound.turnId !== "string" ||
      typeof value.queuedOutbound.artifactId !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.queuedOutbound.messageHash) ||
      !isIsoTimestamp(value.queuedOutbound.createdAt))
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Session queued outbound record is malformed");
  }
  if (["completed", "rolled_back", "blocked", "aborted", "failed"].includes(status) && !isIsoTimestamp(value.completedAt)) {
    throw new AgentError("RECOVERY_REQUIRED", "Terminal session lacks a completion timestamp");
  }
  if (value.completedAt !== undefined && !isIsoTimestamp(value.completedAt)) {
    throw new AgentError("RECOVERY_REQUIRED", "Session completion timestamp is malformed");
  }
  if (value.lastModelSummaryHash !== undefined && !HASH_PATTERN.test(value.lastModelSummaryHash)) {
    throw new AgentError("RECOVERY_REQUIRED", "Session model-summary fingerprint is malformed");
  }
  if (value.plan !== undefined && !isSessionPlan(value.plan)) {
    throw new AgentError("RECOVERY_REQUIRED", "Session plan record is malformed");
  }
  if (value.lastCheckpointId !== undefined && (typeof value.lastCheckpointId !== "string" || value.lastCheckpointId.length > 128)) {
    throw new AgentError("RECOVERY_REQUIRED", "Session checkpoint reference is malformed");
  }
  if (value.pauseReason !== undefined && (typeof value.pauseReason !== "string" || value.pauseReason.length > 64 * 1024)) {
    throw new AgentError("RECOVERY_REQUIRED", "Session pause reason is malformed");
  }
  if (value.failure !== undefined &&
    (!hasExactKeys(value.failure, ["code", "message"]) ||
      typeof value.failure.code !== "string" || value.failure.code.length > 256 ||
      typeof value.failure.message !== "string" || value.failure.message.length > 64 * 1024)) {
    throw new AgentError("RECOVERY_REQUIRED", "Session failure record is malformed");
  }
}

function isSessionPlan(value: unknown): value is NonNullable<SessionState["plan"]> {
  if (typeof value !== "object" || value === null) return false;
  const plan = value as Partial<NonNullable<SessionState["plan"]>>;
  return hasExactKeys(plan, [
    "planId", "summary", "steps", "anticipatedMutations", "validation", "planHash", "status", "submittedAt", "decidedAt",
  ]) &&
    typeof plan.planId === "string" && isOperationId(plan.planId) &&
    typeof plan.summary === "string" && plan.summary.length > 0 && plan.summary.length <= 64 * 1024 &&
    boundedStringArray(plan.steps, 256, 16 * 1024) && plan.steps.length > 0 &&
    boundedStringArray(plan.anticipatedMutations, 1_024, 32_768) &&
    boundedStringArray(plan.validation, 256, 16 * 1024) &&
    typeof plan.planHash === "string" && HASH_PATTERN.test(plan.planHash) &&
    (plan.status === "approved" || plan.status === "rejected") &&
    isIsoTimestamp(plan.submittedAt) && isIsoTimestamp(plan.decidedAt);
}

function isSessionStatus(value: unknown): value is SessionState["status"] {
  return typeof value === "string" && [
    "created",
    "preflight",
    "grant_pending",
    "transport_starting",
    "initializing_model",
    "awaiting_model",
    "executing_tools",
    "returning_results",
    "awaiting_user",
    "paused",
    "validating_completion",
    "recovering",
    "completed",
    "rolled_back",
    "blocked",
    "aborted",
    "failed",
  ].includes(value);
}

function isExactIntegerRecord(value: unknown, keys: readonly string[]): value is Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === keys.length &&
    entries.every(([key, entry]) => keys.includes(key) && typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0);
}

function isOptionalPathStateRecord(value: unknown): value is Readonly<Record<string, string>> | undefined {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, fingerprint]) =>
    key.length > 0 &&
    key.length <= 32_767 &&
    typeof fingerprint === "string" &&
    /^[a-f0-9]{64}$/u.test(fingerprint));
}

function isHashRecord(value: unknown): value is SessionState["policyHashes"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === 3 && entries.every(([key, entry]) =>
    ["organization", "repository", "grant"].includes(key) && typeof entry === "string" && /^[a-f0-9]{64}$/u.test(entry));
}

function isPendingOperation(value: unknown): value is SessionState["pendingOperations"][number] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<SessionState["pendingOperations"][number]>;
  return hasExactKeys(item, ["operationId", "tool", "mutating", "requestHash", "status", "acceptedAt"]) &&
    isOperationId(item.operationId) && typeof item.tool === "string" && item.tool.length <= 128 && typeof item.mutating === "boolean" &&
    typeof item.requestHash === "string" && /^[a-f0-9]{64}$/u.test(item.requestHash) &&
    (item.status === "accepted" || item.status === "executing" || item.status === "indeterminate") &&
    isIsoTimestamp(item.acceptedAt);
}

function isMutationRecord(value: unknown): value is SessionState["mutations"][number] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<SessionState["mutations"][number]>;
  return hasExactKeys(item, [
    "operationId", "checkpointId", "changedPaths", "changedLines", "completedAt", "repositoryFingerprint",
  ]) &&
    isOperationId(item.operationId) && typeof item.checkpointId === "string" && item.checkpointId.length <= 128 &&
    boundedStringArray(item.changedPaths, 100_000, 32_768) &&
    typeof item.changedLines === "number" && Number.isSafeInteger(item.changedLines) && item.changedLines >= 0 &&
    isIsoTimestamp(item.completedAt) && typeof item.repositoryFingerprint === "string" && HASH_PATTERN.test(item.repositoryFingerprint);
}

function isValidationRecord(value: unknown): value is SessionState["validations"][number] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<SessionState["validations"][number]>;
  return hasExactKeys(item, [
    "operationId", "commandId", "outcome", "exitCode", "completedAt", "mutationSequence", "repositoryFingerprint",
  ], true) &&
    isOperationId(item.operationId) && typeof item.commandId === "string" && item.commandId.length <= 128 &&
    ["success", "failure", "timeout", "cancelled", "policy_denied", "indeterminate"].includes(item.outcome ?? "") &&
    (item.exitCode === undefined || (typeof item.exitCode === "number" && Number.isSafeInteger(item.exitCode))) &&
    isIsoTimestamp(item.completedAt) && typeof item.mutationSequence === "number" &&
    Number.isSafeInteger(item.mutationSequence) && item.mutationSequence >= 0 &&
    (item.repositoryFingerprint === undefined ||
      (typeof item.repositoryFingerprint === "string" && /^[a-f0-9]{64}$/u.test(item.repositoryFingerprint)));
}

function boundedStringArray(value: unknown, maxItems: number, maxLength: number): value is readonly string[] {
  return Array.isArray(value) && value.length <= maxItems &&
    value.every((entry) => typeof entry === "string" && entry.length <= maxLength);
}

function hasExactKeys(
  value: unknown,
  allowed: readonly string[],
  allowMissingOptional = false,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) &&
    (allowMissingOptional || allowed.every((key) => keys.includes(key)));
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
