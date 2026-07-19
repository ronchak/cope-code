import { stableJson } from "../shared/crypto.js";
import { validateProtocolMessage, formatSchemaErrors } from "./schemas.js";
import {
  PROTOCOL_VERSION,
  type ProtocolCorrelation,
  type ProtocolErrorCode,
  type ProtocolErrorMessage,
  type ProtocolMessage,
  type ToolDenialItem,
  type ToolDenialMessage,
  type ToolResultItem,
  type ToolResultMessage,
} from "./types.js";

export function serializeProtocolEnvelope(message: ProtocolMessage): string {
  const validation = validateProtocolMessage(message);
  if (!validation.valid) {
    throw new TypeError(`Cannot serialize invalid cba/1 message: ${formatSchemaErrors(validation.errors).join("; ")}`);
  }
  return `\`\`\`${PROTOCOL_VERSION}\n${stableJson(message)}\n\`\`\``;
}

export function createToolResultMessage(
  correlation: ProtocolCorrelation,
  results: readonly ToolResultItem[],
): ToolResultMessage {
  return {
    protocol: PROTOCOL_VERSION,
    message_type: "tool_result",
    ...correlation,
    results,
  };
}

export function createToolDenialMessage(
  correlation: ProtocolCorrelation,
  denials: readonly ToolDenialItem[],
): ToolDenialMessage {
  return {
    protocol: PROTOCOL_VERSION,
    message_type: "tool_denial",
    ...correlation,
    denials,
  };
}

export function createProtocolErrorMessage(
  correlation: ProtocolCorrelation,
  error: {
    readonly code: ProtocolErrorCode;
    readonly message: string;
    readonly repairable: boolean;
    readonly operation_id?: string;
    readonly details?: Readonly<Record<string, unknown>>;
  },
): ProtocolErrorMessage {
  return {
    protocol: PROTOCOL_VERSION,
    message_type: "protocol_error",
    ...correlation,
    error,
  };
}
