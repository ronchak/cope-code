import { sha256, stableJson } from "../shared/crypto.js";
import type {
  BlockedMessage,
  CompletionMessage,
  ProgressUpdateMessage,
  ProtocolMessage,
  ToolOperation,
  ToolRequestMessage,
} from "./types.js";
import type { ModelFacingMessage } from "./model-facing.js";

export interface IntentNormalizationContext {
  readonly taskId: string;
  readonly turnId: number;
  readonly rawResponse: string;
}

export function normalizeModelFacingMessage(
  message: ModelFacingMessage,
  context: IntentNormalizationContext,
): ProtocolMessage {
  const correlation = {
    protocol: "cba/1" as const,
    task_id: context.taskId,
    turn_id: context.turnId,
    message_id: messageId(context, message.kind),
  };
  switch (message.kind) {
    case "agent_intent": {
      const requested = message.intent === "observe"
        ? message.observations
        : [{ tool: message.intent, arguments: message.arguments }];
      return {
        ...correlation,
        message_type: "tool_request",
        operations: requested.map((entry, index) => ({
          operation_id: operationId(context, index, entry),
          tool: entry.tool,
          arguments: entry.arguments,
        })) as readonly ToolOperation[],
      } satisfies ToolRequestMessage;
    }
    case "agent_answer":
      return {
        ...correlation,
        message_type: "completion",
        operation_id: operationId(context, 0, message),
        report: message.report,
        verified: false,
      } satisfies CompletionMessage;
    case "agent_blocked":
      return {
        ...correlation,
        message_type: "blocked",
        reason_code: "MODEL_BLOCKED",
        summary: message.reason,
        needed: message.needed,
        recoverable: message.recoverable,
      } satisfies BlockedMessage;
    case "agent_progress":
      return {
        ...correlation,
        message_type: "progress_update",
        phase: message.phase,
        summary: message.summary,
      } satisfies ProgressUpdateMessage;
  }
}

function messageId(context: IntentNormalizationContext, kind: string): string {
  return `msg_${String(context.turnId)}_${sha256(
    `${context.taskId}:${String(context.turnId)}:${kind}:${context.rawResponse}`,
  ).slice(0, 16)}`;
}

function operationId(
  context: IntentNormalizationContext,
  index: number,
  value: unknown,
): string {
  return `op_${String(context.turnId)}_${String(index + 1)}_${sha256(
    `${context.taskId}:${String(context.turnId)}:${String(index)}:${stableJson(value)}`,
  ).slice(0, 20)}`;
}
