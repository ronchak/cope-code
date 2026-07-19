import { readFile } from "node:fs/promises";
import {
  PolicyEngine,
  normalizeRepositoryPath,
  type BudgetUsage as PolicyBudgetUsage,
  type EffectivePolicy,
  type PolicyOperation,
  type SessionCapabilityExpansion,
  type SessionGrant,
} from "../policy/index.js";
import { BUDGET_METRICS, TOOL_NAMES } from "../protocol/index.js";
import type { RepositoryBoundary } from "../repository/boundary.js";
import type { RepositoryReadOperation } from "../repository/repository-tools.js";
import { AgentError, errorMessage } from "../shared/errors.js";
import type { CommandCatalog } from "../tools/command-catalog.js";
import type {
  AuthorizationDecision,
  NormalizedToolCall,
  RuntimePolicy,
} from "./contracts.js";

export interface LayeredRuntimePolicyOptions {
  readonly engine: PolicyEngine;
  readonly boundary: RepositoryBoundary;
  readonly commandCatalog: CommandCatalog;
  readonly currentUsage: () => PolicyBudgetUsage;
  readonly classification?: string;
  readonly defaultReadBytes?: number;
  readonly defaultSearchBytes?: number;
  readonly defaultDiffBytes?: number;
  readonly persistGrant?: (grant: SessionGrant) => Promise<void>;
}

export class LayeredRuntimePolicy implements RuntimePolicy {
  private engineValue: PolicyEngine;
  private readonly classification: string;

  public constructor(private readonly options: LayeredRuntimePolicyOptions) {
    this.engineValue = options.engine;
    this.classification = options.classification ?? "internal";
  }

  public get sessionGrant(): SessionGrant {
    return this.engineValue.session;
  }

  public summarize(): Readonly<Record<string, unknown>> {
    const grant = this.engineValue.session;
    return {
      mode: grant.mode,
      tools: grant.capabilities.tools?.allow ?? [],
      readable_paths: grant.capabilities.paths?.read?.allow ?? [],
      writable_paths: grant.capabilities.paths?.write?.allow ?? [],
      protected_paths: unique([
        ...(this.engineValue.organization.capabilities.paths?.protected ?? []),
        ...(this.engineValue.repository.capabilities.paths?.protected ?? []),
      ]),
      command_ids: grant.capabilities.commands?.ids?.allow ?? [],
      disclosure_classifications: grant.capabilities.disclosure?.classifications?.allow ?? [],
      network: grant.capabilities.network?.access ?? "deny",
      notes: [
        "Organization, repository, and session rules are combined using the most restrictive decision.",
        "Detected secrets are blocked again on the fully serialized browser submission.",
      ],
    };
  }

  public async authorize(call: NormalizedToolCall): Promise<AuthorizationDecision> {
    try {
      const operation = await this.buildOperation(call, false);
      const preliminary = this.engineValue.evaluate(operation);
      if (preliminary.decision !== "allow" || call.name !== "apply_patch") {
        return decisionFor(preliminary, call, this.options.commandCatalog, operation);
      }
      // Exact line accounting requires local before-images. It is performed
      // only after all higher-layer path and change-kind checks allow access.
      const exact = await this.buildOperation(call, true);
      return decisionFor(this.engineValue.evaluate(exact), call, this.options.commandCatalog, exact);
    } catch (error) {
      return {
        outcome: "deny",
        reasonCode: error instanceof AgentError ? error.code : "OPERATION_CONTEXT_INVALID",
        explanation: errorMessage(error),
      };
    }
  }

  public async expandSessionGrant(capability: Readonly<Record<string, unknown>>): Promise<boolean> {
    const expansions = parseExpansions(capability, this.options.commandCatalog);
    if (expansions.length === 0) return false;

    let engine = this.engineValue;
    let grant = engine.session;
    for (const expansion of expansions) {
      const result = engine.expandSessionGrant(expansion);
      if (result.decision === "deny") return false;
      grant = result.grant;
      engine = new PolicyEngine({
        organization: engine.organization,
        repository: engine.repository,
        session: grant,
        pathKey: this.options.boundary.pathKey.bind(this.options.boundary),
      });
    }
    await this.options.persistGrant?.(grant);
    this.engineValue = engine;
    return true;
  }

