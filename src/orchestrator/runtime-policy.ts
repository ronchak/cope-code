import { readFile } from "node:fs/promises";
import {
  PolicyEngine,
  DEFAULT_POLICY_BUDGETS,
  normalizeRepositoryPath,
  type BudgetUsage as PolicyBudgetUsage,
  type EffectivePolicy,
  type PolicyOperation,
  type SessionCapabilityExpansion,
  type SessionGrant,
} from "../policy/index.js";
import {
  BUDGET_METRICS,
  DEFAULT_LIST_FILES_MAX_RESULTS,
  MAX_LIST_FILES_RESULTS,
  TERMINAL_EXEC_MAX_OUTPUT_BYTES,
  TERMINAL_EXEC_MAX_TIMEOUT_MS,
  isToolName,
  TOOL_NAMES,
  toolRequiresContext,
  type BudgetMetric,
} from "../protocol/index.js";
import type { RepositoryBoundary } from "../repository/boundary.js";
import {
  SESSION_DIFF_UNAVAILABLE_TERMINAL_PATH_SAMPLE_BYTES,
} from "../repository/snapshot-diff.js";
import { countChangedLines, planExactTextEdit } from "../repository/exact-text-edit.js";
import type { RepositoryReadOperation } from "../repository/repository-tools.js";
import { readTextFile } from "../repository/text-file.js";
import { AgentError, errorMessage } from "../shared/errors.js";
import { stableJson } from "../shared/crypto.js";
import type { CommandCatalog } from "../tools/command-catalog.js";
import type {
  AuthorizationDecision,
  NormalizedToolCall,
  RuntimePolicy,
} from "./contracts.js";
import {
  CONTROL_PLANE_RESERVE_BYTES,
  GIT_STATUS_RESULT_BYTES,
  plannedToolResultDisclosureBytes,
  projectedListFilesResultBytes,
} from "./disclosure-budget.js";

const OPERATION_SCOPED_BUDGET_METRICS = new Set<BudgetMetric>([
  "read_files",
  "changed_files",
  "changed_lines",
  "disclosed_bytes",
  "commands",
  "command_output_bytes",
]);

const DEFAULT_TERMINAL_TIMEOUT_MS = 300_000;
const DEFAULT_TERMINAL_OUTPUT_BYTES = 256 * 1_024;

