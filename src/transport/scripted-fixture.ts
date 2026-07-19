import { AgentError } from "../shared/errors.js";
import { sha256 } from "../shared/crypto.js";
import { isoNow, type Clock } from "../shared/time.js";
import {
  MODEL_TRANSPORT_CONTRACT_VERSION,
  assertValidCorrelation,
  type ModelTransport,
  type ReceiveRequest,
  type ReceiveResult,
  type SubmissionReceipt,
  type SubmissionRequest,
  type SubmissionResolutionRequest,
  type SubmissionStatus,
  type TransportCallOptions,
} from "./model-transport.js";

export interface ScriptedFixtureTurn {
  readonly taskId: string;
  readonly turnId: string;
  readonly submissionId: string;
  readonly expectedContent?: string | RegExp;
  readonly conversationId?: string;
  readonly submissionStatus?: SubmissionStatus;
  readonly submissionDiagnosticCode?: string;
  readonly response: ScriptedFixtureResponse;
}

export type ScriptedFixtureResponse =
  | { readonly status: "completed"; readonly responseId?: string; readonly content: string }
  | {
      readonly status: "blocked";
      readonly reason: Extract<ReceiveResult, { readonly status: "blocked" }>["reason"];
      readonly retryable?: boolean;
      readonly diagnosticCode?: string;
    }
  | { readonly status: "timed-out"; readonly incomplete?: boolean }
  | { readonly status: "indeterminate"; readonly diagnosticCode?: string };

interface FixtureTurnState {
  readonly turn: ScriptedFixtureTurn;
  submitCalls: number;
  received: boolean;
}

/** Deterministic model fixture used to exercise the complete loop offline. */
export class ScriptedFixtureTransport implements ModelTransport {
  public readonly transportKind = "scripted-fixture/v1";

  readonly #clock: Clock;
  readonly #turns: FixtureTurnState[];
  readonly #receipts = new Map<string, SubmissionReceipt>();
  readonly #contentDigests = new Map<string, string>();
  #cursor = 0;
  #stopped = false;
  #closed = false;

  public constructor(turns: readonly ScriptedFixtureTurn[], clock: Clock = { now: () => new Date() }) {
    this.#clock = clock;
    this.#turns = turns.map((turn) => ({ turn, submitCalls: 0, received: false }));
    assertUniqueSubmissionIds(turns);
  }

