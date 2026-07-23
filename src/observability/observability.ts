import type { RuntimeProgressEvent } from "../orchestrator/agent-runtime.js";

const SESSION_STATUSES = new Set([
  "created", "preflight", "grant_pending", "transport_starting", "initializing_model", "awaiting_model",
  "executing_tools", "returning_results", "awaiting_user", "paused", "validating_completion", "recovering",
  "completed", "rolled_back", "blocked", "aborted", "failed",
]);
const TOOL_NAMES = new Set([
  "list_files", "search_text", "read_file", "git_status", "git_diff", "apply_patch", "run_command",
]);
const TOOL_OUTCOMES = new Set([
  "success", "failure", "conflict", "denied", "timeout", "cancelled", "indeterminate",
]);
const MODEL_STATUSES = new Set(["received"]);

export type OpenTelemetryAttributeValue = string | number | boolean;

/** A source-free record that maps directly to an OpenTelemetry event or metric point. */
export interface ObservabilityRecord {
  readonly signal: "event" | "counter" | "histogram";
  readonly name: string;
  readonly timestampUnixNano: string;
  readonly value?: number;
  readonly attributes: Readonly<Record<string, OpenTelemetryAttributeValue>>;
}

/** Adapter boundary for an OpenTelemetry SDK/OTLP exporter. It is never used by the audit log. */
export interface ObservabilityExporter {
  export(records: readonly ObservabilityRecord[], signal: AbortSignal): Promise<void>;
  shutdown?(signal: AbortSignal): Promise<void>;
}

export interface ObservabilityOptions {
  readonly maxQueueRecords?: number;
  readonly maxBatchRecords?: number;
  readonly exportTimeoutMs?: number;
}

export interface ObservabilityStats {
  readonly acceptedRecords: number;
  readonly droppedRecords: number;
  readonly failedBatches: number;
  readonly exportedBatches: number;
}

/**
 * Bounded, failure-isolated telemetry side channel. Exporter failures and
 * backpressure can drop telemetry but can never affect runtime or local audit.
 */
export class ObservabilityReporter {
  private readonly maxQueueRecords: number;
  private readonly maxBatchRecords: number;
  private readonly exportTimeoutMs: number;
  private readonly queue: ObservabilityRecord[] = [];
  private draining: Promise<void> | undefined;
  private acceptedRecords = 0;
  private droppedRecords = 0;
  private failedBatches = 0;
  private exportedBatches = 0;

  public constructor(
    private readonly exporter: ObservabilityExporter,
    options: ObservabilityOptions = {},
  ) {
    this.maxQueueRecords = boundedInteger(options.maxQueueRecords, 256, 1, 10_000);
    this.maxBatchRecords = boundedInteger(options.maxBatchRecords, 32, 1, 1_000);
    this.exportTimeoutMs = boundedInteger(options.exportTimeoutMs, 1_000, 10, 30_000);
  }

  public observe(event: RuntimeProgressEvent): void {
    try {
      for (const record of recordsForProgress(event)) {
        if (this.queue.length >= this.maxQueueRecords) {
          this.droppedRecords += 1;
          continue;
        }
        this.queue.push(record);
        this.acceptedRecords += 1;
      }
      this.scheduleDrain();
    } catch {
      // Projection is observational and deliberately cannot affect execution.
    }
  }

  public async flush(): Promise<void> {
    this.scheduleDrain();
    await this.draining;
  }

  public async shutdown(): Promise<void> {
    await this.flush();
    if (this.exporter.shutdown === undefined) return;
    await isolatedCall((signal) => this.exporter.shutdown?.(signal) ?? Promise.resolve(), this.exportTimeoutMs)
      .catch(() => { this.failedBatches += 1; });
  }

  public stats(): ObservabilityStats {
    return {
      acceptedRecords: this.acceptedRecords,
      droppedRecords: this.droppedRecords,
      failedBatches: this.failedBatches,
      exportedBatches: this.exportedBatches,
    };
  }

