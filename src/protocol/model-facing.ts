import { stableJson } from "../shared/crypto.js";
import {
  DEFAULT_MAX_PROTOCOL_INPUT_BYTES,
  ProtocolParseError,
  extractCbaEnvelope,
} from "./parser.js";
import { formatSchemaErrors, validateToolArguments } from "./schemas.js";
import {
  isBatchableToolName,
  isToolName,
  type CompleteTaskArguments,
  type ProgressUpdateMessage,
  type ToolArgumentsByName,
  type ToolName,
} from "./types.js";

export const MODEL_FACING_PROTOCOL_VERSION = "cba-agent/1" as const;

export interface ModelFacingToolIntent {
  readonly kind: "agent_intent";
  readonly intent: ToolName;
  readonly arguments: ToolArgumentsByName[ToolName];
  readonly reason: string;
}

export interface ModelFacingObservationIntent {
  readonly kind: "agent_intent";
  readonly intent: "observe";
  readonly observations: readonly {
    readonly tool: ToolName;
    readonly arguments: ToolArgumentsByName[ToolName];
  }[];
  readonly reason: string;
}

export interface ModelFacingAnswer {
  readonly kind: "agent_answer";
  readonly report: CompleteTaskArguments;
}

export interface ModelFacingBlocked {
  readonly kind: "agent_blocked";
  readonly reason: string;
  readonly needed: readonly string[];
  readonly recoverable: boolean;
}

export interface ModelFacingProgress {
  readonly kind: "agent_progress";
  readonly phase: ProgressUpdateMessage["phase"];
  readonly summary: string;
}

export type ModelFacingMessage =
  | ModelFacingToolIntent
  | ModelFacingObservationIntent
  | ModelFacingAnswer
  | ModelFacingBlocked
  | ModelFacingProgress;

export function parseModelFacingEnvelope(
  input: string,
  maximumBytes = DEFAULT_MAX_PROTOCOL_INPUT_BYTES,
): ModelFacingMessage {
  const actualBytes = Buffer.byteLength(input, "utf8");
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("maximumBytes must be a positive safe integer");
  }
  if (actualBytes > maximumBytes) {
    throw new ProtocolParseError(
      "INPUT_TOO_LARGE",
      `The response is ${actualBytes} bytes, exceeding the ${maximumBytes}-byte model-response limit.`,
      {
        stage: "model_response_capture",
        actual_bytes: actualBytes,
        maximum_bytes: maximumBytes,
      },
      false,
    );
  }

  const envelope = extractCbaEnvelope(input, MODEL_FACING_PROTOCOL_VERSION);
  let decoded: unknown;
  try {
    decoded = JSON.parse(envelope.json) as unknown;
  } catch (error) {
    throw new ProtocolParseError(
      "INVALID_JSON",
      "The model-facing envelope does not contain complete, valid JSON.",
      {
        stage: "model_intent_parse",
        start_line: envelope.start_line,
        error: error instanceof Error ? error.message : String(error),
      },
      true,
      { cause: error },
    );
  }
  return parseModelFacingMessage(decoded);
}

export function renderModelFacingReminder(): string {
  return [
    `${MODEL_FACING_PROTOCOL_VERSION} reminder: machine actions use exactly one complete \`\`\`${MODEL_FACING_PROTOCOL_VERSION} fenced JSON object.`,
    "Do not provide task, turn, message, or operation IDs; Cope adds those deterministically.",
    `For a final informational response use ${stableJson({
      kind: "agent_answer",
      content_markdown: "Your answer.",
      basis: { user_provided_context: true },
      limitations: [],
    })}.`,
  ].join("\n");
}

function parseModelFacingMessage(value: unknown): ModelFacingMessage {
  const object = record(value, "The model-facing JSON root must be an object.");
  const kind = requiredString(object.kind, "kind");
  switch (kind) {
    case "agent_intent":
      return parseIntent(object);
    case "agent_answer":
      return parseAnswer(object);
    case "agent_blocked":
      return parseBlocked(object);
    case "agent_progress":
      return parseProgress(object);
    default:
      throw invalid("Unknown model-facing message kind.", {
        json_path: "$.kind",
        actual: kind,
        expected: ["agent_intent", "agent_answer", "agent_blocked", "agent_progress"],
      });
  }
}

function parseIntent(
  object: Readonly<Record<string, unknown>>,
): ModelFacingToolIntent | ModelFacingObservationIntent {
  const intent = requiredString(object.intent, "intent");
  const reason = boundedString(object.reason, "reason");
  if (intent === "observe") {
    exactKeys(object, ["kind", "intent", "observations", "reason"]);
    if (!Array.isArray(object.observations) || object.observations.length < 1 || object.observations.length > 32) {
      throw invalid("agent_intent observations must contain between 1 and 32 entries.", {
        json_path: "$.observations",
      });
    }
    const observations = object.observations.map((entry, index) => {
      const candidate = record(entry, `Observation ${index + 1} must be an object.`);
      exactKeys(candidate, ["tool", "arguments"]);
      const tool = requiredString(candidate.tool, `observations[${index}].tool`);
      if (!isToolName(tool) || !isBatchableToolName(tool)) {
        throw invalid("Only independent batchable read tools may be requested as observations.", {
          json_path: `$.observations[${index}].tool`,
          actual: tool,
        });
      }
      return {
        tool,
        arguments: validatedArguments(tool, candidate.arguments, `$.observations[${index}].arguments`),
      };
    });
    return { kind: "agent_intent", intent: "observe", observations, reason };
  }

  exactKeys(object, ["kind", "intent", "arguments", "reason"]);
  if (!isToolName(intent)) {
    throw invalid("Unknown model-facing tool intent.", {
      json_path: "$.intent",
      actual: intent,
    });
  }
  return {
    kind: "agent_intent",
    intent,
    arguments: validatedArguments(intent, object.arguments, "$.arguments"),
    reason,
  };
}

