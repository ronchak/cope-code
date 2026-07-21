import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
} from "node:fs/promises";
import path from "node:path";

import { AuditLog } from "../audit/audit-log.js";
import { browserProductPresentation, launchBrowserCopilotTransport } from "../browser/index.js";
import { loadRuntimeConfiguration } from "../config/loader.js";
import type { LoadedRuntimeConfiguration } from "../config/types.js";
import type { RuntimeProgressEvent } from "../orchestrator/agent-runtime.js";
import { LayeredRuntimePolicy } from "../orchestrator/runtime-policy.js";
import {
  PolicyEngine,
  createDefaultSessionGrant,
  type SessionGrant,
} from "../policy/index.js";
import { runHostEligibilityPreflight, runMachinePreflight } from "../preflight/machine.js";
import {
  CheckpointStore,
  GitInspector,
  RepositoryBoundary,
  type RepositoryContext,
} from "../repository/index.js";
import { createReviewPackage } from "../review/index.js";
import {
  DisclosureLedger,
  SecretScanner,
  loadFingerprintKey,
  type DisclosureRecord,
} from "../security/index.js";
import { newId, sha256, stableJson } from "../shared/crypto.js";
import { AgentError, errorMessage } from "../shared/errors.js";
import { CommandCatalog } from "../tools/command-catalog.js";
import { resolveStateHome } from "../session/paths.js";
import {
  CompletionHandoffStore,
  type CompletionHandoffRecord,
} from "../session/completion-handoff-store.js";
import { allowedTransitions, isTerminal, transitionSession } from "../session/state-machine.js";
import { SessionStore, type WorkspaceLock } from "../session/store.js";
import {
  SESSION_SCHEMA_VERSION,
  type SessionState,
  type SessionStatus,
  zeroBudgetUsage,
} from "../session/types.js";
import type { ModelTransport } from "../transport/index.js";
import type { CliCommand, TransportSelection } from "./arguments.js";
import {
  SessionControlMonitor,
  type ActiveRuntimeControl,
  type ControlAction,
  writeControlRequest,
} from "./control-channel.js";
import { loadCliFixture } from "./fixture-loader.js";
import { inspectReplayIdentity, loadReplayTransport } from "./replay-loader.js";
import {
  composeRuntime,
  effectiveGrantSummary,
  sessionBudgetLimits,
} from "./runtime-composition.js";
import {
  SESSION_RUNTIME_MANIFEST_VERSION,
  assertBrowserRuntimeManifestMatches,
  readRuntimeManifest,
  readSessionGrant,
  sourceFileIdentity,
  writeRuntimeManifest,
  writeSessionGrant,
  type SessionRuntimeManifest,
} from "./session-files.js";
import { TerminalUserInteraction } from "./terminal-user.js";
import { executeDoctorCommand } from "./doctor.js";
import { executeUpdateCommand } from "./update.js";
import { pinBrowserConfigurationForSession } from "./setup-transaction.js";
import { executeDemoCommand } from "./demo.js";
import { renderHumanResult } from "./friendly-output.js";
import { executeInteractiveCommand } from "./interactive.js";
import { writeRepositoryConfiguration, executeSetupCommand } from "./onboarding.js";
import { executeSessionsCommand } from "./sessions.js";
import { resolveWorkspace } from "./workspace.js";
import { cyan, dim, green, symbols, yellow } from "./presentation.js";
import {
  CURRENT_HOST_PLATFORM,
  resolveDefaultGitExecutable,
  type HostPlatform,
} from "../platform/index.js";
import { verifyPrivateStateHome } from "../platform/private-storage.js";

export const CLI_VERSION = "0.1.2";

export interface CliIo {
  readonly stdout: { write(value: string): unknown };
  readonly stderr: { write(value: string): unknown };
}

export interface CommandDependencies {
  readonly host: HostPlatform;
}

export async function executeCommand(
  command: CliCommand,
  io: CliIo,
  dependencies: CommandDependencies = { host: CURRENT_HOST_PLATFORM },
): Promise<number> {
  const { host } = dependencies;
  if (isWriteCapableCommand(command.command)) host.assertNonPrivileged();
  if (command.command === "interactive") {
    await earlyDarwinEligibility(host, command.transport === "edge");
  }
  switch (command.command) {
    case "help":
      io.stdout.write(helpText(command.advanced));
      return 0;
    case "version":
      io.stdout.write(`${CLI_VERSION}\n`);
      return 0;
    case "interactive":
      return executeInteractiveCommand(
        command,
        io,
        (next, nextIo) => executeCommand(next, nextIo, { host }),
        CLI_VERSION,
        host,
      );
    case "demo":
      return executeDemoCommand(command, io, CLI_VERSION);
    case "setup":
      return executeSetupCommand(command, io, host);
    case "doctor":
      return executeDoctorCommand(command, io, host);
    case "update":
      return executeUpdateCommand(command, io, host);
    case "sessions":
      return executeSessionsCommand(command, io, host);
    case "init":
      return initializeRepository(command, io);
    case "run":
      return runNewSession(command, io, host);
    case "resume":
      return resumeSession(command, io, host);
    case "status":
      return showStatus(command, io, host);
    case "pause":
      return controlSession(command, "pause", io, host);
    case "abort":
      return controlSession(command, "abort", io, host);
    case "rollback":
      return rollbackSession(command, io, host);
    case "verify-audit":
      return verifyAudit(command, io, host);
    case "export-review":
      return exportReview(command, io, host);
  }
}

function isWriteCapableCommand(command: CliCommand["command"]): boolean {
  return !["help", "version", "demo", "doctor", "sessions", "status", "verify-audit"].includes(command);
}

async function earlyDarwinEligibility(
  host: HostPlatform,
  liveBrowser: boolean,
): Promise<void> {
  if (host.platform !== "darwin") return undefined;
  await runHostEligibilityPreflight({ liveBrowser, host });
}

async function initializeRepository(
  command: Extract<CliCommand, { readonly command: "init" }>,
  io: CliIo,
): Promise<number> {
  const interactive = !command.json && process.stdin.isTTY === true && process.stdout.isTTY === true;
  const workspace = await resolveWorkspace(command.repository, { interactive, output: io.stdout });
  const result = await writeRepositoryConfiguration({
    repositoryRoot: workspace.repositoryRoot,
    profile: command.quick ? "standard" : "manual",
    force: command.force,
  });
  output(command.json, io, {
    initialized: true,
    repository: workspace.repositoryRoot,
    configuration: result.filename,
    profile: result.profile,
    validationCommands: result.commandCount,
    next: command.quick
      ? "Run cope in this project."
      : "Review writable paths and commands, or rerun with cope init --quick for the guided editing profile.",
  });
  return 0;
}