interface TerminalExecutionBounds {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface LayeredRuntimePolicyOptions {
  readonly engine: PolicyEngine;
  readonly boundary: RepositoryBoundary;
  readonly commandCatalog: CommandCatalog;
  readonly currentUsage: () => PolicyBudgetUsage;
  readonly classification?: string;
  readonly defaultReadBytes?: number;
  readonly defaultSearchBytes?: number;
  readonly defaultDiffBytes?: number;
  readonly maxMutationFileBytes?: number;
  readonly maxPatchBytes?: number;
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
    const terminalActive =
      grant.mode === "auto" &&
      (grant.capabilities.tools?.allow ?? []).includes("terminal_exec");
    const disclosureLimits = this.engineValue.getEffectiveDisclosureLimits();
    const listBounds = listFilesRuntimeBounds(this.engineValue);
    const budgetRecovery = budgetRecoveryHeadroom(this.engineValue);
    const disclosureLimitParts = [
      disclosureLimits.max_bytes_per_operation === undefined
        ? undefined
        : `${disclosureLimits.max_bytes_per_operation} bytes`,
      disclosureLimits.max_files_per_operation === undefined
        ? undefined
        : `${disclosureLimits.max_files_per_operation} files`,
    ].filter((entry): entry is string => entry !== undefined);
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
      network: terminalActive
        ? "allow"
        : grant.capabilities.network?.access ?? "deny",
      operation_limits: {
        list_files: {
          default_max_results:
            listBounds.disabled === true ? 0 : listBounds.defaultResults,
          maximum_results:
            listBounds.disabled === true ? 0 : listBounds.maxResults,
          ...(listBounds.disabled === true
            ? { listing_disabled_by_policy: true }
            : {}),
          ...(disclosureLimits.max_files_per_operation === undefined
            ? {}
            : {
                policy_max_files_per_operation:
                  disclosureLimits.max_files_per_operation,
              }),
          ...(disclosureLimits.max_bytes_per_operation === undefined
            ? {}
            : {
                policy_max_bytes_per_operation:
                  disclosureLimits.max_bytes_per_operation,
              }),
        },
      },
      budget_recovery: budgetRecovery,
      notes: [
        "Organization, repository, and session rules are combined using the most restrictive decision.",
        "Detected secrets are blocked again on the fully serialized browser submission.",
        ...(terminalActive
          ? [
              "Developer terminal commands run as the current user from the project as a starting directory, not an OS sandbox; ordinary environment and network access and local Git may be used, and local repository effects are observed after execution. Catalog-command network policy remains separately enforced.",
            ]
          : []),
        ...(disclosureLimitParts.length === 0
          ? []
          : [
              `Effective per-operation disclosure limits: ${disclosureLimitParts.join(" and ")}. ` +
              "These hard ceilings are separate from cumulative task budgets; reduce max_bytes or max_results instead of requesting a task-budget expansion.",
            ]),
        ...Object.entries(budgetRecovery)
          .filter(([, entry]) => entry.available === false)
          .map(
            ([metric, entry]) =>
              `Raise-and-continue is unavailable for ${metric}: the active limit ` +
              `${entry.current_limit} has no headroom below the ` +
              `${entry.blocking_layer} ceiling ${entry.higher_layer_ceiling}.`,
          ),
      ],
    };
  }

  public async authorize(call: NormalizedToolCall): Promise<AuthorizationDecision> {
    return this.authorizeAgainst(this.engineValue, call);
  }

  public async authorizeOnce(
    call: NormalizedToolCall,
    capability: Readonly<Record<string, unknown>>,
  ): Promise<AuthorizationDecision> {
    const expansions = parseExpansions(capability, this.options.commandCatalog);
    const unsupportedBudget = expansions.find(
      (expansion) =>
        expansion.kind === "budget" &&
        !OPERATION_SCOPED_BUDGET_METRICS.has(expansion.metric),
    );
    if (unsupportedBudget?.kind === "budget") {
      return {
        outcome: "deny",
        reasonCode: "CAPABILITY_EXPANSION_DENIED",
        explanation:
          `The ${unsupportedBudget.metric} budget cannot be expanded for one operation; session approval is required.`,
      };
    }
    const engine = this.expandedEngine(capability);
    if (engine === undefined) {
      return {
        outcome: "deny",
        reasonCode: "CAPABILITY_EXPANSION_INVALID",
        explanation: "The approved one-time capability could not be applied.",
      };
    }
    const decision = await this.authorizeAgainst(engine, call);
    if (decision.outcome !== "allow") return decision;
    const oneTimeBudgetLimits = Object.fromEntries(
      expansions
        .filter((expansion) => expansion.kind === "budget")
        .flatMap((expansion) => {
          const limit = engine.getEffectiveBudgetLimits()[expansion.metric];
          return limit === undefined ? [] : [[expansion.metric, limit] as const];
        }),
    );
    return {
      ...decision,
      ...(Object.keys(oneTimeBudgetLimits).length === 0
        ? {}
        : { oneTimeBudgetLimits }),
    };
  }

  private async authorizeAgainst(
    engine: PolicyEngine,
    call: NormalizedToolCall,
  ): Promise<AuthorizationDecision> {
    try {
      if (
        call.name === "list_files" &&
        listFilesRuntimeBounds(engine).disabled === true
      ) {
        return {
          outcome: "deny",
          reasonCode: "DISCLOSURE_OPERATION_LIMIT_EXCEEDED",
          explanation:
            "Repository listing is disabled because the effective policy file ceiling is 0.",
          details: {
            dimension: "files",
            limit: 0,
            requested: call.arguments.max_results ?? "default",
          },
        };
      }
      if (
        call.name === "git_diff" &&
        call.arguments.scope === "session"
      ) {
        const bounds = sessionGitDiffRuntimeBounds(
          engine,
          positiveInteger(call.arguments.max_bytes) ??
            this.options.defaultDiffBytes ??
            256 * 1024,
        );
        if (bounds.disabled === true) {
          return {
            outcome: "deny",
            reasonCode: "DISCLOSURE_OPERATION_LIMIT_EXCEEDED",
            explanation:
              "Session diff disclosure is disabled because the effective per-operation byte ceiling cannot contain its bounded terminal-unavailable path sample.",
            details: {
              dimension: "bytes",
              limit: bounds.policyCeiling,
              requested:
                SESSION_DIFF_UNAVAILABLE_TERMINAL_PATH_SAMPLE_BYTES +
                bounds.requestedDiffBytes,
            },
          };
        }
      }
      const effectiveCall = effectiveToolCall(
        engine,
        call,
        this.options.defaultDiffBytes,
      );
      const terminal =
        effectiveCall.name === "terminal_exec"
          ? terminalExecutionBounds(engine, effectiveCall, this.options.currentUsage())
          : undefined;
      const operation = await this.buildOperation(effectiveCall, false, terminal);
      const preliminary = engine.evaluate(operation);
      if (preliminary.decision !== "allow" || !toolRequiresContext(call.name, "change")) {
        return decisionFor(
          preliminary,
          effectiveCall,
          this.options.commandCatalog,
          operation,
          effectiveCall === call ? undefined : effectiveCall.arguments,
          terminal,
        );
      }
      // Exact line accounting requires local before-images. It is performed
      // only after all higher-layer path and change-kind checks allow access.
      const exact = await this.buildOperation(effectiveCall, true, terminal);
      return decisionFor(
        engine.evaluate(exact),
        effectiveCall,
        this.options.commandCatalog,
        exact,
        effectiveCall === call ? undefined : effectiveCall.arguments,
        terminal,
      );
    } catch (error) {
      if (error instanceof AgentError && error.code === "STALE_STATE") {
        return {
          outcome: "conflict",
          reasonCode: error.code,
          explanation: errorMessage(error),
        };
      }
      return {
        outcome: "deny",
        reasonCode: error instanceof AgentError ? error.code : "OPERATION_CONTEXT_INVALID",
        explanation: errorMessage(error),
      };
    }
  }

  public async expandSessionGrant(capability: Readonly<Record<string, unknown>>): Promise<boolean> {
    const engine = this.expandedEngine(capability);
    if (engine === undefined) return false;
    const grant = engine.session;
    await this.options.persistGrant?.(grant);
    this.engineValue = engine;
    return true;
  }

  public assessSessionGrantExpansion(
    capability: Readonly<Record<string, unknown>>,
  ): Readonly<{
    outcome: "change" | "no_op" | "deny" | "unavailable";
    reasonCode: string;
    explanation: string;
    details?: Readonly<Record<string, unknown>>;
  }> {
    const expansions = parseExpansions(capability, this.options.commandCatalog);
    if (expansions.length === 0) {
      return {
        outcome: "deny",
        reasonCode: "CAPABILITY_EXPANSION_INVALID",
        explanation: "The requested capability expansion is structurally invalid.",
      };
    }
    let engine = this.engineValue;
    let changesEffectiveCapabilities = false;
    const usage = this.options.currentUsage();
    for (const expansion of expansions) {
      const result = engine.expandSessionGrant(expansion, usage);
      if (result.decision === "deny") {
        const strictReasons = result.reasons.filter(
          (reason) => reason.decision === "deny",
        );
        const unavailable = strictReasons.find(
          (reason) =>
            reason.reason_code === "BUDGET_EXPANSION_UNAVAILABLE",
        );
        if (unavailable !== undefined) {
          return {
            outcome: "unavailable",
            reasonCode: unavailable.reason_code,
            explanation: unavailable.message,
            ...(unavailable.details === undefined
              ? {}
              : { details: unavailable.details }),
          };
        }
        const monotonicNoOp =
          expansion.kind === "budget" &&
          strictReasons.length > 0 &&
          strictReasons.every((reason) => reason.layer === "session");
        const currentLimit =
          expansion.kind === "budget"
            ? engine.getEffectiveBudgetLimits()[expansion.metric] ??
              DEFAULT_POLICY_BUDGETS[expansion.metric]
            : undefined;
        const currentUsage =
          expansion.kind === "budget"
            ? usage[expansion.metric]
            : undefined;
        return {
          outcome: monotonicNoOp ? "no_op" : "deny",
          reasonCode: monotonicNoOp
            ? "CAPABILITY_REQUEST_NO_OP"
            : "CAPABILITY_EXPANSION_DENIED",
          explanation:
            strictReasons.map((reason) => reason.message).join(" ") ||
            "The requested capability expansion is not permitted.",
          ...(expansion.kind !== "budget" ||
          currentLimit === undefined ||
          currentUsage === undefined
            ? {}
            : {
                details: {
                  metric: expansion.metric,
                  requested_limit: expansion.requested_limit,
                  current_limit: currentLimit,
                  current_usage: currentUsage,
                  minimum_acceptable:
                    Math.max(currentLimit, currentUsage) + 1,
                },
              }),
        };
      }
      const next = new PolicyEngine({
        organization: engine.organization,
        repository: engine.repository,
        session: result.grant,
        pathKey: this.options.boundary.pathKey.bind(this.options.boundary),
      });
      if (
        stableJson(next.session.capabilities) !==
        stableJson(engine.session.capabilities)
      ) {
        changesEffectiveCapabilities = true;
      }
      engine = next;
    }
    if (!changesEffectiveCapabilities) {
      return {
        outcome: "no_op",
        reasonCode: "CAPABILITY_REQUEST_NO_OP",
        explanation:
          "The requested capability is already present in the effective session grant.",
      };
    }
    const budgetExpansion =
      expansions.length === 1 && expansions[0]?.kind === "budget"
        ? expansions[0]
        : undefined;
    const budgetDetails =
      budgetExpansion === undefined
        ? undefined
        : (() => {
            const currentLimit =
              this.engineValue.getEffectiveBudgetLimits()[
                budgetExpansion.metric
              ] ?? DEFAULT_POLICY_BUDGETS[budgetExpansion.metric];
            const headroom =
              budgetRecoveryHeadroom(this.engineValue)[
                budgetExpansion.metric
              ];
            return {
              metric: budgetExpansion.metric,
              current_limit: currentLimit,
              current_usage: usage[budgetExpansion.metric],
              minimum_acceptable:
                Math.max(currentLimit, usage[budgetExpansion.metric]) + 1,
              ...(headroom.higher_layer_ceiling === undefined
                ? {}
                : {
                    higher_layer_ceiling:
                      headroom.higher_layer_ceiling,
                  }),
              ...(headroom.blocking_layer === undefined
                ? {}
                : { blocking_layer: headroom.blocking_layer }),
            };
          })();
    return {
      outcome: "change",
      reasonCode: "CAPABILITY_EXPANSION_REQUIRES_APPROVAL",
      explanation: "The request would expand the effective session grant.",
      ...(budgetDetails === undefined ? {} : { details: budgetDetails }),
    };
  }

  private expandedEngine(
    capability: Readonly<Record<string, unknown>>,
  ): PolicyEngine | undefined {
    const expansions = parseExpansions(capability, this.options.commandCatalog);
    if (expansions.length === 0) return undefined;

    let engine = this.engineValue;
    for (const expansion of expansions) {
      const result = engine.expandSessionGrant(
        expansion,
        this.options.currentUsage(),
      );
      if (result.decision === "deny") return undefined;
      engine = new PolicyEngine({
        organization: engine.organization,
        repository: engine.repository,
        session: result.grant,
        pathKey: this.options.boundary.pathKey.bind(this.options.boundary),
      });
    }
    return engine;
  }

  public isPathInScope(path: string): boolean {
    const normalized = normalizeRepositoryPath(path);
    if (normalized === undefined) return false;
    return TOOL_NAMES.filter(
      (tool) => toolRequiresContext(tool, "path") && toolRequiresContext(tool, "change"),
    ).some((tool) => {
      const operation: PolicyOperation = {
        tool,
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
    });
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

  private async buildOperation(
    call: NormalizedToolCall,
    exactPatchLines: boolean,
    terminal?: TerminalExecutionBounds,
  ): Promise<PolicyOperation> {
    const usage = { ...this.options.currentUsage() };
    const paths = pathFacts(call);
    let disclosure: PolicyOperation["disclosure"];
    let command: PolicyOperation["command"];
    let network: PolicyOperation["network"];
    let change: PolicyOperation["change"];
    let additionalSerializedDisclosureBytes = 0;

    if (call.name === "read_file") {
      const byteCount = positiveInteger(call.arguments.max_bytes) ?? this.options.defaultReadBytes ?? 128 * 1024;
      disclosure = disclosureFact(this.classification, byteCount, 1);
      usage.read_files += 1;
    } else if (call.name === "search_text") {
      const byteCount = this.options.defaultSearchBytes ?? 128 * 1024;
      disclosure = disclosureFact(this.classification, byteCount, 1);
    } else if (call.name === "list_files") {
      const fileCount = requiredPositiveInteger(
        call.arguments.max_results,
        "max_results",
      );
      disclosure = disclosureFact(
        this.classification,
        projectedListFilesResultBytes(fileCount),
        fileCount,
      );
    } else if (call.name === "git_diff") {
      const byteCount = positiveInteger(call.arguments.max_bytes) ?? this.options.defaultDiffBytes ?? 256 * 1024;
      if ((optionalString(call.arguments.scope) ?? "working_tree") === "session") {
        additionalSerializedDisclosureBytes =
          SESSION_DIFF_UNAVAILABLE_TERMINAL_PATH_SAMPLE_BYTES;
      }
      disclosure = disclosureFact(
        this.classification,
        byteCount + additionalSerializedDisclosureBytes,
        1,
      );
    } else if (call.name === "git_status") {
      disclosure = disclosureFact(this.classification, GIT_STATUS_RESULT_BYTES, 1);
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
    } else if (call.name === "terminal_exec") {
      if (terminal === undefined) {
        throw new AgentError(
          "INTERNAL_ERROR",
          "Terminal execution bounds are unavailable",
        );
      }
      disclosure = disclosureFact(
        this.classification,
        terminal.maxOutputBytes + terminalInvocationSourceBytes(call),
        1,
      );
      usage.commands += 1;
      usage.command_output_bytes += terminal.maxOutputBytes;
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
    } else if (call.name === "edit_text") {
      const edit = editTextInput(call.arguments);
      const changedLines = exactPatchLines ? await this.countExactEditLines(edit) : 0;
      change = {
        files_changed: 1,
        changed_lines: changedLines,
        creates: 0,
        deletes: 0,
        dependency_manifest: isDependencyManifest(edit.path),
        local_commit: false,
      };
      usage.changed_files += 1;
      usage.changed_lines += changedLines;
    }

    const pathBytes = paths.reduce(
      (total, entry) => total + Buffer.byteLength(entry.path),
      0,
    );
    const plannedDisclosureBytes = plannedToolResultDisclosureBytes(
      (disclosure?.byte_count ?? 0) - additionalSerializedDisclosureBytes,
      pathBytes,
      additionalSerializedDisclosureBytes,
    );
    if (!Number.isSafeInteger(usage.disclosed_bytes + plannedDisclosureBytes)) {
      throw new AgentError("BUDGET_EXCEEDED", "Projected disclosure usage is too large");
    }
    usage.disclosed_bytes += plannedDisclosureBytes + CONTROL_PLANE_RESERVE_BYTES;

    return {
      tool: call.name,
      ...(paths.length === 0 ? {} : { paths }),
      ...(command === undefined ? {} : { command }),
      ...(disclosure === undefined ? {} : { disclosure }),
      ...(network === undefined ? {} : { network }),
      ...(change === undefined ? {} : { change }),
      planned_disclosure_bytes: plannedDisclosureBytes,
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

  private async countExactEditLines(edit: EditTextInput): Promise<number> {
    const resolved = await this.options.boundary.resolve(edit.path, { allowMissingLeaf: true });
    if (!resolved.exists) {
      throw new AgentError("STALE_STATE", "Edit target no longer exists", {
        path: edit.path,
      });
    }
    const existing = await this.options.boundary.resolveExistingFile(edit.path);
    const maxFileBytes = this.options.maxMutationFileBytes ?? 1024 * 1024;
    const snapshot = await readTextFile(existing.absolutePath, edit.path, maxFileBytes);
    return planExactTextEdit(
      {
        content: snapshot.content,
        bytes: snapshot.bytes,
        sha256: snapshot.state.sha256,
      },
      {
        path: edit.path,
        baseSha256: edit.base_sha256,
        oldText: edit.old_text,
        newText: edit.new_text,
        expectedOccurrences: edit.expected_occurrences,
      },
      Math.min(maxFileBytes, this.options.maxPatchBytes ?? 4 * 1024 * 1024),
    ).changedLines;
  }
}

function budgetRecoveryHeadroom(
  engine: PolicyEngine,
): Readonly<
  Record<
    BudgetMetric,
    {
      readonly current_limit: number;
      readonly available: boolean;
      readonly higher_layer_ceiling?: number;
      readonly blocking_layer?: "organization" | "repository";
    }
  >
> {
  const effective = engine.getEffectiveBudgetLimits();
  return Object.fromEntries(
    BUDGET_METRICS.map((metric) => {
      const current =
        effective[metric] ?? DEFAULT_POLICY_BUDGETS[metric];
      const higherLayers = [
        {
          layer: "organization" as const,
          limit: engine.organization.capabilities.budgets?.[metric],
        },
        {
          layer: "repository" as const,
          limit: engine.repository.capabilities.budgets?.[metric],
        },
      ].filter(
        (entry): entry is {
          readonly layer: "organization" | "repository";
          readonly limit: number;
        } => entry.limit !== undefined,
      );
      const blocking =
        higherLayers.length === 0
          ? undefined
          : higherLayers.reduce((lowest, entry) =>
              entry.limit < lowest.limit ? entry : lowest,
            );
      return [
        metric,
        {
          current_limit: current,
          available: blocking === undefined || current < blocking.limit,
          ...(blocking === undefined
            ? {}
            : {
                higher_layer_ceiling: blocking.limit,
                blocking_layer: blocking.layer,
              }),
        },
      ];
    }),
  ) as Readonly<
    Record<
      BudgetMetric,
      {
        readonly current_limit: number;
        readonly available: boolean;
        readonly higher_layer_ceiling?: number;
        readonly blocking_layer?: "organization" | "repository";
      }
    >
  >;
}

interface EditTextInput {
  readonly path: string;
  readonly base_sha256: string;
  readonly old_text: string;
  readonly new_text: string;
  readonly expected_occurrences: number;
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
  if (call.name === "edit_text") {
    return [{ path: requiredString(call.arguments.path, "path"), access: "write" }];
  }
  return [];
}

function editTextInput(value: Readonly<Record<string, unknown>>): EditTextInput {
  const expected = positiveInteger(value.expected_occurrences);
  if (expected === undefined) throw new AgentError("PROTOCOL_INVALID", "expected_occurrences must be positive");
  return {
    path: requiredString(value.path, "path"),
    base_sha256: requiredString(value.base_sha256, "base_sha256"),
    old_text: requiredString(value.old_text, "old_text"),
    new_text: requiredText(value.new_text, "new_text"),
    expected_occurrences: expected,
  };
}

function decisionFor(
  policy: EffectivePolicy,
  call: NormalizedToolCall,
  catalog: CommandCatalog,
  operation: PolicyOperation,
  effectiveArguments?: Readonly<Record<string, unknown>>,
  terminal?: TerminalExecutionBounds,
): AuthorizationDecision {
  if (policy.decision === "allow") {
    return {
      outcome: "allow",
      reasonCode: "ALLOWED",
      explanation: "Operation is inside the effective grant.",
      ...(effectiveArguments === undefined ? {} : { effectiveArguments }),
      ...(terminal === undefined ? {} : { terminal }),
      ...(operation.planned_disclosure_bytes === undefined
        ? {}
        : { plannedDisclosureBytes: operation.planned_disclosure_bytes }),
      ...(operation.change === undefined
        ? {}
        : {
            plannedMutation: {
              changedFiles: operation.change.files_changed,
              changedLines: operation.change.changed_lines,
            },
          }),
    };
  }
  const strictReasons = policy.reasons.filter((reason) => reason.decision === policy.decision);
  const primary = strictReasons[0] ?? policy.reasons[0];
  const explanation = strictReasons.map((reason) => reason.message).join(" ") || "Operation is not granted.";
  if (policy.decision === "deny") {
    return {
      outcome: "deny",
      reasonCode: primary?.reason_code ?? "POLICY_DENIED",
      explanation,
      ...(primary?.details === undefined ? {} : { details: primary.details }),
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
    ...(primary?.details === undefined ? {} : { details: primary.details }),
  };
}

function terminalExecutionBounds(
  engine: PolicyEngine,
  call: NormalizedToolCall,
  usage: PolicyBudgetUsage,
): TerminalExecutionBounds {
  const requestedTimeout =
    positiveInteger(call.arguments.timeout_ms) ?? DEFAULT_TERMINAL_TIMEOUT_MS;
  const timeoutCeilings = [
    TERMINAL_EXEC_MAX_TIMEOUT_MS,
    engine.organization.capabilities.commands?.max_timeout_ms,
    engine.repository.capabilities.commands?.max_timeout_ms,
    engine.session.capabilities.commands?.max_timeout_ms,
  ].filter((value): value is number => value !== undefined);
  const timeoutMs = Math.min(requestedTimeout, ...timeoutCeilings);

  const requestedOutput =
    positiveInteger(call.arguments.max_output_bytes) ??
    DEFAULT_TERMINAL_OUTPUT_BYTES;
  const effectiveBudgets = engine.getEffectiveBudgetLimits();
  const commandOutputRemaining = Math.max(
    0,
    (effectiveBudgets.command_output_bytes ??
      DEFAULT_POLICY_BUDGETS.command_output_bytes) -
      usage.command_output_bytes,
  );
  const disclosedRemaining = Math.max(
    0,
    (effectiveBudgets.disclosed_bytes ?? DEFAULT_POLICY_BUDGETS.disclosed_bytes) -
      usage.disclosed_bytes -
      CONTROL_PLANE_RESERVE_BYTES,
  );
  const invocationSourceBytes = terminalInvocationSourceBytes(call);
  const disclosureSourceCeiling = maximumSourceBytesForDisclosure(
    disclosedRemaining,
    invocationSourceBytes,
  );
  const perOperationDisclosureBytes =
    engine.getEffectiveDisclosureLimits().max_bytes_per_operation ??
    TERMINAL_EXEC_MAX_OUTPUT_BYTES;
  const perOperationSourceCeiling = maximumSourceBytesForDisclosure(
    perOperationDisclosureBytes,
    invocationSourceBytes,
  );
  const maxOutputBytes = Math.max(
    1,
    Math.min(
      requestedOutput,
      TERMINAL_EXEC_MAX_OUTPUT_BYTES,
      commandOutputRemaining,
      disclosureSourceCeiling,
      perOperationSourceCeiling,
    ),
  );
  return { timeoutMs, maxOutputBytes };
}

function maximumSourceBytesForDisclosure(
  disclosureBytes: number,
  fixedSourceBytes = 0,
): number {
  if (disclosureBytes <= 0) return 0;
  let lower = 0;
  let upper = Math.min(disclosureBytes, TERMINAL_EXEC_MAX_OUTPUT_BYTES);
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (
      plannedToolResultDisclosureBytes(
        fixedSourceBytes + middle,
        0,
      ) <= disclosureBytes
    ) {
      lower = middle;
    } else {
      upper = middle - 1;
    }
  }
  return lower;
}

function terminalInvocationSourceBytes(call: NormalizedToolCall): number {
  const cwd =
    typeof call.arguments.cwd === "string"
      ? Buffer.byteLength(call.arguments.cwd)
      : 1;
  if (call.arguments.mode === "shell") {
    return cwd + Buffer.byteLength(String(call.arguments.command ?? ""));
  }
  const executable =
    typeof call.arguments.executable === "string"
      ? Buffer.byteLength(call.arguments.executable)
      : 0;
  const argumentsValue = Array.isArray(call.arguments.arguments)
    ? call.arguments.arguments
    : [];
  return argumentsValue.reduce(
    (total, argument) =>
      total +
      (typeof argument === "string" ? Buffer.byteLength(argument) : 0),
    cwd + executable,
  );
}

export interface ListFilesRuntimeBounds {
  readonly defaultResults: number;
  readonly maxResults: number;
  readonly disabled?: true;
}

/**
 * One policy-derived bound used by both authorization and repository
 * execution. The product default is a cap, never authority to exceed a
 * stricter effective policy.
 */
export function listFilesRuntimeBounds(engine: PolicyEngine): ListFilesRuntimeBounds {
  const policyCeiling =
    engine.getEffectiveDisclosureLimits().max_files_per_operation ??
    MAX_LIST_FILES_RESULTS;
  const disabled = policyCeiling === 0;
  const maxResults = disabled
    ? 0
    : Math.min(MAX_LIST_FILES_RESULTS, policyCeiling);
  return {
    maxResults,
    defaultResults: Math.min(DEFAULT_LIST_FILES_MAX_RESULTS, maxResults),
    ...(disabled ? { disabled: true as const } : {}),
  };
}

function effectiveToolCall(
  engine: PolicyEngine,
  call: NormalizedToolCall,
  defaultDiffBytes?: number,
): NormalizedToolCall {
  if (call.name === "list_files") {
    const bounds = listFilesRuntimeBounds(engine);
    const requested = positiveInteger(call.arguments.max_results);
    const applied = Math.min(requested ?? bounds.defaultResults, bounds.maxResults);
    if (call.arguments.max_results === applied) return call;
    return {
      ...call,
      arguments: {
        ...call.arguments,
        max_results: applied,
      },
    };
  }
  if (
    call.name === "git_diff" &&
    call.arguments.scope === "session"
  ) {
    const bounds = sessionGitDiffRuntimeBounds(
      engine,
      positiveInteger(call.arguments.max_bytes) ??
        defaultDiffBytes ??
        256 * 1024,
    );
    if (bounds.disabled === true) return call;
    if (call.arguments.max_bytes === bounds.appliedDiffBytes) return call;
    return {
      ...call,
      arguments: {
        ...call.arguments,
        max_bytes: bounds.appliedDiffBytes,
      },
    };
  }
  return call;
}

type SessionGitDiffRuntimeBounds = {
  readonly policyCeiling: number;
  readonly requestedDiffBytes: number;
} & (
  | {
      readonly disabled: true;
    }
  | {
      readonly disabled?: false;
      readonly appliedDiffBytes: number;
    }
);

function sessionGitDiffRuntimeBounds(
  engine: PolicyEngine,
  requestedDiffBytes: number,
): SessionGitDiffRuntimeBounds {
  const policyCeiling =
    engine.getEffectiveDisclosureLimits().max_bytes_per_operation ??
    Number.MAX_SAFE_INTEGER;
  const availableDiffBytes =
    policyCeiling - SESSION_DIFF_UNAVAILABLE_TERMINAL_PATH_SAMPLE_BYTES;
  if (availableDiffBytes < 1) {
    return {
      policyCeiling,
      requestedDiffBytes,
      disabled: true,
    };
  }
  return {
    policyCeiling,
    requestedDiffBytes,
    appliedDiffBytes: Math.min(requestedDiffBytes, availableDiffBytes),
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
      .filter((tool): tool is NormalizedToolCall["name"] => typeof tool === "string" && isToolName(tool))
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
  if (value.kind === "tool") return typeof value.tool === "string" && isToolName(value.tool);
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

function isDependencyManifest(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return /(^|\/)(package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|cargo\.toml|cargo\.lock|go\.mod|go\.sum|pom\.xml|build\.gradle(?:\.kts)?)$/u.test(normalized);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new AgentError("PROTOCOL_INVALID", `${name} is required`);
  return value;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new AgentError("PROTOCOL_INVALID", `${name} must be a string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function requiredPositiveInteger(value: unknown, name: string): number {
  const parsed = positiveInteger(value);
  if (parsed === undefined) {
    throw new AgentError("PROTOCOL_INVALID", `${name} must be a positive integer`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
