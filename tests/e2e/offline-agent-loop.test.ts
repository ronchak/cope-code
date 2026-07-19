import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { AuditLog } from "../../src/audit/audit-log.js";
import { AgentRuntime } from "../../src/orchestrator/agent-runtime.js";
import { CbaProtocolAdapter } from "../../src/orchestrator/cba-protocol-adapter.js";
import { LayeredRuntimePolicy } from "../../src/orchestrator/runtime-policy.js";
import {
  DEFAULT_ORGANIZATION_POLICY,
  DEFAULT_REPOSITORY_POLICY,
  PolicyEngine,
  createDefaultSessionGrant,
  type BudgetUsage as PolicyBudgetUsage,
} from "../../src/policy/index.js";
import { serializeProtocolEnvelope, type ProtocolMessage } from "../../src/protocol/index.js";
import { DEFAULT_GIT_EXECUTABLE, RepositoryContext } from "../../src/repository/index.js";
import { ContentSecurity, DisclosureLedger, SecretScanner } from "../../src/security/index.js";
import { sha256, stableJson } from "../../src/shared/crypto.js";
import { SessionArtifactStore } from "../../src/session/artifact-store.js";
import { OperationJournal } from "../../src/session/operation-journal.js";
import { SessionStore } from "../../src/session/store.js";
import {
  DEFAULT_BUDGET_LIMITS,
  SESSION_SCHEMA_VERSION,
  type SessionState,
  zeroBudgetUsage,
} from "../../src/session/types.js";
import {
  CommandCatalog,
  ProcessRunner,
  ToolHost,
  preauthorizedToolPolicy,
} from "../../src/tools/index.js";
import { ScriptedFixtureTransport, type ScriptedFixtureTurn } from "../../src/transport/index.js";

const execFileAsync = promisify(execFile);

