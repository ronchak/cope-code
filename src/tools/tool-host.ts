import { AgentError, errorMessage } from "../shared/errors.js";
import { sha256, stableJson } from "../shared/crypto.js";
import { isOperationId } from "../shared/operation-id.js";
import type { GitInspector, GitStatusResult } from "../repository/git.js";
import type { PatchEngine } from "../repository/patch-engine.js";
import type { RepositoryTools } from "../repository/repository-tools.js";
import type { RepositoryContext } from "../repository/context.js";
import type {
  SessionMutationDiffRecord,
  SnapshotDiffInspector,
} from "../repository/snapshot-diff.js";
import type { ContentProcessor } from "../repository/types.js";
import type { ProcessRunner } from "./process-runner.js";

export type ToolHostToolName =
  | "list_files"
  | "search_text"
  | "read_file"
  | "git_status"
  | "git_diff"
  | "edit_text"
  | "apply_patch"
  | "run_command";

export interface ToolHostCall {
  readonly operationId: string;
  readonly name: ToolHostToolName;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type ToolAuthorizationDecision =
  | { readonly outcome: "allow"; readonly reasonCode?: string }
  | {
      readonly outcome: "ask" | "deny";
      readonly reasonCode: string;
      readonly explanation: string;
      readonly details?: Readonly<Record<string, unknown>>;
    };

/** Structural policy boundary: ToolHost never imports or changes policy state. */
export interface ToolPolicyEvaluator {
  authorize(call: ToolHostCall): ToolAuthorizationDecision | Promise<ToolAuthorizationDecision>;
}

export interface CompletionPathScope {
  isPathInScope(path: string): boolean;
}

export interface SessionDiffState {
  readonly lastCheckpointId?: string;
  readonly mutations: readonly SessionMutationDiffRecord[];
}

interface ToolHostCommonDependencies {
  readonly processRunner: ProcessRunner;
  readonly policy: ToolPolicyEvaluator;
  readonly resultProcessor?: ContentProcessor;
  readonly completionPathScope?: CompletionPathScope;
  readonly snapshotDiff?: SnapshotDiffInspector;
  readonly sessionDiffState?: () => SessionDiffState;
}

export type ToolHostDependencies = ToolHostCommonDependencies &
  (
    | {
        readonly context: Pick<RepositoryContext, "tools" | "git" | "patchEngine" | "snapshotDiff">;
        readonly repository?: never;
        readonly git?: never;
        readonly patchEngine?: never;
      }
    | {
        readonly context?: never;
        readonly repository: RepositoryTools;
        readonly git: GitInspector;
        readonly patchEngine: PatchEngine;
      }
  );

export interface ToolHostOutcome {
  readonly operationId: string;
  readonly tool: ToolHostToolName;
  readonly status:
    | "success"
    | "failure"
    | "conflict"
    | "denied"
    | "timeout"
    | "cancelled"
    | "indeterminate";
  readonly data: Readonly<Record<string, unknown>>;
  readonly safeMetadata: Readonly<Record<string, unknown>>;
}

export interface RepositoryCompletionSnapshot {
  readonly pathKey: (value: string) => string;
  readonly known: boolean;
  readonly fingerprint: string;
  readonly excludedStateFingerprint: string;
  readonly hasConflicts: boolean;
  readonly branch: string | null;
  readonly head: string | null;
  readonly pathStateFingerprints: Readonly<Record<string, string>>;
  readonly changedPaths: readonly string[];
  readonly outOfScopePaths: readonly string[];
  readonly gitStatusSummary: string;
}

interface OperationEntry {
  readonly fingerprint: string;
  readonly outcome: Promise<ToolHostOutcome>;
}

export class ToolHost {
  private readonly operations = new Map<string, OperationEntry>();
  private readonly repository: RepositoryTools;
  private readonly git: GitInspector;
  private readonly patchEngine: PatchEngine;
  private readonly snapshotDiff: SnapshotDiffInspector | undefined;

  public constructor(private readonly dependencies: ToolHostDependencies) {
    if (dependencies.context !== undefined) {
      this.repository = dependencies.context.tools;
      this.git = dependencies.context.git;
      this.patchEngine = dependencies.context.patchEngine;
      this.snapshotDiff = dependencies.context.snapshotDiff;
    } else {
      this.repository = dependencies.repository;
      this.git = dependencies.git;
      this.patchEngine = dependencies.patchEngine;
      this.snapshotDiff = dependencies.snapshotDiff;
    }
  }

