import { BUDGET_METRICS, TOOL_NAMES, type BudgetMetric, type ToolName } from "../protocol/types.js";
import { assertValidPolicyDocument, assertValidSessionGrant } from "./schemas.js";
import { matchPolicyPattern, normalizeRepositoryPath } from "./patterns.js";
import {
  POLICY_DECISION_WEIGHT,
  type BudgetLimits,
  type EffectivePolicy,
  type PathAccess,
  type PolicyCapabilities,
  type PolicyCheck,
  type PolicyDecision,
  type PolicyDocument,
  type PolicyLayer,
  type PolicyOperation,
  type PolicyReasonCode,
  type RuleSet,
  type SessionCapabilityExpansion,
  type SessionExpansionResult,
  type SessionGrant,
} from "./types.js";

interface LayerView {
  readonly layer: PolicyLayer;
  readonly defaultDecision: PolicyDecision;
  readonly capabilities: PolicyCapabilities;
}

interface CheckInput {
  readonly layer: PolicyLayer;
  readonly dimension: PolicyCheck["dimension"];
  readonly decision: PolicyDecision;
  readonly allowCode?: PolicyReasonCode;
  readonly askCode: PolicyReasonCode;
  readonly denyCode: PolicyReasonCode;
  readonly allowMessage?: string;
  readonly askMessage: string;
  readonly denyMessage: string;
  readonly capabilityKey?: string;
  readonly resource?: string;
}

export class PolicyEngine {
  public readonly organization: PolicyDocument;
  public readonly repository: PolicyDocument;
  public readonly session: SessionGrant;
  public readonly repositoryPathKey: (value: string) => string;

  public constructor(input: {
    readonly organization: PolicyDocument;
    readonly repository: PolicyDocument;
    readonly session: SessionGrant;
    readonly pathKey?: (value: string) => string;
  }) {
    assertValidPolicyDocument(input.organization);
    assertValidPolicyDocument(input.repository);
    assertValidSessionGrant(input.session);
    if (input.organization.layer !== "organization") throw new TypeError("organization policy has the wrong layer");
    if (input.repository.layer !== "repository") throw new TypeError("repository policy has the wrong layer");
    this.organization = input.organization;
    this.repository = input.repository;
    this.session = input.session;
    // The default preserves the original Windows-oriented policy behavior for
    // non-composed/library callers. Live composition injects the actual volume.
    this.repositoryPathKey = input.pathKey ?? ((value) => value.toLowerCase());
  }

  public evaluate(operation: PolicyOperation): EffectivePolicy {
    const checks: PolicyCheck[] = [];
    const layers = this.layers();

    if (!(TOOL_NAMES as readonly string[]).includes(operation.tool)) {
      checks.push({
        layer: "organization",
        dimension: "tool",
        decision: "deny",
        reason_code: "UNKNOWN_TOOL",
        message: `Tool '${String(operation.tool)}' is not in the versioned catalog.`,
        resource: String(operation.tool),
      });
      return this.finish(checks);
    }

    this.evaluateMode(operation, checks);
    for (const layer of layers) this.evaluateTool(layer, operation.tool, checks);
    this.evaluateRequiredContext(operation, checks);
    this.evaluateOperationFacts(operation, checks);
    for (const path of operation.paths ?? []) this.evaluatePath(path.path, path.access, layers, checks);
    if (operation.command !== undefined) this.evaluateCommand(operation, layers, checks);
    if (operation.disclosure !== undefined) this.evaluateDisclosure(operation, layers, checks);
    if (operation.network?.required === true) this.evaluateNetwork(operation, layers, checks);
    if (operation.change !== undefined) this.evaluateChange(operation, layers, checks);
    this.evaluateBudgets(operation, layers, checks);
    return this.finish(checks);
  }

  public getEffectiveBudgetLimits(): BudgetLimits {
    const effective: Partial<Record<BudgetMetric, number>> = {};
    for (const metric of BUDGET_METRICS) {
      const limits = this.layers()
        .map((layer) => layer.capabilities.budgets?.[metric])
        .filter((limit): limit is number => limit !== undefined);
      if (limits.length > 0) effective[metric] = Math.min(...limits);
    }
    return effective;
  }

  /**
   * Call only after the user has granted the requested expansion. A higher
   * layer deny leaves the grant unchanged; an ask is recorded as a scoped
   * approval so it does not prompt repeatedly during this session.
   */
  public expandSessionGrant(expansion: SessionCapabilityExpansion, grantedAt = new Date().toISOString()): SessionExpansionResult {
    return expandGrant(this.organization, this.repository, this.session, expansion, grantedAt, this.repositoryPathKey);
  }

  private layers(): readonly LayerView[] {
    return [
      {
        layer: "organization",
        defaultDecision: this.organization.default_decision,
        capabilities: this.organization.capabilities,
      },
      {
        layer: "repository",
        defaultDecision: this.repository.default_decision,
        capabilities: this.repository.capabilities,
      },
      { layer: "session", defaultDecision: this.session.default_decision, capabilities: this.session.capabilities },
    ];
  }

