import { AgentError } from "../shared/errors.js";
import { isOperationId } from "../shared/operation-id.js";
import { err, ok, type Result } from "../shared/result.js";
import { formatSchemaErrors, validateProtocolMessage } from "./schemas.js";
import {
  PROTOCOL_MESSAGE_TYPES,
  PROTOCOL_VERSION,
  READ_ONLY_TOOL_NAMES,
  TOOL_NAMES,
  type ProtocolErrorCode,
  type ProtocolMessage,
  type ToolName,
  type ToolRequestMessage,
} from "./types.js";

export const DEFAULT_MAX_PROTOCOL_INPUT_BYTES = 1_048_576;

export interface ProtocolParseContext {
  readonly expected_task_id: string;
  readonly expected_turn_id: number;
  readonly max_input_bytes?: number;
  readonly seen_operation_ids?: ReadonlySet<string>;
  readonly accepted_message_types?: ReadonlySet<ProtocolMessage["message_type"]>;
  readonly path_key?: (value: string) => string;
}

export interface ExtractedEnvelope {
  readonly version: string;
  readonly json: string;
  readonly start_line: number;
  readonly end_line: number;
}

export class ProtocolParseError extends AgentError {
  public constructor(
    public readonly protocolCode: ProtocolErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    public readonly repairable = true,
    options?: ErrorOptions,
  ) {
    super(protocolCode === "DUPLICATE_OPERATION_ID" ? "DUPLICATE_OPERATION" : "PROTOCOL_INVALID", message, details, options);
    this.name = "ProtocolParseError";
  }
}

interface OpenFence {
  readonly character: "`" | "~";
  readonly length: number;
  readonly protocolVersion?: string;
  readonly startIndex: number;
  readonly payloadStartIndex: number;
}

interface EnvelopeScan {
  readonly envelopes: readonly ExtractedEnvelope[];
  readonly truncatedProtocol?: { readonly version: string; readonly start_line: number };
}

/**
 * Finds protocol fences while respecting surrounding Markdown fences. This
 * prevents a repository excerpt containing ```cba/1 from becoming executable.
 */
function scanMarkdownFences(input: string): EnvelopeScan {
  const lines = input.split(/\r\n|\n/u);
  const envelopes: ExtractedEnvelope[] = [];
  let open: OpenFence | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (open !== undefined) {
      if (isClosingFence(line, open)) {
        if (open.protocolVersion !== undefined) {
          envelopes.push({
            version: open.protocolVersion,
            json: lines.slice(open.payloadStartIndex, index).join("\n"),
            start_line: open.startIndex + 1,
            end_line: index + 1,
          });
        }
        open = undefined;
      }
      continue;
    }

    const protocolOpening = /^```(cba\/[^\s`~]+)$/u.exec(line);
    if (protocolOpening !== null) {
      open = {
        character: "`",
        length: 3,
        protocolVersion: protocolOpening[1] ?? "",
        startIndex: index,
        payloadStartIndex: index + 1,
      };
      continue;
    }

    const markdownOpening = /^(?: {0,3})(`{3,}|~{3,})(.*)$/u.exec(line);
    if (markdownOpening !== null) {
      const marker = markdownOpening[1] ?? "";
      open = {
        character: marker.startsWith("`") ? "`" : "~",
        length: marker.length,
        startIndex: index,
        payloadStartIndex: index + 1,
      };
    }
  }

  if (open?.protocolVersion !== undefined) {
    return {
      envelopes,
      truncatedProtocol: { version: open.protocolVersion, start_line: open.startIndex + 1 },
    };
  }
  return { envelopes };
}

function isClosingFence(line: string, open: OpenFence): boolean {
  if (open.protocolVersion !== undefined) {
    // Protocol fences are intentionally stricter than general Markdown.
    return line === "```";
  }
  const escaped = open.character === "`" ? "`" : "~";
  const match = new RegExp(`^ {0,3}(${escaped}{${open.length},})[ \\t]*$`, "u").exec(line);
  return match !== null;
}

export function extractProtocolEnvelope(input: string): ExtractedEnvelope {
  const scan = scanMarkdownFences(input);
  const protocolCount = scan.envelopes.length + (scan.truncatedProtocol === undefined ? 0 : 1);
  if (protocolCount > 1) {
    throw new ProtocolParseError(
      "MULTIPLE_ENVELOPES",
      "The response contains more than one CBA protocol envelope; exactly one is required.",
      { count: protocolCount },
    );
  }
  if (scan.truncatedProtocol !== undefined) {
    throw new ProtocolParseError(
      "TRUNCATED_ENVELOPE",
      "The CBA protocol envelope has no exact closing fence.",
      scan.truncatedProtocol,
    );
  }
  const envelope = scan.envelopes[0];
  if (envelope === undefined) {
    throw new ProtocolParseError("MISSING_ENVELOPE", "No CBA protocol envelope was found.");
  }
  if (envelope.version !== PROTOCOL_VERSION) {
    throw new ProtocolParseError(
      "UNSUPPORTED_VERSION",
      `Unsupported protocol version '${envelope.version}'; expected '${PROTOCOL_VERSION}'.`,
      { received_version: envelope.version, expected_version: PROTOCOL_VERSION },
    );
  }
  if (envelope.json.trim().length === 0) {
    throw new ProtocolParseError("EMPTY_ENVELOPE", "The CBA protocol envelope is empty.");
  }
  return envelope;
}

