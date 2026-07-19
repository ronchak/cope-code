import { BUDGET_METRICS, TOOL_NAMES, type BudgetMetric, type ToolName } from "../protocol/types.js";
import {
  POLICY_SCHEMA_VERSION,
  SESSION_GRANT_SCHEMA_VERSION,
  type AutonomyMode,
  type BudgetLimits,
  type BudgetUsage,
  type PolicyDocument,
  type SessionGrant,
} from "./types.js";

const PROTECTED_MUTATION_PATHS = [
  ".git",
  ".git/**",
  ".cba",
  ".cba/**",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.pfx",
  "**/*.p12",
  "**/*.key",
  "**/credentials*",
  ".github/workflows/**",
  ".gitlab-ci.yml",
  "azure-pipelines.yml",
  "Jenkinsfile",
] as const;

const EXCLUDED_DISCLOSURE_PATHS = [
  ".git",
  ".git/**",
  ".cba",
  ".cba/**",
  "node_modules",
  "node_modules/**",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.pfx",
  "**/*.p12",
  "**/*.key",
] as const;

export const DEFAULT_POLICY_BUDGETS: Readonly<Record<BudgetMetric, number>> = {
  elapsed_ms: 3_600_000,
  turns: 40,
  operations: 160,
  read_files: 80,
  changed_files: 30,
  changed_lines: 2_000,
  disclosed_bytes: 2_000_000,
  commands: 30,
  command_output_bytes: 1_000_000,
  protocol_repairs: 4,
};

export const DEFAULT_ORGANIZATION_POLICY: PolicyDocument = {
  schema_version: POLICY_SCHEMA_VERSION,
  policy_id: "default-organization",
  revision: "1",
  layer: "organization",
  default_decision: "allow",
  capabilities: {
    tools: { allow: TOOL_NAMES },
    paths: { excluded: EXCLUDED_DISCLOSURE_PATHS, protected: PROTECTED_MUTATION_PATHS },
    commands: {
      risks: { low: "allow", medium: "allow", high: "ask" },
      side_effects: "allow",
      max_timeout_ms: 3_600_000,
    },
    disclosure: {
      classifications: {
        allow: ["public", "internal"],
        ask: ["confidential"],
        deny: ["restricted", "secret", "credential"],
        unmatched: "deny",
      },
      secrets: "deny",
      max_bytes_per_operation: 1_000_000,
      max_files_per_operation: 50,
    },
    network: { access: "deny" },
    changes: {
      create_files: "allow",
      delete_files: "allow",
      dependency_manifests: "ask",
      local_commits: "deny",
      max_files_per_operation: 30,
      max_changed_lines_per_operation: 2_000,
      on_limit_exceeded: "deny",
    },
    budgets: DEFAULT_POLICY_BUDGETS,
    budget_exceeded: "deny",
  },
};

export const DEFAULT_REPOSITORY_POLICY: PolicyDocument = {
  schema_version: POLICY_SCHEMA_VERSION,
  policy_id: "default-repository",
  revision: "1",
  layer: "repository",
  default_decision: "allow",
  capabilities: {
    tools: { allow: TOOL_NAMES },
    paths: { excluded: EXCLUDED_DISCLOSURE_PATHS, protected: PROTECTED_MUTATION_PATHS },
    commands: { risks: { low: "allow", medium: "allow", high: "ask" }, side_effects: "allow" },
    disclosure: { secrets: "deny" },
    network: { access: "deny" },
    changes: {
      create_files: "allow",
      delete_files: "ask",
      dependency_manifests: "ask",
      local_commits: "deny",
      on_limit_exceeded: "ask",
    },
    budgets: DEFAULT_POLICY_BUDGETS,
    budget_exceeded: "deny",
  },
};

export interface DefaultSessionGrantOptions {
  readonly grant_id: string;
  readonly task_id: string;
  readonly repository_root: string;
  readonly branch?: string;
  readonly mode: AutonomyMode;
  readonly readable_paths?: readonly string[];
  readonly writable_paths?: readonly string[];
  readonly command_ids?: readonly string[];
  readonly disclosure_classifications?: readonly string[];
  readonly tools?: readonly ToolName[];
  readonly budgets?: BudgetLimits;
}

export function createDefaultSessionGrant(options: DefaultSessionGrantOptions): SessionGrant {
  const branch = options.branch === undefined ? {} : { branch: options.branch };
  return {
    schema_version: SESSION_GRANT_SCHEMA_VERSION,
    grant_id: options.grant_id,
    task_id: options.task_id,
    repository_root: options.repository_root,
    ...branch,
    mode: options.mode,
    default_decision: "ask",
    capabilities: {
      tools: { allow: options.tools ?? TOOL_NAMES, unmatched: "ask" },
      paths: {
        read: { allow: options.readable_paths ?? ["**"], unmatched: "ask" },
        write: { allow: options.writable_paths ?? [], unmatched: "ask" },
        create: { allow: options.writable_paths ?? [], unmatched: "ask" },
        delete: { allow: options.writable_paths ?? [], unmatched: "ask" },
      },
      commands: {
        ids: { allow: options.command_ids ?? [], unmatched: "ask" },
        categories: { unmatched: "allow" },
        risks: { low: "allow", medium: options.mode === "auto" ? "allow" : "ask", high: "ask" },
        side_effects: options.mode === "inspect" ? "deny" : "allow",
      },
      disclosure: {
        classifications: {
          allow: options.disclosure_classifications ?? ["public", "internal"],
          unmatched: "ask",
        },
        secrets: "deny",
      },
      network: { access: "deny" },
      changes: {
        create_files: options.mode === "inspect" ? "deny" : "allow",
        delete_files: options.mode === "auto" ? "allow" : "ask",
        dependency_manifests: "ask",
        local_commits: "deny",
        on_limit_exceeded: "ask",
      },
      budgets: { ...DEFAULT_POLICY_BUDGETS, ...options.budgets },
      budget_exceeded: "ask",
    },
    approved_capabilities: [],
  };
}

export function zeroPolicyBudgetUsage(): BudgetUsage {
  return Object.fromEntries(BUDGET_METRICS.map((metric) => [metric, 0])) as unknown as BudgetUsage;
}