  private evaluateMode(operation: PolicyOperation, checks: PolicyCheck[]): void {
    if (this.session.mode === "inspect") {
      if (operation.tool === "apply_patch" || operation.paths?.some((path) => path.access !== "read") === true) {
        checks.push({
          layer: "session",
          dimension: "mode",
          decision: "deny",
          reason_code: "MODE_INSPECT_WRITE_DENIED",
          message: "Inspect mode does not permit repository mutations.",
        });
      }
      if (operation.tool === "run_command" && operation.command?.side_effects === true) {
        checks.push({
          layer: "session",
          dimension: "mode",
          decision: "deny",
          reason_code: "MODE_INSPECT_SIDE_EFFECT_DENIED",
          message: "Inspect mode does not permit commands with side effects.",
        });
      }
    }
    if (this.session.mode === "edit" && operation.command?.risk === "high") {
      checks.push(
        this.resolveCheck({
          layer: "session",
          dimension: "mode",
          decision: "ask",
          askCode: "MODE_EDIT_HIGH_RISK_REQUIRES_APPROVAL",
          denyCode: "COMMAND_RISK_NOT_GRANTED",
          askMessage: `Edit mode requires approval for high-risk command '${operation.command.id}'.`,
          denyMessage: `High-risk command '${operation.command.id}' is denied in Edit mode.`,
          capabilityKey: `command:${operation.command.id}`,
          resource: operation.command.id,
        }),
      );
    }
  }

  private evaluateTool(layer: LayerView, tool: ToolName, checks: PolicyCheck[]): void {
    const result = decideRule(layer.capabilities.tools, tool, layer.defaultDecision, (value, pattern) => value === pattern);
    checks.push(
      this.resolveCheck({
        layer: layer.layer,
        dimension: "tool",
        decision: result,
        askCode: "TOOL_REQUIRES_APPROVAL",
        denyCode: "TOOL_NOT_GRANTED",
        askMessage: `${layer.layer} policy requires approval for tool '${tool}'.`,
        denyMessage: `${layer.layer} policy does not grant tool '${tool}'.`,
        capabilityKey: `tool:${tool}`,
        resource: tool,
      }),
    );
  }

  private evaluateRequiredContext(operation: PolicyOperation, checks: PolicyCheck[]): void {
    const needsPath = ["list_files", "search_text", "read_file", "apply_patch"].includes(operation.tool);
    if (needsPath && (operation.paths?.length ?? 0) === 0) {
      checks.push({
        layer: "organization",
        dimension: "path",
        decision: "deny",
        reason_code: "OPERATION_CONTEXT_MISSING",
        message: `Policy evaluation for '${operation.tool}' requires resolved path context.`,
      });
    }
    if (operation.tool === "run_command" && operation.command === undefined) {
      checks.push({
        layer: "organization",
        dimension: "command",
        decision: "deny",
        reason_code: "OPERATION_CONTEXT_MISSING",
        message: "run_command policy evaluation requires catalog-resolved command metadata.",
      });
    }
    if (operation.tool === "run_command" && operation.network === undefined) {
      checks.push({
        layer: "organization",
        dimension: "network",
        decision: "deny",
        reason_code: "OPERATION_CONTEXT_MISSING",
        message: "run_command policy evaluation requires catalog-resolved network metadata.",
      });
    }
    if (operation.tool === "apply_patch" && operation.change === undefined) {
      checks.push({
        layer: "organization",
        dimension: "change",
        decision: "deny",
        reason_code: "OPERATION_CONTEXT_MISSING",
        message: "apply_patch policy evaluation requires deterministic change counts and kinds.",
      });
    }
  }

