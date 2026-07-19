import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { newId, sha256, stableJson } from "../shared/crypto.js";
import { AgentError } from "../shared/errors.js";
import { isOperationId } from "../shared/operation-id.js";

export type OperationStatus = "accepted" | "executing" | "completed" | "failed" | "indeterminate";

const MAX_OPERATION_RECORD_BYTES = 1024 * 1024;
const OPERATION_KEYS = [
  "schemaVersion",
  "sessionId",
  "operationId",
  "tool",
  "mutating",
  "requestHash",
  "acceptedAt",
  "updatedAt",
  "status",
  "outcome",
  "safeResult",
  "integrityHash",
] as const;

export interface OperationRecord {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly operationId: string;
  readonly tool: string;
  readonly mutating: boolean;
  readonly requestHash: string;
  readonly acceptedAt: string;
  readonly updatedAt: string;
  readonly status: OperationStatus;
  readonly outcome?: string;
  readonly safeResult?: Readonly<Record<string, unknown>>;
  readonly integrityHash: string;
}

export type RegisterOperationResult =
  | { readonly kind: "new"; readonly record: OperationRecord }
  | { readonly kind: "retry_safe"; readonly record: OperationRecord }
  | { readonly kind: "replay_completed"; readonly record: OperationRecord }
  | { readonly kind: "retry_read_only"; readonly record: OperationRecord }
  | { readonly kind: "indeterminate_mutation"; readonly record: OperationRecord };

export class OperationJournal {
  public constructor(
    private readonly directory: string,
    private readonly sessionId: string,
  ) {}

  public async register(
    operationId: string,
    tool: string,
    mutating: boolean,
    request: unknown,
    now: string,
  ): Promise<RegisterOperationResult> {
    assertOperationId(operationId);
    const requestHash = sha256(stableJson(request));
    const existing = await this.readOptional(operationId);
    if (existing) {
      if (existing.requestHash !== requestHash || existing.tool !== tool || existing.mutating !== mutating) {
        throw new AgentError("DUPLICATE_OPERATION", "Operation identifier was reused for a different request", {
          operationId,
        });
      }
      if (existing.status === "completed" || existing.status === "failed") {
        return { kind: "replay_completed", record: existing };
      }
      // Acceptance is durably recorded before execution begins. A crash at this
      // point therefore cannot have produced a tool side effect and the exact
      // same request can safely advance to executing.
      if (existing.status === "accepted") {
        return { kind: "retry_safe", record: existing };
      }
      if (mutating) {
        const indeterminate = await this.update(existing, "indeterminate", now, "uncertain_after_restart");
        return { kind: "indeterminate_mutation", record: indeterminate };
      }
      const retry = await this.update(existing, "accepted", now, "retry_read_only");
      return { kind: "retry_read_only", record: retry };
    }

    const base = {
      schemaVersion: 1 as const,
      sessionId: this.sessionId,
      operationId,
      tool,
      mutating,
      requestHash,
      acceptedAt: now,
      updatedAt: now,
      status: "accepted" as const,
    };
    const record: OperationRecord = { ...base, integrityHash: sha256(stableJson(base)) };
    await this.writeNew(record);
    return { kind: "new", record };
  }

  public async markExecuting(record: OperationRecord, now: string): Promise<OperationRecord> {
    if (record.status !== "accepted") {
      throw new AgentError("RECOVERY_REQUIRED", `Cannot execute operation from ${record.status}`, {
        operationId: record.operationId,
      });
    }
    return this.update(record, "executing", now);
  }

  public async markCompleted(
    record: OperationRecord,
    now: string,
    outcome: string,
    safeResult: Readonly<Record<string, unknown>>,
  ): Promise<OperationRecord> {
    if (record.status !== "executing") {
      throw new AgentError("RECOVERY_REQUIRED", `Cannot complete operation from ${record.status}`, {
        operationId: record.operationId,
      });
    }
    return this.update(record, "completed", now, outcome, safeResult);
  }

  public async markFailed(
    record: OperationRecord,
    now: string,
    outcome: string,
    safeResult: Readonly<Record<string, unknown>>,
  ): Promise<OperationRecord> {
    if (record.status !== "executing" && record.status !== "accepted") {
      throw new AgentError("RECOVERY_REQUIRED", `Cannot fail operation from ${record.status}`, {
        operationId: record.operationId,
      });
    }
    return this.update(record, "failed", now, outcome, safeResult);
  }

  public async markIndeterminate(
    record: OperationRecord,
    now: string,
    outcome: string,
    safeResult: Readonly<Record<string, unknown>>,
  ): Promise<OperationRecord> {
    if (record.status !== "executing" && record.status !== "accepted") {
      throw new AgentError("RECOVERY_REQUIRED", `Cannot mark operation indeterminate from ${record.status}`, {
        operationId: record.operationId,
      });
    }
    return this.update(record, "indeterminate", now, outcome, safeResult);
  }

  public async read(operationId: string): Promise<OperationRecord> {
    const record = await this.readOptional(operationId);
    if (!record) throw new AgentError("RECOVERY_REQUIRED", `Unknown operation ${operationId}`);
    return record;
  }