  public isPathInScope(path: string): boolean {
    const normalized = normalizeRepositoryPath(path);
    if (normalized === undefined) return false;
    const operation: PolicyOperation = {
      tool: "apply_patch",
      paths: [{ path: normalized, access: "write" }],
      change: {
        files_changed: 1,
        changed_lines: 0,
        creates: 0,
        deletes: 0,
        dependency_manifest: false,
        local_commit: false,
      },
      projected_usage: this.options.currentUsage(),
    };
    return this.engineValue.evaluate(operation).decision === "allow";
  }

  /**
   * Fail-closed exact-path check used by deterministic repository adapters
   * after a broader list/search/Git request has already been authorized.
   */
  public isReadPathAllowed(tool: RepositoryReadOperation, path: string): boolean {
    const normalized = normalizeRepositoryPath(path);
    if (normalized === undefined) return false;
    const operation: PolicyOperation = {
      tool,
      paths: [{ path: normalized, access: "read" }],
      projected_usage: this.options.currentUsage(),
    };
    return this.engineValue.evaluate(operation).decision === "allow";
  }

  private async buildOperation(call: NormalizedToolCall, exactPatchLines: boolean): Promise<PolicyOperation> {
    const usage = { ...this.options.currentUsage() };
    const paths = pathFacts(call);
    let disclosure: PolicyOperation["disclosure"];
    let command: PolicyOperation["command"];
    let network: PolicyOperation["network"];
    let change: PolicyOperation["change"];

    if (call.name === "read_file") {
      const byteCount = positiveInteger(call.arguments.max_bytes) ?? this.options.defaultReadBytes ?? 128 * 1024;
      disclosure = disclosureFact(this.classification, byteCount, 1);
      usage.read_files += 1;
      usage.disclosed_bytes += byteCount;
    } else if (call.name === "search_text") {
      const byteCount = this.options.defaultSearchBytes ?? 128 * 1024;
      disclosure = disclosureFact(this.classification, byteCount, 1);
      usage.disclosed_bytes += byteCount;
    } else if (call.name === "list_files") {
      const fileCount = positiveInteger(call.arguments.max_results) ?? 500;
      const byteCount = Math.min(fileCount * 256, 128 * 1024);
      disclosure = disclosureFact(this.classification, byteCount, fileCount);
      usage.disclosed_bytes += byteCount;
    } else if (call.name === "git_diff") {
      const byteCount = positiveInteger(call.arguments.max_bytes) ?? this.options.defaultDiffBytes ?? 256 * 1024;
      disclosure = disclosureFact(this.classification, byteCount, 1);
      usage.disclosed_bytes += byteCount;
    } else if (call.name === "git_status") {
      disclosure = disclosureFact(this.classification, 64 * 1024, 1);
      usage.disclosed_bytes += 64 * 1024;
    } else if (call.name === "run_command") {
      const commandId = requiredString(call.arguments.command_id, "command_id");
      const requestedTimeout = positiveInteger(call.arguments.timeout_ms);
      const resolved = this.options.commandCatalog.resolve({
        command_id: commandId,
        ...(isRecord(call.arguments.parameters) ? { parameters: call.arguments.parameters as never } : {}),
        ...(requestedTimeout === undefined ? {} : { timeout_ms: requestedTimeout }),
      });
      command = {
        id: resolved.id,
        category: resolved.category,
        risk: resolved.risk,
        side_effects: resolved.sideEffects,
        timeout_ms: resolved.timeoutMs,
      };
      network = { required: resolved.networkRequired, hosts: resolved.networkHosts };
      disclosure = disclosureFact(this.classification, resolved.maxOutputBytes, 1);
      usage.commands += 1;
      usage.command_output_bytes += resolved.maxOutputBytes;
      usage.disclosed_bytes += resolved.maxOutputBytes;
    } else if (call.name === "apply_patch") {
      const changes = patchChanges(call.arguments.changes);
      const changedLines = exactPatchLines ? await this.countExactChangedLines(changes) : 0;
      change = {
        files_changed: changes.length,
        changed_lines: changedLines,
        creates: changes.filter((entry) => entry.kind === "create").length,
        deletes: changes.filter((entry) => entry.kind === "delete").length,
        dependency_manifest: changes.some((entry) => isDependencyManifest(entry.path)),
        local_commit: false,
      };
      usage.changed_files += changes.length;
      usage.changed_lines += changedLines;
    }

    return {
      tool: call.name,
      ...(paths.length === 0 ? {} : { paths }),
      ...(command === undefined ? {} : { command }),
      ...(disclosure === undefined ? {} : { disclosure }),
      ...(network === undefined ? {} : { network }),
      ...(change === undefined ? {} : { change }),
      projected_usage: usage,
    };
  }