  private evaluateOperationFacts(operation: PolicyOperation, checks: PolicyCheck[]): void {
    const invalid = (dimension: PolicyCheck["dimension"], message: string): void => {
      checks.push({
        layer: "organization",
        dimension,
        decision: "deny",
        reason_code: "INVALID_OPERATION_CONTEXT",
        message,
      });
    };
    for (const metric of BUDGET_METRICS) {
      const value = operation.projected_usage[metric];
      if (!Number.isSafeInteger(value) || value < 0) invalid("budget", `Projected ${metric} usage must be a non-negative safe integer.`);
    }
    if (
      operation.command !== undefined &&
      (!Number.isSafeInteger(operation.command.timeout_ms) || operation.command.timeout_ms < 1)
    ) {
      invalid("command", "Resolved command timeout must be a positive safe integer.");
    }
    if (operation.disclosure !== undefined) {
      if (!isNonNegativeInteger(operation.disclosure.byte_count) || !isNonNegativeInteger(operation.disclosure.file_count)) {
        invalid("disclosure", "Disclosure byte and file counts must be non-negative safe integers.");
      }
    }
    if (operation.network !== undefined) {
      const normalizedHosts = operation.network.hosts.map((host) => host.trim().toLowerCase());
      if (
        (operation.network.required && normalizedHosts.length === 0) ||
        (!operation.network.required && normalizedHosts.length > 0) ||
        normalizedHosts.some((host) => host.length === 0) ||
        new Set(normalizedHosts).size !== normalizedHosts.length
      ) {
        invalid("network", "Network metadata must name unique hosts when required and no hosts when network is disabled.");
      }
    }
    if (operation.change !== undefined) {
      const change = operation.change;
      if (
        !isNonNegativeInteger(change.files_changed) ||
        !isNonNegativeInteger(change.changed_lines) ||
        !isNonNegativeInteger(change.creates) ||
        !isNonNegativeInteger(change.deletes)
      ) {
        invalid("change", "Change counts must be non-negative safe integers.");
      }
    }
    if (operation.tool === "apply_patch" && operation.change !== undefined) {
      const mutationPaths = operation.paths?.filter((path) => path.access !== "read") ?? [];
      const uniquePaths = new Set(
        mutationPaths.map((path) => {
          const normalized = normalizeRepositoryPath(path.path);
          return normalized === undefined ? `invalid:${path.path}` : this.repositoryPathKey(normalized);
        }),
      );
      const creates = mutationPaths.filter((path) => path.access === "create").length;
      const deletes = mutationPaths.filter((path) => path.access === "delete").length;
      if (
        mutationPaths.length !== (operation.paths?.length ?? 0) ||
        uniquePaths.size !== mutationPaths.length ||
        operation.change.files_changed !== uniquePaths.size ||
        operation.change.creates !== creates ||
        operation.change.deletes !== deletes
      ) {
        invalid("change", "apply_patch path inventory and deterministic change counts do not agree.");
      }
    }
  }

  private evaluatePath(path: string, access: PathAccess, layers: readonly LayerView[], checks: PolicyCheck[]): void {
    const normalized = normalizeRepositoryPath(path);
    if (normalized === undefined) {
      checks.push({
        layer: "organization",
        dimension: "path",
        decision: "deny",
        reason_code: "INVALID_REPOSITORY_PATH",
        message: `Path '${path}' is absolute, traverses upward, or is otherwise invalid.`,
        resource: path,
      });
      return;
    }
    for (const layer of layers) {
      const policy = layer.capabilities.paths;
      if (access !== "read" && this.matchesRepositoryPath(normalized, policy?.protected)) {
        checks.push({
          layer: layer.layer,
          dimension: "path",
          decision: "deny",
          reason_code: "PATH_PROTECTED",
          message: `${layer.layer} policy protects '${normalized}' from mutation.`,
          resource: normalized,
        });
        continue;
      }
      if (this.matchesRepositoryPath(normalized, policy?.excluded)) {
        checks.push({
          layer: layer.layer,
          dimension: "path",
          decision: "deny",
          reason_code: "PATH_EXCLUDED",
          message: `${layer.layer} policy excludes '${normalized}' from access and disclosure.`,
          resource: normalized,
        });
        continue;
      }
      const rules = policy?.[access] ?? (access === "create" || access === "delete" ? policy?.write : undefined);
      const result = decideRule(
        rules,
        normalized,
        layer.defaultDecision,
        (value, pattern) => this.matchesRepositoryPathPattern(value, pattern),
      );
      checks.push(
        this.resolveCheck({
          layer: layer.layer,
          dimension: "path",
          decision: result,
          askCode: "PATH_REQUIRES_APPROVAL",
          denyCode: "PATH_NOT_GRANTED",
          askMessage: `${layer.layer} policy requires approval for ${access} access to '${normalized}'.`,
          denyMessage: `${layer.layer} policy does not grant ${access} access to '${normalized}'.`,
          capabilityKey: `path:${access}:${this.repositoryPathKey(normalized)}`,
          resource: normalized,
        }),
      );
    }
  }

  private evaluateCommand(operation: PolicyOperation, layers: readonly LayerView[], checks: PolicyCheck[]): void {
    const command = operation.command;
    if (command === undefined) return;
    for (const layer of layers) {
      const policy = layer.capabilities.commands;
      this.addCommandRuleCheck(layer, "id", command.id, policy?.ids, checks);
      this.addCommandRuleCheck(layer, "category", command.category, policy?.categories, checks);
      const riskDecision = policy?.risks?.[command.risk] ?? layer.defaultDecision;
      checks.push(
        this.resolveCheck({
          layer: layer.layer,
          dimension: "command",
          decision: riskDecision,
          askCode: "COMMAND_RISK_REQUIRES_APPROVAL",
          denyCode: "COMMAND_RISK_NOT_GRANTED",
          askMessage: `${layer.layer} policy requires approval for ${command.risk}-risk command '${command.id}'.`,
          denyMessage: `${layer.layer} policy denies ${command.risk}-risk command '${command.id}'.`,
          capabilityKey: `command:${command.id}`,
          resource: command.id,
        }),
      );
      if (command.side_effects) {
        const sideEffectDecision = policy?.side_effects ?? layer.defaultDecision;
        checks.push(
          this.resolveCheck({
            layer: layer.layer,
            dimension: "command",
            decision: sideEffectDecision,
            askCode: "COMMAND_SIDE_EFFECT_REQUIRES_APPROVAL",
            denyCode: "COMMAND_SIDE_EFFECT_NOT_GRANTED",
            askMessage: `${layer.layer} policy requires approval for command side effects.`,
            denyMessage: `${layer.layer} policy denies command side effects.`,
            capabilityKey: `command:${command.id}`,
            resource: command.id,
          }),
        );
      }
      if (policy?.max_timeout_ms !== undefined && command.timeout_ms > policy.max_timeout_ms) {
        checks.push({
          layer: layer.layer,
          dimension: "command",
          decision: "deny",
          reason_code: "COMMAND_TIMEOUT_EXCEEDED",
          message: `Command timeout ${command.timeout_ms}ms exceeds ${layer.layer} limit ${policy.max_timeout_ms}ms.`,
          resource: command.id,
        });
      }
    }
  }

