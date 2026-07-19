/**
 * Versioned, browser-agnostic contract between orchestration and a reasoning
 * transport.  Nothing in this module knows about pages, selectors, or DOM.
 */
export const MODEL_TRANSPORT_CONTRACT_VERSION = "model-transport/v1" as const;

export interface TurnCorrelation {
  readonly taskId: string;
  readonly turnId: string;
}

export interface SubmissionRequest extends TurnCorrelation {
  /** Stable idempotency key assigned and persisted by the orchestrator. */
  readonly submissionId: string;
  readonly content: string;
  /** When present, submitting into a different conversation is forbidden. */
  readonly expectedConversationId?: string;
}

/**
 * `indeterminate` is deliberately distinct from failure.  Callers MUST NOT
 * retry an indeterminate submission until resolveSubmission proves it was not
 * submitted.
 */
export type SubmissionStatus = "submitted" | "not-submitted" | "indeterminate";

export interface SubmissionReceipt extends TurnCorrelation {
  readonly contractVersion: typeof MODEL_TRANSPORT_CONTRACT_VERSION;
  readonly submissionId: string;
  readonly status: SubmissionStatus;
  readonly observedAt: string;
  readonly conversationId?: string;
  /** Opaque correlation marker; it contains no prompt or response content. */
  readonly transportMarker?: string;
  readonly diagnosticCode?: string;
}

export interface SubmissionResolutionRequest extends TurnCorrelation {
  readonly submissionId: string;
  readonly expectedConversationId?: string;
}

export interface ReceiveRequest extends TurnCorrelation {
  readonly submissionId: string;
  readonly maxWaitMs?: number;
  readonly expectedConversationId?: string;
}

export type TransportBlockReason =
  | "authentication-required"
  | "identity-unverified"
  | "protection-unverified"
  | "unapproved-host"
  | "throttled"
  | "service-error"
  | "blocking-modal"
  | "transport-incompatible"
  | "transport-disabled"
  | "conversation-mismatch"
  | "submission-unresolved"
  | "unknown";

interface ReceiveResultBase extends TurnCorrelation {
  readonly contractVersion: typeof MODEL_TRANSPORT_CONTRACT_VERSION;
  readonly submissionId: string;
  readonly observedAt: string;
  readonly conversationId?: string;
}

export interface CompletedReceiveResult extends ReceiveResultBase {
  readonly status: "completed";
  readonly responseId: string;
  readonly content: string;
}

export interface BlockedReceiveResult extends ReceiveResultBase {
  readonly status: "blocked";
  readonly reason: TransportBlockReason;
  readonly retryable: boolean;
  readonly diagnosticCode?: string;
}

export interface TimedOutReceiveResult extends ReceiveResultBase {
  readonly status: "timed-out";
  readonly diagnosticCode: "NO_RESPONSE" | "RESPONSE_INCOMPLETE";
}

export interface IndeterminateReceiveResult extends ReceiveResultBase {
  readonly status: "indeterminate";
  readonly diagnosticCode: string;
}

export interface CancelledReceiveResult extends ReceiveResultBase {
  readonly status: "cancelled";
  readonly diagnosticCode: "ABORTED" | "KILL_SWITCH";
}

export type ReceiveResult =
  | CompletedReceiveResult
  | BlockedReceiveResult
  | TimedOutReceiveResult
  | IndeterminateReceiveResult
  | CancelledReceiveResult;

export interface TransportCallOptions {
  readonly signal?: AbortSignal;
}

export interface ModelTransport {
  readonly transportKind: string;

  submit(
    request: SubmissionRequest,
    options?: TransportCallOptions,
  ): Promise<SubmissionReceipt>;

  /** Resolve an earlier result without causing another submission. */
  resolveSubmission(
    request: SubmissionResolutionRequest,
    options?: TransportCallOptions,
  ): Promise<SubmissionReceipt>;

  receive(request: ReceiveRequest, options?: TransportCallOptions): Promise<ReceiveResult>;

  /** Immediately prevents future actions and cancels transport-owned waits. */
  emergencyStop(reason: string): Promise<void>;

  close(): Promise<void>;
}

const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function assertValidCorrelation(value: TurnCorrelation & { readonly submissionId: string }): void {
  assertCorrelationPart("taskId", value.taskId);
  assertCorrelationPart("turnId", value.turnId);
  assertCorrelationPart("submissionId", value.submissionId);
}

function assertCorrelationPart(name: string, value: string): void {
  if (!CORRELATION_ID.test(value)) {
    throw new TypeError(`${name} must be a non-empty, bounded correlation identifier`);
  }
}

export function sameTurn(left: TurnCorrelation, right: TurnCorrelation): boolean {
  return left.taskId === right.taskId && left.turnId === right.turnId;
}
