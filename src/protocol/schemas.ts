import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

import {
  OPERATION_ID_MAX_LENGTH,
  OPERATION_ID_MIN_LENGTH,
  OPERATION_ID_PATTERN_SOURCE,
} from "../shared/operation-id.js";

import {
  BUDGET_METRICS,
  PROTOCOL_ERROR_CODES,
  PROTOCOL_MESSAGE_TYPES,
  PROTOCOL_VERSION,
  TOOL_NAMES,
  type ProtocolMessage,
  type ToolArgumentsByName,
  type ToolName,
} from "./types.js";

type JsonSchema = Readonly<Record<string, unknown>>;

const identifier = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
} as const;

const operationIdentifier = {
  type: "string",
  minLength: OPERATION_ID_MIN_LENGTH,
  maxLength: OPERATION_ID_MAX_LENGTH,
  pattern: OPERATION_ID_PATTERN_SOURCE,
} as const;

const shortString = { type: "string", minLength: 1, maxLength: 4_096 } as const;
const pathString = { type: "string", minLength: 1, maxLength: 1_024, pattern: "^[^\\u0000]+$" } as const;
const sha256 = { type: "string", pattern: "^[a-fA-F0-9]{64}$" } as const;

const strictObject = (
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

const nonEmptyStringArray = (item: JsonSchema = shortString, maxItems = 256): JsonSchema => ({
  type: "array",
  minItems: 1,
  maxItems,
  uniqueItems: true,
  items: item,
});

const optionalStringArray = (item: JsonSchema = shortString, maxItems = 256): JsonSchema => ({
  type: "array",
  maxItems,
  uniqueItems: true,
  items: item,
});

const listFilesSchema = strictObject({
  path: pathString,
  max_depth: { type: "integer", minimum: 0, maximum: 64 },
  max_results: { type: "integer", minimum: 1, maximum: 10_000 },
});

const searchTextSchema = strictObject(
  {
    query: { type: "string", minLength: 1, maxLength: 8_192 },
    mode: { enum: ["literal", "regex"] },
    path: pathString,
    file_patterns: nonEmptyStringArray(pathString, 128),
    max_results: { type: "integer", minimum: 1, maximum: 10_000 },
    context_lines: { type: "integer", minimum: 0, maximum: 100 },
  },
  ["query"],
);

const readFileSchema = strictObject(
  {
    path: pathString,
    start_line: { type: "integer", minimum: 1 },
    end_line: { type: "integer", minimum: 1 },
    max_bytes: { type: "integer", minimum: 1, maximum: 16_777_216 },
  },
  ["path"],
);

const gitStatusSchema = strictObject({ include_untracked: { type: "boolean" } });

const gitDiffSchema = strictObject({
  scope: { enum: ["session", "working_tree", "staged", "checkpoint"] },
  paths: nonEmptyStringArray(pathString, 256),
  baseline: { type: "string", minLength: 1, maxLength: 256 },
  max_bytes: { type: "integer", minimum: 1, maximum: 16_777_216 },
});

const atomicChangeSchema: JsonSchema = {
  oneOf: [
    strictObject({ kind: { const: "create" }, path: pathString, content: { type: "string", maxLength: 1_048_576 } }, [
      "kind",
      "path",
      "content",
    ]),
    strictObject(
      {
        kind: { const: "update" },
        path: pathString,
        base_sha256: sha256,
        content: { type: "string", maxLength: 1_048_576 },
      },
      ["kind", "path", "base_sha256", "content"],
    ),
    strictObject({ kind: { const: "delete" }, path: pathString, base_sha256: sha256 }, [
      "kind",
      "path",
      "base_sha256",
    ]),
  ],
};

const applyPatchSchema = strictObject(
  { changes: { type: "array", minItems: 1, maxItems: 128, items: atomicChangeSchema } },
  ["changes"],
);

const commandParameterValue: JsonSchema = {
  oneOf: [
    { type: "string", maxLength: 4_096 },
    { type: "number" },
    { type: "boolean" },
    { type: "array", maxItems: 256, items: { type: "string", maxLength: 4_096 } },
  ],
};

const runCommandSchema = strictObject(
  {
    command_id: identifier,
    parameters: {
      type: "object",
      maxProperties: 128,
      additionalProperties: commandParameterValue,
      propertyNames: identifier,
    },
    timeout_ms: { type: "integer", minimum: 1, maximum: 86_400_000 },
  },
  ["command_id"],
);

const inputChoiceSchema = strictObject(
  { id: identifier, label: { ...shortString, maxLength: 256 }, description: shortString },
  ["id", "label"],
);

const requestUserInputSchema = strictObject(
  {
    question: shortString,
    reason: shortString,
    choices: { type: "array", minItems: 2, maxItems: 20, items: inputChoiceSchema },
    allow_free_form: { type: "boolean" },
  },
  ["question", "reason"],
);

const capabilityTargetSchema: JsonSchema = {
  oneOf: [
    strictObject(
      {
        kind: { const: "path" },
        access: { enum: ["read", "write", "create", "delete"] },
        paths: nonEmptyStringArray(pathString, 128),
      },
      ["kind", "access", "paths"],
    ),
    strictObject(
      { kind: { const: "command" }, command_ids: nonEmptyStringArray(identifier, 128) },
      ["kind", "command_ids"],
    ),
    strictObject({ kind: { const: "network" }, hosts: nonEmptyStringArray(shortString, 128) }, ["kind"]),
    strictObject(
      { kind: { const: "disclosure" }, classifications: nonEmptyStringArray(identifier, 128) },
      ["kind", "classifications"],
    ),
    strictObject(
      {
        kind: { const: "change" },
        change: { enum: ["create_file", "delete_file", "dependency_manifest", "local_commit"] },
      },
      ["kind", "change"],
    ),
    strictObject(
      {
        kind: { const: "budget" },
        metric: { enum: BUDGET_METRICS },
        requested_limit: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      },
      ["kind", "metric", "requested_limit"],
    ),
    strictObject(
      { kind: { const: "tool" }, tools: nonEmptyStringArray({ enum: TOOL_NAMES }, TOOL_NAMES.length) },
      ["kind", "tools"],
    ),
  ],
};

const requestCapabilitySchema = strictObject(
  { target: capabilityTargetSchema, reason: shortString, expected_operation: shortString, risk: shortString },
  ["target", "reason", "expected_operation"],
);

const acceptanceCriterionSchema = strictObject(
  {
    criterion: shortString,
    status: { enum: ["satisfied", "not_satisfied", "unknown"] },
    evidence: shortString,
  },
  ["criterion", "status"],
);

const validationReportSchema = strictObject(
  {
    command_id: identifier,
    status: { enum: ["passed", "failed", "not_run"] },
    summary: shortString,
  },
  ["command_id", "status", "summary"],
);

const completeTaskSchema = strictObject(
  {
    summary: shortString,
    acceptance_criteria: { type: "array", maxItems: 256, items: acceptanceCriterionSchema },
    validation: { type: "array", maxItems: 256, items: validationReportSchema },
    skipped_validation: optionalStringArray(shortString),
    remaining_risks: optionalStringArray(shortString),
    follow_up: optionalStringArray(shortString),
  },
  ["summary", "acceptance_criteria", "validation", "skipped_validation", "remaining_risks", "follow_up"],
);

export const TOOL_ARGUMENT_SCHEMAS: Readonly<Record<ToolName, JsonSchema>> = {
  list_files: listFilesSchema,
  search_text: searchTextSchema,
  read_file: readFileSchema,
  git_status: gitStatusSchema,
  git_diff: gitDiffSchema,
  apply_patch: applyPatchSchema,
  run_command: runCommandSchema,
  request_user_input: requestUserInputSchema,
  request_capability: requestCapabilitySchema,
  complete_task: completeTaskSchema,
};

const baseProperties = {
  protocol: { const: PROTOCOL_VERSION },
  message_type: { enum: PROTOCOL_MESSAGE_TYPES },
  message_id: identifier,
  task_id: identifier,
  turn_id: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
} as const;

const baseRequired = ["protocol", "message_type", "message_id", "task_id", "turn_id"] as const;

const operationSchemas = TOOL_NAMES.map((tool) =>
  strictObject(
    { operation_id: operationIdentifier, tool: { const: tool }, arguments: TOOL_ARGUMENT_SCHEMAS[tool] },
    ["operation_id", "tool", "arguments"],
  ),
);

const toolRequestMessageSchema = strictObject(
  {
    ...baseProperties,
    message_type: { const: "tool_request" },
    operations: { type: "array", minItems: 1, maxItems: 32, items: { oneOf: operationSchemas } },
  },
  [...baseRequired, "operations"],
);

const operationErrorSchema = strictObject(
  { code: identifier, message: shortString, details: { type: "object", additionalProperties: true } },
  ["code", "message"],
);

const toolResultItemSchema = strictObject(
  {
    operation_id: operationIdentifier,
    tool: { enum: TOOL_NAMES },
    status: { enum: ["success", "failure", "conflict", "timeout", "cancelled", "indeterminate"] },
    output: true,
    error: operationErrorSchema,
    truncated: { type: "boolean" },
  },
  ["operation_id", "tool", "status"],
);

const toolResultMessageSchema = strictObject(
  {
    ...baseProperties,
    message_type: { const: "tool_result" },
    results: { type: "array", minItems: 1, maxItems: 32, items: toolResultItemSchema },
  },
  [...baseRequired, "results"],
);

const denialItemSchema = strictObject(
  {
    operation_id: operationIdentifier,
    tool: { enum: TOOL_NAMES },
    decision: { enum: ["ask", "deny"] },
    reason_code: identifier,
    message: shortString,
    details: { type: "object", additionalProperties: true },
  },
  ["operation_id", "tool", "decision", "reason_code", "message"],
);

const toolDenialMessageSchema = strictObject(
  {
    ...baseProperties,
    message_type: { const: "tool_denial" },
    denials: { type: "array", minItems: 1, maxItems: 32, items: denialItemSchema },
  },
  [...baseRequired, "denials"],
);

const protocolErrorDetailSchema = strictObject(
  {
    code: { enum: PROTOCOL_ERROR_CODES },
    message: shortString,
    repairable: { type: "boolean" },
    operation_id: operationIdentifier,
    details: { type: "object", additionalProperties: true },
  },
  ["code", "message", "repairable"],
);

const protocolErrorMessageSchema = strictObject(
  { ...baseProperties, message_type: { const: "protocol_error" }, error: protocolErrorDetailSchema },
  [...baseRequired, "error"],
);

const userInputRequestMessageSchema = strictObject(
  {
    ...baseProperties,
    message_type: { const: "user_input_request" },
    operation_id: operationIdentifier,
    request: requestUserInputSchema,
  },
  [...baseRequired, "operation_id", "request"],
);

const capabilityRequestMessageSchema = strictObject(
  {
    ...baseProperties,
    message_type: { const: "capability_request" },
    operation_id: operationIdentifier,
    request: requestCapabilitySchema,
  },
  [...baseRequired, "operation_id", "request"],
);

const progressUpdateMessageSchema = strictObject(
  {
    ...baseProperties,
    message_type: { const: "progress_update" },
    phase: { enum: ["discovering", "planning", "editing", "validating", "recovering"] },
    summary: shortString,
    completed_steps: optionalStringArray(shortString),
    current_step: shortString,
    next_steps: optionalStringArray(shortString),
  },
  [...baseRequired, "phase", "summary"],
);

const planSubmissionMessageSchema = strictObject(
  {
    ...baseProperties,
    message_type: { const: "plan_submission" },
    operation_id: operationIdentifier,
    plan: strictObject({
      summary: shortString,
      steps: { type: "array", minItems: 1, maxItems: 256, items: shortString },
      anticipated_mutations: optionalStringArray(shortString),
      validation: optionalStringArray(shortString),
    }, ["summary", "steps", "anticipated_mutations", "validation"]),
  },
  [...baseRequired, "operation_id", "plan"],
);

const completionMessageSchema = strictObject(
  {
    ...baseProperties,
    message_type: { const: "completion" },
    operation_id: operationIdentifier,
    report: completeTaskSchema,
    verified: { const: false },
  },
  [...baseRequired, "operation_id", "report", "verified"],
);

const blockedMessageSchema = strictObject(
  {
    ...baseProperties,
    message_type: { const: "blocked" },
    reason_code: identifier,
    summary: shortString,
    needed: optionalStringArray(shortString),
    recoverable: { type: "boolean" },
  },
  [...baseRequired, "reason_code", "summary", "needed", "recoverable"],
);

export const PROTOCOL_MESSAGE_SCHEMA: JsonSchema = {
  $id: "https://local.cba.invalid/contracts/cba-1-message.schema.json",
  oneOf: [
    toolRequestMessageSchema,
    toolResultMessageSchema,
    toolDenialMessageSchema,
    protocolErrorMessageSchema,
    userInputRequestMessageSchema,
    capabilityRequestMessageSchema,
    progressUpdateMessageSchema,
    planSubmissionMessageSchema,
    completionMessageSchema,
    blockedMessageSchema,
  ],
};

const ajv = new Ajv({ allErrors: true, strict: true, messages: true });
const validateMessage = ajv.compile(PROTOCOL_MESSAGE_SCHEMA) as ValidateFunction<ProtocolMessage>;
const argumentValidators = Object.fromEntries(
  TOOL_NAMES.map((tool) => [tool, ajv.compile(TOOL_ARGUMENT_SCHEMAS[tool])]),
) as Record<ToolName, ValidateFunction>;

export interface SchemaValidationResult<T> {
  readonly valid: boolean;
  readonly value?: T;
  readonly errors: readonly ErrorObject[];
}

export function validateProtocolMessage(value: unknown): SchemaValidationResult<ProtocolMessage> {
  const valid = validateMessage(value);
  return valid
    ? { valid: true, value: value as ProtocolMessage, errors: [] }
    : { valid: false, errors: validateMessage.errors ?? [] };
}

export function validateToolArguments<TName extends ToolName>(
  tool: TName,
  value: unknown,
): SchemaValidationResult<ToolArgumentsByName[TName]> {
  const validate = argumentValidators[tool];
  const valid = validate(value);
  return valid
    ? { valid: true, value: value as ToolArgumentsByName[TName], errors: [] }
    : { valid: false, errors: validate.errors ?? [] };
}

export function formatSchemaErrors(errors: readonly ErrorObject[]): readonly string[] {
  return errors.map((error) => {
    const location = error.instancePath.length > 0 ? error.instancePath : "/";
    return `${location} ${error.message ?? error.keyword}`;
  });
}