  private addCommandRuleCheck(
    layer: LayerView,
    kind: "id" | "category",
    value: string,
    rules: RuleSet<string> | undefined,
    checks: PolicyCheck[],
  ): void {
    const result = decideRule(rules, value, layer.defaultDecision, matchPolicyPattern);
    const category = kind === "category";
    checks.push(
      this.resolveCheck({
        layer: layer.layer,
        dimension: "command",
        decision: result,
        askCode: category ? "COMMAND_CATEGORY_REQUIRES_APPROVAL" : "COMMAND_REQUIRES_APPROVAL",
        denyCode: category ? "COMMAND_CATEGORY_NOT_GRANTED" : "COMMAND_NOT_GRANTED",
        askMessage: `${layer.layer} policy requires approval for command ${kind} '${value}'.`,
        denyMessage: `${layer.layer} policy does not grant command ${kind} '${value}'.`,
        capabilityKey: category ? `command-category:${value.toLowerCase()}` : `command:${value}`,
        resource: value,
      }),
    );
  }

  private evaluateDisclosure(operation: PolicyOperation, layers: readonly LayerView[], checks: PolicyCheck[]): void {
    const disclosure = operation.disclosure;
    if (disclosure === undefined) return;
    if (disclosure.contains_secret) {
      checks.push({
        layer: "organization",
        dimension: "disclosure",
        decision: "deny",
        reason_code: "SECRET_DISCLOSURE_DENIED",
        message: "Detected secrets or credential-equivalent material cannot be submitted to the model.",
        resource: disclosure.classification,
      });
    }
    for (const layer of layers) {
      const policy = layer.capabilities.disclosure;
      const result = decideRule(
        policy?.classifications,
        disclosure.classification,
        layer.defaultDecision,
        matchPolicyPattern,
      );
      checks.push(
        this.resolveCheck({
          layer: layer.layer,
          dimension: "disclosure",
          decision: result,
          askCode: "DISCLOSURE_CLASSIFICATION_REQUIRES_APPROVAL",
          denyCode: "DISCLOSURE_CLASSIFICATION_DENIED",
          askMessage: `${layer.layer} policy requires approval to disclose '${disclosure.classification}' content.`,
          denyMessage: `${layer.layer} policy denies disclosure of '${disclosure.classification}' content.`,
          capabilityKey: `disclosure:${disclosure.classification.toLowerCase()}`,
          resource: disclosure.classification,
        }),
      );
      if (
        (policy?.max_bytes_per_operation !== undefined && disclosure.byte_count > policy.max_bytes_per_operation) ||
        (policy?.max_files_per_operation !== undefined && disclosure.file_count > policy.max_files_per_operation)
      ) {
        const decision = layer.capabilities.budget_exceeded ?? (layer.layer === "session" ? "ask" : "deny");
        checks.push(
          this.resolveCheck({
            layer: layer.layer,
            dimension: "disclosure",
            decision,
            askCode: "DISCLOSURE_OPERATION_LIMIT_EXCEEDED",
            denyCode: "DISCLOSURE_OPERATION_LIMIT_EXCEEDED",
            askMessage: `${layer.layer} per-operation disclosure limit would be exceeded.`,
            denyMessage: `${layer.layer} per-operation disclosure limit would be exceeded.`,
            capabilityKey: "budget:disclosed_bytes",
          }),
        );
      }
    }
  }

