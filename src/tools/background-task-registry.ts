import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import { newId, sha256, stableJson } from "../shared/crypto.js";
import { AgentError } from "../shared/errors.js";
import type { RunCommandRequest, ResolvedCommand } from "./command-catalog.js";
import type { CommandOutcome } from "./process-runner.js";

const BACKGROUND_TASK_SCHEMA_VERSION = 1;
const GENESIS_HASH = "0".repeat(64);
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const TASK_ID_PATTERN = /^background_[0-9a-f-]{36}$/u;

export type BackgroundTaskStatus =
  | "queued"
  | "running"
  | "success"
  | "failure"
  | "timeout"
  | "cancelled"
  | "policy-denied"
  | "indeterminate"
  | "interrupted";

export interface BackgroundTaskHandle {
  readonly taskId: string;
  readonly commandId: string;
}

export interface BackgroundTaskRecord extends BackgroundTaskHandle {
  readonly status: BackgroundTaskStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly outcome?: CommandOutcome;
}

export interface CatalogCommandRunner {
  describe(request: RunCommandRequest): ResolvedCommand;
  run(request: RunCommandRequest, signal?: AbortSignal): Promise<CommandOutcome>;
}

export interface BackgroundTaskRegistryOptions {
  readonly maxTasks?: number;
  readonly maxConcurrent?: number;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

interface JournalEvent extends BackgroundTaskRecord {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly previousHash: string;
  readonly eventHash: string;
}

/**
 * Durable lifecycle registry for background execution of approved catalog
 * commands. It deliberately accepts no executable, argv, or shell string.
 */
export class BackgroundTaskRegistry {
  private readonly tasks = new Map<string, BackgroundTaskRecord>();
  private readonly active = new Map<string, { controller: AbortController; completion: Promise<void> }>();
  private readonly maxTasks: number;
  private readonly maxConcurrent: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private initializePromise?: Promise<void>;
  private appendTail: Promise<void> = Promise.resolve();
  private sequence = 0;
  private previousHash = GENESIS_HASH;
  private journalBytes = 0;

  public constructor(
    private readonly journalFile: string,
    private readonly runner: CatalogCommandRunner,
    options: BackgroundTaskRegistryOptions = {},
  ) {
    this.maxTasks = boundedInteger(options.maxTasks ?? 128, 1, 1_024, "maxTasks");
    this.maxConcurrent = boundedInteger(options.maxConcurrent ?? 4, 1, 32, "maxConcurrent");
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => newId("background"));
  }

  public async initialize(): Promise<void> {
    this.initializePromise ??= this.loadAndRecover();
    await this.initializePromise;
  }