  /** Implements the orchestrator's ToolExecutor contract structurally. */
  public async execute(call: ToolHostCall, signal: AbortSignal): Promise<ToolHostOutcome> {
    return this.dispatch(call, signal);
  }

  public async dispatch(call: ToolHostCall, signal?: AbortSignal): Promise<ToolHostOutcome> {
    validateCall(call);
    const fingerprint = sha256(stableJson({ name: call.name, arguments: call.arguments }));
    const existing = this.operations.get(call.operationId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return failureOutcome(
          call,
          new AgentError("DUPLICATE_OPERATION", "Operation identifier was reused for a different request", {
            operationId: call.operationId,
          }),
        );
      }
      return existing.outcome;
    }

    const outcome = this.authorizeAndExecute(call, signal);
    this.operations.set(call.operationId, { fingerprint, outcome });
    return outcome;
  }

  public async inspectCompletionState(): Promise<RepositoryCompletionSnapshot> {
    try {
      await this.repository.boundary.assertNoNestedGitBoundaries();
      const status = await this.git.status();
      const changedPaths = status.entries
        .filter((entry) => entry.kind !== "ignored")
        .map((entry) => entry.path);
      const pathScope = this.dependencies.completionPathScope;
      const outOfScopePaths =
        pathScope === undefined ? [...changedPaths] : changedPaths.filter((path) => !pathScope.isPathInScope(path));
      return {
        pathKey: (value: string) => this.repository.boundary.pathKey(value),
        known: pathScope !== undefined,
        fingerprint: status.snapshotSha256,
        excludedStateFingerprint: status.excludedStateSha256,
        hasConflicts: status.hasConflicts,
        branch: status.branch,
        head: status.head,
        pathStateFingerprints: Object.fromEntries(
          status.entries
            .filter((entry) => entry.kind !== "ignored")
            .map((entry) => [this.repository.boundary.pathKey(entry.path), entry.stateSha256]),
        ),
        changedPaths,
        outOfScopePaths,
        gitStatusSummary: statusSummary(status),
      };
    } catch (error) {
      return {
        pathKey: (value: string) => this.repository.boundary.pathKey(value),
        known: false,
        fingerprint: "unknown",
        excludedStateFingerprint: "unknown",
        hasConflicts: true,
        branch: null,
        head: null,
        pathStateFingerprints: {},
        changedPaths: [],
        outOfScopePaths: [],
        gitStatusSummary: `Git state unavailable: ${errorMessage(error)}`,
      };
    }
  }

  private async authorizeAndExecute(
    call: ToolHostCall,
    signal: AbortSignal | undefined,
  ): Promise<ToolHostOutcome> {
    try {
      const decision = await this.dependencies.policy.authorize(call);
      if (decision.outcome !== "allow") {
        return {
          operationId: call.operationId,
          tool: call.name,
          status: "denied",
          data: {
            decision: decision.outcome,
            code: decision.reasonCode,
            message: decision.explanation,
            ...(decision.details ?? {}),
          },
          safeMetadata: {
            decision: decision.outcome,
            reasonCode: decision.reasonCode,
          },
        };
      }
      return await this.executeAuthorized(call, signal);
    } catch (error) {
      return failureOutcome(call, error);
    }
  }

