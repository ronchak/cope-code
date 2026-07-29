import { access, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { AgentError, errorMessage } from "../shared/errors.js";
import {
  TERMINAL_SESSION_MAX_PATH_BYTES,
  TERMINAL_SESSION_MAX_PATH_ENDPOINTS,
} from "../repository/workspace-observer.js";
import { newId, stableJson } from "../shared/crypto.js";
import {
  isJournalOperationId,
  isOperationId,
} from "../shared/operation-id.js";
import { currentHost, workspaceKey } from "./paths.js";
import { SESSION_SCHEMA_VERSION, type SessionState } from "./types.js";
import { allowedTransitions, isTerminal } from "./state-machine.js";
import {
  ARTIFACT_KINDS,
  SessionArtifactStore,
  type ArtifactReference,
} from "./artifact-store.js";
import {
  CompletionHandoffStore,
  isCompletionHandoffReference,
} from "./completion-handoff-store.js";
import { sessionRetainsSourceArtifacts } from "./terminal-cleanup.js";
import { syncDirectory } from "./directory-sync.js";

export const MAX_SESSION_BYTES = 4 * 1024 * 1024;
export const TERMINAL_SESSION_HEADROOM_BYTES = 128 * 1024;
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
  "completionAuthority",
  "status",
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "pauseReason",
  "failure",
  "policyHashes",
  "sourceArtifactRetention",
  "budgetLimits",
  "budgetUsage",
  "turnSequence",
  "mutationSequence",
  "pendingOperations",
  "completedOperationIds",
  "unreturnedOperationIds",
  "pendingTerminalEffectOperationIds",
  "submission",
  "transportConversationId",
  "queuedOutbound",
  "mutations",
  "validations",
  "lastCheckpointId",
  "lastModelSummaryHash",
  "completionHandoff",
  "terminalCleanup",
  "protocolRepairStreak",
  "budgetPauseStreak",
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
    await this.writeValidated(state);
  }

  public async read(sessionId: string): Promise<SessionState> {
    const parsed = await this.readValidated(sessionId);
    if (!isTerminal(parsed.status)) return parsed;
    const removeSourceArtifacts = !sessionRetainsSourceArtifacts(parsed);
    const removeSeparateHandoff =
      parsed.status !== "completed" || parsed.completionHandoff?.inlineRecord !== undefined;
    if (!removeSourceArtifacts && !removeSeparateHandoff) return parsed;

    try {
      // Legacy rollback paths could leave a completion report attached to a
      // later non-completed terminal state. A completed inline handoff can
      // likewise coexist with an orphaned file from an interrupted 0.1.6
      // completion. Removing the separate report is sufficient to retire the
      // sensitive artifact and deliberately avoids rewriting a possibly newer
      // state snapshot.
      const sessionDirectory = this.sessionDirectory(sessionId);
      const cleanup: Promise<void>[] = [];
      if (removeSourceArtifacts) {
        cleanup.push(new SessionArtifactStore(path.join(sessionDirectory, "artifacts")).clear());
      }
      if (removeSeparateHandoff) {
        cleanup.push(CompletionHandoffStore.removeAt(path.join(sessionDirectory, "handoff")));
      }
      // Start independent cleanup operations before awaiting so one transient
      // failure cannot suppress another. The durable terminal policy retries
      // the entire idempotent set on the next load.
      await Promise.all(cleanup);
      const current = await this.readValidated(sessionId);
      // Suppress the obsolete reference in memory. A later legitimate state
      // transition persists the already-established terminal invariant.
      if (isTerminal(current.status) && current.status !== "completed") delete current.completionHandoff;
      return current;
    } catch (error) {
      throw new AgentError(
        "RECOVERY_REQUIRED",
        "Cannot finish terminal recovery artifact cleanup",
        { sessionId, status: parsed.status },
        { cause: error },
      );
    }
  }

  private async writeValidated(state: SessionState): Promise<void> {
    const directory = this.sessionDirectory(state.sessionId);
    const destination = path.join(directory, "session.json");
    const temporary = path.join(directory, `session.${newId("write")}.tmp`);
    const serialized = serializeSessionState(state);
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

  private async readValidated(sessionId: string): Promise<SessionState> {
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

export interface SessionStateWritePreflight {
  readonly fits: boolean;
  readonly bytes: number;
  readonly reserveBytes: number;
  readonly maxBytes: number;
}

export function preflightSessionStateWrite(
  state: SessionState,
  reserveBytes = 0,
): SessionStateWritePreflight {
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0) {
    throw new AgentError("INTERNAL_ERROR", "Session-state reserve is invalid");
  }
  const bytes = Buffer.byteLength(serializeSessionState(state));
  return {
    fits: bytes + reserveBytes <= MAX_SESSION_BYTES,
    bytes,
    reserveBytes,
    maxBytes: MAX_SESSION_BYTES,
  };
}

function serializeSessionState(state: SessionState): string {
  return `${stableJson(state)}\n`;
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
    (value.completionAuthority !== undefined &&
      !["frozen", "observed"].includes(value.completionAuthority)) ||
    !isSessionStatus(value.status) ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    !isIsoTimestamp(value.startedAt) ||
    (value.sourceArtifactRetention !== undefined &&
      !["remove", "retain"].includes(value.sourceArtifactRetention)) ||
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
    (value.unreturnedOperationIds !== undefined &&
      (!Array.isArray(value.unreturnedOperationIds) ||
        value.unreturnedOperationIds.length > 100_000)) ||
    (value.pendingTerminalEffectOperationIds !== undefined &&
      (!Array.isArray(value.pendingTerminalEffectOperationIds) ||
        value.pendingTerminalEffectOperationIds.length > 100_000)) ||
    !Array.isArray(value.mutations) || value.mutations.length > 100_000 ||
    !Array.isArray(value.validations) || value.validations.length > 100_000 ||
    !Number.isSafeInteger(value.protocolRepairStreak) ||
    (value.protocolRepairStreak ?? -1) < 0 ||
    (value.budgetPauseStreak !== undefined &&
      (!Number.isSafeInteger(value.budgetPauseStreak) ||
        value.budgetPauseStreak < 0))
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Session state failed structural validation");
  }
  if (
    !isHashRecord(value.policyHashes) ||
    !value.pendingOperations.every(isPendingOperation) ||
    !value.completedOperationIds.every(isJournalOperationId) ||
    new Set(value.completedOperationIds).size !== value.completedOperationIds.length ||
    (value.unreturnedOperationIds !== undefined &&
      (!value.unreturnedOperationIds.every(isJournalOperationId) ||
        new Set(value.unreturnedOperationIds).size !== value.unreturnedOperationIds.length ||
        value.unreturnedOperationIds.some(
          (operationId) => !value.completedOperationIds?.includes(operationId),
        ))) ||
    (value.pendingTerminalEffectOperationIds !== undefined &&
      (!value.pendingTerminalEffectOperationIds.every(isJournalOperationId) ||
        new Set(value.pendingTerminalEffectOperationIds).size !==
          value.pendingTerminalEffectOperationIds.length)) ||
    !value.mutations.every(isMutationRecord) ||
    !value.validations.every(isValidationRecord)
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Session state contains malformed durable records");
  }
  if (
    value.completionHandoff !== undefined &&
    !isCompletionHandoffReference(value.completionHandoff, value.sessionId)
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Session completion-handoff reference is malformed");
  }
  if (
    value.terminalCleanup !== undefined &&
    (!hasExactKeys(value.terminalCleanup, ["sourceArtifacts"]) ||
      !["remove", "retain"].includes(value.terminalCleanup.sourceArtifacts))
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Session terminal-cleanup policy is malformed");
  }
  // This also guarantees that a status is a recognized key in the transition table.
  const status = value.status;
  allowedTransitions(status);
  if (value.terminalCleanup !== undefined && !isTerminal(status)) {
    throw new AgentError("RECOVERY_REQUIRED", "A nonterminal session cannot have a terminal-cleanup policy");
  }
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
    (!hasExactKeys(
      value.queuedOutbound,
      ["turnId", "artifactId", "messageHash", "createdAt", "disclosure"],
      true,
    ) ||
      typeof value.queuedOutbound.turnId !== "string" ||
      typeof value.queuedOutbound.artifactId !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.queuedOutbound.messageHash) ||
      !isIsoTimestamp(value.queuedOutbound.createdAt) ||
      (
        value.queuedOutbound.disclosure !== undefined &&
        (
          !hasExactKeys(
            value.queuedOutbound.disclosure,
            ["kind", "disclosedBytes", "sha256"],
          ) ||
          !["tool_result", "decision"].includes(
            value.queuedOutbound.disclosure.kind,
          ) ||
          !Number.isSafeInteger(value.queuedOutbound.disclosure.disclosedBytes) ||
          value.queuedOutbound.disclosure.disclosedBytes < 0 ||
          !HASH_PATTERN.test(value.queuedOutbound.disclosure.sha256)
        )
      ))
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
    isJournalOperationId(item.operationId) && typeof item.tool === "string" && item.tool.length <= 128 && typeof item.mutating === "boolean" &&
    typeof item.requestHash === "string" && /^[a-f0-9]{64}$/u.test(item.requestHash) &&
    (item.status === "accepted" || item.status === "executing" || item.status === "indeterminate") &&
    isIsoTimestamp(item.acceptedAt);
}

