import {
  PROTOCOL_ERROR_CODES,
  createProtocolErrorMessage,
  createToolDenialMessage,
  createToolResultMessage,
  parseProtocolEnvelope,
  renderBootstrapContract,
  renderProtocolReminder,
  serializeProtocolEnvelope,
  type CapabilityRequestMessage,
  type CompleteTaskArguments,
  type CompletionMessage,
  type ProtocolCorrelation,
  type ProtocolErrorCode,
  type ProtocolMessage,
  type RequestCapabilityArguments,
  type ToolName as WireToolName,
  type ToolOperation,
  type ToolOutcomeStatus,
} from "../protocol/index.js";
import { sha256 } from "../shared/crypto.js";
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

export interface CbaProtocolAdapterOptions {
  readonly seenOperationIds?: () => ReadonlySet<string>;
  readonly pathKey?: (value: string) => string;
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
    },
  ): ParsedModelTurn {
    const numericTurn = parseTurnId(expected.turnId);
    const seen = expected.recoveryReplay === true ? undefined : this.options.seenOperationIds?.();
    const message = parseProtocolEnvelope(raw, {
      expected_task_id: expected.taskId,
      expected_turn_id: numericTurn,
      accepted_message_types: MODEL_MESSAGE_TYPES,
      ...(seen === undefined ? {} : { seen_operation_ids: seen }),
      ...(this.options.pathKey === undefined ? {} : { path_key: this.options.pathKey }),
    });
    return {
      protocolVersion: "cba/1",
      taskId: expected.taskId,
      turnId: expected.turnId,
      messages: [normalizeMessage(message)],
    };
  }

  public renderToolOutcomes(input: Parameters<ProtocolAdapter["renderToolOutcomes"]>[0]): string {
    const correlation = correlationFor(input.taskId, input.priorTurnId, "result");
    const allDenied = input.outcomes.length > 0 && input.outcomes.every((outcome) => outcome.status === "denied");
    if (allDenied) {
      return withReminder(serializeProtocolEnvelope(
        createToolDenialMessage(
          correlation,
          input.outcomes.map((outcome) => ({
            operation_id: outcome.operationId,
            tool: outcome.tool,
            decision: outcome.data.decision === "ask" ? "ask" : "deny",
            reason_code: String(outcome.data.code ?? "POLICY_DENIED"),
            message: String(outcome.data.message ?? "The operation is outside the effective grant."),
          })),
        ),
      ), input.taskId, input.priorTurnId);
    }
    return withReminder(serializeProtocolEnvelope(
      createToolResultMessage(correlation, input.outcomes.map(toolResultItem)),
    ), input.taskId, input.priorTurnId);
  }

  public renderProtocolError(input: Parameters<ProtocolAdapter["renderProtocolError"]>[0]): string {
    const requestedCode = input.code as ProtocolErrorCode;
    const code = (PROTOCOL_ERROR_CODES as readonly string[]).includes(requestedCode)
      ? requestedCode
      : "INVALID_MESSAGE";
    return withReminder(serializeProtocolEnvelope(
      createProtocolErrorMessage(correlationFor(input.taskId, input.priorTurnId, "protocol_error"), {
        code,
        message: input.message,
        repairable: true,
        details: { repair_attempt: input.repairAttempt, source_code: input.code },
      }),
    ), input.taskId, input.priorTurnId);
  }

  public renderUserDecision(input: Parameters<ProtocolAdapter["renderUserDecision"]>[0]): string {
    return withReminder(serializeProtocolEnvelope(
      createToolResultMessage(correlationFor(input.taskId, input.priorTurnId, "decision"), [
        {
          operation_id: input.requestId,
          tool: input.kind === "user_input" ? "request_user_input" : "request_capability",
          status: "success",
          output: input.decision,
        },
      ]),
    ), input.taskId, input.priorTurnId);
  }

  public renderCompletionRejected(input: Parameters<ProtocolAdapter["renderCompletionRejected"]>[0]): string {
    return withReminder(serializeProtocolEnvelope(
      createToolResultMessage(correlationFor(input.taskId, input.priorTurnId, "completion_rejected"), [
        {
          operation_id: input.operationId,
          tool: "complete_task",
          status: "failure",
          error: {
            code: "COMPLETION_NOT_VERIFIED",
            message: "The deterministic harness did not accept the completion claim.",
            details: {
              reasons: input.verification.reasons,
              actual: input.verification.actual,
            },
          },
        },
      ]),
    ), input.taskId, input.priorTurnId);
  }
}

function normalizeMessage(message: ProtocolMessage): NormalizedModelMessage {
  switch (message.message_type) {
    case "tool_request": {
      const operation = message.operations[0];
      if (message.operations.length === 1 && operation !== undefined) {
        if (operation.tool === "request_user_input") return normalizeUserInput(operation);
        if (operation.tool === "request_capability") return normalizeCapability(operation.operation_id, operation.arguments);
        if (operation.tool === "complete_task") return normalizeCompletion(operation.operation_id, operation.arguments);
      }
      return {
        type: "tool_request",
        calls: message.operations.map((entry) => {
          if (entry.tool === "request_user_input" || entry.tool === "request_capability" || entry.tool === "complete_task") {
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
        reason: `${message.reason_code}: ${message.summary}${message.needed.length === 0 ? "" : ` Needed: ${message.needed.join(", ")}`}`,
        recoverable: message.recoverable,
      };
    case "tool_result":
    case "tool_denial":
    case "protocol_error":
      throw new AgentError("PROTOCOL_INVALID", `Model cannot send harness message type ${message.message_type}`);
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
      summary: report.summary,
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

function toolResultItem(outcome: ToolOutcome) {
  const status: ToolOutcomeStatus = outcome.status === "denied" ? "failure" : outcome.status;
  const success = status === "success";
  return {
    operation_id: outcome.operationId,
    tool: outcome.tool as WireToolName,
    status,
    ...(success ? { output: outcome.data } : {
      error: {
        code: String(outcome.data.code ?? outcome.status.toUpperCase()),
        message: String(outcome.data.message ?? `Tool ended with ${outcome.status}`),
        details: outcome.data,
      },
    }),
  };
}

function correlationFor(taskId: string, turnId: string, kind: string): ProtocolCorrelation {
  const numeric = parseTurnId(turnId);
  return {
    task_id: taskId,
    turn_id: numeric,
    message_id: `h_${kind}_${numeric}_${sha256(`${taskId}:${turnId}:${kind}`).slice(0, 12)}`,
  };
}

function withReminder(envelope: string, taskId: string, priorTurnId: string): string {
  return `${envelope}\n\n${renderProtocolReminder(taskId, parseTurnId(priorTurnId) + 1)}`;
}

function parseTurnId(value: string): number {
  const match = /^turn_(\d{1,9})$/u.exec(value);
  const numeric = Number.parseInt(match?.[1] ?? "", 10);
  if (!Number.isSafeInteger(numeric) || numeric < 1) {
    throw new AgentError("PROTOCOL_INVALID", `Invalid turn identifier '${value}'`);
  }
  return numeric;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function wireTools(value: unknown): readonly WireToolName[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is WireToolName => typeof entry === "string") as readonly WireToolName[];
}

function mode(value: unknown): "inspect" | "edit" | "auto" {
  return value === "inspect" || value === "auto" ? value : "edit";
}

function decision(value: unknown): "allow" | "ask" | "deny" {
  return value === "allow" || value === "ask" ? value : "deny";
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
