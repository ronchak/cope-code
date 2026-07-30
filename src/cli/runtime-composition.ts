import path from "node:path";

import { AuditLog } from "../audit/audit-log.js";
import type { LoadedRuntimeConfiguration } from "../config/types.js";
import {
  AgentRuntime,
  type RuntimeProgressEvent,
} from "../orchestrator/agent-runtime.js";
import { CbaProtocolAdapter } from "../orchestrator/cba-protocol-adapter.js";
import type { UserInteraction } from "../orchestrator/contracts.js";
import {
  LayeredRuntimePolicy,
  listFilesRuntimeBounds,
} from "../orchestrator/runtime-policy.js";
import {
  PolicyEngine,
  type BudgetLimits as PolicyBudgetLimits,
  type BudgetUsage as PolicyBudgetUsage,
  type SessionGrant,
} from "../policy/index.js";
import {
  DEFAULT_MAX_CHECKPOINT_FILES,
  DEFAULT_REPOSITORY_EXCLUSIONS,
  RepositoryContext,
} from "../repository/index.js";
import { SnapshotDiffInspector } from "../repository/snapshot-diff.js";
import type {
  CheckpointFileSnapshot,
  CheckpointSnapshot,
} from "../repository/checkpoint.js";
import type {
  SessionMutationDiffRecord,
  TerminalBeforeImageResolution,
  TerminalSessionMutationDiffRecord,
} from "../repository/snapshot-diff.js";
import {
  ContentSecurity,
  DEFAULT_PROTECTED_RULES,
  DisclosureLedger,
  ProtectedPathPolicy,
  SecretScanner,
  loadFingerprintKey,
  loadOrCreateFingerprintKey,
  type ProtectedPathRule,
} from "../security/index.js";
import { sha256, stableJson } from "../shared/crypto.js";
import { AgentError } from "../shared/errors.js";
import { SessionArtifactStore } from "../session/artifact-store.js";
import { CompletionHandoffStore } from "../session/completion-handoff-store.js";
import { OperationJournal } from "../session/operation-journal.js";
import { TerminalArtifactPersistence } from "../session/terminal-artifacts.js";
import type { TerminalRecoveryContext } from "../session/terminal-artifacts.js";
import type { SessionStore } from "../session/store.js";
import {
  DEFAULT_BUDGET_LIMITS,
  type BudgetLimits,
  type SessionState,
} from "../session/types.js";
import {
  CommandCatalog,
  ProcessRunner,
  TerminalExecutor,
  ToolHost,
  preauthorizedToolPolicy,
  type TerminalLiveOutput,
} from "../tools/index.js";
import type { ModelTransport } from "../transport/index.js";
import { writeSessionGrant } from "./session-files.js";
import { resolveDefaultGitExecutable, type HostPlatform } from "../platform/index.js";

export interface ComposeRuntimeOptions {
  readonly state: SessionState;
  readonly store: SessionStore;
  readonly configuration: LoadedRuntimeConfiguration;
  readonly grant: SessionGrant;
  readonly transport: ModelTransport;
  readonly user: UserInteraction;
  readonly idFactory?: (prefix: string) => string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: RuntimeProgressEvent) => void;
  readonly onTerminalOutput?: TerminalLiveOutput;
  readonly host: HostPlatform;
  readonly recoveryContext?: TerminalRecoveryContext;
}

export interface ComposedRuntime {
  readonly runtime: AgentRuntime;
  readonly audit: AuditLog;
  readonly repository: RepositoryContext;
  readonly disclosureLedger: DisclosureLedger;
}