function isMutationRecord(value: unknown): value is SessionState["mutations"][number] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<SessionState["mutations"][number]>;
  const commonIsValid =
    isOperationId(item.operationId) &&
    boundedStringArray(item.changedPaths, 100_000, 32_768) &&
    typeof item.changedLines === "number" && Number.isSafeInteger(item.changedLines) && item.changedLines >= 0 &&
    isIsoTimestamp(item.completedAt);
  if (!commonIsValid) return false;
  if (item.kind === undefined || item.kind === "patch") {
    return hasExactKeys(item, [
      "kind", "operationId", "checkpointId", "changedPaths", "changedLines", "completedAt",
      "repositoryFingerprint",
    ], true) &&
      typeof item.checkpointId === "string" && item.checkpointId.length <= 128 &&
      typeof item.repositoryFingerprint === "string" &&
      HASH_PATTERN.test(item.repositoryFingerprint);
  }
  if (item.kind !== "terminal") return false;
  const terminal = item as Partial<Extract<SessionState["mutations"][number], { readonly kind: "terminal" }>>;
  if (
    (terminal as { readonly recordContract?: unknown }).recordContract !==
    "terminal-mutation/2"
  ) {
    return hasExactKeys(terminal, [
      "kind", "operationId", "changedPaths", "changedLines", "createdPaths", "updatedPaths",
      "deletedPaths", "renamedPaths", "preExistingTouchedPaths", "completedAt",
      "observationOutcome", "preObservation", "postObservation", "terminalResult",
      "repositoryFingerprint",
    ], true) &&
      validLegacyTerminalPaths(terminal) &&
      ["none", "observed", "protected_or_hidden_changed", "unknown"].includes(
        terminal.observationOutcome ?? "",
      ) &&
      (terminal.preObservation === undefined ||
        isExpectedArtifactReference(terminal.preObservation, "terminal-pre-observation")) &&
      (terminal.postObservation === undefined ||
        isExpectedArtifactReference(terminal.postObservation, "terminal-post-observation")) &&
      isExpectedArtifactReference(terminal.terminalResult, "terminal-result") &&
      (terminal.repositoryFingerprint === undefined ||
        HASH_PATTERN.test(terminal.repositoryFingerprint));
  }
  if (!hasExactKeys(terminal, [
    "kind", "operationId", "changedPaths", "changedLines", "createdPaths", "updatedPaths",
    "deletedPaths", "renamedPaths", "preExistingTouchedPaths", "completedAt",
    "observationOutcome", "preObservation", "postObservation", "terminalResult",
    "repositoryFingerprint", "recordContract", "processOutcome", "createdTotal",
    "updatedTotal", "deletedTotal", "renamedTotal", "preExistingTouchedTotal",
    "changedPathCount", "pathEndpointTotal", "omittedPathEndpointTotal",
    "pathFactsTruncated", "pathFactsSha256", "unavailableBaselineCount",
    "postObservationControl",
  ], true)) return false;
  const full = terminal as Partial<Extract<
    SessionState["mutations"][number],
    { readonly recordContract: "terminal-mutation/2" }
  >>;
  if (
    !boundedStringArray(
      full.changedPaths,
      TERMINAL_SESSION_MAX_PATH_ENDPOINTS,
      32_768,
    ) ||
    !boundedStringArray(
      full.createdPaths,
      TERMINAL_SESSION_MAX_PATH_ENDPOINTS,
      32_768,
    ) ||
    !boundedStringArray(
      full.updatedPaths,
      TERMINAL_SESSION_MAX_PATH_ENDPOINTS,
      32_768,
    ) ||
    !boundedStringArray(
      full.deletedPaths,
      TERMINAL_SESSION_MAX_PATH_ENDPOINTS,
      32_768,
    ) ||
    !boundedStringArray(
      full.preExistingTouchedPaths,
      TERMINAL_SESSION_MAX_PATH_ENDPOINTS,
      32_768,
    ) ||
    !Array.isArray(full.renamedPaths) ||
    full.renamedPaths.length >
      Math.floor(TERMINAL_SESSION_MAX_PATH_ENDPOINTS / 2) ||
    !full.renamedPaths.every((rename) =>
      hasExactKeys(rename, ["from", "to"]) &&
      typeof rename.from === "string" && Buffer.byteLength(rename.from) <= 32_768 &&
      typeof rename.to === "string" && Buffer.byteLength(rename.to) <= 32_768
    ) ||
    terminalRetainedEndpointCount(full) >
      TERMINAL_SESSION_MAX_PATH_ENDPOINTS ||
    terminalPathFactBytes(full) > TERMINAL_SESSION_MAX_PATH_BYTES ||
    !validNonnegativeInteger(full.changedPathCount) ||
    !validNonnegativeInteger(full.createdTotal) ||
    !validNonnegativeInteger(full.updatedTotal) ||
    !validNonnegativeInteger(full.deletedTotal) ||
    !validNonnegativeInteger(full.renamedTotal) ||
    !validNonnegativeInteger(full.preExistingTouchedTotal) ||
    !validNonnegativeInteger(full.pathEndpointTotal) ||
    !validNonnegativeInteger(full.omittedPathEndpointTotal) ||
    !validNonnegativeInteger(full.unavailableBaselineCount) ||
    full.createdTotal < full.createdPaths.length ||
    full.updatedTotal < full.updatedPaths.length ||
    full.deletedTotal < full.deletedPaths.length ||
    full.renamedTotal < full.renamedPaths.length ||
    full.preExistingTouchedTotal < full.preExistingTouchedPaths.length ||
    full.changedPathCount < full.changedPaths.length ||
    full.pathEndpointTotal !==
      full.createdTotal + full.updatedTotal + full.deletedTotal +
      full.renamedTotal * 2 + full.preExistingTouchedTotal ||
    full.omittedPathEndpointTotal !== full.pathEndpointTotal -
      (full.createdPaths.length + full.updatedPaths.length + full.deletedPaths.length +
        full.renamedPaths.length * 2 + full.preExistingTouchedPaths.length) ||
    typeof full.pathFactsTruncated !== "boolean" ||
    full.pathFactsTruncated !== (full.omittedPathEndpointTotal > 0) ||
    typeof full.pathFactsSha256 !== "string" ||
    !HASH_PATTERN.test(full.pathFactsSha256) ||
    (full.processOutcome !== undefined &&
      ![
        "completed", "completed_nonzero", "spawn_failed", "timed_out",
        "cancelled", "persistence_failed", "indeterminate",
      ].includes(full.processOutcome)) ||
    !isExpectedArtifactReference(full.preObservation, "terminal-pre-observation") ||
    !isExpectedArtifactReference(full.postObservation, "terminal-post-observation") ||
    !isExpectedArtifactReference(full.terminalResult, "terminal-result") ||
    full.preObservation.id !== full.operationId ||
    full.postObservation.id !== full.operationId ||
    full.terminalResult.id !== full.operationId
  ) return false;
  if (full.observationOutcome === "observed") {
    return typeof full.repositoryFingerprint === "string" &&
      HASH_PATTERN.test(full.repositoryFingerprint) &&
      isTerminalPostObservationControl(full.postObservationControl);
  }
  return (
    ["protected_or_hidden_changed", "unknown"].includes(
      full.observationOutcome ?? "",
    ) &&
    full.repositoryFingerprint === undefined &&
    full.postObservationControl === undefined
  );
}