  private async countExactChangedLines(changes: readonly PatchInput[]): Promise<number> {
    let total = 0;
    for (const change of changes) {
      let before = "";
      if (change.kind !== "create") {
        const existing = await this.options.boundary.resolveExistingFile(change.path);
        before = await readFile(existing.absolutePath, "utf8");
      }
      const after = change.kind === "delete" ? "" : change.content;
      total += countChangedLines(before, after);
    }
    return total;
  }
}

type PatchInput =
  | { readonly kind: "create"; readonly path: string; readonly content: string }
  | { readonly kind: "update"; readonly path: string; readonly content: string }
  | { readonly kind: "delete"; readonly path: string };

function pathFacts(call: NormalizedToolCall): NonNullable<PolicyOperation["paths"]> {
  if (call.name === "list_files" || call.name === "search_text") {
    return [{ path: optionalString(call.arguments.path) ?? ".", access: "read" }];
  }
  if (call.name === "read_file") {
    return [{ path: requiredString(call.arguments.path, "path"), access: "read" }];
  }
  if (call.name === "git_diff" && Array.isArray(call.arguments.paths)) {
    return call.arguments.paths
      .filter((entry): entry is string => typeof entry === "string")
      .map((path) => ({ path, access: "read" as const }));
  }
  if (call.name === "apply_patch") {
    return patchChanges(call.arguments.changes).map((change) => ({
      path: change.path,
      access: change.kind === "create" ? "create" : change.kind === "delete" ? "delete" : "write",
    }));
  }
  return [];
}

function decisionFor(
  policy: EffectivePolicy,
  call: NormalizedToolCall,
  catalog: CommandCatalog,
  operation: PolicyOperation,
): AuthorizationDecision {
  if (policy.decision === "allow") {
    return { outcome: "allow", reasonCode: "ALLOWED", explanation: "Operation is inside the effective grant." };
  }
  const strictReasons = policy.reasons.filter((reason) => reason.decision === policy.decision);
  const primary = strictReasons[0] ?? policy.reasons[0];
  const explanation = strictReasons.map((reason) => reason.message).join(" ") || "Operation is not granted.";
  if (policy.decision === "deny") {
    return {
      outcome: "deny",
      reasonCode: primary?.reason_code ?? "POLICY_DENIED",
      explanation,
    };
  }
  const expansion = expansionFor(primary?.capability_key, call, catalog, operation);
  return {
    outcome: "ask",
    reasonCode: primary?.reason_code ?? "POLICY_ASK",
    explanation,
    capability: {
      key: primary?.capability_key ?? "unknown",
      ...(expansion === undefined ? {} : { expansion }),
    },
  };
}

function expansionFor(
  key: string | undefined,
  call: NormalizedToolCall,
  catalog: CommandCatalog,
  operation: PolicyOperation,
): SessionCapabilityExpansion | undefined {
  if (key === undefined) return undefined;
  if (key.startsWith("tool:")) return { kind: "tool", tool: call.name };
  if (key.startsWith("path:")) {
    const [, access, ...pathParts] = key.split(":");
    if (access === "read" || access === "write" || access === "create" || access === "delete") {
      return { kind: "path", access, path: pathParts.join(":") };
    }
  }
  if (key.startsWith("command:")) {
    const id = key.slice("command:".length);
    const command = catalog.inspect(id);
    if (command) return { kind: "command", command_id: id, category: command.category, risk: command.risk };
  }
  if (key.startsWith("disclosure:")) return { kind: "disclosure", classification: key.slice(11) };
  if (key.startsWith("network:")) {
    const host = key.slice(8);
    return host === "*" ? { kind: "network" } : { kind: "network", host };
  }
  if (key.startsWith("change:")) {
    const change = key.slice(7);
    if (change === "create_file" || change === "delete_file" || change === "dependency_manifest" || change === "local_commit") {
      return { kind: "change", change };
    }
  }
  if (key.startsWith("budget:")) {
    const metric = key.slice(7);
    if ((BUDGET_METRICS as readonly string[]).includes(metric)) {
      return {
        kind: "budget",
        metric: metric as (typeof BUDGET_METRICS)[number],
        requested_limit: operation.projected_usage[metric as (typeof BUDGET_METRICS)[number]],
      };
    }
  }
  return undefined;
}