export function parseProtocolEnvelope(input: string, context: ProtocolParseContext): ProtocolMessage {
  const maximum = context.max_input_bytes ?? DEFAULT_MAX_PROTOCOL_INPUT_BYTES;
  const actualBytes = Buffer.byteLength(input, "utf8");
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new TypeError("max_input_bytes must be a positive safe integer");
  }
  if (actualBytes > maximum) {
    throw new ProtocolParseError(
      "INPUT_TOO_LARGE",
      `The response is ${actualBytes} bytes, exceeding the ${maximum}-byte protocol input limit.`,
      { actual_bytes: actualBytes, maximum_bytes: maximum },
      false,
    );
  }

  const envelope = extractProtocolEnvelope(input);
  let decoded: unknown;
  try {
    decoded = JSON.parse(envelope.json) as unknown;
  } catch (error) {
    throw new ProtocolParseError(
      "INVALID_JSON",
      "The CBA envelope does not contain complete, valid JSON.",
      { start_line: envelope.start_line, error: error instanceof Error ? error.message : String(error) },
      true,
      { cause: error },
    );
  }

  preflightDiscriminators(decoded);
  const validation = validateProtocolMessage(decoded);
  if (!validation.valid || validation.value === undefined) {
    throw new ProtocolParseError(
      "SCHEMA_INVALID",
      "The protocol message does not conform to the cba/1 schema.",
      { errors: formatSchemaErrors(validation.errors) },
    );
  }

  const message = validation.value;
  if (message.task_id !== context.expected_task_id) {
    throw new ProtocolParseError(
      "TASK_MISMATCH",
      `Message task '${message.task_id}' does not match active task '${context.expected_task_id}'.`,
      { received_task_id: message.task_id, expected_task_id: context.expected_task_id },
      false,
    );
  }
  if (message.turn_id !== context.expected_turn_id) {
    throw new ProtocolParseError(
      "TURN_MISMATCH",
      `Message turn ${message.turn_id} does not match expected turn ${context.expected_turn_id}.`,
      { received_turn_id: message.turn_id, expected_turn_id: context.expected_turn_id },
      false,
    );
  }
  if (context.accepted_message_types !== undefined && !context.accepted_message_types.has(message.message_type)) {
    throw new ProtocolParseError(
      "INVALID_MESSAGE",
      `Message type '${message.message_type}' is not valid in the current direction or state.`,
      { message_type: message.message_type },
    );
  }

  validateMessageSemantics(message, context.seen_operation_ids, context.path_key ?? defaultPathKey);
  return message;
}

export function tryParseProtocolEnvelope(
  input: string,
  context: ProtocolParseContext,
): Result<ProtocolMessage, ProtocolParseError> {
  try {
    return ok(parseProtocolEnvelope(input, context));
  } catch (error) {
    if (error instanceof ProtocolParseError) {
      return err(error);
    }
    throw error;
  }
}

function preflightDiscriminators(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolParseError("INVALID_MESSAGE", "The protocol JSON root must be an object.");
  }
  const object = value as Record<string, unknown>;
  if (object.protocol !== PROTOCOL_VERSION) {
    throw new ProtocolParseError(
      "UNSUPPORTED_VERSION",
      `The JSON protocol discriminator must be '${PROTOCOL_VERSION}'.`,
      { received_version: object.protocol },
    );
  }
  if (
    typeof object.message_type !== "string" ||
    !(PROTOCOL_MESSAGE_TYPES as readonly string[]).includes(object.message_type)
  ) {
    throw new ProtocolParseError(
      "UNKNOWN_MESSAGE_TYPE",
      `Unknown cba/1 message type '${String(object.message_type)}'.`,
      { received_message_type: object.message_type },
    );
  }
  for (const candidate of extractToolDiscriminators(object)) {
    if (!(TOOL_NAMES as readonly string[]).includes(candidate)) {
      throw new ProtocolParseError("UNKNOWN_TOOL", `Unknown cba/1 tool '${candidate}'.`, { tool: candidate });
    }
  }
}

function extractToolDiscriminators(object: Record<string, unknown>): readonly string[] {
  const containers: unknown[] = [];
  if (object.message_type === "tool_request") containers.push(object.operations);
  if (object.message_type === "tool_result") containers.push(object.results);
  if (object.message_type === "tool_denial") containers.push(object.denials);
  const tools: string[] = [];
  for (const container of containers) {
    if (!Array.isArray(container)) continue;
    for (const item of container) {
      if (item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).tool === "string") {
        tools.push((item as Record<string, unknown>).tool as string);
      }
    }
  }
  return tools;
}