function parseAnswer(object: Readonly<Record<string, unknown>>): ModelFacingAnswer {
  exactKeys(object, [
    "kind",
    "content_markdown",
    "basis",
    "acceptance_criteria",
    "validation",
    "skipped_validation",
    "limitations",
    "follow_up",
  ], [
    "acceptance_criteria",
    "validation",
    "skipped_validation",
    "limitations",
    "follow_up",
  ]);
  const basis = parseBasis(object.basis);
  const report: CompleteTaskArguments = {
    kind: "answer",
    summary: boundedString(object.content_markdown, "content_markdown"),
    basis,
    acceptance_criteria: arrayOrEmpty(object.acceptance_criteria),
    validation: arrayOrEmpty(object.validation),
    skipped_validation: stringArrayOrEmpty(object.skipped_validation, "skipped_validation"),
    remaining_risks: stringArrayOrEmpty(object.limitations, "limitations"),
    follow_up: stringArrayOrEmpty(object.follow_up, "follow_up"),
  } as CompleteTaskArguments;
  const validation = validateToolArguments("complete_task", report);
  if (!validation.valid || validation.value === undefined) {
    throw invalid("agent_answer does not conform to the completion report schema.", {
      json_path: "$",
      errors: formatSchemaErrors(validation.errors),
    });
  }
  return { kind: "agent_answer", report: validation.value };
}

function parseBasis(value: unknown): NonNullable<CompleteTaskArguments["basis"]> {
  const object = record(value, "agent_answer basis must be an object.");
  exactKeys(object, ["observed_files", "tool_result_refs", "user_provided_context"], [
    "observed_files",
    "tool_result_refs",
    "user_provided_context",
  ]);
  return {
    ...(object.observed_files === undefined
      ? {}
      : { observed_files: stringArray(object.observed_files, "basis.observed_files") }),
    ...(object.tool_result_refs === undefined
      ? {}
      : { tool_result_refs: stringArray(object.tool_result_refs, "basis.tool_result_refs") }),
    ...(object.user_provided_context === undefined
      ? {}
      : typeof object.user_provided_context === "boolean"
        ? { user_provided_context: object.user_provided_context }
        : (() => { throw invalid("basis.user_provided_context must be a boolean."); })()),
  };
}

function parseBlocked(object: Readonly<Record<string, unknown>>): ModelFacingBlocked {
  exactKeys(object, ["kind", "reason", "needed", "recoverable"]);
  const needed = typeof object.needed === "string"
    ? [boundedString(object.needed, "needed")]
    : stringArray(object.needed, "needed");
  if (typeof object.recoverable !== "boolean") {
    throw invalid("agent_blocked recoverable must be a boolean.", {
      json_path: "$.recoverable",
    });
  }
  return {
    kind: "agent_blocked",
    reason: boundedString(object.reason, "reason"),
    needed,
    recoverable: object.recoverable,
  };
}

function parseProgress(object: Readonly<Record<string, unknown>>): ModelFacingProgress {
  exactKeys(object, ["kind", "phase", "summary"]);
  const phase = requiredString(object.phase, "phase");
  if (!["discovering", "planning", "editing", "validating", "recovering"].includes(phase)) {
    throw invalid("agent_progress phase is invalid.", {
      json_path: "$.phase",
      actual: phase,
    });
  }
  return {
    kind: "agent_progress",
    phase: phase as ProgressUpdateMessage["phase"],
    summary: boundedString(object.summary, "summary"),
  };
}

function validatedArguments<TName extends ToolName>(
  tool: TName,
  value: unknown,
  jsonPath: string,
): ToolArgumentsByName[TName] {
  const result = validateToolArguments(tool, value);
  if (!result.valid || result.value === undefined) {
    throw invalid(`Arguments for '${tool}' are invalid.`, {
      json_path: jsonPath,
      errors: formatSchemaErrors(result.errors),
    });
  }
  return result.value;
}

function record(value: unknown, message: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(message);
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  optional: readonly string[] = [],
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  const required = allowed.filter((key) => !optional.includes(key));
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (extras.length > 0 || missing.length > 0) {
    throw invalid("The model-facing message has missing or unknown fields.", {
      json_path: "$",
      missing,
      unknown: extras,
    });
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(`${name} must be a non-empty string.`, { json_path: `$.${name}` });
  }
  return value;
}

function boundedString(value: unknown, name: string): string {
  const text = requiredString(value, name);
  if (text.length > 4_096) {
    throw invalid(`${name} exceeds the 4096-character limit.`, {
      json_path: `$.${name}`,
      actual_length: text.length,
    });
  }
  return text;
}

function stringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw invalid(`${name} must be an array with at most 256 entries.`, {
      json_path: `$.${name}`,
    });
  }
  const strings = value.map((entry, index) =>
    boundedString(entry, `${name}[${index}]`));
  if (new Set(strings).size !== strings.length) {
    throw invalid(`${name} entries must be unique.`, { json_path: `$.${name}` });
  }
  return strings;
}

function stringArrayOrEmpty(value: unknown, name: string): readonly string[] {
  return value === undefined ? [] : stringArray(value, name);
}

function arrayOrEmpty(value: unknown): readonly never[] | readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid("Expected an array.");
  return value;
}

function invalid(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ProtocolParseError {
  return new ProtocolParseError(
    "SCHEMA_INVALID",
    message,
    { stage: "model_intent_validation", ...details },
  );
}
