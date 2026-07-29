import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { selectHostPlatform } from "../../src/platform/index.js";
import { RepositoryBoundary } from "../../src/repository/boundary.js";
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