  private async update(
    record: OperationRecord,
    status: OperationStatus,
    now: string,
    outcome?: string,
    safeResult?: Readonly<Record<string, unknown>>,
  ): Promise<OperationRecord> {
    const latest = await this.read(record.operationId);
    if (latest.integrityHash !== record.integrityHash) {
      throw new AgentError("RECOVERY_REQUIRED", "Operation changed concurrently", {
        operationId: record.operationId,
      });
    }
    const { integrityHash: _oldHash, outcome: _oldOutcome, safeResult: _oldResult, ...prior } = latest;
    const base = {
      ...prior,
      updatedAt: now,
      status,
      ...(outcome === undefined ? {} : { outcome }),
      ...(safeResult === undefined ? {} : { safeResult }),
    };
    const updated: OperationRecord = { ...base, integrityHash: sha256(stableJson(base)) };
    await this.replace(updated);
    return updated;
  }

  private async readOptional(operationId: string): Promise<OperationRecord | undefined> {
    try {
      const bytes = await readFile(this.filename(operationId));
      if (bytes.length === 0 || bytes.length > MAX_OPERATION_RECORD_BYTES) {
        throw new AgentError("RECOVERY_REQUIRED", "Operation journal record is empty or oversized", { operationId });
      }
      const raw = bytes.toString("utf8");
      if (raw.charCodeAt(0) === 0xfeff || !raw.endsWith("\n")) {
        throw new AgentError("RECOVERY_REQUIRED", "Operation journal record is partial or contains a BOM", { operationId });
      }
      const parsed = JSON.parse(raw) as OperationRecord;
      if (!isOperationRecord(parsed)) {
        throw new AgentError("RECOVERY_REQUIRED", "Operation journal record has an invalid schema", { operationId });
      }
      const { integrityHash, ...base } = parsed;
      if (
        parsed.schemaVersion !== 1 ||
        parsed.sessionId !== this.sessionId ||
        parsed.operationId !== operationId ||
        sha256(stableJson(base)) !== integrityHash
      ) {
        throw new AgentError("RECOVERY_REQUIRED", "Operation journal integrity check failed", { operationId });
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (!(error instanceof AgentError)) {
        throw new AgentError("RECOVERY_REQUIRED", "Operation journal record is unreadable", {
          operationId,
        }, { cause: error });
      }
      throw error;
    }
  }

  private async writeNew(record: OperationRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const serialized = serializeRecord(record);
    const handle = await open(this.filename(record.operationId), "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async replace(record: OperationRecord): Promise<void> {
    const destination = this.filename(record.operationId);
    const temporary = `${destination}.${newId("write")}.tmp`;
    const serialized = serializeRecord(record);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
  }

  private filename(operationId: string): string {
    assertOperationId(operationId);
    return path.join(this.directory, `${operationId}.json`);
  }
}

function assertOperationId(operationId: string): void {
  if (!isOperationId(operationId)) {
    throw new AgentError("PROTOCOL_INVALID", "Unsafe operation identifier");
  }
}

function serializeRecord(record: OperationRecord): string {
  if (!isOperationRecord(record)) {
    throw new AgentError("INTERNAL_ERROR", "Refusing to persist a malformed operation journal record");
  }
  const serialized = `${stableJson(record)}\n`;
  if (Buffer.byteLength(serialized) > MAX_OPERATION_RECORD_BYTES) {
    throw new AgentError("BUDGET_EXCEEDED", "Operation journal record exceeds its storage bound", {
      operationId: record.operationId,
    });
  }
  return serialized;
}

function isOperationRecord(value: unknown): value is OperationRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<OperationRecord>;
  const keys = Object.keys(value);
  if (!keys.every((key) => OPERATION_KEYS.includes(key as typeof OPERATION_KEYS[number]))) return false;
  const required = [
    "schemaVersion", "sessionId", "operationId", "tool", "mutating", "requestHash",
    "acceptedAt", "updatedAt", "status", "integrityHash",
  ];
  if (!required.every((key) => keys.includes(key))) return false;
  if (
    item.schemaVersion !== 1 ||
    typeof item.sessionId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(item.sessionId) ||
    !isOperationId(item.operationId) ||
    typeof item.tool !== "string" || item.tool.length === 0 || item.tool.length > 128 ||
    typeof item.mutating !== "boolean" ||
    typeof item.requestHash !== "string" || !/^[a-f0-9]{64}$/u.test(item.requestHash) ||
    !isIsoTimestamp(item.acceptedAt) ||
    !isIsoTimestamp(item.updatedAt) ||
    !(["accepted", "executing", "completed", "failed", "indeterminate"] as const).includes(item.status as OperationStatus) ||
    typeof item.integrityHash !== "string" || !/^[a-f0-9]{64}$/u.test(item.integrityHash) ||
    (item.outcome !== undefined && (typeof item.outcome !== "string" || item.outcome.length > 4_096)) ||
    (item.safeResult !== undefined &&
      (item.safeResult === null || typeof item.safeResult !== "object" || Array.isArray(item.safeResult)))
  ) return false;
  if ((item.status === "completed" || item.status === "failed" || item.status === "indeterminate") && item.outcome === undefined) {
    return false;
  }
  return true;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}