function validLegacyTerminalPaths(
  terminal: Partial<Extract<
    SessionState["mutations"][number],
    { readonly kind: "terminal" }
  >>,
): boolean {
  return boundedStringArray(terminal.createdPaths, 100_000, 32_768) &&
    boundedStringArray(terminal.updatedPaths, 100_000, 32_768) &&
    boundedStringArray(terminal.deletedPaths, 100_000, 32_768) &&
    boundedStringArray(terminal.preExistingTouchedPaths, 100_000, 32_768) &&
    Array.isArray(terminal.renamedPaths) &&
    terminal.renamedPaths.length <= 100_000 &&
    terminal.renamedPaths.every((rename) =>
      hasExactKeys(rename, ["from", "to"]) &&
      typeof rename.from === "string" && rename.from.length <= 32_768 &&
      typeof rename.to === "string" && rename.to.length <= 32_768
    );
}

function terminalPathFactBytes(
  terminal: {
    readonly changedPaths?: readonly string[];
    readonly createdPaths?: readonly string[];
    readonly updatedPaths?: readonly string[];
    readonly deletedPaths?: readonly string[];
    readonly preExistingTouchedPaths?: readonly string[];
    readonly renamedPaths?: readonly { readonly from: string; readonly to: string }[];
  },
): number {
  return [
    ...(terminal.changedPaths ?? []),
    ...(terminal.createdPaths ?? []),
    ...(terminal.updatedPaths ?? []),
    ...(terminal.deletedPaths ?? []),
    ...(terminal.preExistingTouchedPaths ?? []),
    ...(terminal.renamedPaths ?? []).flatMap((rename) => [rename.from, rename.to]),
  ].reduce((total, value) => total + Buffer.byteLength(value), 0);
}