test("offline fixture completes discovery, edit, failed validation, correction, and verified completion", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-e2e-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const repositoryRoot = path.join(temporary, "repo");
  const stateHome = path.join(temporary, "state");
  await mkdir(path.join(repositoryRoot, "src"), { recursive: true });
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["init", "--quiet", repositoryRoot]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", repositoryRoot, "config", "user.name", "CBA E2E"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", repositoryRoot, "config", "user.email", "cba@example.invalid"]);
  const initial = "export const answer = 1;\n";
  const firstAttempt = "export const answer = 2;\n";
  const corrected = "export const answer = 42;\n";
  await writeFile(path.join(repositoryRoot, "src", "answer.js"), initial, "utf8");
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", repositoryRoot, "add", "--", "src/answer.js"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", repositoryRoot, "commit", "--quiet", "-m", "initial"]);

  const sessionId = "session_e2e_0001";
  const taskId = "task_e2e_0001";
  const criterion = "src/answer.js exports the value 42 and validation passes";
  const ledger = new DisclosureLedger(sessionId, {
    outputFile: path.join(stateHome, "sessions", sessionId, "disclosures.jsonl"),
  });
  await ledger.initialize();
  const contentSecurity = new ContentSecurity(new SecretScanner(), ledger, { classification: "internal" });
  const repository = await RepositoryContext.create({
    repositoryRoot,
    checkpointDirectory: path.join(stateHome, "checkpoints", sessionId),
    repositoryTools: { contentProcessor: contentSecurity },
    patchBudgets: {
      maxFiles: 10,
      maxFileBytes: 64 * 1024,
      maxTotalBytes: 256 * 1024,
      maxChangedLines: 100,
      allowCreate: true,
      allowDelete: false,
    },
  });
  const catalog = new CommandCatalog([
    {
      id: "validate-answer",
      category: "test",
      risk: "low",
      // Conservatively classified like a normal repository validation command.
      // The e2e proves edit/auto mode can execute side-effect-capable catalog
      // entries while the harness independently verifies repository integrity.
      sideEffects: true,
      networkRequired: false,
      executable: process.execPath,
      fixedArguments: [
        "-e",
        "const fs=require('node:fs');const s=fs.readFileSync('src/answer.js','utf8');if(!/answer\\s*=\\s*42/.test(s)){console.error('expected 42');process.exit(1)}console.log('validation passed')",
      ],
      workingDirectory: ".",
      timeoutMs: 5_000,
      maxTimeoutMs: 5_000,
      maxOutputBytes: 4_096,
      successExitCodes: [0],
    },
  ]);
  const started = "2026-01-01T00:00:00.000Z";
  const grant = createDefaultSessionGrant({
    grant_id: "grant_e2e_0001",
    task_id: taskId,
    repository_root: repositoryRoot,
    mode: "auto",
    readable_paths: ["**"],
    writable_paths: ["src/**"],
    command_ids: ["validate-answer"],
    disclosure_classifications: ["internal"],
  });
  const initialStatus = await repository.git.status();
  const state: SessionState = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    protocolVersion: "cba/1",
    sessionId,
    taskId,
    repositoryRoot,
    repositoryFingerprintAtStart: initialStatus.snapshotSha256,
    repositoryExcludedStateAtStart: initialStatus.excludedStateSha256,
    preExistingChanges: [],
    objective: "Change the exported answer to 42 and prove it with the configured validation.",
    acceptanceCriteria: [criterion],
    mode: "auto",
    status: "grant_pending",
    createdAt: started,
    updatedAt: started,
    startedAt: started,
    policyHashes: {
      organization: sha256(stableJson(DEFAULT_ORGANIZATION_POLICY)),
      repository: sha256(stableJson(DEFAULT_REPOSITORY_POLICY)),
      grant: sha256(stableJson(grant)),
    },
    budgetLimits: { ...DEFAULT_BUDGET_LIMITS, maxElapsedMs: 9_999_999_999_999 },
    budgetUsage: zeroBudgetUsage(),
    turnSequence: 0,
    mutationSequence: 0,
    pendingOperations: [],
    completedOperationIds: [],
    mutations: [],
    validations: [],
    protocolRepairStreak: 0,
  };
  const store = new SessionStore(stateHome);
  await store.create(state);
  const sessionDirectory = store.sessionDirectory(sessionId);
  const audit = new AuditLog(path.join(sessionDirectory, "audit.jsonl"), sessionId);
  await audit.append({
    type: "session.created",
    taskId,
    data: { mode: state.mode, repositoryFingerprint: state.repositoryFingerprintAtStart },
  });
  await audit.append({ type: "grant.established", taskId, data: { grantHash: state.policyHashes.grant } });

  const policy = new LayeredRuntimePolicy({
    engine: new PolicyEngine({
      organization: DEFAULT_ORGANIZATION_POLICY,
      repository: DEFAULT_REPOSITORY_POLICY,
      session: grant,
    }),
    boundary: repository.boundary,
    commandCatalog: catalog,
    currentUsage: () => policyUsage(state),
    classification: "internal",
  });
  const runner = new ProcessRunner(repository.boundary, catalog, { contentProcessor: contentSecurity });
  const tools = new ToolHost({
    context: repository,
    processRunner: runner,
    policy: preauthorizedToolPolicy,
    resultProcessor: contentSecurity,
    completionPathScope: policy,
  });
  const protocol = new CbaProtocolAdapter({
    seenOperationIds: () => new Set(state.completedOperationIds),
  });
  const turns = scriptedTurns(taskId, sha256(initial), sha256(firstAttempt), firstAttempt, corrected, criterion);
  const transport = new ScriptedFixtureTransport(turns, { now: () => new Date("2026-01-01T00:00:01.000Z") });
  let submissionNumber = 0;
  const runtime = new AgentRuntime({
    state,
    store,
    journal: new OperationJournal(path.join(sessionDirectory, "operations"), sessionId),
    audit,
    protocol,
    policy,
    tools,
    transport,
    disclosure: contentSecurity,
    user: {
      requestInput: async () => { throw new Error("fixture did not authorize user input"); },
      requestCapability: async () => { throw new Error("fixture exceeded its grant"); },
    },
    completionRequirements: {
      requiredCommandIds: ["validate-answer"],
      requireValidationAfterLastMutation: true,
      requireCleanPendingOperations: true,
    },
    clock: { now: () => new Date("2026-01-01T00:00:02.000Z") },
    idFactory: () => `submission_${String(++submissionNumber)}`,
    artifacts: new SessionArtifactStore(path.join(sessionDirectory, "artifacts")),
  });

  const result = await runtime.run();

  assert.equal(result.status, "completed");
  assert.equal(result.completion?.accepted, true);
  assert.equal(transport.remainingTurns, 0);
  assert.equal(await readFile(path.join(repositoryRoot, "src", "answer.js"), "utf8"), corrected);
  assert.equal(state.mutations.length, 2);
  assert.equal(state.validations.length, 2);
  assert.equal(state.validations[0]?.outcome, "failure");
  assert.equal(state.validations[1]?.outcome, "success");
  assert.equal(state.validations[1]?.mutationSequence, 2);
  assert.equal(state.lastCheckpointId !== undefined, true);
  assert.equal((await AuditLog.verify(path.join(sessionDirectory, "audit.jsonl"), sessionId)).length > 20, true);
  assert.equal(await DisclosureLedger.verifyFile(path.join(sessionDirectory, "disclosures.jsonl")), true);
});