  private scheduleDrain(): void {
    if (this.draining !== undefined || this.queue.length === 0) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      if (this.queue.length > 0) this.scheduleDrain();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.maxBatchRecords);
      try {
        await isolatedCall((signal) => this.exporter.export(batch, signal), this.exportTimeoutMs);
        this.exportedBatches += 1;
      } catch {
        this.failedBatches += 1;
        this.droppedRecords += batch.length;
      }
    }
  }
}

export function recordsForProgress(event: RuntimeProgressEvent): readonly ObservabilityRecord[] {
  const timestampUnixNano = isoToUnixNano(event.timestamp);
  const common: Record<string, OpenTelemetryAttributeValue> = {
    "cope.runtime.kind": event.kind,
    "cope.session.status": allowlistedToken(event.status, SESSION_STATUSES),
  };
  if (event.kind === "state") {
    addToken(common, "cope.state.from", event.detail.from, SESSION_STATUSES);
    addToken(common, "cope.state.to", event.detail.to, SESSION_STATUSES);
    common["cope.state.has_reason"] = typeof event.detail.reason === "string" && event.detail.reason.length > 0;
  } else if (event.kind === "model") {
    addToken(common, "cope.model.status", event.detail.status, MODEL_STATUSES);
  } else if (event.kind === "tool") {
    addToken(common, "cope.tool.name", event.detail.tool, TOOL_NAMES);
    addToken(common, "cope.tool.outcome", event.detail.outcome, TOOL_OUTCOMES);
  } else {
    common["cope.completion.accepted"] = event.detail.accepted === true;
  }
  const attributes = Object.freeze({ ...common });

  const records: ObservabilityRecord[] = [{
    signal: "event",
    name: `cope.runtime.${event.kind}`,
    timestampUnixNano,
    attributes,
  }, {
    signal: "counter",
    name: "cope.runtime.events",
    timestampUnixNano,
    value: 1,
    attributes,
  }];
  addMeasurement(records, "histogram", "cope.model.response.bytes", event.detail.responseBytes, timestampUnixNano, attributes);
  addMeasurement(records, "counter", "cope.completion.changed_files", event.detail.changedFileCount, timestampUnixNano, attributes);
  addMeasurement(records, "counter", "cope.completion.successful_commands", event.detail.successfulCommandCount, timestampUnixNano, attributes);
  addMeasurement(records, "counter", "cope.completion.failed_commands", event.detail.failedCommandCount, timestampUnixNano, attributes);
  addMeasurement(records, "counter", "cope.completion.rejections", event.detail.rejectionCount, timestampUnixNano, attributes);
  return records;
}

function addMeasurement(
  records: ObservabilityRecord[],
  signal: "counter" | "histogram",
  name: string,
  raw: unknown,
  timestampUnixNano: string,
  attributes: Readonly<Record<string, OpenTelemetryAttributeValue>>,
): void {
  if (!Number.isSafeInteger(raw) || (raw as number) < 0) return;
  records.push({ signal, name, timestampUnixNano, value: raw as number, attributes });
}

function addToken(
  attributes: Record<string, OpenTelemetryAttributeValue>,
  key: string,
  raw: unknown,
  allowed: ReadonlySet<string>,
): void {
  if (typeof raw === "string" && allowed.has(raw)) attributes[key] = raw;
}

function allowlistedToken(value: string, allowed: ReadonlySet<string>): string {
  return allowed.has(value) ? value : "unknown";
}

function isoToUnixNano(value: string): string {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? (BigInt(milliseconds) * 1_000_000n).toString() : "0";
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value >= minimum && value <= maximum ? value : fallback;
}

async function isolatedCall(action: (signal: AbortSignal) => Promise<void>, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error("Observability export timed out"));
      reject(new Error("Observability export timed out"));
    }, timeoutMs);
    timer.unref?.();
  });
  const operation = Promise.resolve().then(() => action(controller.signal));
  try {
    await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void operation.catch(() => undefined);
  }
}