  private async executeAuthorized(
    call: ToolHostCall,
    signal: AbortSignal | undefined,
  ): Promise<ToolHostOutcome> {
    switch (call.name) {
      case "list_files": {
        const args = checkedObject(call.arguments, ["path", "max_depth", "max_results"]);
        const result = await this.repository.listFiles({
          ...optionalString(args, "path"),
          ...optionalNumberAs(args, "max_depth", "maxDepth"),
          ...optionalNumberAs(args, "max_results", "maxResults"),
        });
        return successOutcome(call, asRecord(result), {
          entryCount: result.entries.length,
          truncated: result.truncated,
        });
      }
      case "search_text": {
        const args = checkedObject(call.arguments, [
          "query",
          "mode",
          "path",
          "file_patterns",
          "max_results",
          "context_lines",
        ]);
        if (args.mode !== undefined && args.mode !== "literal") {
          throw new AgentError("UNSUPPORTED_FILE", "Only literal search is enabled in cba/1");
        }
        const result = await this.repository.searchText({
          query: requiredString(args, "query"),
          ...optionalString(args, "path"),
          ...optionalStringArrayAs(args, "file_patterns", "filePatterns"),
          ...optionalNumberAs(args, "max_results", "maxResults"),
          ...optionalNumberAs(args, "context_lines", "contextLines"),
          operationId: call.operationId,
        });
        return successOutcome(call, asRecord(result), {
          matchCount: result.matches.length,
          disclosedBytes: result.outputBytes,
          truncated: result.truncated,
        });
      }
      case "read_file": {
        const args = checkedObject(call.arguments, ["path", "start_line", "end_line", "max_bytes"]);
        const result = await this.repository.readFile({
          path: requiredString(args, "path"),
          ...optionalNumberAs(args, "start_line", "startLine"),
          ...optionalNumberAs(args, "end_line", "endLine"),
          ...optionalNumberAs(args, "max_bytes", "maxBytes"),
          operationId: call.operationId,
        });
        return successOutcome(call, asRecord(result), {
          path: result.path,
          fileSha256: result.state.sha256,
          disclosedBytes: Buffer.byteLength(result.content),
          truncated: result.truncated,
        });
      }
      case "git_status": {
        const args = checkedObject(call.arguments, ["include_untracked"]);
        const includeUntracked = optionalBoolean(args, "include_untracked") ?? true;
        const result = await this.git.status(signal);
        const filtered = includeUntracked
          ? result
          : { ...result, entries: result.entries.filter((entry) => entry.kind !== "untracked") };
        const { excludedStateSha256: _excludedStateSha256, ...safeFiltered } = filtered;
        const disclosed = {
          ...safeFiltered,
          entries: filtered.entries.map(({ stateSha256: _stateSha256, ...entry }) => entry),
        };
        return successOutcome(call, asRecord(disclosed), {
          fingerprint: result.snapshotSha256,
          changedFileCount: filtered.entries.length,
          excludedCount: result.excludedCount,
          hasConflicts: result.hasConflicts,
        });
      }
      case "git_diff": {
        const args = checkedObject(call.arguments, ["scope", "paths", "baseline", "max_bytes"]);
        const scope = optionalStringValue(args, "scope") ?? "working_tree";
        if (!["session", "working_tree", "staged", "checkpoint"].includes(scope)) {
          throw new AgentError("PROTOCOL_INVALID", "Git diff scope is invalid", { scope });
        }
        const requestedBaseline = optionalStringValue(args, "baseline");
        const paths = optionalStringArrayAs(args, "paths", "paths");
        const maximum = optionalNumberAs(args, "max_bytes", "maxBytes");
        const rawResult = scope === "checkpoint"
          ? await this.checkpointDiff(requestedBaseline, paths, maximum, signal)
          : scope === "session"
            ? await this.sessionDiff(requestedBaseline, paths, maximum, signal)
            : await this.gitWorkingTreeDiff(
                scope as "working_tree" | "staged",
                requestedBaseline,
                paths,
                maximum,
                signal,
              );
        const processed = await this.dependencies.resultProcessor?.process({
          operationId: call.operationId,
          source: "tool-result",
          content: rawResult.diff,
        });
        const bounded = boundUtf8(processed?.content ?? rawResult.diff, rawResult.limitBytes);
        const result = {
          ...("contractVersion" in rawResult ? { contractVersion: rawResult.contractVersion } : {}),
          scope,
          baseline: rawResult.baseline,
          diff: bounded.content,
          truncated: rawResult.truncated || bounded.truncated,
          outputBytes: Buffer.byteLength(bounded.content),
          sha256: sha256(bounded.content),
          excludedCount: rawResult.excludedCount,
          maxBytes: rawResult.limitBytes,
          ...("comparedFileCount" in rawResult ? { comparedFileCount: rawResult.comparedFileCount } : {}),
          ...("changedFileCount" in rawResult ? { changedFileCount: rawResult.changedFileCount } : {}),
        };
        return successOutcome(call, asRecord(result), {
          scope,
          baseline: result.baseline,
          outputBytes: result.outputBytes,
          truncated: result.truncated,
          excludedCount: result.excludedCount,
          redactionCount: processed?.redactionCount ?? 0,
        });
      }
      case "apply_patch": {
        const args = checkedObject(call.arguments, ["changes"]);
        if (!Array.isArray(args.changes)) {
          throw new AgentError("PROTOCOL_INVALID", "apply_patch changes must be an array");
        }
        const result = await this.patchEngine.applyPatch({
          changes: args.changes as never,
          operationId: call.operationId,
        });
        let repositoryFingerprint = "unknown";
        let repositoryStateKnown = false;
        let repositoryHasConflicts = true;
        try {
          const repositoryStatus = await this.git.status();
          repositoryFingerprint = repositoryStatus.snapshotSha256;
          repositoryStateKnown = true;
          repositoryHasConflicts = repositoryStatus.hasConflicts;
        } catch {
          // The patch remains committed and recoverable, but completion will
          // fail closed until repository state can be reconciled.
        }
        return successOutcome(call, asRecord(result), {
          checkpointId: result.checkpointId,
          changedFileCount: result.changedPaths.length,
          changedPaths: result.changedPaths.map((entry) => entry.path),
          changedLines: result.changedLines,
          repositoryFingerprint,
          repositoryStateKnown,
          repositoryHasConflicts,
        });
      }
      case "edit_text": {
        const args = checkedObject(call.arguments, [
          "path", "base_sha256", "old_text", "new_text", "expected_occurrences",
        ]);
        const result = await this.patchEngine.editText({
          path: requiredString(args, "path"),
          base_sha256: requiredString(args, "base_sha256"),
          old_text: requiredString(args, "old_text"),
          new_text: requiredString(args, "new_text"),
          expected_occurrences: requiredNumber(args, "expected_occurrences"),
          operationId: call.operationId,
        });
        let repositoryFingerprint = "unknown";
        let repositoryStateKnown = false;
        let repositoryHasConflicts = true;
        try {
          const repositoryStatus = await this.git.status();
          repositoryFingerprint = repositoryStatus.snapshotSha256;
          repositoryStateKnown = true;
          repositoryHasConflicts = repositoryStatus.hasConflicts;
        } catch {
          // The edit remains committed and recoverable; completion fails closed.
        }
        return successOutcome(call, asRecord(result), {
          checkpointId: result.checkpointId,
          changedFileCount: result.changedPaths.length,
          changedPaths: result.changedPaths.map((entry) => entry.path),
          changedLines: result.changedLines,
          repositoryFingerprint,
          repositoryStateKnown,
          repositoryHasConflicts,
        });
      }
      case "run_command": {
        const args = checkedObject(call.arguments, ["command_id", "parameters", "timeout_ms"]);
        const parameters = optionalParameters(args, "parameters");
        const request = {
          command_id: requiredString(args, "command_id"),
          ...(parameters === undefined ? {} : { parameters }),
          ...optionalNumberAs(args, "timeout_ms", "timeout_ms"),
          operationId: call.operationId,
        };
        const command = this.dependencies.processRunner.describe(request);
        // Every child command is bracketed by deterministic repository
        // integrity evidence. Side-effecting validation may create ordinary
        // Git-ignored build products, but neither command class may alter
        // Git-visible, protected, Git-control, or nested-repository state.
        // A side-effect-free declaration additionally binds ignored files.
        await this.repository.boundary.assertNoNestedGitBoundaries();
        const repositoryBefore = await this.git.commandBoundaryState({
          includeIgnoredWorktree: !command.sideEffects,
        }, signal);
        const result = await this.dependencies.processRunner.run(
          request,
          signal,
        );
        const status =
          result.outcome === "success"
            ? "success"
            : result.outcome === "timeout"
              ? "timeout"
              : result.outcome === "cancelled"
                ? "cancelled"
                : result.outcome === "policy-denied"
                  ? "denied"
                  : result.outcome === "indeterminate"
                    ? "indeterminate"
                    : "failure";
        let repositoryAfter: Awaited<ReturnType<GitInspector["commandBoundaryState"]>>;
        try {
          await this.repository.boundary.assertNoNestedGitBoundaries();
          repositoryAfter = await this.git.commandBoundaryState({
            includeIgnoredWorktree: !command.sideEffects,
          });
        } catch (error) {
          throw new AgentError(
            "RECOVERY_REQUIRED",
            "Repository state became unverifiable while a command was running",
            {
              commandId: result.commandId,
              commandOutcome: result.outcome,
              repositoryStateKnown: false,
            },
            { cause: error },
          );
        }
        if (repositoryAfter.integritySha256 !== repositoryBefore.integritySha256) {
          throw new AgentError(
            "RECOVERY_REQUIRED",
            command.sideEffects
              ? "An approved command changed Git-visible, protected, or repository-control state"
              : "A command declared side-effect-free changed repository state",
            {
              commandId: result.commandId,
              commandOutcome: result.outcome,
              reasonCode: "COMMAND_UNDECLARED_REPOSITORY_MUTATION",
              repositoryStateKnown: true,
              repositoryHasConflicts: repositoryAfter.status.hasConflicts,
              repositoryFingerprint: repositoryAfter.status.snapshotSha256,
            },
          );
        }
        return {
          operationId: call.operationId,
          tool: call.name,
          status,
          data: asRecord(result),
          safeMetadata: {
            commandId: result.commandId,
            outcome: result.outcome,
            exitCode: result.exitCode,
            outputBytes: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
            truncated: result.truncated,
            redactionCount: result.redactionCount,
            sideEffects: command.sideEffects,
            repositoryFingerprint: repositoryAfter.status.snapshotSha256,
            repositoryStateKnown: true,
            repositoryHasConflicts: repositoryAfter.status.hasConflicts,
          },
        };
      }
    }
  }