function scriptedTurns(
  taskId: string,
  initialHash: string,
  firstAttemptHash: string,
  firstAttempt: string,
  corrected: string,
  criterion: string,
): readonly ScriptedFixtureTurn[] {
  const messages: ProtocolMessage[] = [
    request(taskId, 1, "op_list", "list_files", { path: "src", max_depth: 2, max_results: 20 }),
    request(taskId, 2, "op_read", "read_file", { path: "src/answer.js", max_bytes: 4_096 }),
    request(taskId, 3, "op_patch_first", "apply_patch", {
      changes: [{ kind: "update", path: "src/answer.js", base_sha256: initialHash, content: firstAttempt }],
    }),
    request(taskId, 4, "op_validate_fail", "run_command", { command_id: "validate-answer" }),
    request(taskId, 5, "op_patch_correct", "apply_patch", {
      changes: [{ kind: "update", path: "src/answer.js", base_sha256: firstAttemptHash, content: corrected }],
    }),
    request(taskId, 6, "op_validate_pass", "run_command", { command_id: "validate-answer" }),
    request(taskId, 7, "op_diff", "git_diff", {
      scope: "working_tree",
      paths: ["src/answer.js"],
      max_bytes: 8_192,
    }),
    {
      protocol: "cba/1",
      message_type: "completion",
      message_id: "model_message_8",
      task_id: taskId,
      turn_id: 8,
      operation_id: "op_complete",
      report: {
        summary: "Updated the answer to 42 after correcting the failed first validation, then validated the final repository state.",
        acceptance_criteria: [{ criterion, status: "satisfied", evidence: "validate-answer passed after the final mutation" }],
        validation: [{ command_id: "validate-answer", status: "passed", summary: "Latest run exited 0" }],
        skipped_validation: [],
        remaining_risks: [],
        follow_up: [],
      },
      verified: false,
    },
  ];
  return messages.map((message, index) => ({
    taskId,
    turnId: `turn_${String(index + 1).padStart(4, "0")}`,
    submissionId: `submission_${String(index + 1)}`,
    conversationId: "offline-e2e-conversation",
    response: { status: "completed", content: serializeProtocolEnvelope(message) },
  }));
}

function request(
  taskId: string,
  turnId: number,
  operationId: string,
  tool: "list_files" | "read_file" | "apply_patch" | "run_command" | "git_diff",
  args: Readonly<Record<string, unknown>>,
): ProtocolMessage {
  return {
    protocol: "cba/1",
    message_type: "tool_request",
    message_id: `model_message_${String(turnId)}`,
    task_id: taskId,
    turn_id: turnId,
    operations: [{ operation_id: operationId, tool, arguments: args as never } as never],
  };
}

function policyUsage(state: SessionState): PolicyBudgetUsage {
  return {
    elapsed_ms: 0,
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
