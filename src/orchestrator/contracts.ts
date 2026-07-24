import type { CompletionClaim, CompletionVerification, RepositoryCompletionState } from "./completion.js";

export type ToolName =
  | "list_files"
  | "search_text"
  | "read_file"
  | "git_status"
  | "git_diff"
  | "edit_text"
  | "apply_patch"
  | "run_command";

export interface NormalizedToolCall {
  readonly operationId: string;
  readonly name: ToolName;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type NormalizedModelMessage =
  | { readonly type: "tool_request"; readonly calls: readonly NormalizedToolCall[] }
  | { readonly type: "request_user_input"; readonly requestId: string; readonly question: string; readonly choices?: readonly string[] }
  | {
      readonly type: "request_capability";
      readonly requestId: string;
      readonly capability: Readonly<Record<string, unknown>>;
      readonly reason: string;
      readonly risk?: string;
    }
  | { readonly type: "progress"; readonly summary: string }
  | { readonly type: "complete_task"; readonly operationId: string; readonly claim: CompletionClaim }
  | { readonly type: "blocked"; readonly reason: string; readonly recoverable: boolean };

export interface ParsedModelTurn {
  readonly protocolVersion: "cba/1";
  readonly taskId: string;
  readonly turnId: string;
  readonly messages: readonly NormalizedModelMessage[];
}

export interface ToolOutcome {
  readonly operationId: string;
  readonly tool: ToolName;
  readonly status:
    | "success"
    | "failure"
    | "conflict"
    | "denied"
    | "timeout"
    | "cancelled"
    | "indeterminate";
  /** Structured result to return after the final disclosure guard. */
  readonly data: Readonly<Record<string, unknown>>;
  /** Non-source-bearing metadata safe to persist in operation/audit records. */
  readonly safeMetadata: Readonly<Record<string, unknown>>;
}

export interface ProtocolAdapter {
  renderBootstrap(input: {
    readonly sessionId: string;
    readonly taskId: string;
    readonly objective: string;
    readonly acceptanceCriteria: readonly string[];
    readonly policySummary: Readonly<Record<string, unknown>>;
    readonly budgetSummary: Readonly<Record<string, unknown>>;
  }): string;
  parseModelTurn(raw: string, expected: {
    readonly taskId: string;
    readonly turnId: string;
    /** True only while replaying an integrity-checked cached response after interruption. */
    readonly recoveryReplay?: boolean;
  }): ParsedModelTurn;
  renderToolOutcomes(input: {
    readonly taskId: string;
    readonly priorTurnId: string;
    readonly outcomes: readonly ToolOutcome[];
  }): string;
  renderProtocolError(input: {
    readonly taskId: string;
    readonly priorTurnId: string;
    readonly code: string;
    readonly message: string;
    readonly repairAttempt: number;
  }): string;
  renderUserDecision(input: {
    readonly taskId: string;
    readonly priorTurnId: string;
    readonly requestId: string;
    readonly kind: "user_input" | "capability";
    readonly decision: Readonly<Record<string, unknown>>;
  }): string;
  renderCompletionRejected(input: {
    readonly taskId: string;
    readonly priorTurnId: string;
    readonly operationId: string;
    readonly verification: CompletionVerification;
  }): string;
}

export type AuthorizationDecision =
  | { readonly outcome: "allow"; readonly reasonCode: string; readonly explanation: string }
  | { readonly outcome: "ask"; readonly reasonCode: string; readonly explanation: string; readonly capability: Readonly<Record<string, unknown>> }
  | { readonly outcome: "deny"; readonly reasonCode: string; readonly explanation: string };

export interface RuntimePolicy {
  summarize(): Readonly<Record<string, unknown>>;
  authorize(call: NormalizedToolCall): AuthorizationDecision | Promise<AuthorizationDecision>;
  expandSessionGrant(capability: Readonly<Record<string, unknown>>): Promise<boolean>;
}

export interface ToolExecutor {
  execute(call: NormalizedToolCall, signal: AbortSignal): Promise<ToolOutcome>;
  inspectCompletionState(): Promise<RepositoryCompletionState>;
}

export interface DisclosureGuard {
  inspectAndSerialize(message: string, context: { readonly kind: "bootstrap" | "tool_result" | "repair" | "decision" }): Promise<string>;
}

export interface UserInteraction {
  requestInput(request: {
    readonly question: string;
    readonly choices?: readonly string[];
  }): Promise<Readonly<Record<string, unknown>>>;
  requestCapability(request: {
    readonly capability: Readonly<Record<string, unknown>>;
    readonly reason: string;
    readonly risk?: string;
  }): Promise<{ readonly decision: "deny" | "allow_once" | "allow_session"; readonly note?: string }>;
}
