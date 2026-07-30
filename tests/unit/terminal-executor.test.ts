import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { selectHostPlatform } from "../../src/platform/index.js";
import { RepositoryBoundary } from "../../src/repository/boundary.js";
import {
  WORKSPACE_OBSERVATION_CONTRACT,
  createWorkspacePathFacts,
  type WorkspaceObservation,
} from "../../src/repository/workspace-observer.js";
import { SessionArtifactStore } from "../../src/session/artifact-store.js";
import {
  TerminalArtifactPersistence,
  isTerminalJournalResultMetadata,
} from "../../src/session/terminal-artifacts.js";
import type {
  TerminalOutputSink,
  TerminalProcessRequest,
} from "../../src/tools/process-runner.js";
import { TerminalExecutor } from "../../src/tools/terminal-executor.js";

test("terminal executor persists a bounded head/tail result and replays it exactly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cope-terminal-executor-"));
  await mkdir(path.join(root, "sub"));
  const boundary = await RepositoryBoundary.create(root);
  const persistence = new TerminalArtifactPersistence(
    new SessionArtifactStore(path.join(root, ".state", "artifacts")),
  );
  const chunks = [
    { stream: "stdout" as const, bytes: Buffer.from("HEAD-12345") },
    { stream: "stdout" as const, bytes: Buffer.from("middle-secret-middle") },
    { stream: "stdout" as const, bytes: Buffer.from("TAIL-98765") },
  ];
  const totalBytes = chunks.reduce((total, entry) => total + entry.bytes.length, 0);
  let observedRequest: TerminalProcessRequest | undefined;
  const live: Buffer[] = [];
  const executor = new TerminalExecutor({
    boundary,
    process: {
      runTerminal: async (
        request: TerminalProcessRequest,
        sink: TerminalOutputSink,
      ) => {
        observedRequest = request;
        for (const chunk of chunks) await sink.write(chunk.stream, chunk.bytes);
        return {
          outcome: "completed",
          exitCode: 0,
          signal: null,
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
          durationMs: 1_000,
          stdoutBytes: totalBytes,
          stderrBytes: 0,
        };
      },
    },
    persistence,
    host: selectHostPlatform("linux", "x64"),
    environment: {
      PATH: "/usr/bin",
      HOME: "/developer",
      COPE_INTERNAL_TOKEN: "must-not-inherit",
    },
    contentProcessor: {
      process: async (input) => ({
        content: input.content.replaceAll("secret", "[REDACTED]"),
        redactionCount: input.content.includes("secret") ? 1 : 0,
      }),
    },
    maxLiveOutputBytes: 5,
    onTerminalOutput: async (_operationId, _stream, chunk) => {
      live.push(Buffer.from(chunk));
    },
  });
  const requestHash = "a".repeat(64);
  const outcome = await executor.execute(
    {
      operationId: "op_terminal_executor",
      name: "terminal_exec",
      arguments: {
        contract: "terminal-exec/1",
        mode: "shell",
        command: "printf test",
        cwd: "sub",
      },
    },
    { timeoutMs: 30_000, maxOutputBytes: 16, requestHash },
  );

  assert.equal(outcome.status, "success");
  assert.equal(isTerminalJournalResultMetadata(outcome.safeMetadata), true);
  assert.equal(observedRequest?.cwd, path.join(boundary.root, "sub"));
  assert.equal(observedRequest?.timeoutMs, 30_000);
  assert.equal(observedRequest?.maxOutputBytes, 16);
  assert.equal(observedRequest?.environment.HOME, "/developer");
  assert.equal(observedRequest?.environment.COPE_INTERNAL_TOKEN, undefined);
  assert.equal(Buffer.concat(live).toString("utf8"), "HEAD-");

  const result = outcome.data;
  assert.equal(result.contract, "terminal-exec-result/1");
  assert.equal(result.outcome, "completed");
  assert.equal(result.replayed, false);
  assert.equal(
    (result.stdout as { readonly bytes: number }).bytes,
    totalBytes,
  );
  assert.equal(
    (result.stdout as { readonly truncated: boolean }).truncated,
    true,
  );
  assert.match(
    (result.stdout as { readonly head: string }).head,
    /^HEAD/u,
  );
  assert.match(
    (result.stdout as { readonly tail: string }).tail,
    /98765$/u,
  );
  assert.equal(
    (result.mutation as { readonly outcome: string }).outcome,
    "unknown",
  );

  const requestArtifact = await persistence.readRequest(
    "op_terminal_executor",
  );
  assert.deepEqual(
    requestArtifact?.execution.inherited_environment_keys,
    ["HOME", "PATH"],
  );
  assert.deepEqual(
    requestArtifact?.execution.removed_environment_keys,
    ["COPE_INTERNAL_TOKEN"],
  );
  const replay = await executor.recoverCompleted({
    operationId: "op_terminal_executor",
    tool: "terminal_exec",
    requestHash,
  });
  assert.equal(replay?.status, "success");
  assert.equal(replay?.data.replayed, true);
  assert.deepEqual(
    { ...replay?.data, replayed: false },
    outcome.data,
  );
});

