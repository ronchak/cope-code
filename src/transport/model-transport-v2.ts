import type {
  ModelTransport,
  ReceiveRequest,
  ReceiveResult,
  SubmissionReceipt,
  SubmissionRequest,
  SubmissionResolutionRequest,
  TransportCallOptions,
  TurnCorrelation,
} from "./model-transport.js";

/** Additive contract for structured transports; cba/1 remains a v1 transport. */
export const MODEL_TRANSPORT_V2_CONTRACT_VERSION = "model-transport/v2" as const;

export type TransportOutputMode = "complete" | "stream";
export type TransportSignalKind = "model" | "usage" | "stop" | "context";

export interface TransportModelDescriptor {
  readonly id: string;
  readonly displayName?: string;
  readonly contextWindowTokens?: number;
}

export interface ModelTransportCapabilities {
  readonly contractVersion: typeof MODEL_TRANSPORT_V2_CONTRACT_VERSION;
  /** Stable implementation identifier, never a credential or endpoint. */
  readonly transportKind: string;
  readonly inputKinds: readonly ["text"];
  readonly outputModes: readonly TransportOutputMode[];
  readonly signals: readonly TransportSignalKind[];
  readonly models?: readonly TransportModelDescriptor[];
  readonly maxInputBytes?: number;
}

export interface TransportNegotiationRequest {
  readonly outputMode?: TransportOutputMode;
  readonly modelId?: string;
  readonly requiredSignals?: readonly TransportSignalKind[];
}

export interface NegotiatedTransportCapabilities {
  readonly contractVersion: typeof MODEL_TRANSPORT_V2_CONTRACT_VERSION;
  readonly transportKind: string;
  readonly outputMode: TransportOutputMode;
  readonly modelId?: string;
  readonly signals: readonly TransportSignalKind[];
  readonly maxInputBytes?: number;
}

export interface TextTransportInput {
  readonly kind: "text";
  readonly content: string;
}

export interface TypedSubmissionRequest extends TurnCorrelation {
  /** Carries the same persisted exactly-once key as v1 SubmissionRequest. */
  readonly submissionId: string;
  readonly input: TextTransportInput;
  readonly expectedConversationId?: string;
  readonly modelId?: string;
}

interface TransportStreamEventBase extends TurnCorrelation {
  readonly contractVersion: typeof MODEL_TRANSPORT_V2_CONTRACT_VERSION;
  readonly submissionId: string;
  readonly observedAt: string;
}

export interface OutputDeltaEvent extends TransportStreamEventBase {
  readonly type: "output-delta";
  readonly responseId: string;
  readonly sequence: number;
  readonly content: string;
}

export interface ModelSignalEvent extends TransportStreamEventBase {
  readonly type: "model";
  readonly modelId: string;
}

export interface UsageSignalEvent extends TransportStreamEventBase {
  readonly type: "usage";
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface ContextSignalEvent extends TransportStreamEventBase {
  readonly type: "context";
  readonly usedTokens?: number;
  readonly remainingTokens?: number;
  readonly contextWindowTokens?: number;
  readonly compactionRecommended?: boolean;
}

export type TransportStopReason =
  | "end-turn"
  | "max-tokens"
  | "tool-use"
  | "blocked"
  | "timed-out"
  | "cancelled"
  | "indeterminate"
  | "error";

export interface StopSignalEvent extends TransportStreamEventBase {
  readonly type: "stop";
  readonly reason: TransportStopReason;
  readonly diagnosticCode?: string;
}

export interface CompletedStreamEvent extends TransportStreamEventBase {
  readonly type: "completed";
  /** Authoritative terminal result; deltas and signals are advisory until this event. */
  readonly result: ReceiveResult;
}

export type TransportStreamEvent =
  | OutputDeltaEvent
  | ModelSignalEvent
  | UsageSignalEvent
  | ContextSignalEvent
  | StopSignalEvent
  | CompletedStreamEvent;

/**
 * V2 is deliberately additive. Implementations retain v1 submit/receive so
 * existing orchestrators and the CBA text adapter continue to work unchanged.
 * submitTyped and resolveSubmission share one idempotency namespace: an
 * indeterminate receipt MUST NOT be retried until resolution proves
 * `not-submitted`.
 */
export interface ModelTransportV2 extends ModelTransport {
  getCapabilities(options?: TransportCallOptions): Promise<ModelTransportCapabilities>;
  negotiate(
    request: TransportNegotiationRequest,
    options?: TransportCallOptions,
  ): Promise<NegotiatedTransportCapabilities>;
  submitTyped(request: TypedSubmissionRequest, options?: TransportCallOptions): Promise<SubmissionReceipt>;
  stream(request: ReceiveRequest, options?: TransportCallOptions): AsyncIterable<TransportStreamEvent>;