function terminalRetainedEndpointCount(
  terminal: {
    readonly createdPaths?: readonly string[];
    readonly updatedPaths?: readonly string[];
    readonly deletedPaths?: readonly string[];
    readonly preExistingTouchedPaths?: readonly string[];
    readonly renamedPaths?: readonly { readonly from: string; readonly to: string }[];
  },
): number {
  return (
    (terminal.createdPaths?.length ?? 0) +
    (terminal.updatedPaths?.length ?? 0) +
    (terminal.deletedPaths?.length ?? 0) +
    (terminal.preExistingTouchedPaths?.length ?? 0) +
    (terminal.renamedPaths?.length ?? 0) * 2
  );
}

function validNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0;
}

function isExpectedArtifactReference(
  value: unknown,
  kind: ArtifactReference["kind"],
): value is ArtifactReference {
  return isArtifactReference(value) && value.kind === kind;
}

function isTerminalPostObservationControl(value: unknown): boolean {
  if (!hasExactKeys(value, ["branch", "head", "excludedStateFingerprint"])) {
    return false;
  }
  const control = value as {
    readonly branch?: unknown;
    readonly head?: unknown;
    readonly excludedStateFingerprint?: unknown;
  };
  return (
    (control.branch === null || typeof control.branch === "string") &&
    (control.head === null || typeof control.head === "string") &&
    typeof control.excludedStateFingerprint === "string" &&
    HASH_PATTERN.test(control.excludedStateFingerprint)
  );
}

function isArtifactReference(value: unknown): value is ArtifactReference {
  if (!hasExactKeys(value, ["kind", "id", "bytes", "sha256"])) return false;
  const reference = value as Partial<ArtifactReference>;
  return typeof reference.kind === "string" &&
    (ARTIFACT_KINDS as readonly string[]).includes(reference.kind) &&
    typeof reference.id === "string" &&
    /^[A-Za-z0-9._-]{3,160}$/u.test(reference.id) &&
    typeof reference.bytes === "number" &&
    Number.isSafeInteger(reference.bytes) &&
    reference.bytes >= 0 &&
    typeof reference.sha256 === "string" &&
    HASH_PATTERN.test(reference.sha256);
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