  private async checkpointDiff(
    requestedBaseline: string | undefined,
    paths: { readonly paths?: readonly string[] },
    maximum: { readonly maxBytes?: number },
    signal: AbortSignal | undefined,
  ) {
    const inspector = this.requireSnapshotDiff();
    const checkpointId = requestedBaseline ?? this.dependencies.sessionDiffState?.().lastCheckpointId;
    if (checkpointId === undefined) {
      throw new AgentError("PROTOCOL_INVALID", "Checkpoint diff requires a baseline checkpoint ID or a current session checkpoint");
    }
    if (!/^checkpoint_[0-9a-f-]{36}$/iu.test(checkpointId)) {
      throw new AgentError("PROTOCOL_INVALID", "Checkpoint diff baseline is not a checkpoint identifier");
    }
    return inspector.diffCheckpoint(checkpointId, { ...paths, ...maximum }, signal);
  }

  private async sessionDiff(
    requestedBaseline: string | undefined,
    paths: { readonly paths?: readonly string[] },
    maximum: { readonly maxBytes?: number },
    signal: AbortSignal | undefined,
  ) {
    if (requestedBaseline !== undefined) {
      throw new AgentError("PROTOCOL_INVALID", "Session diff derives its baseline from mutation checkpoints");
    }
    const state = this.dependencies.sessionDiffState?.();
    if (state === undefined) {
      throw new AgentError("PROTOCOL_INVALID", "Session diff state is unavailable");
    }
    return this.requireSnapshotDiff().diffSession(state.mutations, { ...paths, ...maximum }, signal);
  }