  private evaluateNetwork(operation: PolicyOperation, layers: readonly LayerView[], checks: PolicyCheck[]): void {
    const network = operation.network;
    if (network === undefined || !network.required) return;
    for (const layer of layers) {
      const policy = layer.capabilities.network;
      const accessDecision = policy?.access ?? layer.defaultDecision;
      checks.push(
        this.resolveCheck({
          layer: layer.layer,
          dimension: "network",
          decision: accessDecision,
          askCode: "NETWORK_REQUIRES_APPROVAL",
          denyCode: "NETWORK_DENIED",
          askMessage: `${layer.layer} policy requires approval for network access.`,
          denyMessage: `${layer.layer} policy denies network access.`,
          capabilityKey: "network:*",
        }),
      );
      for (const host of network.hosts) {
        const hostDecision = decideRule(policy?.hosts, host, accessDecision, matchPolicyPattern);
        checks.push(
          this.resolveCheck({
            layer: layer.layer,
            dimension: "network",
            decision: hostDecision,
            askCode: "NETWORK_HOST_REQUIRES_APPROVAL",
            denyCode: "NETWORK_HOST_DENIED",
            askMessage: `${layer.layer} policy requires approval for network host '${host}'.`,
            denyMessage: `${layer.layer} policy denies network host '${host}'.`,
            capabilityKey: `network:${host.toLowerCase()}`,
            resource: host,
          }),
        );
      }
    }
  }

  private evaluateChange(operation: PolicyOperation, layers: readonly LayerView[], checks: PolicyCheck[]): void {
    const change = operation.change;
    if (change === undefined) return;
    for (const layer of layers) {
      const policy = layer.capabilities.changes;
      if (change.creates > 0) this.addChangeCheck(layer, "create_file", policy?.create_files, checks);
      if (change.deletes > 0) this.addChangeCheck(layer, "delete_file", policy?.delete_files, checks);
      if (change.dependency_manifest) {
        this.addChangeCheck(layer, "dependency_manifest", policy?.dependency_manifests, checks);
      }
      if (change.local_commit) this.addChangeCheck(layer, "local_commit", policy?.local_commits, checks);
      if (
        (policy?.max_files_per_operation !== undefined && change.files_changed > policy.max_files_per_operation) ||
        (policy?.max_changed_lines_per_operation !== undefined &&
          change.changed_lines > policy.max_changed_lines_per_operation)
      ) {
        const decision = policy.on_limit_exceeded ?? (layer.layer === "session" ? "ask" : "deny");
        checks.push(
          this.resolveCheck({
            layer: layer.layer,
            dimension: "change",
            decision,
            askCode: "CHANGE_OPERATION_LIMIT_EXCEEDED",
            denyCode: "CHANGE_OPERATION_LIMIT_EXCEEDED",
            askMessage: `${layer.layer} per-operation change limit would be exceeded.`,
            denyMessage: `${layer.layer} per-operation change limit would be exceeded.`,
            capabilityKey: "budget:changed_lines",
          }),
        );
      }
    }
  }

  private addChangeCheck(
    layer: LayerView,
    change: "create_file" | "delete_file" | "dependency_manifest" | "local_commit",
    configured: PolicyDecision | undefined,
    checks: PolicyCheck[],
  ): void {
    const decision = configured ?? layer.defaultDecision;
    const labels = {
      create_file: ["CREATE_FILE_REQUIRES_APPROVAL", "CREATE_FILE_DENIED", "file creation"],
      delete_file: ["DELETE_FILE_REQUIRES_APPROVAL", "DELETE_FILE_DENIED", "file deletion"],
      dependency_manifest: ["DEPENDENCY_CHANGE_REQUIRES_APPROVAL", "DEPENDENCY_CHANGE_DENIED", "dependency changes"],
      local_commit: ["LOCAL_COMMIT_REQUIRES_APPROVAL", "LOCAL_COMMIT_DENIED", "local commits"],
    } as const;
    const [askCode, denyCode, label] = labels[change];
    checks.push(
      this.resolveCheck({
        layer: layer.layer,
        dimension: "change",
        decision,
        askCode,
        denyCode,
        askMessage: `${layer.layer} policy requires approval for ${label}.`,
        denyMessage: `${layer.layer} policy denies ${label}.`,
        capabilityKey: `change:${change}`,
        resource: change,
      }),
    );
  }

  private evaluateBudgets(operation: PolicyOperation, layers: readonly LayerView[], checks: PolicyCheck[]): void {
    for (const layer of layers) {
      for (const metric of BUDGET_METRICS) {
        const limit = layer.capabilities.budgets?.[metric];
        if (limit === undefined || operation.projected_usage[metric] <= limit) continue;
        const decision = layer.capabilities.budget_exceeded ?? (layer.layer === "session" ? "ask" : "deny");
        checks.push(
          this.resolveCheck({
            layer: layer.layer,
            dimension: "budget",
            decision,
            askCode: "BUDGET_EXCEEDED",
            denyCode: "BUDGET_EXCEEDED",
            askMessage: `${layer.layer} ${metric} budget ${limit} would be exceeded by projected usage ${operation.projected_usage[metric]}.`,
            denyMessage: `${layer.layer} ${metric} budget ${limit} would be exceeded by projected usage ${operation.projected_usage[metric]}.`,
            capabilityKey: `budget:${metric}`,
            resource: metric,
          }),
        );
      }
    }
  }