test("terminal executor rejects invalid or host-unsafe calls before launch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cope-terminal-preflight-"));
  const boundary = await RepositoryBoundary.create(root);
  let launches = 0;
  const executor = new TerminalExecutor({
    boundary,
    process: {
      runTerminal: async () => {
        launches += 1;
        throw new Error("must not launch");
      },
    },
    persistence: new TerminalArtifactPersistence(
      new SessionArtifactStore(path.join(root, ".state", "artifacts")),
    ),
    host: selectHostPlatform("win32", "x64"),
    environment: { COMSPEC: "cmd.exe" },
  });

  const outcome = await executor.execute(
    {
      operationId: "op_terminal_batch",
      name: "terminal_exec",
      arguments: {
        contract: "terminal-exec/1",
        mode: "argv",
        executable: "script.cmd",
        arguments: [],
      },
    },
    {
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      requestHash: "b".repeat(64),
    },
  );
  assert.equal(outcome.status, "failure");
  assert.equal(outcome.safeMetadata.outcome, "spawn_failed");
  assert.equal(launches, 0);
  assert.equal(
    await new TerminalArtifactPersistence(
      new SessionArtifactStore(path.join(root, ".state", "artifacts")),
    ).recoverCompleted({
      operationId: "op_terminal_batch",
      tool: "terminal_exec",
      requestHash: "b".repeat(64),
    }),
    undefined,
  );
});

test("terminal executor durably brackets launch with full workspace evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cope-terminal-full-evidence-"));
  const boundary = await RepositoryBoundary.create(root);
  const persistence = new TerminalArtifactPersistence(
    new SessionArtifactStore(path.join(root, ".state", "artifacts")),
  );
  const operationId = "op_terminal_full_evidence";
  const requestHash = "c".repeat(64);
  const pre = workspaceObservation("pre", "a".repeat(64));
  const post = workspaceObservation("post", "b".repeat(64));
  const paths = createWorkspacePathFacts({
    created: ["src/new.ts"],
    updated: [],
    deleted: [],
    renamed: [],
    preExistingTouched: [],
  });
  let processLaunches = 0;
  const executor = new TerminalExecutor({
    boundary,
    persistence,
    host: selectHostPlatform("linux", "x64"),
    observer: {
      capturePre: async () => pre,
      capturePost: async (observedPre) => {
        assert.deepEqual(observedPre, pre);
        return post;
      },
      compare: async (observedPre, observedPost) => {
        assert.deepEqual(observedPre, pre);
        assert.deepEqual(observedPost, post);
        return {
          outcome: "observed",
          paths,
          changedFiles: 1,
          changedLines: 2,
          binaryFiles: 0,
          unavailableBaselineCount: 0,
          repositoryFingerprint: post.repositoryFingerprint,
          postObservationControl: {
            branch: post.branch,
            head: post.head,
            excludedStateFingerprint:
              post.components.excluded,
          },
          limitationCodes: [],
        };
      },
    },
    process: {
      runTerminal: async () => {
        processLaunches += 1;
        const evidence = await persistence.inspectIncompleteEvidence({
          operationId,
          requestHash,
          recoveryContext: "ordinary_process_crash",
        });
        assert.equal(
          evidence.state,
          "launch_without_exit",
          "request, pre-observation, and launch receipt must be durable before process launch",
        );
        return {
          outcome: "completed",
          exitCode: 0,
          signal: null,
          startedAt: "2026-01-01T00:00:01.000Z",
          completedAt: "2026-01-01T00:00:02.000Z",
          durationMs: 1_000,
          stdoutBytes: 0,
          stderrBytes: 0,
        };
      },
    },
  });

  const outcome = await executor.execute(
    {
      operationId,
      name: "terminal_exec",
      arguments: {
        contract: "terminal-exec/1",
        mode: "shell",
        command: "true",
      },
    },
    {
      timeoutMs: 30_000,
      maxOutputBytes: 8_192,
      requestHash,
      preExistingBaseline: {
        paths: [],
        hasReconstructibleBaseline: async () => false,
      },
    },
  );

  assert.equal(processLaunches, 1);
  assert.equal(outcome.status, "success");
  assert.equal(isTerminalJournalResultMetadata(outcome.safeMetadata), true);
  if (!isTerminalJournalResultMetadata(outcome.safeMetadata)) {
    assert.fail("expected full terminal journal metadata");
  }
  assert.equal(outcome.safeMetadata.mutation_outcome, "observed");
  assert.equal(outcome.safeMetadata.changed_files, 1);
  assert.equal(outcome.safeMetadata.changed_lines, 2);
  const evidence = await executor.inspectCompletedEvidence({
    operationId,
    requestHash,
    terminalResult: outcome.safeMetadata.terminal_result,
  });
  assert.equal("launch_receipt" in evidence.artifact, true);
  assert.equal(evidence.artifact.result.mutation.outcome, "observed");
  assert.deepEqual(
    evidence.artifact.result.mutation.created,
    ["src/new.ts"],
  );
  assert.equal(
    evidence.artifact.result.mutation.path_facts_sha256,
    paths.completeFactsSha256,
  );
});

