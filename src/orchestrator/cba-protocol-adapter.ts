import {
  DEFAULT_MAX_PROTOCOL_INPUT_BYTES,
  PROTOCOL_ERROR_CODES,
  MODEL_FACING_PROTOCOL_VERSION,
  ProtocolParseError,
  parseProtocolEnvelope,
  extractCbaEnvelope,
  normalizeModelFacingMessage,
  parseModelFacingEnvelope,
  renderBootstrapContract,
  renderProtocolReminder,
  serializeProtocolEnvelope,
  validateProtocolMessage,
  isLocalToolName,
  isOrchestratorToolName,
  isToolName,
  type CompleteTaskArguments,
  type ProtocolErrorCode,
  type ProtocolMessage,
  type RequestCapabilityArguments,
  type OrchestratorToolName,
  type ToolName as WireToolName,
  type ToolOperation,
} from "../protocol/index.js";
import { sha256, stableJson } from "../shared/crypto.js";
import { AgentError } from "../shared/errors.js";
import type {
  NormalizedModelMessage,
  ParsedModelTurn,
  ProtocolAdapter,
  ToolName,
  ToolOutcome,
} from "./contracts.js";

const MODEL_MESSAGE_TYPES = new Set<ProtocolMessage["message_type"]>([
  "tool_request",
  "user_input_request",
  "capability_request",
  "progress_update",
  "completion",
  "blocked",
]);

const MODEL_PROTOCOL_CAPTURE_ERROR_MESSAGES = {
  MISSING_ENVELOPE: "The model response quoted a protocol fence outside an owned protocol widget.",
  MULTIPLE_ENVELOPES: "The captured model response contains more than one protocol envelope.",
  UNSUPPORTED_VERSION: "The captured model response used an unsupported protocol version.",
  EMPTY_ENVELOPE: "The captured model response contains an empty protocol envelope.",
  INVALID_JSON: "The captured model response does not contain complete, valid JSON.",
  SCHEMA_INVALID: "The captured model response body does not match its declared protocol dialect.",
} as const;

export interface CbaProtocolAdapterOptions {
  readonly seenOperationIds?: () => ReadonlySet<string>;
  readonly pathKey?: (value: string) => string;
  /**
   * Legacy correlation rebinding is allowed only for live browser responses
   * whose marker/baseline proof was established before protocol parsing.
   */
  readonly allowLegacyCorrelationRebind?: boolean;
}

export class CbaProtocolAdapter implements ProtocolAdapter {
  public constructor(private readonly options: CbaProtocolAdapterOptions = {}) {}

  public renderBootstrap(input: Parameters<ProtocolAdapter["renderBootstrap"]>[0]): string {
    const summary = input.policySummary;
    const tools = wireTools(summary.tools);
    return renderBootstrapContract({
      session_id: input.sessionId,
      task_id: input.taskId,
      first_turn_id: 1,
      objective: input.objective,
      acceptance_criteria: input.acceptanceCriteria,
      ...(tools === undefined ? {} : { tools }),
      policy: {
        mode: mode(summary.mode),
        readable_paths: strings(summary.readable_paths),
        writable_paths: strings(summary.writable_paths),
        protected_paths: strings(summary.protected_paths),
        command_ids: strings(summary.command_ids),
        disclosure_classifications: strings(summary.disclosure_classifications),
        network: decision(summary.network),
        ...(isRecord(summary.operation_limits)
          ? { operation_limits: summary.operation_limits }
          : {}),
        ...(isRecord(summary.budget_recovery)
          ? { budget_recovery: summary.budget_recovery }
          : {}),
        notes: strings(summary.notes),
      },
      budgets: budgetSummary(input.budgetSummary),
    });
  }