  private resolveCheck(input: CheckInput): PolicyCheck {
    if (input.decision === "ask" && input.capabilityKey !== undefined && this.isApproved(input.capabilityKey)) {
      return optionalCheckFields({
        layer: input.layer,
        dimension: input.dimension,
        decision: "allow",
        reason_code: "CAPABILITY_APPROVED_FOR_SESSION",
        message: `Session approval '${input.capabilityKey}' satisfies this policy escalation.`,
        capabilityKey: input.capabilityKey,
        ...(input.resource === undefined ? {} : { resource: input.resource }),
      });
    }
    return optionalCheckFields({
      layer: input.layer,
      dimension: input.dimension,
      decision: input.decision,
      reason_code:
        input.decision === "allow" ? (input.allowCode ?? "ALLOWED") : input.decision === "ask" ? input.askCode : input.denyCode,
      message:
        input.decision === "allow"
          ? (input.allowMessage ?? `${input.layer} policy allows this ${input.dimension}.`)
          : input.decision === "ask"
            ? input.askMessage
            : input.denyMessage,
      ...(input.capabilityKey === undefined ? {} : { capabilityKey: input.capabilityKey }),
      ...(input.resource === undefined ? {} : { resource: input.resource }),
    });
  }

  private isApproved(key: string): boolean {
    if (key.startsWith("path:")) {
      return this.session.approved_capabilities.some((approval) => approval.key === key);
    }
    const normalized = key.toLowerCase();
    return this.session.approved_capabilities.some(
      (approval) => approval.key.toLowerCase() === normalized || approval.key === "network:*" && key.startsWith("network:"),
    );
  }

  private matchesRepositoryPath(value: string, patterns: readonly string[] | undefined): boolean {
    return patterns?.some((pattern) => this.matchesRepositoryPathPattern(value, pattern)) === true;
  }

  private matchesRepositoryPathPattern(value: string, pattern: string): boolean {
    return matchPolicyPattern(this.repositoryPathKey(value), this.repositoryPathKey(pattern), true);
  }

  private finish(checks: readonly PolicyCheck[]): EffectivePolicy {
    let decision: PolicyDecision = "allow";
    for (const check of checks) {
      if (POLICY_DECISION_WEIGHT[check.decision] > POLICY_DECISION_WEIGHT[decision]) decision = check.decision;
    }
    return {
      decision,
      checks,
      reasons: checks.filter((check) => check.decision !== "allow"),
      effective_budget_limits: this.getEffectiveBudgetLimits(),
    };
  }
}

function decideRule<T extends string>(
  rules: RuleSet<T> | undefined,
  value: T,
  defaultDecision: PolicyDecision,
  matcher: (value: string, pattern: string) => boolean,
): PolicyDecision {
  if (rules?.deny?.some((pattern) => matcher(value, pattern)) === true) return "deny";
  if (rules?.ask?.some((pattern) => matcher(value, pattern)) === true) return "ask";
  if (rules?.allow?.some((pattern) => matcher(value, pattern)) === true) return "allow";
  return rules?.unmatched ?? defaultDecision;
}

function optionalCheckFields(input: {
  readonly layer: PolicyLayer;
  readonly dimension: PolicyCheck["dimension"];
  readonly decision: PolicyDecision;
  readonly reason_code: PolicyReasonCode;
  readonly message: string;
  readonly capabilityKey?: string;
  readonly resource?: string;
}): PolicyCheck {
  return {
    layer: input.layer,
    dimension: input.dimension,
    decision: input.decision,
    reason_code: input.reason_code,
    message: input.message,
    ...(input.capabilityKey === undefined ? {} : { capability_key: input.capabilityKey }),
    ...(input.resource === undefined ? {} : { resource: input.resource }),
  };
}

