import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

import { BUDGET_METRICS, TOOL_NAMES } from "../protocol/types.js";
import { isSafePolicyPattern } from "./patterns.js";
import {
  POLICY_SCHEMA_VERSION,
  SESSION_GRANT_SCHEMA_VERSION,
  type PolicyDocument,
  type PolicyValidationResult,
  type RuleSet,
  type SessionGrant,
} from "./types.js";

type JsonSchema = Readonly<Record<string, unknown>>;

const identifier = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
} as const;
const decision = { enum: ["allow", "ask", "deny"] } as const;
const escalationDecision = { enum: ["ask", "deny"] } as const;
const stringItem = { type: "string", minLength: 1, maxLength: 1_024 } as const;

const strictObject = (
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): JsonSchema => ({ type: "object", additionalProperties: false, properties, required });

const uniqueStrings = (items: JsonSchema = stringItem): JsonSchema => ({
  type: "array",
  maxItems: 1_024,
  uniqueItems: true,
  items,
});

const ruleSet = (items: JsonSchema = stringItem): JsonSchema =>
  strictObject({ allow: uniqueStrings(items), ask: uniqueStrings(items), deny: uniqueStrings(items), unmatched: decision });

const pathPolicy = strictObject({
  read: ruleSet(),
  write: ruleSet(),
  create: ruleSet(),
  delete: ruleSet(),
  excluded: uniqueStrings(),
  protected: uniqueStrings(),
});

const commandPolicy = strictObject({
  ids: ruleSet(),
  categories: ruleSet(),
  risks: strictObject({ low: decision, medium: decision, high: decision }),
  side_effects: decision,
  max_timeout_ms: { type: "integer", minimum: 1, maximum: 86_400_000 },
});

const disclosurePolicy = strictObject({
  classifications: ruleSet(),
  secrets: { const: "deny" },
  max_bytes_per_operation: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  max_files_per_operation: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
});

const networkPolicy = strictObject({ access: decision, hosts: ruleSet() });

const changePolicy = strictObject({
  create_files: decision,
  delete_files: decision,
  dependency_manifests: decision,
  local_commits: decision,
  max_files_per_operation: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  max_changed_lines_per_operation: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  on_limit_exceeded: escalationDecision,
});

const budgets: JsonSchema = {
  type: "object",
  additionalProperties: false,
  propertyNames: { enum: BUDGET_METRICS },
  properties: Object.fromEntries(
    BUDGET_METRICS.map((metric) => [metric, { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }]),
  ),
};

const capabilities = strictObject({
  tools: ruleSet({ enum: TOOL_NAMES }),
  paths: pathPolicy,
  commands: commandPolicy,
  disclosure: disclosurePolicy,
  network: networkPolicy,
  changes: changePolicy,
  budgets,
  budget_exceeded: escalationDecision,
});

export const POLICY_DOCUMENT_SCHEMA: JsonSchema = {
  $id: "https://local.cba.invalid/contracts/cba-policy-1.schema.json",
  ...strictObject(
    {
      schema_version: { const: POLICY_SCHEMA_VERSION },
      policy_id: identifier,
      revision: identifier,
      layer: { enum: ["organization", "repository"] },
      default_decision: decision,
      capabilities,
    },
    ["schema_version", "policy_id", "revision", "layer", "default_decision", "capabilities"],
  ),
};

const approval = strictObject(
  {
    key: { type: "string", minLength: 1, maxLength: 2_048 },
    granted_at: { type: "string", minLength: 1, maxLength: 64 },
  },
  ["key", "granted_at"],
);

export const SESSION_GRANT_SCHEMA: JsonSchema = {
  $id: "https://local.cba.invalid/contracts/cba-session-grant-1.schema.json",
  ...strictObject(
    {
      schema_version: { const: SESSION_GRANT_SCHEMA_VERSION },
      grant_id: identifier,
      task_id: identifier,
      repository_root: { type: "string", minLength: 1, maxLength: 32_768 },
      branch: { type: "string", minLength: 1, maxLength: 1_024 },
      mode: { enum: ["inspect", "edit", "auto"] },
      default_decision: decision,
      capabilities,
      approved_capabilities: { type: "array", maxItems: 1_024, items: approval },
    },
    [
      "schema_version",
      "grant_id",
      "task_id",
      "repository_root",
      "mode",
      "default_decision",
      "capabilities",
      "approved_capabilities",
    ],
  ),
};