  public parseModelTurn(
    raw: string,
    expected: {
      readonly taskId: string;
      readonly turnId: string;
      readonly recoveryReplay?: boolean;
      readonly captureEvidence?: Readonly<Record<string, unknown>>;
    },
  ): ParsedModelTurn {
    enforceOwnedReconstructedCapture(expected.captureEvidence);
    const actualBytes = Buffer.byteLength(raw, "utf8");
    if (actualBytes > DEFAULT_MAX_PROTOCOL_INPUT_BYTES) {
      throw new ProtocolParseError(
        "INPUT_TOO_LARGE",
        `The response is ${actualBytes} bytes, exceeding the ${DEFAULT_MAX_PROTOCOL_INPUT_BYTES}-byte protocol input limit.`,
        {
          actual_bytes: actualBytes,
          maximum_bytes: DEFAULT_MAX_PROTOCOL_INPUT_BYTES,
        },
        false,
      );
    }
    const numericTurn = parseTurnId(expected.turnId);
    const seen = expected.recoveryReplay === true ? undefined : this.options.seenOperationIds?.();
    const parseContext = {
      expected_task_id: expected.taskId,
      expected_turn_id: numericTurn,
      accepted_message_types: MODEL_MESSAGE_TYPES,
      ...(seen === undefined ? {} : { seen_operation_ids: seen }),
      ...(this.options.pathKey === undefined ? {} : { path_key: this.options.pathKey }),
    };
    let message: ProtocolMessage;
    let normalizations: ParsedModelTurn["normalizations"];
    if (isGenericCopilotFallback(raw)) {
      throw new ProtocolParseError(
        "INVALID_MESSAGE",
        "Copilot returned its generic service fallback instead of an agent response.",
        {
          stage: "model_response_classification",
          diagnostic_code: "COPILOT_GENERIC_FALLBACK",
          repairable: true,
          suggested_action: "Retry the bounded turn; if the fallback repeats, inspect the browser service state.",
        },
      );
    }
    const envelopeVersion = extractCbaEnvelope(raw).version;
    if (envelopeVersion === MODEL_FACING_PROTOCOL_VERSION) {
      const facing = parseModelFacingEnvelope(raw);
      const canonical = normalizeModelFacingMessage(facing, {
        taskId: expected.taskId,
        turnId: numericTurn,
        rawResponse: raw,
      });
      message = parseProtocolEnvelope(serializeProtocolEnvelope(canonical), parseContext);
    } else {
      try {
        message = parseProtocolEnvelope(raw, parseContext);
      } catch (error) {
        if (
          !(error instanceof ProtocolParseError) ||
          !["TASK_MISMATCH", "TURN_MISMATCH"].includes(error.protocolCode) ||
          this.options.allowLegacyCorrelationRebind !== true ||
          expected.recoveryReplay === true
        ) {
          throw error;
        }
        const legacy = parseLegacyWithoutExpectedCorrelation(raw, this.options.pathKey);
        const rebound = {
          ...legacy,
          task_id: expected.taskId,
          turn_id: numericTurn,
          message_id: `msg_legacy_${String(numericTurn)}_${sha256(raw).slice(0, 16)}`,
        } as ProtocolMessage;
        message = parseProtocolEnvelope(serializeProtocolEnvelope(rebound), parseContext);
        normalizations = [{
          kind: "legacy_correlation_rebound",
          receivedTaskId: legacy.task_id,
          expectedTaskId: expected.taskId,
          receivedTurnId: legacy.turn_id,
          expectedTurnId: numericTurn,
        }];
      }
    }
    return {
      protocolVersion: "cba/1",
      taskId: expected.taskId,
      turnId: expected.turnId,
      messages: [normalizeMessage(message)],
      ...(normalizations === undefined ? {} : { normalizations }),
    };
  }

  public isRepairableParseError(error: unknown): boolean {
    return error instanceof ProtocolParseError && error.repairable;
  }

  public renderToolOutcomes(input: Parameters<ProtocolAdapter["renderToolOutcomes"]>[0]): string {
    return withReminder({
      kind: "harness_tool_results",
      results: input.outcomes.map(modelToolResult),
    });
  }

  public renderProtocolError(input: Parameters<ProtocolAdapter["renderProtocolError"]>[0]): string {
    const requestedCode = input.code as ProtocolErrorCode;
    const code = (PROTOCOL_ERROR_CODES as readonly string[]).includes(requestedCode)
      ? requestedCode
      : "INVALID_MESSAGE";
    return withReminder({
      kind: "harness_protocol_error",
      error: {
        code,
        message: input.message,
        repairable: input.repairable ?? true,
        details: {
          ...(input.repairAttempt === undefined
            ? {}
            : { repair_attempt: input.repairAttempt }),
          source_code: input.code,
          ...(input.details ?? {}),
        },
      },
    });
  }

  public renderUserDecision(input: Parameters<ProtocolAdapter["renderUserDecision"]>[0]): string {
    return withReminder({
      kind: "harness_decision",
      operation_ref: input.requestId,
      request_kind: input.kind,
      decision: input.decision,
    });
  }

  public renderCompletionRejected(input: Parameters<ProtocolAdapter["renderCompletionRejected"]>[0]): string {
    return withReminder({
      kind: "harness_completion_rejected",
      operation_ref: input.operationId,
      error: {
        code: "COMPLETION_NOT_VERIFIED",
        message: "The deterministic harness did not accept the completion claim.",
        details: {
          reasons: input.verification.reasons,
          actual: input.verification.actual,
        },
      },
    });
  }
}