function expandGrant(
  organization: PolicyDocument,
  repository: PolicyDocument,
  session: SessionGrant,
  expansion: SessionCapabilityExpansion,
  grantedAt: string,
  pathKey: (value: string) => string,
): SessionExpansionResult {
  const capabilityKey = expansionKey(expansion, pathKey);
  const reasons: PolicyCheck[] = [];
  const higherLayers: readonly LayerView[] = [
    { layer: "organization", defaultDecision: organization.default_decision, capabilities: organization.capabilities },
    { layer: "repository", defaultDecision: repository.default_decision, capabilities: repository.capabilities },
  ];

  const expansionInvalid =
    (expansion.kind === "tool" && !(TOOL_NAMES as readonly string[]).includes(expansion.tool)) ||
    (expansion.kind === "command" &&
      (expansion.command_id.trim().length === 0 || expansion.category.trim().length === 0)) ||
    (expansion.kind === "disclosure" && expansion.classification.trim().length === 0) ||
    (expansion.kind === "network" && expansion.host !== undefined && expansion.host.trim().length === 0) ||
    (expansion.kind === "budget" &&
      (!Number.isSafeInteger(expansion.requested_limit) || expansion.requested_limit < 1));
  if (expansionInvalid) {
    reasons.push({
      layer: "organization",
      dimension: expansionDimension(expansion),
      decision: "deny",
      reason_code: "CAPABILITY_EXPANSION_DENIED",
      message: `Capability expansion '${capabilityKey}' is structurally invalid.`,
      capability_key: capabilityKey,
    });
  }

  if (session.mode === "inspect" && expansion.kind === "path" && expansion.access !== "read") {
    reasons.push({
      layer: "session",
      dimension: "mode",
      decision: "deny",
      reason_code: "MODE_INSPECT_WRITE_DENIED",
      message: "Inspect mode cannot be expanded to include repository mutation; select another mode explicitly.",
      capability_key: capabilityKey,
    });
  }

  for (const layer of higherLayers) {
    const decision = expansionDecision(layer, expansion, pathKey);
    if (decision === "allow") continue;
    reasons.push({
      layer: layer.layer,
      dimension: expansionDimension(expansion),
      decision,
      reason_code: decision === "deny" ? "CAPABILITY_EXPANSION_DENIED" : "CAPABILITY_EXPANSION_REQUIRES_APPROVAL",
      message:
        decision === "deny"
          ? `${layer.layer} policy does not permit expansion '${capabilityKey}'.`
          : `${layer.layer} policy permits expansion '${capabilityKey}' only with explicit session approval.`,
      capability_key: capabilityKey,
    });
  }

  const decision = reasons.some((reason) => reason.decision === "deny")
    ? "deny"
    : reasons.some((reason) => reason.decision === "ask")
      ? "ask"
      : "allow";
  if (decision === "deny") return { decision, grant: session, reasons, capability_key: capabilityKey };

  const grant = applyExpansion(session, expansion, capabilityKey, grantedAt);
  assertValidSessionGrant(grant);
  return { decision, grant, reasons, capability_key: capabilityKey };
}

function expansionDecision(
  layer: LayerView,
  expansion: SessionCapabilityExpansion,
  pathKey: (value: string) => string,
): PolicyDecision {
  const capabilities = layer.capabilities;
  switch (expansion.kind) {
    case "tool":
      return decideRule(capabilities.tools, expansion.tool, layer.defaultDecision, (value, pattern) => value === pattern);
    case "path": {
      const normalized = normalizeRepositoryPath(expansion.path);
      if (normalized === undefined) return "deny";
      const matchesPath = (value: string, pattern: string): boolean =>
        matchPolicyPattern(pathKey(value), pathKey(pattern), true);
      if (capabilities.paths?.excluded?.some((pattern) => matchesPath(normalized, pattern)) === true) return "deny";
      if (
        expansion.access !== "read" &&
        capabilities.paths?.protected?.some((pattern) => matchesPath(normalized, pattern)) === true
      ) return "deny";
      const rules =
        capabilities.paths?.[expansion.access] ??
        (expansion.access === "create" || expansion.access === "delete" ? capabilities.paths?.write : undefined);
      return decideRule(rules, normalized, layer.defaultDecision, matchesPath);
    }
    case "command": {
      const id = decideRule(capabilities.commands?.ids, expansion.command_id, layer.defaultDecision, matchPolicyPattern);
      const category = decideRule(
        capabilities.commands?.categories,
        expansion.category,
        layer.defaultDecision,
        matchPolicyPattern,
      );
      const risk = capabilities.commands?.risks?.[expansion.risk] ?? layer.defaultDecision;
      return strictest([id, category, risk]);
    }
    case "disclosure":
      return decideRule(
        capabilities.disclosure?.classifications,
        expansion.classification,
        layer.defaultDecision,
        matchPolicyPattern,
      );
    case "network": {
      const access = capabilities.network?.access ?? layer.defaultDecision;
      if (expansion.host === undefined) return access;
      return strictest([
        access,
        decideRule(capabilities.network?.hosts, expansion.host, access, matchPolicyPattern),
      ]);
    }
    case "change": {
      const configured = {
        create_file: capabilities.changes?.create_files,
        delete_file: capabilities.changes?.delete_files,
        dependency_manifest: capabilities.changes?.dependency_manifests,
        local_commit: capabilities.changes?.local_commits,
      }[expansion.change];
      return configured ?? layer.defaultDecision;
    }
    case "budget": {
      const limit = capabilities.budgets?.[expansion.metric];
      return limit !== undefined && expansion.requested_limit > limit ? "deny" : "allow";
    }
  }
}