function parseExpansions(
  capability: Readonly<Record<string, unknown>>,
  catalog: CommandCatalog,
): readonly SessionCapabilityExpansion[] {
  if (isExpansion(capability.expansion)) return [capability.expansion];
  const kind = capability.kind;
  if (kind === "path" && isPathAccess(capability.access) && Array.isArray(capability.paths)) {
    return capability.paths
      .filter((entry): entry is string => typeof entry === "string")
      .map((path) => ({ kind: "path", access: capability.access as never, path }));
  }
  if (kind === "command" && Array.isArray(capability.command_ids)) {
    return capability.command_ids.flatMap((id) => {
      if (typeof id !== "string") return [];
      const command = catalog.inspect(id);
      return command === undefined ? [] : [{ kind: "command" as const, command_id: id, category: command.category, risk: command.risk }];
    });
  }
  if (kind === "tool" && Array.isArray(capability.tools)) {
    return capability.tools
      .filter((tool): tool is NormalizedToolCall["name"] =>
        typeof tool === "string" && (TOOL_NAMES as readonly string[]).includes(tool),
      )
      .map((tool) => ({ kind: "tool", tool }));
  }
  if (kind === "disclosure" && Array.isArray(capability.classifications)) {
    return capability.classifications.filter((value): value is string => typeof value === "string").map((classification) => ({ kind: "disclosure", classification }));
  }
  if (kind === "network") {
    const hosts = Array.isArray(capability.hosts) ? capability.hosts.filter((value): value is string => typeof value === "string") : [];
    return hosts.length === 0 ? [{ kind: "network" }] : hosts.map((host) => ({ kind: "network", host }));
  }
  if (kind === "change" && typeof capability.change === "string") {
    const change = capability.change;
    if (change === "create_file" || change === "delete_file" || change === "dependency_manifest" || change === "local_commit") {
      return [{ kind: "change", change }];
    }
  }
  if (kind === "budget" && typeof capability.metric === "string" && positiveInteger(capability.requested_limit) !== undefined) {
    return [{ kind: "budget", metric: capability.metric as never, requested_limit: capability.requested_limit as number }];
  }
  return [];
}

function isExpansion(value: unknown): value is SessionCapabilityExpansion {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "tool") return typeof value.tool === "string" && (TOOL_NAMES as readonly string[]).includes(value.tool);
  if (value.kind === "path") return isPathAccess(value.access) && typeof value.path === "string";
  if (value.kind === "command") {
    return typeof value.command_id === "string" && typeof value.category === "string" &&
      (value.risk === "low" || value.risk === "medium" || value.risk === "high");
  }
  if (value.kind === "disclosure") return typeof value.classification === "string";
  if (value.kind === "network") return value.host === undefined || typeof value.host === "string";
  if (value.kind === "change") {
    return value.change === "create_file" || value.change === "delete_file" ||
      value.change === "dependency_manifest" || value.change === "local_commit";
  }
  return value.kind === "budget" && typeof value.metric === "string" &&
    (BUDGET_METRICS as readonly string[]).includes(value.metric) && positiveInteger(value.requested_limit) !== undefined;
}

function isPathAccess(value: unknown): value is "read" | "write" | "create" | "delete" {
  return value === "read" || value === "write" || value === "create" || value === "delete";
}

function patchChanges(value: unknown): readonly PatchInput[] {
  if (!Array.isArray(value) || value.length === 0) throw new AgentError("PROTOCOL_INVALID", "Patch changes are required");
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string") throw new AgentError("PROTOCOL_INVALID", "Patch change is invalid");
    if (entry.kind === "delete") return { kind: "delete" as const, path: entry.path };
    if ((entry.kind === "create" || entry.kind === "update") && typeof entry.content === "string") {
      return { kind: entry.kind, path: entry.path, content: entry.content };
    }
    throw new AgentError("PROTOCOL_INVALID", "Patch change kind or content is invalid");
  });
}

function disclosureFact(classification: string, byteCount: number, fileCount: number) {
  return { classification, byte_count: byteCount, file_count: fileCount, contains_secret: false };
}

function countChangedLines(before: string, after: string): number {
  const beforeLines = before === "" ? [] : before.split(/\r?\n/u);
  const afterLines = after === "" ? [] : after.split(/\r?\n/u);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - suffix - 1] === afterLines[afterLines.length - suffix - 1]
  ) suffix += 1;
  return beforeLines.length - prefix - suffix + afterLines.length - prefix - suffix;
}

function isDependencyManifest(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return /(^|\/)(package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|cargo\.toml|cargo\.lock|go\.mod|go\.sum|pom\.xml|build\.gradle(?:\.kts)?)$/u.test(normalized);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new AgentError("PROTOCOL_INVALID", `${name} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
