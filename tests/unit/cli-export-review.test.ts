import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AuditLog } from "../../src/audit/audit-log.js";
import { parseCliArguments } from "../../src/cli/arguments.js";
import { executeCommand } from "../../src/cli/commands.js";
import { verifyReviewPackage, type ReviewPackage } from "../../src/review/index.js";
import { DisclosureLedger } from "../../src/security/index.js";
import {
  DEFAULT_BUDGET_LIMITS,
  SESSION_SCHEMA_VERSION,
  type SessionState,
  zeroBudgetUsage,
} from "../../src/session/types.js";
import { SessionStore } from "../../src/session/store.js";

const NOW = "2026-07-17T12:00:00.000Z";

async function createSessionFixture(): Promise<{
  readonly root: string;
  readonly repository: string;
  readonly stateHome: string;
  readonly sessionId: string;
  readonly sessionDirectory: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cba-cli-review-"));
  const repository = path.join(root, "repository-PRIVATE-NAME");
  const stateHome = path.join(root, "state");
  await mkdir(repository, { recursive: true });
  const state: SessionState = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    protocolVersion: "cba/1",
    sessionId: "session_review_cli",
    taskId: "task_review_cli",
    repositoryRoot: repository,
    repositoryFingerprintAtStart: "f".repeat(64),
    repositoryExcludedStateAtStart: "0".repeat(64),
    preExistingChanges: ["private/PREEXISTING-PATH.ts"],
    objective: "OBJECTIVE-SECRET: repair private behavior",
    acceptanceCriteria: ["CRITERION-SECRET: preserve private data"],
    mode: "edit",
    status: "completed",
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    policyHashes: {
      organization: "a".repeat(64),
      repository: "b".repeat(64),
      grant: "c".repeat(64),
    },
    budgetLimits: { ...DEFAULT_BUDGET_LIMITS },
    budgetUsage: { ...zeroBudgetUsage(), turns: 2, operations: 1, disclosedBytes: 18 },
    turnSequence: 2,
    mutationSequence: 0,
    pendingOperations: [],
    completedOperationIds: ["op_read_01"],
    mutations: [],
    validations: [],
    protocolRepairStreak: 0,
  };
  const store = new SessionStore(stateHome);
  await store.create(state);
  const sessionDirectory = store.sessionDirectory(state.sessionId);
  const audit = new AuditLog(path.join(sessionDirectory, "audit.jsonl"), state.sessionId, {
    now: () => new Date(NOW),
  });
  await audit.append({
    type: "session.created",
    taskId: state.taskId,
    data: { privatePath: "AUDIT-PRIVATE-PATH.ts", modelContent: "MODEL-CONTENT-SECRET" },
  });
  const disclosures = new DisclosureLedger(state.sessionId, {
    outputFile: path.join(sessionDirectory, "disclosures.jsonl"),
    clock: { now: () => new Date(NOW) },
  });
  await disclosures.record({
    operationId: "op_read_01",
    source: "repository-file",
    path: "src/DISCLOSURE-PRIVATE-PATH.ts",
    classification: "internal",
    content: "redacted-safe-data",
    originalByteCount: 18,
  });
  return { root, repository, stateHome, sessionId: state.sessionId, sessionDirectory };
}

test("export-review writes an atomic private source-free package to the session directory", async (context) => {
  const fixture = await createSessionFixture();
  context.after(async () => rm(fixture.root, { recursive: true, force: true }));
  let stdout = "";
  const exitCode = await executeCommand(
    parseCliArguments([
      "export-review",
      fixture.sessionId,
      "--state-home",
      fixture.stateHome,
      "--json",
    ]),
    {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: () => undefined },
    },
  );

  assert.equal(exitCode, 0);
  const commandResult = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(commandResult.exported, true);
  assert.equal("repositoryRoot" in commandResult, false);
  assert.equal("outputFile" in commandResult, false);

  const filename = path.join(fixture.sessionDirectory, "review-package.json");
  const serialized = await readFile(filename, "utf8");
  const reviewPackage = JSON.parse(serialized) as ReviewPackage;
  assert.equal(verifyReviewPackage(reviewPackage), true);
  for (const forbidden of [
    fixture.repository,
    "PRIVATE-NAME",
    "OBJECTIVE-SECRET",
    "CRITERION-SECRET",
    "PREEXISTING-PATH",
    "AUDIT-PRIVATE-PATH",
    "MODEL-CONTENT-SECRET",
    "DISCLOSURE-PRIVATE-PATH",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `review package leaked ${forbidden}`);
  }
  if (process.platform !== "win32") {
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
  }

  const approvedDirectory = path.join(fixture.root, "approved-output");
  const customFile = path.join(approvedDirectory, "review.json");
  await mkdir(approvedDirectory);
  assert.equal(
    await executeCommand(
      parseCliArguments([
        "export-review",
        fixture.sessionId,
        "--state-home",
        fixture.stateHome,
        "--output",
        customFile,
      ]),
      { stdout: { write: () => undefined }, stderr: { write: () => undefined } },
    ),
    0,
  );
  assert.equal(verifyReviewPackage(JSON.parse(await readFile(customFile, "utf8")) as ReviewPackage), true);
});

test("export-review rejects a corrupt audit chain", async (context) => {
  const fixture = await createSessionFixture();
  context.after(async () => rm(fixture.root, { recursive: true, force: true }));
  await appendFile(path.join(fixture.sessionDirectory, "audit.jsonl"), "{\"tampered\":true}\n");
  await assert.rejects(
    executeCommand(
      parseCliArguments(["export-review", fixture.sessionId, "--state-home", fixture.stateHome]),
      { stdout: { write: () => undefined }, stderr: { write: () => undefined } },
    ),
    /Audit verification|Audit chain/,
  );
});

test("export-review rejects repository/state targets and corrupt disclosure evidence", async (context) => {
  const fixture = await createSessionFixture();
  context.after(async () => rm(fixture.root, { recursive: true, force: true }));
  const io = {
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
  };

  await assert.rejects(
    executeCommand(
      parseCliArguments([
        "export-review",
        fixture.sessionId,
        "--state-home",
        fixture.stateHome,
        "--output",
        path.join(fixture.repository, "review.json"),
      ]),
      io,
    ),
    /outside the repository/,
  );
  await assert.rejects(
    executeCommand(
      parseCliArguments([
        "export-review",
        fixture.sessionId,
        "--state-home",
        fixture.stateHome,
        "--output",
        path.join(fixture.sessionDirectory, "session.json"),
      ]),
      io,
    ),
    /state-control files/,
  );

  await appendFile(path.join(fixture.sessionDirectory, "disclosures.jsonl"), "{\"tampered\":true}\n");
  await assert.rejects(
    executeCommand(
      parseCliArguments(["export-review", fixture.sessionId, "--state-home", fixture.stateHome]),
      io,
    ),
    /Disclosure ledger/,
  );
});