const ajv = new Ajv({ allErrors: true, strict: true, messages: true });
const policyValidator = ajv.compile(POLICY_DOCUMENT_SCHEMA) as ValidateFunction<PolicyDocument>;
const sessionValidator = ajv.compile(SESSION_GRANT_SCHEMA) as ValidateFunction<SessionGrant>;

export function validatePolicyDocument(value: unknown): PolicyValidationResult<PolicyDocument> {
  if (!policyValidator(value)) return invalid(policyValidator.errors);
  const errors = validateCapabilitiesSemantics(value.capabilities);
  return errors.length === 0 ? { valid: true, value, errors: [] } : { valid: false, errors };
}

export function validateSessionGrant(value: unknown): PolicyValidationResult<SessionGrant> {
  if (!sessionValidator(value)) return invalid(sessionValidator.errors);
  const errors = [
    ...validateCapabilitiesSemantics(value.capabilities),
    ...duplicates(value.approved_capabilities.map((approval) => approval.key), "approved capability"),
  ];
  return errors.length === 0 ? { valid: true, value, errors: [] } : { valid: false, errors };
}

export function assertValidPolicyDocument(value: unknown): asserts value is PolicyDocument {
  const result = validatePolicyDocument(value);
  if (!result.valid) throw new TypeError(`Invalid policy document: ${result.errors.join("; ")}`);
}

export function assertValidSessionGrant(value: unknown): asserts value is SessionGrant {
  const result = validateSessionGrant(value);
  if (!result.valid) throw new TypeError(`Invalid session grant: ${result.errors.join("; ")}`);
}

function invalid<T>(errors: readonly ErrorObject[] | null | undefined): PolicyValidationResult<T> {
  return {
    valid: false,
    errors: (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`),
  };
}

function validateCapabilitiesSemantics(capabilitySet: PolicyDocument["capabilities"]): readonly string[] {
  const errors: string[] = [];
  errors.push(...validateRuleSet(capabilitySet.tools, "tools", false));
  const paths = capabilitySet.paths;
  if (paths !== undefined) {
    errors.push(...validateRuleSet(paths.read, "paths.read", true));
    errors.push(...validateRuleSet(paths.write, "paths.write", true));
    errors.push(...validateRuleSet(paths.create, "paths.create", true));
    errors.push(...validateRuleSet(paths.delete, "paths.delete", true));
    for (const [name, patterns] of [
      ["paths.excluded", paths.excluded],
      ["paths.protected", paths.protected],
    ] as const) {
      for (const pattern of patterns ?? []) {
        if (!isSafePolicyPattern(pattern)) errors.push(`${name} contains unsafe pattern '${pattern}'`);
      }
    }
  }
  errors.push(...validateRuleSet(capabilitySet.commands?.ids, "commands.ids", false));
  errors.push(...validateRuleSet(capabilitySet.commands?.categories, "commands.categories", false));
  errors.push(...validateRuleSet(capabilitySet.disclosure?.classifications, "disclosure.classifications", false));
  errors.push(...validateRuleSet(capabilitySet.network?.hosts, "network.hosts", false));
  return errors;
}

function validateRuleSet(
  rules: RuleSet<string> | undefined,
  name: string,
  patterns: boolean,
): readonly string[] {
  if (rules === undefined) return [];
  const errors = [
    ...overlaps(rules.allow, rules.ask, name, "allow", "ask"),
    ...overlaps(rules.allow, rules.deny, name, "allow", "deny"),
    ...overlaps(rules.ask, rules.deny, name, "ask", "deny"),
  ];
  if (patterns) {
    for (const pattern of [...(rules.allow ?? []), ...(rules.ask ?? []), ...(rules.deny ?? [])]) {
      if (!isSafePolicyPattern(pattern)) errors.push(`${name} contains unsafe pattern '${pattern}'`);
    }
  }
  return errors;
}

function overlaps(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
  name: string,
  leftName: string,
  rightName: string,
): readonly string[] {
  const rightValues = new Set((right ?? []).map((value) => value.toLowerCase()));
  return (left ?? [])
    .filter((value) => rightValues.has(value.toLowerCase()))
    .map((value) => `${name} entry '${value}' appears in both ${leftName} and ${rightName}`);
}

function duplicates(values: readonly string[], name: string): readonly string[] {
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const value of values) {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) errors.push(`Duplicate ${name} '${value}'`);
    seen.add(normalized);
  }
  return errors;
}