async function runNewSession(
  command: Extract<CliCommand, { readonly command: "run" }>,
  io: CliIo,
  host: HostPlatform,
): Promise<number> {
  await earlyDarwinEligibility(host, command.transport === "edge");
  const gitExecutable = resolveDefaultGitExecutable(host);
  const boundary = await RepositoryBoundary.discover(command.repository, gitExecutable);
  const stateHome = await prepareStateHome(command.stateHome ?? resolveStateHome(process.env, host), boundary.root, host);
  const configuration = await loadRuntimeConfiguration({
    repositoryRoot: boundary.root,
    stateHome,
    requireBrowser: command.transport === "edge",
    host,
  });
  await runMachinePreflight({
    repositoryRoot: boundary.root,
    liveBrowser: command.transport === "edge",
    ...(configuration.browser === undefined ? {} : {
      browserProduct: configuration.browser.product,
      browserExecutable: configuration.browser.browserExecutable,
      ...(configuration.browser.browserVersion === undefined ? {} : { browserVersion: configuration.browser.browserVersion }),
    }),
    host,
    gitExecutable,
  });
  const source = await selectedSource(command.transport, command.fixture, command.transcript);
  const replayIdentity = command.transport === "replay" && source !== undefined
    ? await inspectReplayIdentity(source.canonicalPath)
    : undefined;
  const sessionId = command.transport === "replay" && source !== undefined
    ? `session_replay_${source.sha256.slice(0, 32)}`
    : newId("session");
  const taskId = replayIdentity?.taskId ?? newId("task");
  const store = new SessionStore(stateHome);
  const now = new Date().toISOString();
  const lock = await store.acquireWorkspaceLock(boundary.root, sessionId, now);
  let state: SessionState | undefined;
  let audit: AuditLog | undefined;
  let monitor: SessionControlMonitor | undefined;
  let transport: ModelTransport | undefined;
  const setupControl = new DeferredRuntimeControl();
  const onSignal = (): void => { void setupControl.requestPause("Operator interrupted the active CLI"); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    // Establish branch identity without ever retaining policy-denied paths.
    // The ephemeral key ensures even a crash before runtime composition cannot
    // leave dictionary-guessable hidden-state fingerprints in session data.
    const bootstrapFingerprintKey = randomBytes(32);
    const identityStatus = await new GitInspector(boundary, {
      gitExecutable,
      maxDiffBytes: configuration.repository.limits.max_diff_bytes,
      fingerprintKey: bootstrapFingerprintKey,
      isPathAllowed: () => false,
    }).status();
    const grant = createGrant(configuration, {
      taskId,
      repositoryRoot: boundary.root,
      ...(identityStatus.branch === null ? {} : { branch: identityStatus.branch }),
      mode: command.mode,
    });
    const engine = new PolicyEngine({
      organization: configuration.organizationPolicy,
      repository: configuration.repository.policy,
      session: grant,
      pathKey: boundary.pathKey.bind(boundary),
    });
    const initialPolicy = new LayeredRuntimePolicy({
      engine,
      boundary,
      commandCatalog: new CommandCatalog(configuration.repository.commands),
      currentUsage: emptyPolicyUsage,
      classification: configuration.repository.classification,
      defaultReadBytes: configuration.repository.limits.max_read_bytes,
      defaultSearchBytes: configuration.repository.limits.max_search_output_bytes,
      defaultDiffBytes: configuration.repository.limits.max_diff_bytes,
    });
    const initialStatus = await new GitInspector(boundary, {
      gitExecutable,
      maxDiffBytes: configuration.repository.limits.max_diff_bytes,
      fingerprintKey: bootstrapFingerprintKey,
      integrityPatterns: policyProtectedPatterns(configuration, grant),
      isPathAllowed: (candidate, operation) => initialPolicy.isReadPathAllowed(operation, candidate),
    }).status();
    const grantHash = sha256(stableJson(grant));
    state = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      protocolVersion: "cba/1",
      sessionId,
      taskId,
      repositoryRoot: boundary.root,
      repositoryFingerprintAtStart: initialStatus.snapshotSha256,
      repositoryExcludedStateAtStart: initialStatus.excludedStateSha256,
      preExistingChanges: initialStatus.entries
        .filter((entry) => entry.kind !== "ignored")
        .map((entry) => entry.path),
      objective: command.objective,
      acceptanceCriteria: command.acceptanceCriteria,
      mode: command.mode,
      status: "created",
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      policyHashes: {
        organization: configuration.hashes.organization,
        repository: configuration.hashes.repository,
        grant: grantHash,
      },
      budgetLimits: sessionBudgetLimits(engine.getEffectiveBudgetLimits()),
      budgetUsage: zeroBudgetUsage(),
      turnSequence: 0,
      mutationSequence: 0,
      pendingOperations: [],
      completedOperationIds: [],
      mutations: [],
      validations: [],
      protocolRepairStreak: 0,
    };
    await store.create(state);
    const sessionDirectory = store.sessionDirectory(sessionId);
    audit = new AuditLog(path.join(sessionDirectory, "audit.jsonl"), sessionId);
    await audit.append({
      type: "session.created",
      taskId,
      data: {
        mode: command.mode,
        repositoryFingerprint: initialStatus.snapshotSha256,
        preExistingChangeCount: state.preExistingChanges.length,
      },
    });
    await moveState(state, "preflight", store, audit);
    await writeSessionGrant(sessionDirectory, grant);
    if (command.transport === "edge") {
      const expectedBrowserHash = configuration.hashes.browser;
      if (expectedBrowserHash === undefined) {
        throw new AgentError("CONFIG_INVALID", "Live browser configuration hash is unavailable");
      }
      await pinBrowserConfigurationForSession({
        stateHome,
        expectedBrowserHash,
        loadCurrent: async () => loadRuntimeConfiguration({
          repositoryRoot: boundary.root,
          stateHome,
          requireBrowser: true,
          host,
        }),
        writeManifest: async (pinnedConfiguration) => {
          await writeRuntimeManifest(
            sessionDirectory,
            createRuntimeManifest(command.transport, source, pinnedConfiguration, now),
          );
        },
      });
    } else {
      const runtimeManifest = createRuntimeManifest(command.transport, source, configuration, now);
      await writeRuntimeManifest(sessionDirectory, runtimeManifest);
    }
    await moveState(state, "grant_pending", store, audit);

    const user = terminalUser(command.json, io);
    const approved = await user.approveInitialGrant(
      effectiveGrantSummary(configuration, grant),
      command.approveGrant,
    );
    if (!approved) {
      await moveState(state, "aborted", store, audit, "Initial session grant was declined");
      output(command.json, io, sessionResult(state, "Initial session grant was declined"));
      return 2;
    }
    await audit.append({
      type: "grant.established",
      taskId,
      data: { grantHash, approvedCapabilityCount: grant.approved_capabilities.length },
    });
    await moveState(state, "transport_starting", store, audit);
    monitor = new SessionControlMonitor(sessionDirectory, sessionId, setupControl);
    monitor.start();
    const prepared = await prepareTransport(command.transport, source?.canonicalPath, state, configuration, io, setupControl, host);
    transport = prepared.transport;
    setupControl.bindTransport(transport);
    const composed = await composeRuntime({
      state,
      store,
      configuration,
      grant,
      transport,
      user,
      ...(prepared.idFactory === undefined ? {} : { idFactory: prepared.idFactory }),
      onProgress: progressReporter(command.json, io),
      host,
    });
    setupControl.bindRuntime(composed.runtime);
    const result = await composed.runtime.run();
    const currentGrant = await readSessionGrant(sessionDirectory);
    const completionHandoff = await readCompletionHandoff(state, sessionDirectory);
    const finalRepository = result.status === "completed"
      ? await finalRepositoryHandoff(
          composed.repository,
          configuration.repository.limits.max_diff_bytes,
          sessionDirectory,
          result.completion?.actual.repositoryFingerprint,
        )
      : undefined;
    output(command.json, io, {
      ...result,
      ...(completionHandoff === undefined
        ? {}
        : { modelSummary: completionHandoff.claim.summary, modelReport: completionHandoff.claim }),
      handoff: sessionResult(
        state,
        undefined,
        currentGrant,
        disclosureSummary(composed.disclosureLedger.records()),
        finalRepository,
        completionHandoff,
      ),
    });
    return result.status === "completed"
      ? finalRepository?.known === true && finalRepository.matchesVerifiedCompletion === true ? 0 : 1
      : result.status === "paused" ? 2 : 1;
  } catch (error) {
    if (state !== undefined && audit !== undefined && !isTerminal(state.status) && state.status !== "paused") {
      const requested = setupControl.requestedAction;
      const target = requested === "pause" ? "paused" : requested === "abort" ? "aborted" : "failed";
      if (allowedTransitions(state.status).includes(target)) {
        await moveState(state, target, store, audit, errorMessage(error), error);
      }
    }
    throw error;
  } finally {
    await monitor?.stop().catch(() => undefined);
    await transport?.close().catch(() => undefined);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await lock.release();
  }
}