  public async start(request: RunCommandRequest): Promise<BackgroundTaskHandle> {
    await this.initialize();
    // Catalog resolution is the authority boundary. Unknown commands, raw
    // executables, untyped arguments, and excessive timeouts fail before a
    // task handle or durable record exists.
    const command = this.runner.describe(request);
    if (this.tasks.size >= this.maxTasks) {
      throw new AgentError("BUDGET_EXCEEDED", "Background task registry is full", { limit: this.maxTasks });
    }
    if (this.active.size >= this.maxConcurrent) {
      throw new AgentError("BUDGET_EXCEEDED", "Background task concurrency is exhausted", {
        limit: this.maxConcurrent,
      });
    }
    const taskId = this.idFactory();
    if (!TASK_ID_PATTERN.test(taskId) || this.tasks.has(taskId)) {
      throw new AgentError("INTERNAL_ERROR", "Background task identifier is invalid or reused");
    }
    const timestamp = this.now().toISOString();
    let record: BackgroundTaskRecord = {
      taskId,
      commandId: command.id,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.record(record);
    record = { ...record, status: "running", updatedAt: this.now().toISOString() };
    await this.record(record);

    const controller = new AbortController();
    const completion = Promise.resolve().then(() => this.finish(taskId, request, controller.signal));
    this.active.set(taskId, { controller, completion });
    void completion.catch(() => undefined);
    return { taskId, commandId: command.id };
  }

  public async status(taskId: string): Promise<BackgroundTaskRecord> {
    await this.initialize();
    return this.requireTask(taskId);
  }

  public async list(): Promise<readonly BackgroundTaskRecord[]> {
    await this.initialize();
    return [...this.tasks.values()];
  }

  public async cancel(taskId: string): Promise<BackgroundTaskRecord> {
    await this.initialize();
    const existing = this.requireTask(taskId);
    const active = this.active.get(taskId);
    if (active === undefined) return existing;
    active.controller.abort(new AgentError("COMMAND_CANCELLED", "Background task cancellation requested"));
    await active.completion;
    return this.requireTask(taskId);
  }

  public async cancelAll(): Promise<void> {
    await this.initialize();
    const active = [...this.active.values()];
    for (const task of active) task.controller.abort(new AgentError("COMMAND_CANCELLED", "Background task shutdown requested"));
    await Promise.allSettled(active.map((task) => task.completion));
  }

  private async finish(taskId: string, request: RunCommandRequest, signal: AbortSignal): Promise<void> {
    try {
      const outcome = await this.runner.run(request, signal);
      const prior = this.requireTask(taskId);
      await this.record({
        ...prior,
        status: outcome.outcome,
        updatedAt: this.now().toISOString(),
        outcome,
      });
    } catch {
      const prior = this.requireTask(taskId);
      await this.record({
        ...prior,
        status: "indeterminate",
        updatedAt: this.now().toISOString(),
      });
    } finally {
      this.active.delete(taskId);
    }
  }

  private async loadAndRecover(): Promise<void> {
    await mkdir(path.dirname(this.journalFile), { recursive: true, mode: 0o700 });
    let content = "";
    try {
      const bytes = await readFile(this.journalFile);
      if (bytes.length > MAX_JOURNAL_BYTES) {
        throw new AgentError("RECOVERY_REQUIRED", "Background task journal exceeds its storage bound");
      }
      this.journalBytes = bytes.length;
      content = bytes.toString("utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (content !== "") this.replay(content);
    const unfinished = [...this.tasks.values()].filter((task) => task.status === "queued" || task.status === "running");
    for (const task of unfinished) {
      await this.record({ ...task, status: "interrupted", updatedAt: this.now().toISOString() });
    }
  }

  private replay(content: string): void {
    if (!content.endsWith("\n")) throw new AgentError("RECOVERY_REQUIRED", "Background task journal is partial");
    let expectedSequence = 1;
    let previousHash = GENESIS_HASH;
    for (const line of content.split("\n").slice(0, -1)) {
      let event: JournalEvent;
      try {
        event = JSON.parse(line) as JournalEvent;
      } catch (error) {
        throw new AgentError("RECOVERY_REQUIRED", "Background task journal is not valid JSON", {}, { cause: error });
      }
      if (!isJournalEvent(event) || event.sequence !== expectedSequence || event.previousHash !== previousHash) {
        throw new AgentError("RECOVERY_REQUIRED", "Background task journal chain is inconsistent");
      }
      const { eventHash, ...base } = event;
      if (sha256(stableJson(base)) !== eventHash) {
        throw new AgentError("RECOVERY_REQUIRED", "Background task journal integrity check failed");
      }
      this.tasks.set(event.taskId, recordFromEvent(event));
      previousHash = eventHash;
      expectedSequence += 1;
    }
    if (this.tasks.size > this.maxTasks) {
      throw new AgentError("RECOVERY_REQUIRED", "Background task journal exceeds the configured task bound");
    }
    this.sequence = expectedSequence - 1;
    this.previousHash = previousHash;
  }

  private async record(record: BackgroundTaskRecord): Promise<void> {
    const predecessor = this.appendTail;
    let release!: () => void;
    this.appendTail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      const base = {
        schemaVersion: BACKGROUND_TASK_SCHEMA_VERSION as 1,
        sequence: this.sequence + 1,
        previousHash: this.previousHash,
        ...record,
      };
      const event: JournalEvent = { ...base, eventHash: sha256(stableJson(base)) };
      const serialized = `${stableJson(event)}\n`;
      const serializedBytes = Buffer.byteLength(serialized);
      if (this.journalBytes + serializedBytes > MAX_JOURNAL_BYTES) {
        throw new AgentError("BUDGET_EXCEEDED", "Background task journal exceeds its storage bound");
      }
      const handle = await open(this.journalFile, "a", 0o600);
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.sequence = event.sequence;
      this.previousHash = event.eventHash;
      this.journalBytes += serializedBytes;
      this.tasks.set(record.taskId, record);
    } finally {
      release();
    }
  }

  private requireTask(taskId: string): BackgroundTaskRecord {
    if (!TASK_ID_PATTERN.test(taskId)) throw new AgentError("PROTOCOL_INVALID", "Invalid background task identifier");
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new AgentError("RECOVERY_REQUIRED", "Unknown background task", { taskId });
    return structuredClone(task);
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new AgentError("CONFIG_INVALID", `Invalid background task ${name}`, { value, minimum, maximum });
  }
  return value;
}

function isJournalEvent(value: unknown): value is JournalEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<JournalEvent>;
  const keys = Object.keys(event).sort();
  const expected = [
    "commandId", "createdAt", "eventHash", "previousHash", "schemaVersion", "sequence",
    "status", "taskId", "updatedAt", ...(event.outcome === undefined ? [] : ["outcome"]),
  ].sort();
  return stableJson(keys) === stableJson(expected) &&
    event.schemaVersion === BACKGROUND_TASK_SCHEMA_VERSION &&
    Number.isSafeInteger(event.sequence) &&
    typeof event.previousHash === "string" && /^[a-f0-9]{64}$/u.test(event.previousHash) &&
    typeof event.eventHash === "string" && /^[a-f0-9]{64}$/u.test(event.eventHash) &&
    typeof event.taskId === "string" && TASK_ID_PATTERN.test(event.taskId) &&
    typeof event.commandId === "string" && /^[a-z][a-z0-9_.-]{0,63}$/u.test(event.commandId) &&
    typeof event.status === "string" && STATUSES.has(event.status as BackgroundTaskStatus) &&
    typeof event.createdAt === "string" && Number.isFinite(Date.parse(event.createdAt)) &&
    typeof event.updatedAt === "string" && Number.isFinite(Date.parse(event.updatedAt)) &&
    (event.outcome === undefined || isCommandOutcome(event.outcome));
}

const STATUSES = new Set<BackgroundTaskStatus>([
  "queued", "running", "success", "failure", "timeout", "cancelled",
  "policy-denied", "indeterminate", "interrupted",
]);

function isCommandOutcome(value: unknown): value is CommandOutcome {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const outcome = value as Partial<CommandOutcome>;
  const keys = Object.keys(outcome).sort();
  const expected = [
    "commandId", "durationMs", "exitCode", "outcome", "redactionCount", "signal",
    "stderr", "stdout", "truncated", ...(outcome.error === undefined ? [] : ["error"]),
  ].sort();
  return stableJson(keys) === stableJson(expected) &&
    typeof outcome.commandId === "string" &&
    typeof outcome.outcome === "string" && COMMAND_OUTCOMES.has(outcome.outcome) &&
    (outcome.exitCode === null || Number.isSafeInteger(outcome.exitCode)) &&
    (outcome.signal === null || typeof outcome.signal === "string") &&
    typeof outcome.stdout === "string" && typeof outcome.stderr === "string" &&
    typeof outcome.truncated === "boolean" && Number.isSafeInteger(outcome.durationMs) &&
    Number.isSafeInteger(outcome.redactionCount) &&
    (outcome.error === undefined || typeof outcome.error === "string");
}

const COMMAND_OUTCOMES = new Set([
  "success", "failure", "timeout", "cancelled", "policy-denied", "indeterminate",
]);

function recordFromEvent(event: JournalEvent): BackgroundTaskRecord {
  return {
    taskId: event.taskId,
    commandId: event.commandId,
    status: event.status,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
  };
}
