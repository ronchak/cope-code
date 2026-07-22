import path from "node:path";

import { AuditLog } from "../audit/audit-log.js";
import type { LoadedRuntimeConfiguration } from "../config/types.js";
import {
  AgentRuntime,
  type RuntimeProgressEvent,
} from "../orchestrator/agent-runtime.js";
import { CbaProtocolAdapter } from "../orchestrator/cba-protocol-adapter.js";
import type { UserInteraction } from "../orchestrator/contracts.js";
import { LayeredRuntimePolicy } from "../orchestrator/runtime-policy.js";
import {
  PolicyEngine,
  type BudgetLimits as PolicyBudgetLimits,
  type BudgetUsage as PolicyBudgetUsage,
  type SessionGrant,
} from "../policy/index.js";
import {
  DEFAULT_REPOSITORY_EXCLUSIONS,
  RepositoryContext,
} from "../repository/index.js";
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
import type { SessionStore } from "../session/store.js";
import {
  DEFAULT_BUDGET_LIMITS,
  type BudgetLimits,
  type SessionState,
} from "../session/types.js";
import {
  CommandCatalog,
  ProcessRunner,
  ToolHost,
  preauthorizedToolPolicy,
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
  readonly host: HostPlatform;
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
      maxFiles: state.budgetLimits.maxChangedFiles,
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
  const tools = new ToolHost({
    context: repository,
    processRunner,
    policy: preauthorizedToolPolicy,
    resultProcessor: contentSecurity,
    completionPathScope: policy,
    sessionDiffState: () => ({
      ...(state.lastCheckpointId === undefined ? {} : { lastCheckpointId: state.lastCheckpointId }),
      mutations: state.mutations.map((mutation) => ({
        checkpointId: mutation.checkpointId,
        changedPaths: mutation.changedPaths,
      })),
    }),
  });
  const protocol = new CbaProtocolAdapter({
    // Pending operations must be allowed through on recovery so the durable
    // journal can replay read-only work or classify a mutation indeterminate.
    seenOperationIds: () => new Set(state.completedOperationIds),
    pathKey: repository.boundary.pathKey.bind(repository.boundary),
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
    artifacts: new SessionArtifactStore(path.join(sessionDirectory, "artifacts")),
    completionHandoffs: new CompletionHandoffStore(
      path.join(sessionDirectory, "handoff"),
      state.sessionId,
      new SecretScanner(fingerprintKey),
    ),
    retainSourceArtifactsOnCompletion:
      configuration.repository.retention.retain_source_artifacts_on_completion,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
  return { runtime, audit, repository, disclosureLedger };
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
  return JSON.stringify({
    schema_version: "cba-effective-grant/1",
    mode: grant.mode,
    repository_root: grant.repository_root,
    branch: grant.branch ?? null,
    readable_paths: grant.capabilities.paths?.read?.allow ?? [],
    writable_paths: grant.capabilities.paths?.write?.allow ?? [],
    creatable_paths: grant.capabilities.paths?.create?.allow ?? [],
    deletable_paths: grant.capabilities.paths?.delete?.allow ?? [],
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
    command_ids: grant.capabilities.commands?.ids?.allow ?? [],
    command_categories: grant.capabilities.commands?.categories?.allow ?? [],
    session_command_definitions: sessionCommandDefinitions,
    command_constraints_by_layer: {
      organization: configuration.organizationPolicy.capabilities.commands ?? {},
      repository: configuration.repository.policy.capabilities.commands ?? {},
      session: grant.capabilities.commands ?? {},
    },
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
      patch_checkpoint: "durable before-image is written before every apply_patch mutation and sealed with verified post-state",
      commands: "granted sideEffects=true validation commands may create ordinary Git-ignored artifacts; every command must preserve Git-visible, protected, Git-control, and nested-repository state, and sideEffects=false commands additionally preserve bounded ignored-worktree state; intentional source-writing commands require a future versioned checkpointable write-scope contract",
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
    managed_policy: configuration.managedPolicy === undefined ? null : {
      source: "verified_local_bundle",
      ...configuration.managedPolicy.provenance,
      killSwitchEnabled: configuration.managedPolicy.killSwitch.enabled,
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