async function resumeSession(
  command: Extract<CliCommand, { readonly command: "resume" }>,
  io: CliIo,
  host: HostPlatform,
): Promise<number> {
  const stateHome = path.resolve(command.stateHome ?? resolveStateHome(process.env, host));
  await verifyPrivateStateHome(stateHome, host);
  const store = new SessionStore(stateHome);
  let state = await store.read(command.sessionId);
  if (isTerminal(state.status)) {
    throw new AgentError("RECOVERY_REQUIRED", `Session is terminal (${state.status}) and cannot be resumed`);
  }
  const sessionDirectory = store.sessionDirectory(state.sessionId);
  const manifest = await readRuntimeManifest(sessionDirectory);
  const selection = command.transport ?? manifest.transport;
  if (selection !== manifest.transport) {
    throw new AgentError("RECOVERY_REQUIRED", "Transport switching is forbidden for an existing session", {
      recorded: manifest.transport,
      requested: selection,
    });
  }
  await earlyDarwinEligibility(host, selection === "edge");
  const requestedSource = await selectedSource(selection, command.fixture, command.transcript, manifest.source_file);
  if (manifest.source_file !== requestedSource?.canonicalPath || manifest.source_sha256 !== requestedSource?.sha256) {
    throw new AgentError("RECOVERY_REQUIRED", "Pinned offline transport source changed since session creation");
  }
  const boundary = await RepositoryBoundary.create(state.repositoryRoot);
  const canonicalStateHome = await prepareStateHome(stateHome, boundary.root, host);
  const configuration = await loadRuntimeConfiguration({
    repositoryRoot: boundary.root,
    stateHome: canonicalStateHome,
    requireBrowser: selection === "edge",
    host,
  });
  assertConfigurationUnchanged(state, manifest, configuration);
  const grant = await readSessionGrant(sessionDirectory);
  assertGrantMatchesState(grant, state);
  await runMachinePreflight({
    repositoryRoot: boundary.root,
    liveBrowser: selection === "edge",
    ...(configuration.browser === undefined ? {} : {
      browserProduct: configuration.browser.product,
      browserExecutable: configuration.browser.browserExecutable,
      ...(configuration.browser.browserVersion === undefined ? {} : { browserVersion: configuration.browser.browserVersion }),
    }),
    host,
    gitExecutable: resolveDefaultGitExecutable(host),
  });
  const lock = await store.acquireWorkspaceLock(boundary.root, state.sessionId, new Date().toISOString());
  let monitor: SessionControlMonitor | undefined;
  let transport: ModelTransport | undefined;
  const setupControl = new DeferredRuntimeControl();
  const onSignal = (): void => { void setupControl.requestPause("Operator interrupted the active CLI"); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    // The prior owner may have finished between our first read and lock acquisition.
    state = await store.read(command.sessionId);
    if (isTerminal(state.status)) {
      throw new AgentError("RECOVERY_REQUIRED", `Session became terminal (${state.status}) before resume`);
    }
    assertConfigurationUnchanged(state, manifest, configuration);
    assertGrantMatchesState(grant, state);
    const audit = new AuditLog(path.join(sessionDirectory, "audit.jsonl"), state.sessionId);
    const user = terminalUser(command.json, io);
    await audit.initialize();
    if (state.status === "grant_pending") {
      const approved = await user.approveInitialGrant(
        effectiveGrantSummary(configuration, grant),
        command.approveGrant,
      );
      if (!approved) {
        await moveState(state, "aborted", store, audit, "Initial session grant was declined");
        output(command.json, io, sessionResult(state, "Initial session grant was declined"));
        return 2;
      }
      await audit.append({
        type: "grant.established",
        taskId: state.taskId,
        data: { grantHash: state.policyHashes.grant, recoveredApproval: true },
      });
      await moveState(state, "transport_starting", store, audit);
    }
    await audit.append({
      type: "session.recovered",
      taskId: state.taskId,
      data: { priorStatus: state.status, turnSequence: state.turnSequence },
    });
    monitor = new SessionControlMonitor(sessionDirectory, state.sessionId, setupControl);
    monitor.start();
    const prepared = await prepareTransport(selection, requestedSource?.canonicalPath, state, configuration, io, setupControl, host);
    transport = prepared.transport;
    setupControl.bindTransport(transport);
    const composed = await composeRuntime({
      state,
      store,
      configuration,
      grant,
      transport,
      user,
      ...(prepared.idFactory === undefined ? {} : { idFactory: prepared.idFactory }),
      onProgress: progressReporter(command.json, io),
      host,
    });
    setupControl.bindRuntime(composed.runtime);
    const result = await composed.runtime.run();
    const currentGrant = await readSessionGrant(sessionDirectory);
    const completionHandoff = await readCompletionHandoff(state, sessionDirectory);
    const finalRepository = result.status === "completed"
      ? await finalRepositoryHandoff(
          composed.repository,
          configuration.repository.limits.max_diff_bytes,
          sessionDirectory,
          result.completion?.actual.repositoryFingerprint,
        )
      : undefined;
    output(command.json, io, {
      ...result,
      ...(completionHandoff === undefined
        ? {}
        : { modelSummary: completionHandoff.claim.summary, modelReport: completionHandoff.claim }),
      handoff: sessionResult(
        state,
        undefined,
        currentGrant,
        disclosureSummary(composed.disclosureLedger.records()),
        finalRepository,
        completionHandoff,
      ),
    });
    return result.status === "completed"
      ? finalRepository?.known === true && finalRepository.matchesVerifiedCompletion === true ? 0 : 1
      : result.status === "paused" ? 2 : 1;
  } catch (error) {
    if (!isTerminal(state.status) && state.status !== "paused") {
      const requested = setupControl.requestedAction;
      const target = requested === "pause" ? "paused" : requested === "abort" ? "aborted" : "paused";
      if (allowedTransitions(state.status).includes(target)) {
        const audit = new AuditLog(path.join(sessionDirectory, "audit.jsonl"), state.sessionId);
        await moveState(state, target, store, audit, errorMessage(error), error);
      }
    }
    throw error;
  } finally {
    await monitor?.stop().catch(() => undefined);
    await transport?.close().catch(() => undefined);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await lock.release();
  }
}