test("terminal executor preserves unknown attribution when post observation fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cope-terminal-unknown-effect-"));
  const boundary = await RepositoryBoundary.create(root);
  const persistence = new TerminalArtifactPersistence(
    new SessionArtifactStore(path.join(root, ".state", "artifacts")),
  );
  const operationId = "op_terminal_unknown_effect";
  const requestHash = "d".repeat(64);
  const pre = workspaceObservation("pre", "a".repeat(64));
  const executor = new TerminalExecutor({
    boundary,
    persistence,
    host: selectHostPlatform("linux", "x64"),
    observer: {
      capturePre: async () => pre,
      capturePost: async () => {
        throw new Error("post observation unavailable");
      },
      compare: async () => {
        throw new Error("comparison unavailable");
      },
    },
    process: {
      runTerminal: async () => ({
        outcome: "completed",
        exitCode: 0,
        signal: null,
        startedAt: "2026-01-01T00:00:01.000Z",
        completedAt: "2026-01-01T00:00:02.000Z",
        durationMs: 1_000,
        stdoutBytes: 0,
        stderrBytes: 0,
      }),
    },
  });

  const outcome = await executor.execute(
    {
      operationId,
      name: "terminal_exec",
      arguments: {
        contract: "terminal-exec/1",
        mode: "shell",
        command: "true",
      },
    },
    {
      timeoutMs: 30_000,
      maxOutputBytes: 8_192,
      requestHash,
      preExistingBaseline: {
        paths: [],
        hasReconstructibleBaseline: async () => false,
      },
    },
  );

  assert.equal(outcome.status, "success");
  assert.equal(isTerminalJournalResultMetadata(outcome.safeMetadata), true);
  if (!isTerminalJournalResultMetadata(outcome.safeMetadata)) {
    assert.fail("expected full terminal journal metadata");
  }
  assert.equal(outcome.safeMetadata.mutation_outcome, "unknown");
  assert.equal(outcome.safeMetadata.changed_files, 0);
  assert.equal(outcome.safeMetadata.changed_lines, 0);
  const evidence = await executor.inspectCompletedEvidence({
    operationId,
    requestHash,
    terminalResult: outcome.safeMetadata.terminal_result,
  });
  assert.equal("launch_receipt" in evidence.artifact, true);
  assert.equal(evidence.artifact.result.mutation.outcome, "unknown");
  assert.match(
    evidence.artifact.result.mutation.ignored_summary,
    /COMPARE_FAILED/u,
  );
});

function workspaceObservation(
  phase: WorkspaceObservation["phase"],
  repositoryFingerprint: string,
): WorkspaceObservation & { readonly state: "complete" } {
  return {
    contract: WORKSPACE_OBSERVATION_CONTRACT,
    phase,
    observedAt:
      phase === "pre"
        ? "2026-01-01T00:00:00.000Z"
        : "2026-01-01T00:00:02.000Z",
    durationMs: 20,
    state: "complete",
    branch: "main",
    head: "b".repeat(40),
    repositoryFingerprint,
    components: {
      index: "1".repeat(64),
      visible: "2".repeat(64),
      excluded: "3".repeat(64),
      protectedWorktree: "4".repeat(64),
      gitTransitions: "5".repeat(64),
      gitControls: "6".repeat(64),
    },
    entries: [],
    beforeImages: [],
    transitionPaths: {
      paths: [],
      total: 0,
      omitted: 0,
      truncated: false,
      completeFactsSha256: "7".repeat(64),
    },
    ignoredCount: 0,
    ignoredSummarySha256: "8".repeat(64),
    ignoredSummaryTruncated: false,
    nestedRepository: "none",
    limitationCodes: [],
  };
}
