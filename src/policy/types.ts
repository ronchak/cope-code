import type { BudgetMetric, ToolName } from "../protocol/types.js";

export const POLICY_SCHEMA_VERSION = "cba-policy/1" as const;
export const SESSION_GRANT_SCHEMA_VERSION = "cba-session-grant/1" as const;

export type PolicyDecision = "allow" | "ask" | "deny";
export type PolicyLayer = "organization" | "repository" | "session";
export type AutonomyMode = "inspect" | "edit" | "auto";

/** Deny wins over ask, which wins over allow. */
export const POLICY_DECISION_WEIGHT: Readonly<Record<PolicyDecision, number>> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

export interface RuleSet<T extends string = string> {
  readonly allow?: readonly T[];
  readonly ask?: readonly T[];
  readonly deny?: readonly T[];
  /** Decision when no entry matches. Defaults to the containing layer's default. */
  readonly unmatched?: PolicyDecision;
}

export type PathAccess = "read" | "write" | "create" | "delete";

export interface PathPolicy {
  readonly read?: RuleSet<string>;
  readonly write?: RuleSet<string>;
  readonly create?: RuleSet<string>;
  readonly delete?: RuleSet<string>;
  /** Excluded paths cannot be read, disclosed, or changed. */
  readonly excluded?: readonly string[];
  /** Protected paths may be read if separately allowed but cannot be changed. */
  readonly protected?: readonly string[];
}

export type CommandRisk = "low" | "medium" | "high";

export interface CommandPolicy {
  readonly ids?: RuleSet<string>;
  readonly categories?: RuleSet<string>;
  readonly risks?: Readonly<Partial<Record<CommandRisk, PolicyDecision>>>;
  readonly side_effects?: PolicyDecision;
  readonly max_timeout_ms?: number;
}

export interface DisclosurePolicy {
  readonly classifications?: RuleSet<string>;
  /** High-confidence secrets and credentials are a non-overridable v1 deny. */
  readonly secrets?: "deny";
  readonly max_bytes_per_operation?: number;
  readonly max_files_per_operation?: number;
}

export interface NetworkPolicy {
  readonly access?: PolicyDecision;
  readonly hosts?: RuleSet<string>;
}

export interface ChangePolicy {
  readonly create_files?: PolicyDecision;
  readonly delete_files?: PolicyDecision;
  readonly dependency_manifests?: PolicyDecision;
  readonly local_commits?: PolicyDecision;
  readonly max_files_per_operation?: number;
  readonly max_changed_lines_per_operation?: number;
  readonly on_limit_exceeded?: "ask" | "deny";
}

export type BudgetLimits = Readonly<Partial<Record<BudgetMetric, number>>>;
export type BudgetUsage = Readonly<Record<BudgetMetric, number>>;

export interface PolicyCapabilities {
  readonly tools?: RuleSet<ToolName>;
  readonly paths?: PathPolicy;
  readonly commands?: CommandPolicy;
  readonly disclosure?: DisclosurePolicy;
  readonly network?: NetworkPolicy;
  readonly changes?: ChangePolicy;
  readonly budgets?: BudgetLimits;
  readonly budget_exceeded?: "ask" | "deny";
}

export interface PolicyDocument {
  readonly schema_version: typeof POLICY_SCHEMA_VERSION;
  readonly policy_id: string;
  readonly revision: string;
  readonly layer: "organization" | "repository";
  readonly default_decision: PolicyDecision;
  readonly capabilities: PolicyCapabilities;
}

export interface CapabilityApproval {
  /** Canonical key returned on an ask decision, such as path:write:src/a.ts. */
  readonly key: string;
  readonly granted_at: string;
}

export interface SessionGrant {
  readonly schema_version: typeof SESSION_GRANT_SCHEMA_VERSION;
  readonly grant_id: string;
  readonly task_id: string;
  readonly repository_root: string;
  readonly branch?: string;
  readonly mode: AutonomyMode;
  readonly default_decision: PolicyDecision;
  readonly capabilities: PolicyCapabilities;
  readonly approved_capabilities: readonly CapabilityApproval[];
}

export interface PolicyPathAccess {
  readonly path: string;
  readonly access: PathAccess;
}

export interface PolicyCommandContext {
  readonly id: string;
  readonly category: string;
  readonly risk: CommandRisk;
  readonly side_effects: boolean;
  readonly timeout_ms: number;
}

export interface PolicyDisclosureContext {
  readonly classification: string;
  readonly byte_count: number;
  readonly file_count: number;
  readonly contains_secret: boolean;
}

export interface PolicyNetworkContext {
  readonly required: boolean;
  readonly hosts: readonly string[];
}

export interface PolicyChangeContext {
  readonly files_changed: number;
  readonly changed_lines: number;
  readonly creates: number;
  readonly deletes: number;
  readonly dependency_manifest: boolean;
  readonly local_commit: boolean;
}