async function showStatus(
  command: Extract<CliCommand, { readonly command: "status" }>,
  io: CliIo,
  host: HostPlatform,
): Promise<number> {
  const store = new SessionStore(await verifiedStateHome(command.stateHome, host));
  const state = await store.read(command.sessionId);
  const sessionDirectory = store.sessionDirectory(state.sessionId);
  const grant = await readSessionGrant(sessionDirectory);
  const disclosures = new DisclosureLedger(state.sessionId, {
    outputFile: path.join(sessionDirectory, "disclosures.jsonl"),
  });
  await disclosures.initialize();
  const completionHandoff = await readCompletionHandoff(state, sessionDirectory);
  output(
    command.json,
    io,
    sessionResult(
      state,
      undefined,
      grant,
      disclosureSummary(disclosures.records()),
      undefined,
      completionHandoff,
    ),
  );
  return 0;
}

async function controlSession(
  command: Extract<CliCommand, { readonly command: "pause" | "abort" }>,
  action: ControlAction,
  io: CliIo,
  host: HostPlatform,
): Promise<number> {
  const store = new SessionStore(await verifiedStateHome(command.stateHome, host));
  let state = await store.read(command.sessionId);
  if (isTerminal(state.status)) {
    output(command.json, io, sessionResult(state, `Session is already ${state.status}`));
    return state.status === "completed" ? 0 : 1;
  }
  if (action === "pause" && state.status === "paused") {
    output(command.json, io, sessionResult(state, "Session is already paused"));
    return 0;
  }
  const reason = command.reason ?? (action === "pause" ? "Operator requested pause" : "Operator requested abort");
  let lock: WorkspaceLock | undefined;
  try {
    lock = await store.acquireWorkspaceLock(state.repositoryRoot, state.sessionId, new Date().toISOString());
  } catch (error) {
    if (!(error instanceof AgentError) || error.code !== "RECOVERY_REQUIRED" || !("sessionId" in error.details)) {
      throw error;
    }
    if (error.details.sessionId !== state.sessionId) {
      throw new AgentError("RECOVERY_REQUIRED", "A different live session owns this repository", error.details);
    }
    await writeControlRequest(store.sessionDirectory(state.sessionId), state.sessionId, action, reason);
    const accepted = await waitForControlResult(store, state.sessionId, action, 15_000);
    const latest = await store.read(state.sessionId);
    output(command.json, io, sessionResult(latest, accepted ? `${action} acknowledged` : `${action} requested; owner has not acknowledged yet`));
    return accepted ? 0 : 2;
  }
  try {
    state = await store.read(command.sessionId);
    if (isTerminal(state.status)) {
      output(command.json, io, sessionResult(state, `Session is already ${state.status}`));
      return state.status === "completed" ? 0 : 1;
    }
    if (action === "pause" && !allowedTransitions(state.status).includes("paused")) {
      throw new AgentError("RECOVERY_REQUIRED", `Session state '${state.status}' is not actively running and cannot be paused`);
    }
    const audit = new AuditLog(path.join(store.sessionDirectory(state.sessionId), "audit.jsonl"), state.sessionId);
    await moveState(state, action === "pause" ? "paused" : "aborted", store, audit, reason);
    output(command.json, io, sessionResult(state, reason));
    return 0;
  } finally {
    await lock.release();
  }
}

async function rollbackSession(
  command: Extract<CliCommand, { readonly command: "rollback" }>,
  io: CliIo,
  host: HostPlatform,
): Promise<number> {
  const stateHome = path.resolve(command.stateHome ?? resolveStateHome(process.env, host));
  await verifyPrivateStateHome(stateHome, host);
  const store = new SessionStore(stateHome);
  let state = await store.read(command.sessionId);
  let checkpointId = command.checkpointId ?? state.lastCheckpointId;
  const boundary = await RepositoryBoundary.create(state.repositoryRoot);
  const lock = await store.acquireWorkspaceLock(boundary.root, state.sessionId, new Date().toISOString());
  try {
    state = await store.read(command.sessionId);
    checkpointId = command.checkpointId ?? state.lastCheckpointId;
    const configuration = await loadRuntimeConfiguration({
      repositoryRoot: boundary.root,
      stateHome,
      requireBrowser: false,
      host,
    });
    const sessionDirectory = store.sessionDirectory(state.sessionId);
    await AuditLog.verify(path.join(sessionDirectory, "audit.jsonl"), state.sessionId);
    const checkpoints = await CheckpointStore.create(boundary, path.join(sessionDirectory, "checkpoints"), {
      maxCheckpointBytes: configuration.repository.limits.max_checkpoint_bytes,
      maxFiles: state.budgetLimits.maxChangedFiles,
    });
    const recoveredAssociation = checkpointId === undefined;
    if (checkpointId === undefined) {
      const pendingMutations = state.pendingOperations.filter((operation) => operation.mutating);
      if (pendingMutations.length !== 1) {
        throw new AgentError(
          "RECOVERY_REQUIRED",
          "Checkpoint linkage is missing and cannot be recovered unambiguously; specify an inspected checkpoint explicitly",
          { pendingMutationCount: pendingMutations.length },
        );
      }
      checkpointId = (await checkpoints.latest(pendingMutations[0]?.operationId))?.id;
    }
    if (checkpointId === undefined) {
      throw new AgentError(
        "RECOVERY_REQUIRED",
        "Session has no integrity-verified checkpoint associated with its pending mutation",
      );
    }
    const summary = await checkpoints.rollback(checkpointId, { force: command.force });
    const audit = new AuditLog(path.join(sessionDirectory, "audit.jsonl"), state.sessionId);
    await audit.append({
      type: "checkpoint.rolled_back",
      taskId: state.taskId,
      data: { checkpointId, paths: summary.paths, totalBytes: summary.totalBytes, forced: command.force },
    });
    if (state.status !== "rolled_back") {
      await moveState(state, "rolled_back", store, audit, "Completion invalidated by explicit checkpoint rollback");
    }
    output(command.json, io, {
      rolledBack: true,
      checkpoint: summary,
      recoveredAssociation,
      sessionStatus: state.status,
    });
    return 0;
  } finally {
    await lock.release();
  }
}

