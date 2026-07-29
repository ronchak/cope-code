import type { CompletionClaim, CompletionVerification, RepositoryCompletionState } from "./completion.js";
import type {
  BudgetMetric,
  LocalToolName,
} from "../protocol/types.js";

export type ToolName = LocalToolName;

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
  | {
      readonly type: "blocked";
      readonly reasonCode: string;
      readonly summary: string;
      readonly needed: readonly string[];
      readonly recoverable: boolean;
    }
  /**
   * Compatibility shape used by 0.1.7 protocol adapters and offline replay
   * fixtures. New adapters normalize blocked responses into the structured
   * shape above.
   */
  | {
      readonly type: "blocked";
      readonly reason: string;
      readonly recoverable: boolean;
    };

export interface ParsedModelNormalization {
  readonly kind: "legacy_correlation_rebound";
  readonly receivedTaskId: string;
  readonly expectedTaskId: string;
  readonly receivedTurnId: number;
  readonly expectedTurnId: number;
}

export interface ParsedModelTurn {
  readonly protocolVersion: "cba/1";
  readonly taskId: string;
  readonly turnId: string;
  readonly messages: readonly NormalizedModelMessage[];
  readonly normalizations?: readonly ParsedModelNormalization[];
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
    /** Source-free transport evidence for normalization diagnostics. */
    readonly captureEvidence?: Readonly<Record<string, unknown>>;
  }): ParsedModelTurn;
  /** Classifies parser failures before the runtime decides whether a repair turn is safe. */
  isRepairableParseError(error: unknown): boolean;
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
    readonly repairAttempt?: number;
    readonly repairable?: boolean;
    readonly details?: Readonly<Record<string, unknown>>;
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
  | {
      readonly outcome: "allow";
      readonly reasonCode: string;
      readonly explanation: string;
      readonly plannedMutation?: {
        readonly changedFiles: number;
        readonly changedLines: number;
      };
      /** Conservative full protocol-boundary reservation for this tool result. */
      readonly plannedDisclosureBytes?: number;
      /** Effective ceilings approved only for this exact operation. */
      readonly oneTimeBudgetLimits?: Readonly<Partial<Record<BudgetMetric, number>>>;
      /**
       * Deterministically policy-bounded arguments to execute in place of the
       * original request. The operation identity and journaled request remain
       * the model's exact request.
       */
      readonly effectiveArguments?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly outcome: "ask";
      readonly reasonCode: string;
      readonly explanation: string;
      readonly capability: Readonly<Record<string, unknown>>;
      readonly details?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly outcome: "deny";
      readonly reasonCode: string;
      readonly explanation: string;
      readonly details?: Readonly<Record<string, unknown>>;
    }
  | { readonly outcome: "conflict"; readonly reasonCode: string; readonly explanation: string };

export interface RuntimePolicy {
  summarize(): Readonly<Record<string, unknown>>;
  authorize(call: NormalizedToolCall): AuthorizationDecision | Promise<AuthorizationDecision>;
  authorizeOnce?(
    call: NormalizedToolCall,
    capability: Readonly<Record<string, unknown>>,
  ): AuthorizationDecision | Promise<AuthorizationDecision>;
  expandSessionGrant(capability: Readonly<Record<string, unknown>>): Promise<boolean>;
  assessSessionGrantExpansion?(
    capability: Readonly<Record<string, unknown>>,
  ): Readonly<{
    outcome: "change" | "no_op" | "deny" | "unavailable";
    reasonCode: string;
    explanation: string;
    details?: Readonly<Record<string, unknown>>;
  }>;
}

export interface ToolExecutor {
  execute(
    call: NormalizedToolCall,
    signal: AbortSignal,
    context?: ToolExecutionContext,
  ): Promise<ToolOutcome>;
  /**
   * Loads a result that was durably persisted before an executing journal
   * record could be marked complete. Implementations must verify the exact
   * request hash and operation identity and must never launch work here.
   */
  recoverCompleted?(input: RecoverCompletedToolCall): Promise<ToolOutcome | undefined>;
  inspectCompletionState(): Promise<RepositoryCompletionState>;
}

export interface RecoverCompletedToolCall {
  readonly operationId: string;
  readonly tool: ToolName;
  readonly requestHash: string;
}

export interface ToolExecutionContext {
  /** Exact mutation plan already authorized and reserved by the runtime. */
  readonly plannedMutation?: {
    readonly changedFiles: number;
    readonly changedLines: number;
  };
  /** Locally authorized and clamped bounds for terminal-exec/1. */
  readonly terminal?: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  };
}

export interface DisclosureGuard {
  inspectAndSerialize(message: string, context: { readonly kind: "bootstrap" | "tool_result" | "repair" | "decision" }): Promise<string>;
}

export interface UserInteraction {
  requestInput(request: {
    readonly question: string;
    readonly choices?: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<Readonly<Record<string, unknown>>>;
  requestCapability(request: {
    readonly capability: Readonly<Record<string, unknown>>;
    readonly reason: string;
    readonly risk?: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly decision: "deny" | "allow_once" | "allow_session"; readonly note?: string }>;
}
