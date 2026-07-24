/** The first wire contract. Values are deliberately literal and versioned. */
export const PROTOCOL_VERSION = "cba/1" as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export const TOOL_NAMES = [
  "list_files",
  "search_text",
  "read_file",
  "git_status",
  "git_diff",
  "edit_text",
  "apply_patch",
  "run_command",
  "request_user_input",
  "request_capability",
  "complete_task",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const READ_ONLY_TOOL_NAMES = [
  "list_files",
  "search_text",
  "read_file",
  "git_status",
  "git_diff",
] as const satisfies readonly ToolName[];

export type ReadOnlyToolName = (typeof READ_ONLY_TOOL_NAMES)[number];

export interface ListFilesArguments {
  readonly path?: string;
  readonly max_depth?: number;
  readonly max_results?: number;
}

export interface SearchTextArguments {
  readonly query: string;
  readonly mode?: "literal" | "regex";
  readonly path?: string;
  readonly file_patterns?: readonly string[];
  readonly max_results?: number;
  readonly context_lines?: number;
}

export interface ReadFileArguments {
  readonly path: string;
  readonly start_line?: number;
  readonly end_line?: number;
  readonly max_bytes?: number;
}

export interface GitStatusArguments {
  readonly include_untracked?: boolean;
}

export interface GitDiffArguments {
  readonly scope?: "session" | "working_tree" | "staged" | "checkpoint";
  readonly paths?: readonly string[];
  readonly baseline?: string;
  readonly max_bytes?: number;
}

export interface CreateFileChange {
  readonly kind: "create";
  readonly path: string;
  readonly content: string;
}

export interface UpdateFileChange {
  readonly kind: "update";
  readonly path: string;
  /** SHA-256 of the exact current file bytes the model observed. */
  readonly base_sha256: string;
  readonly content: string;
}

export interface DeleteFileChange {
  readonly kind: "delete";
  readonly path: string;
  /** SHA-256 of the exact current file bytes the model observed. */
  readonly base_sha256: string;
}

export type AtomicFileChange = CreateFileChange | UpdateFileChange | DeleteFileChange;

export interface ApplyPatchArguments {
  /** Every change succeeds, or the tool restores the complete prior state. */
  readonly changes: readonly AtomicFileChange[];
}

export interface EditTextArguments {
  readonly path: string;
  /** SHA-256 of the exact current file bytes the model observed. */
  readonly base_sha256: string;
  /** Exact text to replace; regular expressions are never interpreted. */
  readonly old_text: string;
  readonly new_text: string;
  /** The edit proceeds only when old_text occurs exactly this many times. */
  readonly expected_occurrences: number;
}

export type CommandParameterValue = string | number | boolean | readonly string[];

export interface RunCommandArguments {
  /** An identifier from the repository's policy-controlled command catalog. */
  readonly command_id: string;
  readonly parameters?: Readonly<Record<string, CommandParameterValue>>;
  readonly timeout_ms?: number;
}

export interface UserInputChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface RequestUserInputArguments {
  readonly question: string;
  readonly reason: string;
  readonly choices?: readonly UserInputChoice[];
  readonly allow_free_form?: boolean;
}

export interface PathCapabilityTarget {
  readonly kind: "path";
  readonly access: "read" | "write" | "create" | "delete";
  readonly paths: readonly string[];
}

export interface CommandCapabilityTarget {
  readonly kind: "command";
  readonly command_ids: readonly string[];
}

export interface NetworkCapabilityTarget {
  readonly kind: "network";
  /** Omission requests network access without a host-specific grant. */
  readonly hosts?: readonly string[];
}

export interface DisclosureCapabilityTarget {
  readonly kind: "disclosure";
  readonly classifications: readonly string[];
}

export interface ChangeCapabilityTarget {
  readonly kind: "change";
  readonly change: "create_file" | "delete_file" | "dependency_manifest" | "local_commit";
}

export const BUDGET_METRICS = [
  "elapsed_ms",
  "turns",
  "operations",
  "read_files",
  "changed_files",
  "changed_lines",
  "disclosed_bytes",
  "commands",
  "command_output_bytes",
  "protocol_repairs",
] as const;

export type BudgetMetric = (typeof BUDGET_METRICS)[number];

export interface BudgetCapabilityTarget {
  readonly kind: "budget";
  readonly metric: BudgetMetric;
  readonly requested_limit: number;
}

export interface ToolCapabilityTarget {
  readonly kind: "tool";
  readonly tools: readonly ToolName[];
}

export type CapabilityTarget =
  | PathCapabilityTarget
  | CommandCapabilityTarget
  | NetworkCapabilityTarget
  | DisclosureCapabilityTarget
  | ChangeCapabilityTarget
  | BudgetCapabilityTarget
  | ToolCapabilityTarget;

export interface RequestCapabilityArguments {
  readonly target: CapabilityTarget;
  readonly reason: string;
  readonly expected_operation: string;
  readonly risk?: string;
}

export interface AcceptanceCriterionReport {
  readonly criterion: string;
  readonly status: "satisfied" | "not_satisfied" | "unknown";
  readonly evidence?: string;
}

export interface ValidationReport {
  readonly command_id: string;
  readonly status: "passed" | "failed" | "not_run";
  readonly summary: string;
}

export interface CompleteTaskArguments {
  readonly summary: string;
  readonly acceptance_criteria: readonly AcceptanceCriterionReport[];
  readonly validation: readonly ValidationReport[];
  readonly skipped_validation: readonly string[];
  readonly remaining_risks: readonly string[];
  readonly follow_up: readonly string[];
}

export interface ToolArgumentsByName {
  readonly list_files: ListFilesArguments;
  readonly search_text: SearchTextArguments;
  readonly read_file: ReadFileArguments;
  readonly git_status: GitStatusArguments;
  readonly git_diff: GitDiffArguments;
  readonly edit_text: EditTextArguments;
  readonly apply_patch: ApplyPatchArguments;
  readonly run_command: RunCommandArguments;
  readonly request_user_input: RequestUserInputArguments;
  readonly request_capability: RequestCapabilityArguments;
  readonly complete_task: CompleteTaskArguments;
}

export type ToolOperation<TName extends ToolName = ToolName> = TName extends ToolName
  ? {
      readonly operation_id: string;
      readonly tool: TName;
      readonly arguments: ToolArgumentsByName[TName];
    }
  : never;

export interface ProtocolMessageBase<TMessageType extends ProtocolMessageType> {
  readonly protocol: ProtocolVersion;
  readonly message_type: TMessageType;
  readonly message_id: string;
  readonly task_id: string;
  readonly turn_id: number;
}

export interface ToolRequestMessage extends ProtocolMessageBase<"tool_request"> {
  readonly operations: readonly ToolOperation[];
}

export type ToolOutcomeStatus =
  | "success"
  | "failure"
  | "conflict"
  | "timeout"
  | "cancelled"
  | "indeterminate";

export interface OperationError {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ToolResultItem {
  readonly operation_id: string;
  readonly tool: ToolName;
  readonly status: ToolOutcomeStatus;
  readonly output?: unknown;
  readonly error?: OperationError;
  readonly truncated?: boolean;
}

export interface ToolResultMessage extends ProtocolMessageBase<"tool_result"> {
  readonly results: readonly ToolResultItem[];
}

export interface ToolDenialItem {
  readonly operation_id: string;
  readonly tool: ToolName;
  readonly decision: "ask" | "deny";
  readonly reason_code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ToolDenialMessage extends ProtocolMessageBase<"tool_denial"> {
  readonly denials: readonly ToolDenialItem[];
}

export const PROTOCOL_ERROR_CODES = [
  "INPUT_TOO_LARGE",
  "MISSING_ENVELOPE",
  "MULTIPLE_ENVELOPES",
  "TRUNCATED_ENVELOPE",
  "UNSUPPORTED_VERSION",
  "EMPTY_ENVELOPE",
  "INVALID_JSON",
  "INVALID_MESSAGE",
  "UNKNOWN_MESSAGE_TYPE",
  "UNKNOWN_TOOL",
  "SCHEMA_INVALID",
  "TASK_MISMATCH",
  "TURN_MISMATCH",
  "DUPLICATE_OPERATION_ID",
  "INVALID_BATCH",
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

export interface ProtocolErrorDetail {
  readonly code: ProtocolErrorCode;
  readonly message: string;
  readonly repairable: boolean;
  readonly operation_id?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ProtocolErrorMessage extends ProtocolMessageBase<"protocol_error"> {
  readonly error: ProtocolErrorDetail;
}

export interface UserInputRequestMessage extends ProtocolMessageBase<"user_input_request"> {
  readonly operation_id: string;
  readonly request: RequestUserInputArguments;
}

export interface CapabilityRequestMessage extends ProtocolMessageBase<"capability_request"> {
  readonly operation_id: string;
  readonly request: RequestCapabilityArguments;
}

export interface ProgressUpdateMessage extends ProtocolMessageBase<"progress_update"> {
  readonly phase: "discovering" | "planning" | "editing" | "validating" | "recovering";
  readonly summary: string;
  readonly completed_steps?: readonly string[];
  readonly current_step?: string;
  readonly next_steps?: readonly string[];
}

export interface CompletionMessage extends ProtocolMessageBase<"completion"> {
  readonly operation_id: string;
  readonly report: CompleteTaskArguments;
  /** False until the deterministic harness has independently verified the claim. */
  readonly verified: boolean;
}

export interface BlockedMessage extends ProtocolMessageBase<"blocked"> {
  readonly reason_code: string;
  readonly summary: string;
  readonly needed: readonly string[];
  readonly recoverable: boolean;
}

export const PROTOCOL_MESSAGE_TYPES = [
  "tool_request",
  "tool_result",
  "tool_denial",
  "protocol_error",
  "user_input_request",
  "capability_request",
  "progress_update",
  "completion",
  "blocked",
] as const;

export type ProtocolMessageType = (typeof PROTOCOL_MESSAGE_TYPES)[number];

export type ProtocolMessage =
  | ToolRequestMessage
  | ToolResultMessage
  | ToolDenialMessage
  | ProtocolErrorMessage
  | UserInputRequestMessage
  | CapabilityRequestMessage
  | ProgressUpdateMessage
  | CompletionMessage
  | BlockedMessage;

export interface ProtocolCorrelation {
  readonly message_id: string;
  readonly task_id: string;
  readonly turn_id: number;
}