function applyExpansion(
  session: SessionGrant,
  expansion: SessionCapabilityExpansion,
  capabilityKey: string,
  grantedAt: string,
): SessionGrant {
  const capabilities = structuredClone(session.capabilities) as MutableCapabilities;
  switch (expansion.kind) {
    case "tool":
      capabilities.tools = addAllowed(capabilities.tools, expansion.tool);
      break;
    case "path": {
      capabilities.paths ??= {};
      capabilities.paths[expansion.access] = addAllowed(capabilities.paths[expansion.access], expansion.path);
      break;
    }
    case "command":
      capabilities.commands ??= {};
      capabilities.commands.ids = addAllowed(capabilities.commands.ids, expansion.command_id);
      capabilities.commands.categories = addAllowed(capabilities.commands.categories, expansion.category);
      capabilities.commands.risks = { ...capabilities.commands.risks, [expansion.risk]: "allow" };
      break;
    case "disclosure":
      capabilities.disclosure ??= {};
      capabilities.disclosure.classifications = addAllowed(
        capabilities.disclosure.classifications,
        expansion.classification,
      );
      break;
    case "network":
      capabilities.network ??= {};
      capabilities.network.access = "allow";
      if (expansion.host !== undefined) capabilities.network.hosts = addAllowed(capabilities.network.hosts, expansion.host);
      break;
    case "change":
      capabilities.changes ??= {};
      if (expansion.change === "create_file") capabilities.changes.create_files = "allow";
      if (expansion.change === "delete_file") capabilities.changes.delete_files = "allow";
      if (expansion.change === "dependency_manifest") capabilities.changes.dependency_manifests = "allow";
      if (expansion.change === "local_commit") capabilities.changes.local_commits = "allow";
      break;
    case "budget":
      capabilities.budgets = { ...capabilities.budgets, [expansion.metric]: expansion.requested_limit };
      break;
  }
  const approvals = session.approved_capabilities.some((approval) => approval.key === capabilityKey)
    ? session.approved_capabilities
    : [...session.approved_capabilities, { key: capabilityKey, granted_at: grantedAt }];
  return { ...session, capabilities: capabilities as PolicyCapabilities, approved_capabilities: approvals };
}

type MutableRuleSet = {
  allow?: string[];
  ask?: string[];
  deny?: string[];
  unmatched?: PolicyDecision;
};
type MutableCapabilities = {
  tools?: MutableRuleSet;
  paths?: Partial<Record<PathAccess, MutableRuleSet>> & { excluded?: string[]; protected?: string[] };
  commands?: {
    ids?: MutableRuleSet;
    categories?: MutableRuleSet;
    risks?: Partial<Record<"low" | "medium" | "high", PolicyDecision>>;
    side_effects?: PolicyDecision;
    max_timeout_ms?: number;
  };
  disclosure?: {
    classifications?: MutableRuleSet;
    secrets?: "deny";
    max_bytes_per_operation?: number;
    max_files_per_operation?: number;
  };
  network?: { access?: PolicyDecision; hosts?: MutableRuleSet };
  changes?: {
    create_files?: PolicyDecision;
    delete_files?: PolicyDecision;
    dependency_manifests?: PolicyDecision;
    local_commits?: PolicyDecision;
    max_files_per_operation?: number;
    max_changed_lines_per_operation?: number;
    on_limit_exceeded?: "ask" | "deny";
  };
  budgets?: Partial<Record<BudgetMetric, number>>;
  budget_exceeded?: "ask" | "deny";
};

function addAllowed(rules: RuleSet<string> | MutableRuleSet | undefined, value: string): MutableRuleSet {
  const allow = [...(rules?.allow ?? [])];
  if (!allow.some((item) => item.toLowerCase() === value.toLowerCase())) allow.push(value);
  const sameValue = (item: string): boolean => item.toLowerCase() === value.toLowerCase();
  return {
    allow,
    ...(rules?.ask === undefined ? {} : { ask: rules.ask.filter((item) => !sameValue(item)) }),
    ...(rules?.deny === undefined ? {} : { deny: rules.deny.filter((item) => !sameValue(item)) }),
    ...(rules?.unmatched === undefined ? {} : { unmatched: rules.unmatched }),
  };
}

function expansionKey(expansion: SessionCapabilityExpansion, pathKey: (value: string) => string): string {
  switch (expansion.kind) {
    case "tool":
      return `tool:${expansion.tool}`;
    case "path": {
      const normalized = normalizeRepositoryPath(expansion.path) ?? expansion.path.replaceAll("\\", "/");
      return `path:${expansion.access}:${pathKey(normalized)}`;
    }
    case "command":
      return `command:${expansion.command_id}`;
    case "disclosure":
      return `disclosure:${expansion.classification.toLowerCase()}`;
    case "network":
      return expansion.host === undefined ? "network:*" : `network:${expansion.host.toLowerCase()}`;
    case "change":
      return `change:${expansion.change}`;
    case "budget":
      return `budget:${expansion.metric}`;
  }
}

function expansionDimension(expansion: SessionCapabilityExpansion): PolicyCheck["dimension"] {
  if (expansion.kind === "tool") return "tool";
  if (expansion.kind === "path") return "path";
  if (expansion.kind === "command") return "command";
  if (expansion.kind === "disclosure") return "disclosure";
  if (expansion.kind === "network") return "network";
  if (expansion.kind === "change") return "change";
  return "budget";
}

function strictest(decisions: readonly PolicyDecision[]): PolicyDecision {
  return decisions.reduce<PolicyDecision>((current, candidate) =>
    POLICY_DECISION_WEIGHT[candidate] > POLICY_DECISION_WEIGHT[current] ? candidate : current,
  "allow");
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