export async function composeRuntime(options: ComposeRuntimeOptions): Promise<ComposedRuntime> {
  const { state, store, configuration } = options;
  const gitExecutable = resolveDefaultGitExecutable(options.host);
  const sessionDirectory = store.sessionDirectory(state.sessionId);
  const audit = new AuditLog(path.join(sessionDirectory, "audit.jsonl"), state.sessionId);
  await audit.initialize();
  const disclosureLedger = new DisclosureLedger(state.sessionId, {
    outputFile: path.join(sessionDirectory, "disclosures.jsonl"),
  });
  await disclosureLedger.initialize();
  const fingerprintKeyFile = path.join(sessionDirectory, "fingerprint.key");
  const hasDurableRepositoryBaseline =
    Object.hasOwn(state, "repositoryBranchAtStart") && state.preExistingChangeStates !== undefined;
  const fingerprintKey = hasDurableRepositoryBaseline
    ? await loadFingerprintKey(fingerprintKeyFile)
    : await loadOrCreateFingerprintKey(fingerprintKeyFile);
  const contentSecurity = new ContentSecurity(new SecretScanner(fingerprintKey), disclosureLedger, {
    classification: configuration.repository.classification,
  });
  const preliminaryEngine = new PolicyEngine({
    organization: configuration.organizationPolicy,
    repository: configuration.repository.policy,
    session: options.grant,
  });
  const listFilesBounds = listFilesRuntimeBounds(preliminaryEngine);

  const protectedRules = combinedPathPatterns(configuration, "protected", options.grant).map((pattern): ProtectedPathRule => ({
    pattern,
    reason: "Path is protected by an effective policy layer",
  }));
  // Repository adapters are created before the runtime policy because the
  // latter needs the canonical boundary. The closure is fail-closed until
  // composition installs the policy, and adapter construction performs no
  // repository disclosure.
  let pathPolicy: LayeredRuntimePolicy | undefined;
  const repository = await RepositoryContext.create({
    repositoryRoot: state.repositoryRoot,
    checkpointDirectory: path.join(sessionDirectory, "checkpoints"),
    repositoryTools: {
      contentProcessor: contentSecurity,
      extraIgnorePatterns: combinedPathPatterns(configuration, "excluded", options.grant),
      maxSearchOutputBytes: configuration.repository.limits.max_search_output_bytes,
      maxFileBytes: configuration.repository.limits.max_file_bytes,
      maxReadBytes: configuration.repository.limits.max_read_bytes,
      defaultListResults: listFilesBounds.defaultResults,
      maxListResults: listFilesBounds.maxResults,
      isPathReadable: (candidate, operation) =>
        pathPolicy?.isReadPathAllowed(operation, candidate) ?? false,
    },
    git: {
      gitExecutable,
      maxDiffBytes: configuration.repository.limits.max_diff_bytes,
      fingerprintKey,
      integrityPatterns: protectedRules.map((rule) => rule.pattern),
    },
    checkpoints: {
      maxCheckpointBytes: configuration.repository.limits.max_checkpoint_bytes,
      // Structural entry bound shared with recovery (see commands.ts);
      // approved one-time file-budget expansions must never make an
      // execution-created checkpoint unloadable at rollback.
      maxFiles: DEFAULT_MAX_CHECKPOINT_FILES,
    },
    patchBudgets: {
      maxFiles: state.budgetLimits.maxChangedFiles,
      maxFileBytes: configuration.repository.limits.max_file_bytes,
      maxTotalBytes: configuration.repository.limits.max_patch_bytes,
      maxChangedLines: state.budgetLimits.maxChangedLines,
      allowCreate: state.mode !== "inspect",
      // The outer policy remains authoritative and can still deny or ask.
      allowDelete: state.mode !== "inspect",
    },
    protectedPaths: new ProtectedPathPolicy(protectedRules),
  });

  const commandCatalog = new CommandCatalog(configuration.repository.commands);
  const engine = new PolicyEngine({
    organization: configuration.organizationPolicy,
    repository: configuration.repository.policy,
    session: options.grant,
    pathKey: repository.boundary.pathKey.bind(repository.boundary),
  });
  const policy = new LayeredRuntimePolicy({
    engine,
    boundary: repository.boundary,
    commandCatalog,
    currentUsage: () => policyUsage(state),
    classification: configuration.repository.classification,
    defaultReadBytes: configuration.repository.limits.max_read_bytes,
    defaultSearchBytes: configuration.repository.limits.max_search_output_bytes,
    defaultDiffBytes: configuration.repository.limits.max_diff_bytes,
    maxMutationFileBytes: configuration.repository.limits.max_file_bytes,
    maxPatchBytes: configuration.repository.limits.max_patch_bytes,
    persistGrant: async (grant) => {
      const grantHash = await writeSessionGrant(sessionDirectory, grant);
      state.policyHashes.grant = grantHash;
      state.budgetLimits = sessionBudgetLimits(new PolicyEngine({
        organization: configuration.organizationPolicy,
        repository: configuration.repository.policy,
        session: grant,
        pathKey: repository.boundary.pathKey.bind(repository.boundary),
      }).getEffectiveBudgetLimits());
      state.updatedAt = new Date().toISOString();
      await store.write(state);
      await audit.append({
        type: "grant.established",
        taskId: state.taskId,
        data: { grantHash, expanded: true, approvedCapabilityCount: grant.approved_capabilities.length },
      });
    },
  });
  pathPolicy = policy;
  if (!hasDurableRepositoryBaseline) {
    const baseline = await repository.git.status();
    if (options.grant.branch !== undefined && baseline.branch !== options.grant.branch) {
      throw new AgentError(
        "RECOVERY_REQUIRED",
        `Repository branch changed after grant approval (expected ${options.grant.branch}, observed ${baseline.branch ?? "detached"})`,
      );
    }
    state.repositoryFingerprintAtStart = baseline.snapshotSha256;
    state.repositoryExcludedStateAtStart = baseline.excludedStateSha256;
    state.repositoryBranchAtStart = baseline.branch;
    state.repositoryHeadAtStart = baseline.head;
    state.preExistingChanges = baseline.entries
      .filter((entry) => entry.kind !== "ignored")
      .map((entry) => entry.path);
    state.preExistingChangeStates = Object.fromEntries(
      baseline.entries
        .filter((entry) => entry.kind !== "ignored")
        .map((entry) => [repository.boundary.pathKey(entry.path), entry.stateSha256]),
    );
    state.updatedAt = new Date().toISOString();
    await store.write(state);
  }
  const processRunner = new ProcessRunner(repository.boundary, commandCatalog, {
    contentProcessor: contentSecurity,
    host: options.host,
  });
  const artifacts = new SessionArtifactStore(
    path.join(sessionDirectory, "artifacts"),
  );
  const terminalPersistence = new TerminalArtifactPersistence(artifacts);
  const checkpointSnapshots = new Map<
    string,
    Promise<CheckpointSnapshot>
  >();
  const checkpointSnapshot = (
    checkpointId: string,
  ): Promise<CheckpointSnapshot> => {
    const existing = checkpointSnapshots.get(checkpointId);
    if (existing !== undefined) return existing;
    const loaded = repository.checkpoints.snapshot(checkpointId);
    checkpointSnapshots.set(checkpointId, loaded);
    return loaded;
  };
  let terminalBeforeImage:
    | ReturnType<TerminalArtifactPersistence["createBeforeImageResolver"]>
    | undefined;
  const resolveEarlierBaseline = async (
    target: TerminalSessionMutationDiffRecord | undefined,
    repositoryRelativePath: string,
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly baselineId: string;
        readonly entry: CheckpointFileSnapshot;
      }
    | Exclude<
        TerminalBeforeImageResolution,
        { readonly available: true }
      >
    | undefined
  > => {
    const mutation = earliestSessionBaselineMutation(
      state.mutations,
      target?.operationId,
      repositoryRelativePath,
      repository.boundary.pathKey.bind(repository.boundary),
    );
    if (mutation === undefined) return undefined;
    const key = repository.boundary.pathKey(repositoryRelativePath);
    if (mutation.kind !== "terminal") {
      const snapshot = await checkpointSnapshot(mutation.checkpointId);
      const entry = snapshot.entries.find(
        (candidate) =>
          repository.boundary.pathKey(candidate.path) === key,
      );
      if (entry === undefined) {
        throw new AgentError(
          "RECOVERY_REQUIRED",
          "Earlier patch mutation lacks its checkpoint baseline",
          { operationId: mutation.operationId },
        );
      }
      return { baselineId: snapshot.id, entry };
    }
    const resolver = terminalBeforeImage;
    if (resolver === undefined) return undefined;
    const terminalMutation = sessionMutationDiffRecord(mutation);
    if (terminalMutation.kind !== "terminal") return undefined;
    const resolved = await resolver(
      terminalMutation,
      repositoryRelativePath,
      signal,
    );
    return resolved.available
      ? {
          baselineId: resolved.baselineId,
          entry: resolved.entry,
        }
      : resolved;
  };
  terminalBeforeImage = terminalPersistence.createBeforeImageResolver({
    resolveReferences: async (mutation) => {
      const record = state.mutations.find(
        (candidate) =>
          candidate.kind === "terminal" &&
          candidate.operationId === mutation.operationId,
      );
      if (
        record?.kind !== "terminal" ||
        !("recordContract" in record) ||
        record.recordContract !== "terminal-mutation/2"
      ) {
        return undefined;
      }
      return {
        terminalResult: record.terminalResult,
        preObservation: record.preObservation,
      };
    },
    readGitBlob: async (objectId, signal) =>
      readTerminalGitBlob(
        repository,
        objectId,
        configuration.repository.limits.max_file_bytes,
        signal,
      ),
    readHeadPath: async (head, repositoryRelativePath, signal) =>
      readTerminalHeadPath(
        repository,
        head,
        repositoryRelativePath,
        configuration.repository.limits.max_file_bytes,
        signal,
      ),
    resolvePriorBaseline: (mutation, repositoryRelativePath, signal) =>
      resolveEarlierBaseline(mutation, repositoryRelativePath, signal),
    pathKey: repository.boundary.pathKey.bind(repository.boundary),
  });
  const snapshotDiff = new SnapshotDiffInspector(
    repository.boundary,
    repository.checkpoints,
    {
      maxDiffBytes: configuration.repository.limits.max_diff_bytes,
      maxFileBytes: configuration.repository.limits.max_file_bytes,
      maxFiles: DEFAULT_MAX_CHECKPOINT_FILES,
      isPathAllowed: (candidate) =>
        repository.tools.isPathAllowed(candidate, "git_diff"),
      resolveTerminalBeforeImage: terminalBeforeImage,
    },
  );
  const terminalExecutor = new TerminalExecutor({
    boundary: repository.boundary,
    process: processRunner,
    persistence: terminalPersistence,
    host: options.host,
    contentProcessor: contentSecurity,
    observer: repository.workspaceObserver,
    ...(options.onTerminalOutput === undefined
      ? {}
      : { onTerminalOutput: options.onTerminalOutput }),
  });
  const tools = new ToolHost({
    context: repository,
    snapshotDiff,
    processRunner,
    terminalExecutor,
    policy: preauthorizedToolPolicy,
    resultProcessor: contentSecurity,
    completionPathScope: policy,
    terminalBaseline: () => ({
      paths: state.preExistingChanges,
      ...(state.preExistingChangeStates === undefined
        ? {}
        : {
            pathStateFingerprints:
              state.preExistingChangeStates,
          }),
      hasReconstructibleBaseline: async (repositoryRelativePath) =>
        isReconstructibleSessionBaseline(
          await resolveEarlierBaseline(
            undefined,
            repositoryRelativePath,
          ),
        ),
    }),
    sessionDiffState: () => ({
      ...(state.lastCheckpointId === undefined ? {} : { lastCheckpointId: state.lastCheckpointId }),
      mutations: state.mutations.map(sessionMutationDiffRecord),
    }),
  });
  const protocol = new CbaProtocolAdapter({
    // Pending operations must be allowed through on recovery so the durable
    // journal can replay read-only work or classify a mutation indeterminate.
    seenOperationIds: () => new Set(state.completedOperationIds),
    pathKey: repository.boundary.pathKey.bind(repository.boundary),
    allowLegacyCorrelationRebind:
      options.transport.transportKind === "visible-browser-m365-copilot/v1",
  });
  const runtime = new AgentRuntime({
    state,
    store,
    journal: new OperationJournal(path.join(sessionDirectory, "operations"), state.sessionId),
    audit,
    protocol,
    policy,
    tools,
    transport: options.transport,
    disclosure: contentSecurity,
    user: options.user,
    completionRequirements: {
      requiredCommandIds: configuration.repository.completion.required_command_ids,
      requireValidationAfterLastMutation:
        configuration.repository.completion.require_validation_after_last_mutation,
      requireCleanPendingOperations: true,
    },
    ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    artifacts,
    recoveryContext:
      options.recoveryContext ?? "ordinary_process_crash",
    completionHandoffs: new CompletionHandoffStore(
      path.join(sessionDirectory, "handoff"),
      state.sessionId,
      new SecretScanner(fingerprintKey),
    ),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
  return { runtime, audit, repository, disclosureLedger };
}

export function isReconstructibleSessionBaseline(
  resolution:
    | { readonly baselineId: string }
    | { readonly available: false }
    | undefined,
): boolean {
  return resolution !== undefined && !("available" in resolution);
}

export function sessionMutationDiffRecord(
  mutation: SessionState["mutations"][number],
): SessionMutationDiffRecord {
  if (mutation.kind !== "terminal") {
    return {
      checkpointId: mutation.checkpointId,
      changedPaths: mutation.changedPaths,
    };
  }
  return {
    kind: "terminal",
    operationId: mutation.operationId,
    changedPaths: mutation.changedPaths,
    observationOutcome: mutation.observationOutcome,
    renamedPaths: mutation.renamedPaths,
    ...("recordContract" in mutation &&
    mutation.recordContract === "terminal-mutation/2"
      ? {
          changedPathCount: mutation.changedPathCount,
          pathFactsTruncated: mutation.pathFactsTruncated,
        }
      : {}),
  };
}

export function earliestSessionBaselineMutation(
  mutations: SessionState["mutations"],
  targetOperationId: string | undefined,
  repositoryRelativePath: string,
  pathKey: (value: string) => string,
): SessionState["mutations"][number] | undefined {
  const targetIndex =
    targetOperationId === undefined
      ? mutations.length
      : mutations.findIndex(
          (mutation) =>
            mutation.kind === "terminal" &&
            mutation.operationId === targetOperationId,
        );
  const end = targetIndex < 0 ? mutations.length : targetIndex;
  const key = pathKey(repositoryRelativePath);
  return mutations
    .slice(0, end)
    .find(
      (mutation) =>
        mutation.changedPaths.some(
          (candidate) => pathKey(candidate) === key,
        ) ||
        (
          mutation.kind === "terminal" &&
          (
            mutation.observationOutcome ===
              "protected_or_hidden_changed" ||
            (
              mutation.observationOutcome === "unknown" &&
              mutation.changedPaths.length === 0
            ) ||
            (
              "recordContract" in mutation &&
              mutation.recordContract === "terminal-mutation/2" &&
              mutation.changedPathCount >
                mutation.changedPaths.length
            )
          )
        ),
    );
}

async function readTerminalGitBlob(
  repository: RepositoryContext,
  objectId: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer | undefined> {
  try {
    const result = await repository.git.readIsolated(
      ["cat-file", "blob", objectId],
      maxBytes,
      signal,
      true,
    );
    return result.truncated ? undefined : result.bytes;
  } catch (error) {
    if (error instanceof AgentError && error.code === "COMMAND_FAILED") {
      return undefined;
    }
    throw error;
  }
}

async function readTerminalHeadPath(
  repository: RepositoryContext,
  head: string,
  repositoryRelativePath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<
  | {
      readonly objectId: string;
      readonly mode: number;
      readonly bytes: Buffer;
    }
  | undefined
> {
  const tree = await repository.git.readIsolated(
    ["ls-tree", "-z", head, "--", repositoryRelativePath],
    64 * 1024,
    signal,
  );
  if (tree.bytes.length === 0) return undefined;
  const terminator = tree.bytes.indexOf(0);
  const record =
    terminator < 0 ? tree.bytes : tree.bytes.subarray(0, terminator);
  const tab = record.indexOf(9);
  if (tab < 0) return undefined;
  const fields = record.subarray(0, tab).toString("utf8").split(" ");
  const observedPath = record.subarray(tab + 1).toString("utf8");
  const mode = Number.parseInt(fields[0] ?? "", 8);
  const objectId = fields[2];
  if (
    fields[1] !== "blob" ||
    observedPath !== repositoryRelativePath ||
    !Number.isSafeInteger(mode) ||
    objectId === undefined ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(objectId)
  ) {
    return undefined;
  }
  const bytes = await readTerminalGitBlob(
    repository,
    objectId,
    maxBytes,
    signal,
  );
  return bytes === undefined ? undefined : { objectId, mode, bytes };
}

export function sessionBudgetLimits(effective: PolicyBudgetLimits): BudgetLimits {
  return {
    maxTurns: bounded(effective.turns, DEFAULT_BUDGET_LIMITS.maxTurns),
    maxOperations: bounded(effective.operations, DEFAULT_BUDGET_LIMITS.maxOperations),
    maxElapsedMs: bounded(effective.elapsed_ms, DEFAULT_BUDGET_LIMITS.maxElapsedMs),
    maxReadFiles: bounded(effective.read_files, DEFAULT_BUDGET_LIMITS.maxReadFiles),
    maxDisclosedBytes: bounded(effective.disclosed_bytes, DEFAULT_BUDGET_LIMITS.maxDisclosedBytes),
    maxChangedFiles: bounded(effective.changed_files, DEFAULT_BUDGET_LIMITS.maxChangedFiles),
    maxChangedLines: bounded(effective.changed_lines, DEFAULT_BUDGET_LIMITS.maxChangedLines),
    maxCommands: bounded(effective.commands, DEFAULT_BUDGET_LIMITS.maxCommands),
    maxCommandOutputBytes: bounded(
      effective.command_output_bytes,
      DEFAULT_BUDGET_LIMITS.maxCommandOutputBytes,
    ),
    maxProtocolRepairs: bounded(effective.protocol_repairs, DEFAULT_BUDGET_LIMITS.maxProtocolRepairs),
  };
}

export function policyUsage(state: SessionState): PolicyBudgetUsage {
  const elapsed = Date.now() - Date.parse(state.startedAt);
  return {
    elapsed_ms: Number.isSafeInteger(elapsed) && elapsed > 0 ? elapsed : 0,
    turns: state.budgetUsage.turns,
    operations: state.budgetUsage.operations,
    read_files: state.budgetUsage.readFiles,
    changed_files: state.budgetUsage.changedFiles,
    changed_lines: state.budgetUsage.changedLines,
    disclosed_bytes: state.budgetUsage.disclosedBytes,
    commands: state.budgetUsage.commands,
    command_output_bytes: state.budgetUsage.commandOutputBytes,
    protocol_repairs: state.budgetUsage.protocolRepairs,
  };
}

export function effectiveGrantSummary(
  configuration: LoadedRuntimeConfiguration,
  grant: SessionGrant,
): string {
  const engine = new PolicyEngine({
    organization: configuration.organizationPolicy,
    repository: configuration.repository.policy,
    session: grant,
  });
  const sessionCommandIds = new Set(grant.capabilities.commands?.ids?.allow ?? []);
  const sessionCommandDefinitions = configuration.repository.commands
    .filter((command) => sessionCommandIds.has(command.id))
    .map((command) => ({
      id: command.id,
      description: command.description ?? null,
      executable: command.executable,
      fixed_arguments: command.fixedArguments ?? [],
      parameter_definitions: command.parameters ?? [],
      working_directory: command.workingDirectory ?? ".",
      environment_keys: Object.keys(command.environment ?? {}).sort(),
      category: command.category,
      risk: command.risk,
      side_effects: command.sideEffects,
      network_required: command.networkRequired,
      network_hosts: command.networkHosts ?? [],
      timeout_ms: command.timeoutMs ?? null,
      max_timeout_ms: command.maxTimeoutMs ?? null,
    }));
  const readablePaths = grant.capabilities.paths?.read?.allow ?? [];
  const writablePaths = grant.capabilities.paths?.write?.allow ?? [];
  const creatablePaths = grant.capabilities.paths?.create?.allow ?? [];
  const deletablePaths = grant.capabilities.paths?.delete?.allow ?? [];
  const commandIds = grant.capabilities.commands?.ids?.allow ?? [];
  const commandCategories = grant.capabilities.commands?.categories?.allow ?? [];
  const terminalActive =
    grant.mode === "auto" &&
    (grant.capabilities.tools?.allow ?? []).includes("terminal_exec");
  const canWrite = grant.mode !== "inspect" &&
    writablePaths.length + creatablePaths.length + deletablePaths.length > 0;
  const canRunCommands = grant.mode !== "inspect" &&
    (commandIds.length + commandCategories.length > 0 || terminalActive);
  const effectiveMode = terminalActive
    ? "developer"
    : canWrite || canRunCommands
    ? grant.mode === "auto" ? "policy-auto" : "edit-capable"
    : "inspect-only";
  return JSON.stringify({
    schema_version: "cba-effective-grant/1",
    mode: grant.mode,
    requested_mode: grant.mode,
    effective_mode: effectiveMode,
    can_read: readablePaths.length > 0,
    can_write: canWrite,
    can_run_commands: canRunCommands,
    repository_root: grant.repository_root,
    branch: grant.branch ?? null,
    readable_paths: readablePaths,
    writable_paths: writablePaths,
    creatable_paths: creatablePaths,
    deletable_paths: deletablePaths,
    path_scope: {
      mandatory_excluded: DEFAULT_REPOSITORY_EXCLUSIONS,
      mandatory_protected: DEFAULT_PROTECTED_RULES.map((rule) => rule.pattern),
      effective_excluded: effectivePathControls(configuration, grant, "excluded", DEFAULT_REPOSITORY_EXCLUSIONS),
      effective_protected: effectivePathControls(
        configuration,
        grant,
        "protected",
        DEFAULT_PROTECTED_RULES.map((rule) => rule.pattern),
      ),
      rules_by_layer: {
        organization: configuration.organizationPolicy.capabilities.paths ?? {},
        repository: configuration.repository.policy.capabilities.paths ?? {},
        session: grant.capabilities.paths ?? {},
      },
      precedence: "deny > ask > allow; every descendant path is evaluated independently",
    },
    command_ids: commandIds,
    command_categories: commandCategories,
    session_command_definitions: sessionCommandDefinitions,
    command_constraints_by_layer: {
      organization: configuration.organizationPolicy.capabilities.commands ?? {},
      repository: configuration.repository.policy.capabilities.commands ?? {},
      session: grant.capabilities.commands ?? {},
    },
    ...(terminalActive
      ? {
          terminal: {
            active: true,
            runs_as: "current-user",
            cwd_scope: "project-relative-starting-directory",
            isolation: "not-an-os-sandbox",
            network: "ordinary-child-access-not-restricted-by-cope",
            local_git: "allowed-and-observed-after-execution",
            effects: "bounded-local-repository-observation",
            output: "bounded-local-and-model-visible-results",
          },
        }
      : {}),
    disclosure_classifications: grant.capabilities.disclosure?.classifications?.allow ?? [],
    disclosure_constraints_by_layer: {
      organization: configuration.organizationPolicy.capabilities.disclosure ?? {},
      repository: configuration.repository.policy.capabilities.disclosure ?? {},
      session: grant.capabilities.disclosure ?? {},
    },
    network: {
      session_access: grant.capabilities.network?.access ?? "deny",
      constraints_by_layer: {
        organization: configuration.organizationPolicy.capabilities.network ?? {},
        repository: configuration.repository.policy.capabilities.network ?? {},
        session: grant.capabilities.network ?? {},
      },
    },
    change_authority: {
      constraints_by_layer: {
        organization: configuration.organizationPolicy.capabilities.changes ?? {},
        repository: configuration.repository.policy.capabilities.changes ?? {},
        session: grant.capabilities.changes ?? {},
      },
      note: "create, delete, dependency-manifest, local-commit, and per-operation limits use the most restrictive layer",
    },
    effective_budgets: engine.getEffectiveBudgetLimits(),
    checkpoint_and_rollback: {
      patch_checkpoint: "durable before-image is written before every edit_text or apply_patch mutation and sealed with verified post-state",
      commands: terminalActive
        ? "terminal commands run as the current user and are bracketed by durable bounded repository observations; arbitrary commands are not atomic and may have effects outside observable local repository state"
        : "granted sideEffects=true validation commands may create ordinary Git-ignored artifacts; every catalog command must preserve Git-visible, protected, Git-control, and nested-repository state",
      storage: "outside the repository in the protected session state directory",
      rollback: "sealed checkpoints use compare-and-restore; interrupted unsealed checkpoints require explicit --force",
      stale_guard: "rollback refuses to overwrite files changed after the recorded agent mutation unless explicitly forced",
    },
    escalation: {
      inside_grant: "no repeated approval",
      ask: "a capability-specific policy result pauses the exact operation",
      allow_once: "bound only to that exact pending operation and not persisted as broader authority",
      allow_session: "persists a bounded grant expansion only when organization and repository policy permit it",
      deny: "non-overridable constraints, protected/excluded paths, secrets, and hard budget limits cannot be expanded",
    },
    policy_hashes: {
      organization: configuration.hashes.organization,
      repository: configuration.hashes.repository,
      grant: sha256(stableJson(grant)),
    },
  }, null, 2);
}

function combinedPathPatterns(
  configuration: LoadedRuntimeConfiguration,
  kind: "excluded" | "protected",
  grant?: SessionGrant,
): readonly string[] {
  return [...new Set([
    ...(configuration.organizationPolicy.capabilities.paths?.[kind] ?? []),
    ...(configuration.repository.policy.capabilities.paths?.[kind] ?? []),
    ...(grant?.capabilities.paths?.[kind] ?? []),
  ])];
}

function effectivePathControls(
  configuration: LoadedRuntimeConfiguration,
  grant: SessionGrant,
  kind: "excluded" | "protected",
  mandatory: readonly string[],
): readonly string[] {
  return [...new Set([
    ...mandatory,
    ...combinedPathPatterns(configuration, kind, grant),
  ])].sort();
}

function bounded(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : value;
}