/** All facts here come from deterministic local inspection/catalog resolution. */
export interface PolicyOperation {
  readonly tool: ToolName;
  readonly paths?: readonly PolicyPathAccess[];
  readonly command?: PolicyCommandContext;
  readonly disclosure?: PolicyDisclosureContext;
  readonly network?: PolicyNetworkContext;
  readonly change?: PolicyChangeContext;
  /** Projected totals after the operation, not merely this operation's delta. */
  readonly projected_usage: BudgetUsage;
}

export const POLICY_REASON_CODES = [
  "ALLOWED",
  "LAYER_DEFAULT",
  "UNKNOWN_TOOL",
  "TOOL_NOT_GRANTED",
  "TOOL_REQUIRES_APPROVAL",
  "MODE_INSPECT_WRITE_DENIED",
  "MODE_INSPECT_SIDE_EFFECT_DENIED",
  "MODE_EDIT_HIGH_RISK_REQUIRES_APPROVAL",
  "OPERATION_CONTEXT_MISSING",
  "INVALID_OPERATION_CONTEXT",
  "INVALID_REPOSITORY_PATH",
  "PATH_EXCLUDED",
  "PATH_PROTECTED",
  "PATH_NOT_GRANTED",
  "PATH_REQUIRES_APPROVAL",
  "COMMAND_NOT_GRANTED",
  "COMMAND_REQUIRES_APPROVAL",
  "COMMAND_CATEGORY_NOT_GRANTED",
  "COMMAND_CATEGORY_REQUIRES_APPROVAL",
  "COMMAND_RISK_NOT_GRANTED",
  "COMMAND_RISK_REQUIRES_APPROVAL",
  "COMMAND_SIDE_EFFECT_NOT_GRANTED",
  "COMMAND_SIDE_EFFECT_REQUIRES_APPROVAL",
  "COMMAND_TIMEOUT_EXCEEDED",
  "DISCLOSURE_CLASSIFICATION_DENIED",
  "DISCLOSURE_CLASSIFICATION_REQUIRES_APPROVAL",
  "SECRET_DISCLOSURE_DENIED",
  "DISCLOSURE_OPERATION_LIMIT_EXCEEDED",
  "NETWORK_DENIED",
  "NETWORK_REQUIRES_APPROVAL",
  "NETWORK_HOST_DENIED",
  "NETWORK_HOST_REQUIRES_APPROVAL",
  "CREATE_FILE_DENIED",
  "CREATE_FILE_REQUIRES_APPROVAL",
  "DELETE_FILE_DENIED",
  "DELETE_FILE_REQUIRES_APPROVAL",
  "DEPENDENCY_CHANGE_DENIED",
  "DEPENDENCY_CHANGE_REQUIRES_APPROVAL",
  "LOCAL_COMMIT_DENIED",
  "LOCAL_COMMIT_REQUIRES_APPROVAL",
  "CHANGE_OPERATION_LIMIT_EXCEEDED",
  "BUDGET_EXCEEDED",
  "CAPABILITY_APPROVED_FOR_SESSION",
  "CAPABILITY_EXPANSION_DENIED",
  "CAPABILITY_EXPANSION_REQUIRES_APPROVAL",
] as const;

export type PolicyReasonCode = (typeof POLICY_REASON_CODES)[number];

export interface PolicyCheck {
  readonly layer: PolicyLayer;
  readonly dimension: "mode" | "tool" | "path" | "command" | "disclosure" | "network" | "change" | "budget";
  readonly decision: PolicyDecision;
  readonly reason_code: PolicyReasonCode;
  readonly message: string;
  readonly capability_key?: string;
  readonly resource?: string;
}

export interface EffectivePolicy {
  readonly decision: PolicyDecision;
  readonly checks: readonly PolicyCheck[];
  /** Only non-allow checks, suitable for an escalation or denial explanation. */
  readonly reasons: readonly PolicyCheck[];
  readonly effective_budget_limits: BudgetLimits;
}

export interface PolicyValidationResult<T> {
  readonly valid: boolean;
  readonly value?: T;
  readonly errors: readonly string[];
}

export type SessionCapabilityExpansion =
  | { readonly kind: "tool"; readonly tool: ToolName }
  | { readonly kind: "path"; readonly access: PathAccess; readonly path: string }
  | { readonly kind: "command"; readonly command_id: string; readonly category: string; readonly risk: CommandRisk }
  | { readonly kind: "disclosure"; readonly classification: string }
  | { readonly kind: "network"; readonly host?: string }
  | {
      readonly kind: "change";
      readonly change: "create_file" | "delete_file" | "dependency_manifest" | "local_commit";
    }
  | { readonly kind: "budget"; readonly metric: BudgetMetric; readonly requested_limit: number };

export interface SessionExpansionResult {
  readonly decision: PolicyDecision;
  readonly grant: SessionGrant;
  readonly reasons: readonly PolicyCheck[];
  readonly capability_key: string;
}