  /** Explicitly repeated to make the exactly-once recovery requirement visible. */
  resolveSubmission(
    request: SubmissionResolutionRequest,
    options?: TransportCallOptions,
  ): Promise<SubmissionReceipt>;
}

export function isModelTransportV2(transport: ModelTransport): transport is ModelTransportV2 {
  const candidate = transport as Partial<ModelTransportV2>;
  return (
    typeof candidate.getCapabilities === "function" &&
    typeof candidate.negotiate === "function" &&
    typeof candidate.submitTyped === "function" &&
    typeof candidate.stream === "function"
  );
}

/** Deterministic negotiation helper for transports with a static catalog. */
export function negotiateCapabilities(
  capabilities: ModelTransportCapabilities,
  request: TransportNegotiationRequest,
): NegotiatedTransportCapabilities {
  assertValidCapabilities(capabilities);
  const outputMode = request.outputMode ?? "complete";
  if (!capabilities.outputModes.includes(outputMode)) {
    throw new TypeError(`Transport does not support '${outputMode}' output`);
  }
  if (request.modelId !== undefined && capabilities.models?.some((model) => model.id === request.modelId) !== true) {
    throw new TypeError(`Transport does not advertise model '${request.modelId}'`);
  }
  const requiredSignals = [...new Set(request.requiredSignals ?? [])];
  const missing = requiredSignals.filter((signal) => !capabilities.signals.includes(signal));
  if (missing.length > 0) {
    throw new TypeError(`Transport does not support required signal(s): ${missing.join(", ")}`);
  }
  return {
    contractVersion: MODEL_TRANSPORT_V2_CONTRACT_VERSION,
    transportKind: capabilities.transportKind,
    outputMode,
    ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
    signals: requiredSignals,
    ...(capabilities.maxInputBytes === undefined ? {} : { maxInputBytes: capabilities.maxInputBytes }),
  };
}

export function assertValidCapabilities(capabilities: ModelTransportCapabilities): void {
  if (capabilities.contractVersion !== MODEL_TRANSPORT_V2_CONTRACT_VERSION) {
    throw new TypeError("Transport capabilities use an unsupported contract version");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(capabilities.transportKind)) {
    throw new TypeError("Transport kind must be a bounded identifier");
  }
  if (capabilities.outputModes.length === 0 || new Set(capabilities.outputModes).size !== capabilities.outputModes.length) {
    throw new TypeError("Transport output modes must be non-empty and unique");
  }
  if (new Set(capabilities.signals).size !== capabilities.signals.length) {
    throw new TypeError("Transport signals must be unique");
  }
  const modelIds = capabilities.models?.map((model) => model.id) ?? [];
  if (
    modelIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(id)) ||
    new Set(modelIds).size !== modelIds.length
  ) {
    throw new TypeError("Transport model identifiers must be bounded and unique");
  }
  for (const value of [
    capabilities.maxInputBytes,
    ...(capabilities.models?.map((model) => model.contextWindowTokens) ?? []),
  ]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new TypeError("Transport capability bounds must be positive safe integers");
    }
  }
}

/** Lossless conversion used by future V2 transports when serving v1 callers. */
export function toStringSubmission(request: TypedSubmissionRequest): SubmissionRequest {
  return {
    taskId: request.taskId,
    turnId: request.turnId,
    submissionId: request.submissionId,
    content: request.input.content,
    ...(request.expectedConversationId === undefined
      ? {}
      : { expectedConversationId: request.expectedConversationId }),
  };
}