  private async gitWorkingTreeDiff(
    scope: "working_tree" | "staged",
    requestedBaseline: string | undefined,
    paths: { readonly paths?: readonly string[] },
    maximum: { readonly maxBytes?: number },
    signal: AbortSignal | undefined,
  ) {
    if (requestedBaseline !== undefined && (scope !== "working_tree" || requestedBaseline !== "HEAD")) {
      throw new AgentError("POLICY_DENIED", "Only HEAD is accepted as an explicit Git revision baseline");
    }
    const baseline = scope === "staged" ? "staged" : requestedBaseline === "HEAD" ? "head" : "worktree";
    return this.git.diff({ baseline, ...paths, ...maximum }, signal);
  }

  private requireSnapshotDiff(): SnapshotDiffInspector {
    if (this.snapshotDiff === undefined) {
      throw new AgentError("PROTOCOL_INVALID", "Checkpoint-backed diff service is unavailable");
    }
    return this.snapshotDiff;
  }
}

/** Use only when an outer, authoritative policy layer already approved the call. */
export const preauthorizedToolPolicy: ToolPolicyEvaluator = {
  authorize: () => ({ outcome: "allow", reasonCode: "PREAUTHORIZED" }),
};

function validateCall(call: ToolHostCall): void {
  if (!isOperationId(call.operationId)) {
    throw new AgentError("PROTOCOL_INVALID", "Tool operation identifier is invalid");
  }
  if (
    ![
      "list_files",
      "search_text",
      "read_file",
      "git_status",
      "git_diff",
      "edit_text",
      "apply_patch",
      "run_command",
    ].includes(call.name)
  ) {
    throw new AgentError("PROTOCOL_INVALID", "Tool name is not supported", { tool: call.name });
  }
  checkedObject(call.arguments, Object.keys(call.arguments));
}

function checkedObject(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentError("PROTOCOL_INVALID", "Tool arguments must be an object");
  }
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    throw new AgentError("PROTOCOL_INVALID", "Tool arguments contain unknown fields", { fields: unknown });
  }
  return value;
}

function requiredString(value: Readonly<Record<string, unknown>>, key: string): string {
  const entry = value[key];
  if (typeof entry !== "string") {
    throw new AgentError("PROTOCOL_INVALID", `${key} must be a string`);
  }
  return entry;
}

