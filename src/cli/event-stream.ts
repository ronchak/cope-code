import type { RuntimeProgressEvent } from "../orchestrator/agent-runtime.js";

export const COPE_EVENTS_VERSION = "cope-events/1" as const;

export const COPE_EVENT_CAPABILITIES = {
  runtime_progress: true,
  source_free: true,
  ordered_sequence: true,
  stdout_legacy_result: true,
  interactive_requests: false,
} as const;

export interface EventWritable {
  write(value: string): unknown;
}

export interface CopeEvent {
  readonly schema_version: typeof COPE_EVENTS_VERSION;
  readonly sequence: number;
  readonly timestamp: string;
  readonly event: "stream.started" | "runtime.progress";
  readonly capabilities?: typeof COPE_EVENT_CAPABILITIES;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Writes one ordered, source-free cope-events/1 JSON object per line. */
export class CopeEventStream {
  private sequence = 0;
  private started = false;

  public constructor(private readonly destination: EventWritable) {}

  public runtimeProgress(progress: RuntimeProgressEvent): void {
    if (!this.started) this.start(progress.timestamp);
    this.write({
      schema_version: COPE_EVENTS_VERSION,
      sequence: ++this.sequence,
      timestamp: progress.timestamp,
      event: "runtime.progress",
      data: sourceFreeProgress(progress),
    });
  }

  private start(timestamp: string): void {
    this.started = true;
    this.write({
      schema_version: COPE_EVENTS_VERSION,
      sequence: ++this.sequence,
      timestamp,
      event: "stream.started",
      capabilities: COPE_EVENT_CAPABILITIES,
      data: {},
    });
  }

  private write(event: CopeEvent): void {
    this.destination.write(`${JSON.stringify(event)}\n`);
  }
}

function sourceFreeProgress(progress: RuntimeProgressEvent): Readonly<Record<string, unknown>> {
  const correlation = {
    ...(progress.turnId === undefined ? {} : { turn_id: progress.turnId }),
    ...(progress.operationId === undefined ? {} : { operation_id: progress.operationId }),
  };
  if (progress.kind === "state") {
    return {
      kind: progress.kind,
      status: progress.status,
      ...correlation,
      from: scalar(progress.detail.from),
      to: scalar(progress.detail.to),
      has_reason: typeof progress.detail.reason === "string" && progress.detail.reason.length > 0,
    };
  }
  if (progress.kind === "model") {
    return {
      kind: progress.kind,
      status: progress.status,
      ...correlation,
      response_status: scalar(progress.detail.status),
      response_bytes: nonNegativeInteger(progress.detail.responseBytes),
    };
  }
  if (progress.kind === "tool") {
    return {
      kind: progress.kind,
      status: progress.status,
      ...correlation,
      tool: scalar(progress.detail.tool),
      outcome: scalar(progress.detail.outcome),
    };
  }
  return {
    kind: progress.kind,
    status: progress.status,
    ...correlation,
    accepted: progress.detail.accepted === true,
    changed_file_count: nonNegativeInteger(progress.detail.changedFileCount),
    successful_command_count: nonNegativeInteger(progress.detail.successfulCommandCount),
    failed_command_count: nonNegativeInteger(progress.detail.failedCommandCount),
    rejection_count: nonNegativeInteger(progress.detail.rejectionCount),
  };
}

function scalar(value: unknown): string | null {
  return typeof value === "string" && value.length <= 256 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}