function normalizeMessage(message: ProtocolMessage): NormalizedModelMessage {
  switch (message.message_type) {
    case "tool_request": {
      const operation = message.operations[0];
      if (
        message.operations.length === 1 &&
        operation !== undefined &&
        isOrchestratorOperation(operation)
      ) {
        return normalizeOrchestratorTool(operation);
      }
      return {
        type: "tool_request",
        calls: message.operations.map((entry) => {
          if (!isLocalToolName(entry.tool)) {
            throw new AgentError("PROTOCOL_INVALID", `${entry.tool} must be requested alone`);
          }
          return {
            operationId: entry.operation_id,
            name: entry.tool,
            arguments: entry.arguments as Readonly<Record<string, unknown>>,
          };
        }),
      };
    }
    case "user_input_request":
      return {
        type: "request_user_input",
        requestId: message.operation_id,
        question: message.request.question,
        ...(message.request.choices === undefined
          ? {}
          : { choices: message.request.choices.map((choice) => `${choice.label} (${choice.id})`) }),
      };
    case "capability_request":
      return normalizeCapability(message.operation_id, message.request);
    case "progress_update":
      return { type: "progress", summary: message.summary };
    case "completion":
      return normalizeCompletion(message.operation_id, message.report);
    case "blocked":
      return {
        type: "blocked",
        reasonCode: message.reason_code,
        summary: message.summary,
        needed: message.needed,
        recoverable: message.recoverable,
      };
    case "tool_result":
    case "tool_denial":
    case "protocol_error":
      throw new AgentError("PROTOCOL_INVALID", `Model cannot send harness message type ${message.message_type}`);
  }
}

function isOrchestratorOperation(
  operation: ToolOperation,
): operation is ToolOperation<OrchestratorToolName> {
  return isOrchestratorToolName(operation.tool);
}

function normalizeOrchestratorTool(
  operation: ToolOperation<OrchestratorToolName>,
): NormalizedModelMessage {
  switch (operation.tool) {
    case "request_user_input":
      return normalizeUserInput(operation);
    case "request_capability":
      return normalizeCapability(operation.operation_id, operation.arguments);
    case "complete_task":
      return normalizeCompletion(operation.operation_id, operation.arguments);
  }
}

function normalizeUserInput(operation: Extract<ToolOperation, { readonly tool: "request_user_input" }>): NormalizedModelMessage {
  return {
    type: "request_user_input",
    requestId: operation.operation_id,
    question: `${operation.arguments.question}\nReason: ${operation.arguments.reason}`,
    ...(operation.arguments.choices === undefined
      ? {}
      : { choices: operation.arguments.choices.map((choice) => `${choice.label} (${choice.id})`) }),
  };
}

function normalizeCapability(operationId: string, request: RequestCapabilityArguments): NormalizedModelMessage {
  return {
    type: "request_capability",
    requestId: operationId,
    capability: request.target as unknown as Readonly<Record<string, unknown>>,
    reason: `${request.reason} Expected operation: ${request.expected_operation}`,
    ...(request.risk === undefined ? {} : { risk: request.risk }),
  };
}

function normalizeCompletion(operationId: string, report: CompleteTaskArguments): NormalizedModelMessage {
  return {
    type: "complete_task",
    operationId,
    claim: {
      ...(report.kind === undefined ? {} : { kind: report.kind }),
      summary: report.summary,
      ...(report.basis === undefined ? {} : {
        basis: {
          ...(report.basis.observed_files === undefined
            ? {}
            : { observedFiles: report.basis.observed_files }),
          ...(report.basis.tool_result_refs === undefined
            ? {}
            : { toolResultRefs: report.basis.tool_result_refs }),
          ...(report.basis.user_provided_context === undefined
            ? {}
            : { userProvidedContext: report.basis.user_provided_context }),
        },
      }),
      acceptanceCriteria: report.acceptance_criteria.map((criterion) => ({
        criterion: criterion.criterion,
        status: criterion.status,
        ...(criterion.evidence === undefined ? {} : { evidence: criterion.evidence }),
      })),
      validation: report.validation.map((validation) => ({
        commandId: validation.command_id,
        status: validation.status,
        summary: validation.summary,
      })),
      skippedValidation: report.skipped_validation,
      remainingRisks: report.remaining_risks,
      recommendedFollowUp: report.follow_up,
    },
  };
}

function parseLegacyWithoutExpectedCorrelation(
  raw: string,
  pathKey: ((value: string) => string) | undefined,
): ProtocolMessage {
  const envelope = extractCbaEnvelope(raw, "cba/1");
  const decoded = JSON.parse(envelope.json) as unknown;
  const validation = validateProtocolMessage(decoded);
  if (!validation.valid || validation.value === undefined) {
    throw new ProtocolParseError(
      "SCHEMA_INVALID",
      "The legacy cba/1 message does not conform to the internal schema.",
      { errors: validation.errors },
    );
  }
  return parseProtocolEnvelope(raw, {
    expected_task_id: validation.value.task_id,
    expected_turn_id: validation.value.turn_id,
    accepted_message_types: MODEL_MESSAGE_TYPES,
    ...(pathKey === undefined ? {} : { path_key: pathKey }),
  });
}