function validateMessageSemantics(
  message: ProtocolMessage,
  seen: ReadonlySet<string> | undefined,
  pathKey: (value: string) => string,
): void {
  if (message.message_type === "tool_request") {
    validateToolRequestSemantics(message, seen, pathKey);
    return;
  }

  const ids =
    message.message_type === "tool_result"
      ? message.results.map((result) => result.operation_id)
      : message.message_type === "tool_denial"
        ? message.denials.map((denial) => denial.operation_id)
        : "operation_id" in message
          ? [message.operation_id]
          : [];
  ensureUniqueOperationIds(ids, undefined);
}

function validateToolRequestSemantics(
  message: ToolRequestMessage,
  seen: ReadonlySet<string> | undefined,
  pathKey: (value: string) => string,
): void {
  const operationIds = message.operations.map((operation) => operation.operation_id);
  ensureUniqueOperationIds(operationIds, seen);

  if (message.operations.length > 1) {
    const unsafe = message.operations.find(
      (operation) => !(READ_ONLY_TOOL_NAMES as readonly ToolName[]).includes(operation.tool),
    );
    if (unsafe !== undefined) {
      throw new ProtocolParseError(
        "INVALID_BATCH",
        `Only independent read-only tools may be batched; '${unsafe.tool}' must be requested alone.`,
        { operation_id: unsafe.operation_id, tool: unsafe.tool },
      );
    }
  }

  for (const operation of message.operations) {
    if (operation.tool === "read_file") {
      const { start_line: start, end_line: end } = operation.arguments;
      if (start !== undefined && end !== undefined && end < start) {
        throw new ProtocolParseError(
          "SCHEMA_INVALID",
          "read_file end_line must be greater than or equal to start_line.",
          { operation_id: operation.operation_id, start_line: start, end_line: end },
        );
      }
    }
    if (operation.tool === "apply_patch") {
      const normalized = operation.arguments.changes.map((change) => pathKey(change.path));
      if (new Set(normalized).size !== normalized.length) {
        throw new ProtocolParseError(
          "SCHEMA_INVALID",
          "An atomic patch transaction may contain at most one change for each path.",
          { operation_id: operation.operation_id },
        );
      }
    }
    if (operation.tool === "git_diff") {
      const scope = operation.arguments.scope ?? "working_tree";
      const baseline = operation.arguments.baseline;
      const valid =
        scope === "checkpoint"
          ? baseline === undefined || /^checkpoint_[0-9a-f-]{36}$/iu.test(baseline)
          : scope === "session" || scope === "staged"
            ? baseline === undefined
            : baseline === undefined || baseline === "HEAD";
      if (!valid) {
        throw new ProtocolParseError(
          "SCHEMA_INVALID",
          "git_diff baseline is incompatible with the requested scope.",
          { operation_id: operation.operation_id, scope },
        );
      }
    }
    if (operation.tool === "request_user_input") {
      const choiceIds = operation.arguments.choices?.map((choice) => choice.id) ?? [];
      if (new Set(choiceIds).size !== choiceIds.length) {
        throw new ProtocolParseError(
          "SCHEMA_INVALID",
          "request_user_input choice IDs must be unique.",
          { operation_id: operation.operation_id },
        );
      }
    }
  }
}

function defaultPathKey(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

function ensureUniqueOperationIds(ids: readonly string[], seen: ReadonlySet<string> | undefined): void {
  const current = new Set<string>();
  for (const operationId of ids) {
    if (current.has(operationId) || seen?.has(operationId) === true) {
      throw new ProtocolParseError(
        "DUPLICATE_OPERATION_ID",
        `Operation ID '${operationId}' has already been used and cannot be replayed.`,
        { operation_id: operationId, source: current.has(operationId) ? "message" : "session" },
        false,
      );
    }
    current.add(operationId);
  }
}

/** Stateful inbound parser with commit-after-validation operation replay defense. */
export class ProtocolParser {
  readonly #operationIds = new Set<string>();
  readonly #maxInputBytes: number;

  public constructor(maxInputBytes = DEFAULT_MAX_PROTOCOL_INPUT_BYTES) {
    if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1) {
      throw new TypeError("maxInputBytes must be a positive safe integer");
    }
    this.#maxInputBytes = maxInputBytes;
  }

  public parse(
    input: string,
    context: Omit<ProtocolParseContext, "max_input_bytes" | "seen_operation_ids">,
  ): ProtocolMessage {
    const message = parseProtocolEnvelope(input, {
      ...context,
      max_input_bytes: this.#maxInputBytes,
      seen_operation_ids: this.#operationIds,
    });
    if (message.message_type === "tool_request") {
      for (const operation of message.operations) this.#operationIds.add(operation.operation_id);
    }
    return message;
  }

  public hasSeenOperation(operationId: string): boolean {
    return this.#operationIds.has(operationId);
  }

  public restoreOperationIds(operationIds: Iterable<string>): void {
    for (const operationId of operationIds) {
      if (!isOperationId(operationId)) {
        throw new ProtocolParseError(
          "SCHEMA_INVALID",
          "Persisted operation ID does not satisfy the cba/1 contract.",
          { operation_id: operationId },
          false,
        );
      }
      this.#operationIds.add(operationId);
    }
  }

  public snapshotOperationIds(): readonly string[] {
    return [...this.#operationIds].sort();
  }
}
