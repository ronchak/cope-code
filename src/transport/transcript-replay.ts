import { readFile } from "node:fs/promises";

import { AgentError } from "../shared/errors.js";
import { sha256 } from "../shared/crypto.js";
import {
  MODEL_TRANSPORT_CONTRACT_VERSION,
  assertValidCorrelation,
  type ModelTransport,
  type ReceiveRequest,
  type ReceiveResult,
  type SubmissionReceipt,
  type SubmissionRequest,
  type SubmissionResolutionRequest,
  type TransportCallOptions,
} from "./model-transport.js";

export const TRANSCRIPT_SCHEMA_VERSION = "transport-transcript/v1" as const;

export interface TransportTranscriptV1 {
  readonly schemaVersion: typeof TRANSCRIPT_SCHEMA_VERSION;
  readonly events: readonly TranscriptEvent[];
}

export type TranscriptEvent = TranscriptSubmitEvent | TranscriptReceiveEvent | TranscriptResolveEvent;

interface TranscriptCorrelation {
  readonly taskId: string;
  readonly turnId: string;
  readonly submissionId: string;
}

export interface TranscriptSubmitEvent extends TranscriptCorrelation {
  readonly type: "submit";
  /** Content is checked by digest so fixtures need not duplicate prompt material. */
  readonly contentSha256: string;
  readonly receipt: SubmissionReceipt;
}

export interface TranscriptResolveEvent extends TranscriptCorrelation {
  readonly type: "resolve-submission";
  readonly receipt: SubmissionReceipt;
}

export interface TranscriptReceiveEvent extends TranscriptCorrelation {
  readonly type: "receive";
  readonly result: ReceiveResult;
}

/** Strict, zero-network replay of a previously approved transport transcript. */
export class TranscriptReplayTransport implements ModelTransport {
  public readonly transportKind = "transcript-replay/v1";

  readonly #events: readonly TranscriptEvent[];
  #cursor = 0;
  #stopped = false;
  #closed = false;

  public constructor(transcript: TransportTranscriptV1) {
    if (transcript.schemaVersion !== TRANSCRIPT_SCHEMA_VERSION) {
      throw new TypeError(`Unsupported transcript schema: ${String(transcript.schemaVersion)}`);
    }
    this.#events = transcript.events;
  }

  public static async fromFile(path: string): Promise<TranscriptReplayTransport> {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    assertTranscriptShape(raw);
    return new TranscriptReplayTransport(raw);
  }

  public async submit(
    request: SubmissionRequest,
    options: TransportCallOptions = {},
  ): Promise<SubmissionReceipt> {
    this.#assertUsable(options);
    assertValidCorrelation(request);
    const event = this.#consume("submit", request);
    if (event.contentSha256 !== sha256(request.content)) {
      throw new AgentError("PROTOCOL_INVALID", "Transcript submission content digest mismatch", {
        submissionId: request.submissionId,
        actualContentSha256: sha256(request.content),
      });
    }
    assertReceiptMatches(event.receipt, request);
    return event.receipt;
  }

  public async resolveSubmission(
    request: SubmissionResolutionRequest,
    options: TransportCallOptions = {},
  ): Promise<SubmissionReceipt> {
    this.#assertUsable(options);
    assertValidCorrelation(request);
    const event = this.#consume("resolve-submission", request);
    assertReceiptMatches(event.receipt, request);
    return event.receipt;
  }

  public async receive(
    request: ReceiveRequest,
    options: TransportCallOptions = {},
  ): Promise<ReceiveResult> {
    this.#assertUsable(options);
    assertValidCorrelation(request);
    const event = this.#consume("receive", request);
    assertResultMatches(event.result, request);
    return event.result;
  }

  public async emergencyStop(_reason: string): Promise<void> {
    this.#stopped = true;
  }

  public async close(): Promise<void> {
    this.#closed = true;
  }

  public get remainingEvents(): number {
    return this.#events.length - this.#cursor;
  }

  #consume<T extends TranscriptEvent["type"]>(
    type: T,
    correlation: TranscriptCorrelation,
  ): Extract<TranscriptEvent, { readonly type: T }> {
    const event = this.#events[this.#cursor];
    if (event === undefined) {
      throw new AgentError("TRANSPORT_UNAVAILABLE", "Transcript replay is exhausted");
    }
    if (event.type !== type) {
      throw new AgentError("PROTOCOL_INVALID", "Transcript event order mismatch", {
        expectedType: event.type,
        actualType: type,
        eventIndex: this.#cursor,
      });
    }
    assertTranscriptCorrelation(event, correlation, this.#cursor);
    this.#cursor += 1;
    return event as Extract<TranscriptEvent, { readonly type: T }>;
  }

  #assertUsable(options: TransportCallOptions): void {
    if (options.signal?.aborted === true) {
      throw options.signal.reason ?? new Error("Transport call aborted");
    }
    if (this.#stopped) {
      throw new AgentError("TRANSPORT_UNAVAILABLE", "Transcript replay kill switch is active");
    }
    if (this.#closed) {
      throw new AgentError("TRANSPORT_UNAVAILABLE", "Transcript replay is closed");
    }
  }
}

function assertTranscriptCorrelation(
  expected: TranscriptCorrelation,
  actual: TranscriptCorrelation,
  eventIndex: number,
): void {
  if (
    expected.taskId !== actual.taskId ||
    expected.turnId !== actual.turnId ||
    expected.submissionId !== actual.submissionId
  ) {
    throw new AgentError("PROTOCOL_INVALID", "Transcript correlation mismatch", {
      eventIndex,
      expectedTaskId: expected.taskId,
      expectedTurnId: expected.turnId,
      expectedSubmissionId: expected.submissionId,
      actualTaskId: actual.taskId,
      actualTurnId: actual.turnId,
      actualSubmissionId: actual.submissionId,
    });
  }
}

function assertTranscriptShape(value: unknown): asserts value is TransportTranscriptV1 {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as { schemaVersion?: unknown }).schemaVersion !== TRANSCRIPT_SCHEMA_VERSION ||
    !Array.isArray((value as { events?: unknown }).events)
  ) {
    throw new TypeError("Invalid transport transcript");
  }
}

function assertReceiptMatches(receipt: SubmissionReceipt, expected: TranscriptCorrelation): void {
  if (
    receipt.contractVersion !== MODEL_TRANSPORT_CONTRACT_VERSION ||
    receipt.taskId !== expected.taskId ||
    receipt.turnId !== expected.turnId ||
    receipt.submissionId !== expected.submissionId
  ) {
    throw new AgentError("PROTOCOL_INVALID", "Transcript receipt correlation mismatch", {
      submissionId: expected.submissionId,
    });
  }
}

function assertResultMatches(result: ReceiveResult, expected: TranscriptCorrelation): void {
  if (
    result.contractVersion !== MODEL_TRANSPORT_CONTRACT_VERSION ||
    result.taskId !== expected.taskId ||
    result.turnId !== expected.turnId ||
    result.submissionId !== expected.submissionId
  ) {
    throw new AgentError("PROTOCOL_INVALID", "Transcript result correlation mismatch", {
      submissionId: expected.submissionId,
    });
  }
}