  public async submit(
    request: SubmissionRequest,
    options: TransportCallOptions = {},
  ): Promise<SubmissionReceipt> {
    this.#assertUsable(options);
    assertValidCorrelation(request);

    const previous = this.#receipts.get(request.submissionId);
    const priorDigest = this.#contentDigests.get(request.submissionId);
    if (priorDigest !== undefined && priorDigest !== sha256(request.content)) {
      throw new AgentError("DUPLICATE_OPERATION", "Submission id was reused with different content", {
        submissionId: request.submissionId,
      });
    }
    if (previous !== undefined && previous.status !== "not-submitted") {
      this.#assertReceiptCorrelation(previous, request);
      return previous;
    }

    const state = this.#currentTurn();
    assertTurnMatches(state.turn, request);
    assertContentMatches(state.turn.expectedContent, request.content);
    state.submitCalls += 1;
    this.#contentDigests.set(request.submissionId, sha256(request.content));

    const status = state.turn.submissionStatus ?? "submitted";
    const base = {
      contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
      taskId: request.taskId,
      turnId: request.turnId,
      submissionId: request.submissionId,
      status,
      observedAt: isoNow(this.#clock),
      transportMarker: fixtureMarker(request),
    } as const;
    const withConversation =
      state.turn.conversationId === undefined
        ? base
        : { ...base, conversationId: state.turn.conversationId };
    const receipt: SubmissionReceipt =
      state.turn.submissionDiagnosticCode === undefined
        ? withConversation
        : { ...withConversation, diagnosticCode: state.turn.submissionDiagnosticCode };
    this.#receipts.set(request.submissionId, receipt);
    return receipt;
  }

  public async resolveSubmission(
    request: SubmissionResolutionRequest,
    options: TransportCallOptions = {},
  ): Promise<SubmissionReceipt> {
    this.#assertUsable(options);
    assertValidCorrelation(request);
    const receipt = this.#receipts.get(request.submissionId);
    if (receipt === undefined) {
      return {
        contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
        ...request,
        status: "not-submitted",
        observedAt: isoNow(this.#clock),
        diagnosticCode: "FIXTURE_NOT_SUBMITTED",
      };
    }
    this.#assertReceiptCorrelation(receipt, request);
    return receipt;
  }

  public async receive(
    request: ReceiveRequest,
    options: TransportCallOptions = {},
  ): Promise<ReceiveResult> {
    this.#assertUsable(options);
    assertValidCorrelation(request);
    const state = this.#currentTurn();
    assertTurnMatches(state.turn, request);
    const receipt = this.#receipts.get(request.submissionId);
    if (receipt?.status !== "submitted") {
      return this.#baseResult(request, {
        status: "blocked",
        reason: "submission-unresolved",
        retryable: receipt?.status === "not-submitted",
        diagnosticCode: "FIXTURE_SUBMISSION_UNRESOLVED",
      });
    }
    if (state.received) {
      throw new AgentError("DUPLICATE_OPERATION", "Fixture response has already been received", {
        submissionId: request.submissionId,
      });
    }

    state.received = true;
    this.#cursor += 1;
    const response = state.turn.response;
    switch (response.status) {
      case "completed":
        return this.#baseResult(request, {
          status: "completed",
          responseId: response.responseId ?? `fixture-response-${this.#cursor}`,
          content: response.content,
        });
      case "blocked": {
        const base = {
          status: "blocked" as const,
          reason: response.reason,
          retryable: response.retryable ?? false,
        };
        return this.#baseResult(
          request,
          response.diagnosticCode === undefined
            ? base
            : { ...base, diagnosticCode: response.diagnosticCode },
        );
      }
      case "timed-out":
        return this.#baseResult(request, {
          status: "timed-out",
          diagnosticCode: response.incomplete === true ? "RESPONSE_INCOMPLETE" : "NO_RESPONSE",
        });
      case "indeterminate":
        return this.#baseResult(request, {
          status: "indeterminate",
          diagnosticCode: response.diagnosticCode ?? "FIXTURE_INDETERMINATE",
        });
    }
  }

  public async emergencyStop(_reason: string): Promise<void> {
    this.#stopped = true;
  }

  public async close(): Promise<void> {
    this.#closed = true;
  }

  public get remainingTurns(): number {
    return this.#turns.length - this.#cursor;
  }

  #baseResult<T extends Omit<ReceiveResult, keyof ReturnType<typeof baseReceiveFields>>>(
    request: ReceiveRequest,
    result: T,
  ): ReceiveResult {
    const fields = baseReceiveFields(request, this.#clock);
    const turn = this.#turns[this.#cursor - 1]?.turn ?? this.#turns[this.#cursor]?.turn;
    return (
      turn?.conversationId === undefined
        ? { ...fields, ...result }
        : { ...fields, conversationId: turn.conversationId, ...result }
    ) as unknown as ReceiveResult;
  }

  #currentTurn(): FixtureTurnState {
    const state = this.#turns[this.#cursor];
    if (state === undefined) {
      throw new AgentError("TRANSPORT_UNAVAILABLE", "Scripted fixture is exhausted");
    }
    return state;
  }

  #assertUsable(options: TransportCallOptions): void {
    if (options.signal?.aborted === true) {
      throw options.signal.reason ?? new Error("Transport call aborted");
    }
    if (this.#stopped) {
      throw new AgentError("TRANSPORT_UNAVAILABLE", "Scripted fixture kill switch is active");
    }
    if (this.#closed) {
      throw new AgentError("TRANSPORT_UNAVAILABLE", "Scripted fixture is closed");
    }
  }

  #assertReceiptCorrelation(receipt: SubmissionReceipt, request: SubmissionResolutionRequest): void {
    if (receipt.taskId !== request.taskId || receipt.turnId !== request.turnId) {
      throw new AgentError("PROTOCOL_INVALID", "Submission id was reused with different correlation", {
        submissionId: request.submissionId,
      });
    }
  }
}

function baseReceiveFields(request: ReceiveRequest, clock: Clock) {
  return {
    contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
    taskId: request.taskId,
    turnId: request.turnId,
    submissionId: request.submissionId,
    observedAt: isoNow(clock),
  } as const;
}

function assertUniqueSubmissionIds(turns: readonly ScriptedFixtureTurn[]): void {
  const seen = new Set<string>();
  for (const turn of turns) {
    if (seen.has(turn.submissionId)) {
      throw new TypeError(`Duplicate scripted submission id: ${turn.submissionId}`);
    }
    seen.add(turn.submissionId);
  }
}

function assertTurnMatches(
  expected: Pick<ScriptedFixtureTurn, "taskId" | "turnId" | "submissionId">,
  actual: Pick<SubmissionRequest, "taskId" | "turnId" | "submissionId">,
): void {
  if (
    expected.taskId !== actual.taskId ||
    expected.turnId !== actual.turnId ||
    expected.submissionId !== actual.submissionId
  ) {
    throw new AgentError("PROTOCOL_INVALID", "Fixture turn correlation mismatch", {
      expectedTaskId: expected.taskId,
      expectedTurnId: expected.turnId,
      expectedSubmissionId: expected.submissionId,
      actualTaskId: actual.taskId,
      actualTurnId: actual.turnId,
      actualSubmissionId: actual.submissionId,
    });
  }
}

function assertContentMatches(expected: string | RegExp | undefined, actual: string): void {
  if (expected === undefined) return;
  if (expected instanceof RegExp) expected.lastIndex = 0;
  const matches = typeof expected === "string" ? expected === actual : expected.test(actual);
  if (!matches) {
    throw new AgentError("PROTOCOL_INVALID", "Fixture submission content did not match", {
      expectedKind: typeof expected === "string" ? "exact" : "pattern",
      actualLength: actual.length,
    });
  }
}

function fixtureMarker(request: SubmissionRequest): string {
  return `fixture:${request.taskId}:${request.turnId}:${request.submissionId}`;
}