async function verifyAudit(
  command: Extract<CliCommand, { readonly command: "verify-audit" }>,
  io: CliIo,
  host: HostPlatform,
): Promise<number> {
  const store = new SessionStore(await verifiedStateHome(command.stateHome, host));
  const state = await store.read(command.sessionId);
  const sessionDirectory = store.sessionDirectory(state.sessionId);
  const events = await AuditLog.verify(path.join(sessionDirectory, "audit.jsonl"), state.sessionId);
  let disclosureValid = true;
  try {
    disclosureValid = await DisclosureLedger.verifyFile(path.join(sessionDirectory, "disclosures.jsonl"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!disclosureValid) throw new AgentError("RECOVERY_REQUIRED", "Disclosure ledger integrity check failed");
  output(command.json, io, {
    valid: true,
    sessionId: state.sessionId,
    eventCount: events.length,
    finalEventHash: events.at(-1)?.eventHash ?? null,
    disclosureLedgerValid: disclosureValid,
  });
  return 0;
}

async function exportReview(
  command: Extract<CliCommand, { readonly command: "export-review" }>,
  io: CliIo,
  host: HostPlatform,
): Promise<number> {
  const stateHome = path.resolve(command.stateHome ?? resolveStateHome(process.env, host));
  await verifyPrivateStateHome(stateHome, host);
  const store = new SessionStore(stateHome);
  let state = await store.read(command.sessionId);
  const lock = await store.acquireWorkspaceLock(
    state.repositoryRoot,
    state.sessionId,
    new Date().toISOString(),
  );
  try {
    // Re-read after acquiring exclusive workspace ownership so the exported
    // state, audit chain, and disclosure chain form one coherent snapshot.
    state = await store.read(command.sessionId);
    const sessionDirectory = store.sessionDirectory(state.sessionId);
    const auditEvents = await AuditLog.verify(
      path.join(sessionDirectory, "audit.jsonl"),
      state.sessionId,
    );
    const disclosureLedger = new DisclosureLedger(state.sessionId, {
      outputFile: path.join(sessionDirectory, "disclosures.jsonl"),
    });
    await disclosureLedger.initialize();
    if (!disclosureLedger.verifyIntegrity()) {
      throw new AgentError("RECOVERY_REQUIRED", "Disclosure ledger integrity check failed");
    }
    const disclosureRecords = disclosureLedger.records();
    const reviewPackage = createReviewPackage({ state, auditEvents, disclosureRecords });
    const outputFile = await resolveReviewOutputFile({
      ...(command.output === undefined ? {} : { requested: command.output }),
      stateHome,
      sessionDirectory,
      repositoryRoot: state.repositoryRoot,
    });
    await atomicWrite(outputFile, `${stableJson(reviewPackage)}\n`);
    output(command.json, io, {
      exported: true,
      sessionId: state.sessionId,
      version: reviewPackage.version,
      bodySha256: reviewPackage.integrity.bodySha256,
      auditEventCount: reviewPackage.body.audit.eventCount,
      disclosureRecordCount: reviewPackage.body.disclosures.recordCount,
    });
    return 0;
  } finally {
    await lock.release();
  }
}

async function resolveReviewOutputFile(input: {
  readonly requested?: string;
  readonly stateHome: string;
  readonly sessionDirectory: string;
  readonly repositoryRoot: string;
}): Promise<string> {
  const defaultFile = path.join(input.sessionDirectory, "review-package.json");
  const requestedFile = path.resolve(input.requested ?? defaultFile);
  const canonicalRepository = await realpath(input.repositoryRoot);
  if (isWithinPath(canonicalRepository, requestedFile)) {
    throw new AgentError("CONFIG_INVALID", "Review packages must be written outside the repository");
  }

  const parent = path.dirname(requestedFile);
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(parent);
  } catch (error) {
    throw new AgentError(
      "CONFIG_INVALID",
      "Review output directory must already exist",
      {},
      { cause: error },
    );
  }
  const canonicalFile = path.join(canonicalParent, path.basename(requestedFile));
  if (isWithinPath(canonicalRepository, canonicalFile)) {
    throw new AgentError("CONFIG_INVALID", "Review packages must be written outside the repository");
  }

  const canonicalStateHome = await realpath(input.stateHome);
  const canonicalSessionDirectory = await realpath(input.sessionDirectory);
  const canonicalDefaultFile = path.join(canonicalSessionDirectory, "review-package.json");
  if (isWithinPath(canonicalStateHome, canonicalFile) && canonicalFile !== canonicalDefaultFile) {
    throw new AgentError(
      "CONFIG_INVALID",
      "Review output cannot overwrite session or state-control files",
    );
  }

  try {
    const existing = await lstat(canonicalFile);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new AgentError("CONFIG_INVALID", "Review output must be a regular file, not a link or special file");
    }
  } catch (error) {
    if (error instanceof AgentError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return canonicalFile;
}

function isWithinPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function createGrant(
  configuration: LoadedRuntimeConfiguration,
  input: {
    readonly taskId: string;
    readonly repositoryRoot: string;
    readonly branch?: string;
    readonly mode: SessionState["mode"];
  },
): SessionGrant {
  return createDefaultSessionGrant({
    grant_id: newId("grant"),
    task_id: input.taskId,
    repository_root: input.repositoryRoot,
    ...(input.branch === undefined ? {} : { branch: input.branch }),
    mode: input.mode,
    readable_paths: configuration.repository.grant_defaults.readable_paths,
    writable_paths: configuration.repository.grant_defaults.writable_paths,
    command_ids: configuration.repository.commands.map((command) => command.id),
    disclosure_classifications: configuration.repository.grant_defaults.disclosure_classifications,
  });
}

async function prepareTransport(
  selection: TransportSelection,
  sourceFile: string | undefined,
  state: SessionState,
  configuration: LoadedRuntimeConfiguration,
  io: CliIo,
  control: DeferredRuntimeControl,
  host: HostPlatform,
): Promise<{ readonly transport: ModelTransport; readonly idFactory?: (prefix: string) => string }> {
  if (selection === "edge") {
    if (configuration.browser === undefined) {
      throw new AgentError("CONFIG_INVALID", "Browser configuration was not loaded");
    }
    const browserName = browserProductPresentation(configuration.browser.product).productName;
    io.stdout.write(`Opening the dedicated visible ${browserName} session. Complete any sign-in, MFA, or consent in the browser.\n`);
    const transport = await launchBrowserCopilotTransport(configuration.browser, { host });
    control.bindTransport(transport);
    const readiness = await transport.waitForManualReadiness(configuration.browser.waits.manualReadinessMs);
    if (readiness.classification.state !== "ready") {
      await transport.close().catch(() => undefined);
      throw new AgentError(
        "TRANSPORT_UNAVAILABLE",
        "The visible Copilot session did not reach a verified ready state",
        { ...readiness.diagnostic },
      );
    }
    return { transport };
  }
  if (sourceFile === undefined) throw new AgentError("CONFIG_INVALID", `${selection} requires a source file`);
  if (selection === "fixture") {
    const startTurnNumber = fixtureStartTurn(state);
    const recoveringSubmission = state.submission !== undefined && state.submission.state !== "answered"
      ? { turnId: state.submission.turnId, submissionId: state.submission.submissionId }
      : undefined;
    const loaded = await loadCliFixture(sourceFile, {
      taskId: state.taskId,
      startTurnNumber,
      ...(recoveringSubmission === undefined ? {} : { recoveringSubmission }),
    });
    return { transport: loaded.transport, idFactory: loaded.idFactory };
  }
  return loadReplayTransport(sourceFile, state);
}

function fixtureStartTurn(state: SessionState): number {
  const turnId = state.submission !== undefined && state.submission.state !== "answered"
    ? state.submission.turnId
    : state.queuedOutbound?.turnId;
  if (turnId !== undefined) {
    const match = /^turn_(\d+)$/u.exec(turnId);
    if (match === null) throw new AgentError("RECOVERY_REQUIRED", "Session contains an invalid turn identifier");
    return Number.parseInt(match[1] ?? "", 10);
  }
  return state.turnSequence + 1;
}

async function selectedSource(
  selection: TransportSelection,
  fixture: string | undefined,
  transcript: string | undefined,
  recorded?: string,
): Promise<{ readonly canonicalPath: string; readonly sha256: string } | undefined> {
  if (selection === "edge") return undefined;
  const filename = selection === "fixture" ? fixture ?? recorded : transcript ?? recorded;
  if (filename === undefined) throw new AgentError("CONFIG_INVALID", `${selection} requires a source file`);
  return sourceFileIdentity(filename);
}

function createRuntimeManifest(
  selection: TransportSelection,
  source: { readonly canonicalPath: string; readonly sha256: string } | undefined,
  configuration: LoadedRuntimeConfiguration,
  createdAt: string,
): SessionRuntimeManifest {
  return {
    schema_version: SESSION_RUNTIME_MANIFEST_VERSION,
    transport: selection,
    ...(source === undefined ? {} : { source_file: source.canonicalPath, source_sha256: source.sha256 }),
    ...(configuration.hashes.browser === undefined
      ? {}
      : { browser_config_sha256: configuration.hashes.browser }),
    ...(configuration.hashes.browserIdentity === undefined
      ? {}
      : { browser_identity_sha256: configuration.hashes.browserIdentity }),
    created_at: createdAt,
  };
}

function assertConfigurationUnchanged(
  state: SessionState,
  manifest: SessionRuntimeManifest,
  configuration: LoadedRuntimeConfiguration,
): void {
  if (
    state.policyHashes.organization !== configuration.hashes.organization ||
    state.policyHashes.repository !== configuration.hashes.repository
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Policy configuration changed; start a new session with a new grant");
  }
  assertBrowserRuntimeManifestMatches(manifest, configuration.hashes);
}

function assertGrantMatchesState(grant: SessionGrant, state: SessionState): void {
  if (
    grant.task_id !== state.taskId ||
    grant.repository_root !== state.repositoryRoot ||
    grant.mode !== state.mode ||
    sha256(stableJson(grant)) !== state.policyHashes.grant
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Persisted session grant does not match session state");
  }
}

async function moveState(
  state: SessionState,
  next: SessionStatus,
  store: SessionStore,
  audit: AuditLog,
  reason?: string,
  failure?: unknown,
): Promise<void> {
  const from = state.status;
  const now = new Date().toISOString();
  transitionSession(state, next, now, {
    ...(reason === undefined ? {} : { reason }),
    ...(next === "failed"
      ? {
          failure: {
            code: failure instanceof AgentError ? failure.code : "INTERNAL_ERROR",
            message: reason ?? errorMessage(failure),
          },
        }
      : {}),
  });
  await store.write(state);
  await audit.append({
    type: next === "completed" || next === "rolled_back" || next === "blocked" || next === "aborted" || next === "failed"
      ? "session.ended"
      : "session.transition",
    taskId: state.taskId,
    data: { from, to: next, ...(reason === undefined ? {} : { reason }) },
  });
}

async function waitForControlResult(
  store: SessionStore,
  sessionId: string,
  action: ControlAction,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await store.read(sessionId);
    if (action === "pause" ? state.status === "paused" || isTerminal(state.status) : state.status === "aborted") {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function prepareStateHome(
  requested: string,
  repositoryRoot: string,
  host: HostPlatform,
): Promise<string> {
  await verifyPrivateStateHome(path.resolve(requested), host);
  const canonical = await realpath(requested);
  const relative = path.relative(repositoryRoot, canonical);
  const insideRepository = relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  if (insideRepository) {
    throw new AgentError("CONFIG_INVALID", "State storage must be outside the repository", {
      stateHome: canonical,
      repositoryRoot,
    });
  }
  return canonical;
}

async function verifiedStateHome(requested: string | undefined, host: HostPlatform): Promise<string> {
  const stateHome = path.resolve(requested ?? resolveStateHome(process.env, host));
  await verifyPrivateStateHome(stateHome, host);
  return stateHome;
}

function sessionResult(
  state: SessionState,
  message?: string,
  grant?: SessionGrant,
  disclosures?: Readonly<Record<string, unknown>>,
  currentRepository?: Readonly<Record<string, unknown>>,
  completionHandoff?: CompletionHandoffRecord,
): Readonly<Record<string, unknown>> {
  const agentChangedPaths = [...new Set(state.mutations.flatMap((mutation) => mutation.changedPaths))];
  return {
    sessionId: state.sessionId,
    taskId: state.taskId,
    status: state.status,
    repositoryRoot: state.repositoryRoot,
    mode: state.mode,
    turns: state.turnSequence,
    mutations: state.mutations.length,
    validations: state.validations.length,
    pendingOperations: state.pendingOperations.length,
    checkpointId: state.lastCheckpointId ?? null,
    effectiveGrant: grant === undefined ? null : {
      grantId: grant.grant_id,
      mode: grant.mode,
      branch: grant.branch ?? null,
      capabilities: grant.capabilities,
      budgets: grant.capabilities.budgets ?? {},
    },
    budgets: {
      limits: state.budgetLimits,
      usage: state.budgetUsage,
    },
    policyHashes: state.policyHashes,
    repository: {
      fingerprintAtStart: state.repositoryFingerprintAtStart,
      preExistingChanges: state.preExistingChanges,
      agentChangedPaths,
      current: currentRepository ?? null,
    },
    validation: state.validations,
    disclosures: disclosures ?? null,
    completionReport: completionHandoff === undefined ? null : {
      version: completionHandoff.version,
      createdAt: completionHandoff.createdAt,
      integrity: completionHandoff.integrity,
      redactionCount: completionHandoff.redactionCount,
      claim: completionHandoff.claim,
      verification: completionHandoff.verification,
    },
    pauseReason: state.pauseReason ?? null,
    failure: state.failure ?? null,
    ...(message === undefined ? {} : { message }),
  };
}

function disclosureSummary(records: readonly DisclosureRecord[]): Readonly<Record<string, unknown>> {
  const grouped = <T extends string>(selector: (record: DisclosureRecord) => T): Readonly<Record<T, number>> =>
    Object.fromEntries(
      [...new Set(records.map(selector))].sort().map((key) => [key, records.filter((record) => selector(record) === key).length]),
    ) as Readonly<Record<T, number>>;
  const paths = [...new Set(records.flatMap((record) => record.path === undefined ? [] : [record.path]))].sort();
  return {
    recordCount: records.length,
    disclosedRecordCount: records.filter((record) => record.disclosed).length,
    blockedRecordCount: records.filter((record) => !record.disclosed).length,
    originalBytes: records.reduce((sum, record) => sum + record.originalByteCount, 0),
    disclosedBytes: records.reduce((sum, record) => sum + record.disclosedByteCount, 0),
    redactionCount: records.reduce((sum, record) => sum + record.redactions.length, 0),
    classifications: [...new Set(records.map((record) => record.classification))].sort(),
    recordsBySource: grouped((record) => record.source),
    recordsByClassification: grouped((record) => record.classification),
    paths,
    finalRecordHash: records.at(-1)?.recordHash ?? null,
  };
}

function emptyPolicyUsage() {
  return {
    elapsed_ms: 0,
    turns: 0,
    operations: 0,
    read_files: 0,
    changed_files: 0,
    changed_lines: 0,
    disclosed_bytes: 0,
    commands: 0,
    command_output_bytes: 0,
    protocol_repairs: 0,
  } as const;
}

function policyProtectedPatterns(
  configuration: LoadedRuntimeConfiguration,
  grant: SessionGrant,
): readonly string[] {
  return [...new Set([
    ...(configuration.organizationPolicy.capabilities.paths?.protected ?? []),
    ...(configuration.repository.policy.capabilities.paths?.protected ?? []),
    ...(grant.capabilities.paths?.protected ?? []),
  ])];
}

async function readCompletionHandoff(
  state: SessionState,
  sessionDirectory: string,
): Promise<CompletionHandoffRecord | undefined> {
  if (state.completionHandoff === undefined) return undefined;
  const fingerprintKey = await loadFingerprintKey(path.join(sessionDirectory, "fingerprint.key"));
  return new CompletionHandoffStore(
    path.join(sessionDirectory, "handoff"),
    state.sessionId,
    new SecretScanner(fingerprintKey),
  ).read(state.completionHandoff);
}

async function finalRepositoryHandoff(
  repository: RepositoryContext,
  maxDiffBytes: number,
  sessionDirectory: string,
  verifiedFingerprint: string | undefined,
): Promise<Readonly<Record<string, unknown>> & { readonly known: boolean; readonly matchesVerifiedCompletion: boolean }> {
  try {
    const fingerprintKey = await loadFingerprintKey(path.join(sessionDirectory, "fingerprint.key"));
    const scanner = new SecretScanner(fingerprintKey);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const before = await repository.git.status();
      const sections = await finalDiffSections(repository.git, before.head, maxDiffBytes, scanner);
      const after = await repository.git.status();
      if (before.snapshotSha256 !== after.snapshotSha256) continue;
      return {
        known: true,
        consistentSnapshot: true,
        matchesVerifiedCompletion:
          verifiedFingerprint !== undefined && verifiedFingerprint === after.snapshotSha256,
        verifiedFingerprint: verifiedFingerprint ?? null,
        fingerprint: after.snapshotSha256,
        branch: after.branch,
        head: after.head,
        hasConflicts: after.hasConflicts,
        excludedCount: after.excludedCount,
        entries: after.entries.map(({ stateSha256: _stateSha256, ...entry }) => entry),
        diff: {
          sections,
          truncated: sections.some((section) => section.truncated),
          outputBytes: sections.reduce((sum, section) => sum + section.outputBytes, 0),
          presentedBytes: sections.reduce((sum, section) => sum + section.presentedBytes, 0),
          redactionCount: sections.reduce((sum, section) => sum + section.redactionCount, 0),
          excludedCount: sections.reduce((sum, section) => sum + section.excludedCount, 0),
        },
      };
    }
    return {
      known: false,
      matchesVerifiedCompletion: false,
      reasonCode: "REPOSITORY_CHANGED_DURING_HANDOFF",
      message: "Repository state changed while the final diff was prepared; no current validated handoff is available.",
    };
  } catch (error) {
    return {
      known: false,
      matchesVerifiedCompletion: false,
      reasonCode: error instanceof AgentError ? error.code : "REPOSITORY_STATE_UNKNOWN",
      message: errorMessage(error),
    };
  }
}

interface FinalDiffSection {
  readonly baseline: "HEAD" | "index" | "working_tree";
  readonly content: string;
  readonly rawSha256: string;
  readonly presentedSha256: string;
  readonly outputBytes: number;
  readonly presentedBytes: number;
  readonly truncated: boolean;
  readonly redactionCount: number;
  readonly excludedCount: number;
}

async function finalDiffSections(
  git: GitInspector,
  head: string | null,
  maxBytes: number,
  scanner: SecretScanner,
): Promise<readonly FinalDiffSection[]> {
  const requests: Array<{ readonly baseline: "head" | "staged" | "worktree"; readonly label: FinalDiffSection["baseline"] }> =
    head === null
      ? [{ baseline: "staged", label: "index" }, { baseline: "worktree", label: "working_tree" }]
      : [{ baseline: "head", label: "HEAD" }];
  const sections: FinalDiffSection[] = [];
  let remaining = maxBytes;
  for (const request of requests) {
    if (remaining < 1) {
      sections.push({
        baseline: request.label,
        content: "",
        rawSha256: sha256(""),
        presentedSha256: sha256(""),
        outputBytes: 0,
        presentedBytes: 0,
        truncated: true,
        redactionCount: 0,
        excludedCount: 0,
      });
      continue;
    }
    const raw = await git.diff({ baseline: request.baseline, maxBytes: remaining });
    const redacted = scanner.redact(raw.diff);
    sections.push({
      baseline: request.label,
      content: redacted.content,
      rawSha256: raw.sha256,
      presentedSha256: sha256(redacted.content),
      outputBytes: raw.outputBytes,
      presentedBytes: Buffer.byteLength(redacted.content),
      truncated: raw.truncated,
      redactionCount: redacted.redactionCount,
      excludedCount: raw.excludedCount,
    });
    remaining -= raw.outputBytes;
  }
  return sections;
}

function output(json: boolean, io: CliIo, value: object): void {
  if (json) {
    io.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  io.stdout.write(renderHumanResult(value as Readonly<Record<string, unknown>>));
}

function terminalUser(json: boolean, io: CliIo): TerminalUserInteraction {
  return new TerminalUserInteraction({
    output: json ? io.stderr : io.stdout,
    silentPreapprovedGrant: json,
  });
}

function progressReporter(json: boolean, io: CliIo): (event: RuntimeProgressEvent) => void {
  const destination = json ? io.stderr : io.stdout;
  return (event) => {
    if (json) {
      destination.write(`${JSON.stringify({ event: "runtime.progress", ...event })}\n`);
      return;
    }
    let detail = "";
    if (event.kind === "state") {
      const next = String(event.detail.to);
      detail = humanProgressState(next);
    } else if (event.kind === "tool") {
      const outcome = String(event.detail.outcome);
      const marker = outcome === "success" ? green(symbols.ok) : outcome === "failure" ? yellow(symbols.warning) : cyan(symbols.arrow);
      destination.write(`${marker} ${String(event.detail.tool)}: ${outcome}\n`);
      return;
    } else if (event.kind === "model") {
      detail = "Copilot responded";
    } else {
      detail = event.detail.accepted === true ? "Completion verified" : "Completion needs more work";
    }
    destination.write(`${cyan(symbols.arrow)} ${detail}\n`);
  };
}

function helpText(advanced: boolean): string {
  if (advanced) {
    return `Cope ${CLI_VERSION} · advanced commands

Normal use rarely needs these. Run cope by itself for the guided interface.

  cope init [PATH] [--quick] [--force]
  cope run <objective> [-C PATH] [--mode inspect|edit|auto]
           [--accept TEXT ...] [--approve-grant]
           [--transport edge|fixture|replay]
           [--fixture FILE | --transcript FILE]
  cope resume <session-id> [--approve-grant]
  cope status <session-id>
  cope pause <session-id> [--reason TEXT]
  cope abort <session-id> [--reason TEXT]
  cope rollback <session-id> [--checkpoint ID] [--force]
  cope verify-audit <session-id>
  cope export-review <session-id> [--output FILE]
  cope setup [--browser edge|chrome] [--browser-executable PATH]

Common options: --state-home PATH, --json
Compatibility alias: copilot-agent
`;
  }
  return `Cope ${CLI_VERSION}
A guided terminal coding harness for Microsoft 365 Copilot

Start
  cope                         Open Cope in the current project
  cope demo                    Preview the terminal interface without a browser or setup
  cope "fix the failing tests" Run a task directly
  cope PATH                    Open a folder or standalone file
  cope -c                      Continue the latest session

Useful controls
  cope --inspect               Start read-only
  cope --auto                  Use the configured project policy with fewer prompts
  cope setup                   Run or change guided browser setup
  cope update                  Rebuild and reinstall from your local Cope checkout
  cope doctor                  Check Node, Git, browser, and configuration
  cope sessions                Show recent work

Inside Cope
  /help   /mode   /resume   /repo   /doctor   /exit

Run cope help advanced for recovery and automation commands.
`;
}

function humanProgressState(state: string): string {
  switch (state) {
    case "preflight": return "Checking project and machine readiness";
    case "grant_pending": return "Reviewing task permissions";
    case "transport_starting": return "Opening the dedicated browser session";
    case "initializing_model": return "Connecting to Copilot";
    case "awaiting_model": return "Waiting for Copilot";
    case "executing_tools": return "Working in the project";
    case "returning_results": return "Returning tool results";
    case "awaiting_user": return "Waiting for your input";
    case "validating_completion": return "Verifying the result";
    case "completed": return "Task completed";
    case "paused": return "Task paused";
    default: return state.replaceAll("_", " ");
  }
}

async function atomicWrite(filename: string, content: string): Promise<void> {
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filename);
  if (CURRENT_HOST_PLATFORM.supportsDirectoryFsync) {
    const directory = await open(path.dirname(filename), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

class DeferredRuntimeControl implements ActiveRuntimeControl {
  private runtime: ActiveRuntimeControl | undefined;
  private transport: ModelTransport | undefined;
  private requested: ControlAction | undefined;
  private reason = "";

  public get requestedAction(): ControlAction | undefined {
    return this.requested;
  }

  public bindTransport(transport: ModelTransport): void {
    this.transport = transport;
    if (this.requested !== undefined) void transport.emergencyStop(this.reason).catch(() => undefined);
  }

  public bindRuntime(runtime: ActiveRuntimeControl): void {
    this.runtime = runtime;
    if (this.requested === "abort") void runtime.emergencyStop(this.reason);
    else if (this.requested === "pause") void runtime.requestPause(this.reason);
  }

  public async requestPause(reason: string): Promise<void> {
    if (this.requested === "abort") return;
    this.requested = "pause";
    this.reason = reason;
    if (this.runtime !== undefined) await this.runtime.requestPause(reason);
    else await this.transport?.emergencyStop(reason);
  }

  public async emergencyStop(reason: string): Promise<void> {
    this.requested = "abort";
    this.reason = reason;
    if (this.runtime !== undefined) await this.runtime.emergencyStop(reason);
    else await this.transport?.emergencyStop(reason);
  }
}