function requiredNumber(value: Readonly<Record<string, unknown>>, key: string): number {
  const entry = value[key];
  if (typeof entry !== "number") {
    throw new AgentError("PROTOCOL_INVALID", `${key} must be a number`);
  }
  return entry;
}

function optionalString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): { readonly path?: string } {
  const entry = value[key];
  if (entry === undefined) {
    return {};
  }
  if (typeof entry !== "string") {
    throw new AgentError("PROTOCOL_INVALID", `${key} must be a string`);
  }
  return { path: entry };
}

function optionalStringValue(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const entry = value[key];
  if (entry === undefined) {
    return undefined;
  }
  if (typeof entry !== "string") {
    throw new AgentError("PROTOCOL_INVALID", `${key} must be a string`);
  }
  return entry;
}

function optionalBoolean(value: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  const entry = value[key];
  if (entry === undefined) {
    return undefined;
  }
  if (typeof entry !== "boolean") {
    throw new AgentError("PROTOCOL_INVALID", `${key} must be a boolean`);
  }
  return entry;
}

function optionalNumberAs<K extends string>(
  value: Readonly<Record<string, unknown>>,
  key: string,
  outputKey: K,
): { readonly [P in K]?: number } {
  const entry = value[key];
  if (entry === undefined) {
    return {};
  }
  if (typeof entry !== "number" || !Number.isSafeInteger(entry)) {
    throw new AgentError("PROTOCOL_INVALID", `${key} must be an integer`);
  }
  return { [outputKey]: entry } as { readonly [P in K]?: number };
}

function optionalStringArrayAs<K extends string>(
  value: Readonly<Record<string, unknown>>,
  key: string,
  outputKey: K,
): { readonly [P in K]?: readonly string[] } {
  const entry = value[key];
  if (entry === undefined) {
    return {};
  }
  if (!Array.isArray(entry) || !entry.every((item) => typeof item === "string")) {
    throw new AgentError("PROTOCOL_INVALID", `${key} must be a string array`);
  }
  return { [outputKey]: entry } as unknown as { readonly [P in K]?: readonly string[] };
}

function optionalParameters(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, string | number | boolean | readonly string[]>> | undefined {
  const entry = value[key];
  if (entry === undefined) {
    return undefined;
  }
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new AgentError("PROTOCOL_INVALID", `${key} must be an object`);
  }
  for (const parameter of Object.values(entry)) {
    if (
      typeof parameter !== "string" &&
      typeof parameter !== "number" &&
      typeof parameter !== "boolean" &&
      !(Array.isArray(parameter) && parameter.every((item) => typeof item === "string"))
    ) {
      throw new AgentError("PROTOCOL_INVALID", "Command parameter has an invalid type");
    }
  }
  return entry as Readonly<Record<string, string | number | boolean | readonly string[]>>;
}

function successOutcome(
  call: ToolHostCall,
  data: Readonly<Record<string, unknown>>,
  safeMetadata: Readonly<Record<string, unknown>>,
): ToolHostOutcome {
  return { operationId: call.operationId, tool: call.name, status: "success", data, safeMetadata };
}

function failureOutcome(call: ToolHostCall, error: unknown): ToolHostOutcome {
  const code = error instanceof AgentError ? error.code : "INTERNAL_ERROR";
  const status =
    code === "STALE_STATE"
      ? "conflict"
      : code === "RECOVERY_REQUIRED"
        ? "indeterminate"
      : code === "COMMAND_TIMEOUT"
        ? "timeout"
        : code === "COMMAND_CANCELLED"
          ? "cancelled"
          : code === "POLICY_DENIED" || code === "PATH_PROTECTED"
            ? "denied"
            : "failure";
  const details = error instanceof AgentError ? error.details : {};
  return {
    operationId: call.operationId,
    tool: call.name,
    status,
    data: { code, message: errorMessage(error), details },
    safeMetadata: { errorCode: code },
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value as Readonly<Record<string, unknown>>;
}

function statusSummary(status: GitStatusResult): string {
  const untracked = status.entries.filter((entry) => entry.kind === "untracked").length;
  const changed = status.entries.length - untracked;
  return `${status.branch ?? "detached"}@${status.head ?? "unborn"}: ${String(changed)} changed, ${String(untracked)} untracked, ${status.hasConflicts ? "conflicts present" : "no conflicts"}`;
}

function boundUtf8(value: string, maxBytes: number): { readonly content: string; readonly truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { content: value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return { content: bytes.subarray(0, end).toString("utf8"), truncated: true };
}