function isGenericCopilotFallback(raw: string): boolean {
  if (raw.includes("```cba/") || raw.includes("```cba-agent/")) return false;
  const normalized = raw
    .trim()
    .replaceAll("’", "'")
    .replace(/\s+/gu, " ");
  return /^Sorry, I (?:wasn't|was not) able to respond to that\.? Is there something else I can help with\??$/iu.test(
    normalized,
  );
}

function modelToolResult(outcome: ToolOutcome) {
  const success = outcome.status === "success";
  const denied = outcome.status === "denied";
  return {
    operation_ref: outcome.operationId,
    tool: outcome.tool,
    status: outcome.status,
    ...(success ? { output: outcome.data } : {
      error: {
        code: String(outcome.data.code ?? (denied ? "POLICY_DENIED" : outcome.status.toUpperCase())),
        message: String(outcome.data.message ?? `Tool ended with ${outcome.status}`),
        retry_allowed: retryAllowed(outcome),
        request_capability_would_help:
          denied && outcome.data.decision === "ask",
        ...(isRecord(outcome.data.details)
          ? { details: outcome.data.details }
          : { details: outcome.data }),
      },
    }),
  };
}

function retryAllowed(outcome: ToolOutcome): boolean {
  if (outcome.status === "conflict" || outcome.status === "timeout") return true;
  if (outcome.status !== "denied") return false;
  return outcome.data.decision === "ask" ||
    isRecord(outcome.data.details) &&
      isRecord(outcome.data.details.retry_with);
}

function withReminder(
  payload: Readonly<Record<string, unknown>>,
): string {
  return [
    "COPE HARNESS MESSAGE — cba-agent/1",
    "<authoritative_harness_message_json>",
    stableJson(payload),
    "</authoritative_harness_message_json>",
    "",
    renderProtocolReminder(),
  ].join("\n");
}

function parseTurnId(value: string): number {
  const match = /^turn_(\d{1,9})$/u.exec(value);
  const numeric = Number.parseInt(match?.[1] ?? "", 10);
  if (!Number.isSafeInteger(numeric) || numeric < 1) {
    throw new AgentError("PROTOCOL_INVALID", `Invalid turn identifier '${value}'`);
  }
  return numeric;
}

function enforceOwnedReconstructedCapture(
  evidence: Readonly<Record<string, unknown>> | undefined,
): void {
  if (evidence === undefined) return;
  if (
    evidence.contractVersion === "response-capture/v2" &&
    evidence.status === "protocol_reconstructed"
  ) {
    return;
  }
  const code = evidence.protocolErrorCode;
  if (
    evidence.contractVersion === "response-capture/v2" &&
    evidence.status === "model_protocol_malformed" &&
    typeof code === "string" &&
    Object.hasOwn(MODEL_PROTOCOL_CAPTURE_ERROR_MESSAGES, code)
  ) {
    const protocolCode = code as keyof typeof MODEL_PROTOCOL_CAPTURE_ERROR_MESSAGES;
    throw new ProtocolParseError(
      protocolCode,
      MODEL_PROTOCOL_CAPTURE_ERROR_MESSAGES[protocolCode],
      { stage: "model_response_capture" },
      true,
    );
  }
  throw new ProtocolParseError(
    "INVALID_MESSAGE",
    "Capture evidence does not establish an owned reconstructed protocol widget.",
    {
      stage: "model_response_capture",
      capture_ownership_failed: true,
    },
    false,
  );
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function wireTools(value: unknown): readonly WireToolName[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isToolName);
}

function mode(value: unknown): "inspect" | "edit" | "auto" {
  return value === "inspect" || value === "auto" ? value : "edit";
}

function decision(value: unknown): "allow" | "ask" | "deny" {
  return value === "allow" || value === "ask" ? value : "deny";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function budgetSummary(value: Readonly<Record<string, unknown>>) {
  const limits = value.limits as Readonly<Record<string, unknown>> | undefined;
  return compactNumbers({
    elapsed_ms: numberOrUndefined(limits?.maxElapsedMs),
    turns: numberOrUndefined(limits?.maxTurns),
    operations: numberOrUndefined(limits?.maxOperations),
    read_files: numberOrUndefined(limits?.maxReadFiles),
    changed_files: numberOrUndefined(limits?.maxChangedFiles),
    changed_lines: numberOrUndefined(limits?.maxChangedLines),
    disclosed_bytes: numberOrUndefined(limits?.maxDisclosedBytes),
    commands: numberOrUndefined(limits?.maxCommands),
    command_output_bytes: numberOrUndefined(limits?.maxCommandOutputBytes),
    protocol_repairs: numberOrUndefined(limits?.maxProtocolRepairs),
  });
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function compactNumbers(value: Readonly<Record<string, number | undefined>>): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
}
