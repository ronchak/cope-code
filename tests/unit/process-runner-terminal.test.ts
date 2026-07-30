import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CURRENT_HOST_PLATFORM,
  type HostPlatform,
} from "../../src/platform/index.js";
import { RepositoryBoundary } from "../../src/repository/boundary.js";
import { TERMINAL_EXEC_MAX_ARGUMENT_BYTES } from "../../src/protocol/terminal-exec.js";
import { CommandCatalog } from "../../src/tools/command-catalog.js";
import {
  ProcessRunner,
  type TerminalOutputStream,
  type TerminalProcessRequest,
} from "../../src/tools/process-runner.js";

test("terminal process runner executes exact argv and explicit shell requests", async (context) => {
  const fixture = await runnerFixture(context);
  const literal = `spaces "quotes" & ; $() must stay data`;
  const argv = await capture(fixture.runner, request(fixture.root, {
    mode: "argv",
    executable: process.execPath,
    arguments: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", literal],
  }));
  assert.equal(argv.outcome.outcome, "completed");
  assert.equal(argv.outcome.exitCode, 0);
  assert.deepEqual(JSON.parse(argv.stdout), [literal]);

  const shellCommand = process.platform === "win32" ? "echo shell-ok" : "printf shell-ok";
  const shell = await capture(fixture.runner, request(fixture.root, {
    mode: "shell",
    command: shellCommand,
  }));
  assert.equal(shell.outcome.outcome, "completed");
  assert.equal(shell.stdout.trim(), "shell-ok");
});

test("terminal process runner preserves nonzero and spawn-failure truth", async (context) => {
  const fixture = await runnerFixture(context);
  const nonzero = await capture(fixture.runner, request(fixture.root, {
    mode: "argv",
    executable: process.execPath,
    arguments: ["-e", "process.exit(7)"],
  }));
  assert.equal(nonzero.outcome.outcome, "completed_nonzero");
  assert.equal(nonzero.outcome.exitCode, 7);
  assert.equal(nonzero.outcome.signal, null);

  const missing = process.platform === "win32"
    ? "Z:\\cope-missing\\definitely-not-an-executable.exe"
    : "/cope-missing/definitely-not-an-executable";
  const failed = await capture(fixture.runner, request(fixture.root, {
    mode: "argv",
    executable: missing,
    arguments: [],
  }));
  assert.equal(failed.outcome.outcome, "spawn_failed");
  assert.equal(failed.outcome.exitCode, null);
  assert.equal(failed.outcome.signal, null);
});

test("terminal process runner preserves caller-resolved environment exactly", async (context) => {
  const fixture = await runnerFixture(context);
  const result = await capture(fixture.runner, {
    ...request(fixture.root, {
      mode: "argv",
      executable: process.execPath,
      arguments: [
        "-e",
        "process.stdout.write(`${process.env.TERMINAL_CALLER_VALUE}:${process.env.HOME ?? 'absent'}`)",
      ],
    }),
    environment: {
      PATH: process.env.PATH,
      TERMINAL_CALLER_VALUE: "present",
    },
  });
  assert.equal(result.outcome.outcome, "completed");
  assert.equal(result.stdout, "present:absent");
});

test("terminal process runner separates streams, counts raw bytes, and backpressures sink delivery", async (context) => {
  const fixture = await runnerFixture(context);
  const observed: Array<{ readonly stream: TerminalOutputStream; readonly chunk: Buffer }> = [];
  let activeWrites = 0;
  let maximumActiveWrites = 0;
  const outcome = await fixture.runner.runTerminal(
    {
      ...request(fixture.root, {
        mode: "argv",
        executable: process.execPath,
        arguments: [
          "-e",
          "process.stdout.write(Buffer.from([0,1,2,3,4,5,6,7]));process.stderr.write(Buffer.from([8,9,10,11,12,13,14,15]))",
        ],
      }),
      maxOutputBytes: 10,
    },
    {
      async write(stream, chunk) {
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        await new Promise((resolve) => setTimeout(resolve, 1));
        observed.push({ stream, chunk: Buffer.from(chunk) });
        activeWrites -= 1;
      },
    },
  );
  assert.equal(outcome.outcome, "completed");
  assert.equal(outcome.stdoutBytes, 8);
  assert.equal(outcome.stderrBytes, 8);
  assert.equal(observed.reduce((total, entry) => total + entry.chunk.length, 0), 16);
  assert.equal(maximumActiveWrites, 1);
  const observedStdout = Buffer.concat(
    observed.filter((entry) => entry.stream === "stdout").map((entry) => entry.chunk),
  );
  const observedStderr = Buffer.concat(
    observed.filter((entry) => entry.stream === "stderr").map((entry) => entry.chunk),
  );
  assert.deepEqual(observedStdout, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
  assert.deepEqual(observedStderr, Buffer.from([8, 9, 10, 11, 12, 13, 14, 15]));
});

test("terminal process runner bounds timeout, caller cancellation, and cancelAll", async (context) => {
  const fixture = await runnerFixture(context, { terminationGraceMs: 20, outputFlushGraceMs: 20 });
  const waiting = {
    mode: "argv" as const,
    executable: process.execPath,
    arguments: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
  };
  const timedOut = await capture(fixture.runner, {
    ...request(fixture.root, waiting),
    timeoutMs: 40,
  });
  assert.equal(timedOut.outcome.outcome, "timed_out");

  const controller = new AbortController();
  const activeWaiting = {
    ...request(fixture.root, waiting),
    arguments: [
      "-e",
      "process.stdout.write('ready');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
    ],
  };
  const cancelled = await fixture.runner.runTerminal(activeWaiting, {
    write(stream) {
      if (stream === "stdout") controller.abort();
    },
  }, controller.signal);
  assert.equal(cancelled.outcome, "cancelled");

  const globallyCancelled = await fixture.runner.runTerminal(activeWaiting, {
    write(stream) {
      if (stream === "stdout") void fixture.runner.cancelAll();
    },
  });
  assert.equal(globallyCancelled.outcome, "cancelled");
});

test("terminal cancellation waits for the target process handle to close", async (context) => {
  let targetClosed = false;
  const host = new Proxy(CURRENT_HOST_PLATFORM, {
    get(target, property, receiver) {
      if (property === "platform") return "win32";
      if (property === "terminateProcessTree") {
        return async (child: import("node:child_process").ChildProcess): Promise<void> => {
          child.once("close", () => {
            targetClosed = true;
          });
          setTimeout(() => child.kill("SIGKILL"), 50).unref();
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as HostPlatform;
  const fixture = await runnerFixture(context, {
    host,
    terminationGraceMs: 20,
    outputFlushGraceMs: 20,
  });
  const outcome = await capture(fixture.runner, {
    ...request(fixture.root, {
      mode: "argv",
      executable: process.execPath,
      arguments: ["-e", "setInterval(()=>{},1000)"],
    }),
    timeoutMs: 20,
  });
  assert.equal(outcome.outcome.outcome, "timed_out");
  assert.equal(targetClosed, true);
});

test("POSIX terminal process runner preserves signals and bounds inherited-pipe cleanup", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX signal and process-group truth is not available on Windows");
    return;
  }
  const fixture = await runnerFixture(context, { terminationGraceMs: 20, outputFlushGraceMs: 30 });
  const signalled = await capture(fixture.runner, request(fixture.root, {
    mode: "argv",
    executable: process.execPath,
    arguments: ["-e", "process.kill(process.pid,'SIGTERM')"],
  }));
  assert.equal(signalled.outcome.outcome, "completed_nonzero");
  assert.equal(signalled.outcome.exitCode, null);
  assert.equal(signalled.outcome.signal, "SIGTERM");

  const descendant = await capture(fixture.runner, request(fixture.root, {
    mode: "argv",
    executable: process.execPath,
    arguments: [
      "-e",
      [
        "const {spawn}=require('node:child_process')",
        "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']})",
        "console.log(child.pid)",
        "child.unref()",
      ].join(";"),
    ],
  }));
  assert.equal(descendant.outcome.outcome, "completed");
  const descendantPid = Number(descendant.stdout.trim());
  assert.equal(Number.isSafeInteger(descendantPid) && descendantPid > 1, true);
  assert.equal(isAlive(descendantPid), false);
});

test("terminal process runner enforces aggregate argv bytes before launch", async (context) => {
  const fixture = await runnerFixture(context);
  const result = await capture(fixture.runner, request(fixture.root, {
    mode: "argv",
    executable: process.execPath,
    arguments: Array.from({ length: 9 }, () => "x".repeat(TERMINAL_EXEC_MAX_ARGUMENT_BYTES)),
  }));
  assert.equal(result.outcome.outcome, "spawn_failed");
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("terminal additions leave catalog run_command execution unchanged", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cope-catalog-regression-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const boundary = await RepositoryBoundary.create(root);
  const catalog = new CommandCatalog([{
    id: "catalog-regression",
    category: "test",
    risk: "low",
    sideEffects: false,
    networkRequired: false,
    executable: process.execPath,
    fixedArguments: ["-e", "process.stdout.write('catalog-ok')"],
    timeoutMs: 2_000,
    maxOutputBytes: 1_024,
  }]);
  const outcome = await new ProcessRunner(boundary, catalog).run({
    command_id: "catalog-regression",
  });
  assert.equal(outcome.outcome, "success");
  assert.equal(outcome.stdout, "catalog-ok");
  assert.equal(outcome.stderr, "");
  assert.equal(outcome.truncated, false);
});

async function runnerFixture(
  context: { after(callback: () => void | Promise<void>): void },
  options: ConstructorParameters<typeof ProcessRunner>[2] = {},
): Promise<{ readonly root: string; readonly runner: ProcessRunner }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cope-terminal-runner-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const boundary = await RepositoryBoundary.create(root);
  return {
    root,
    runner: new ProcessRunner(boundary, new CommandCatalog([]), options),
  };
}

function request(
  cwd: string,
  invocation:
    | { readonly mode: "shell"; readonly command: string }
    | {
        readonly mode: "argv";
        readonly executable: string;
        readonly arguments: readonly string[];
      },
): TerminalProcessRequest {
  return {
    operationId: "terminal_test_operation",
    cwd,
    timeoutMs: 2_000,
    maxOutputBytes: 1_024,
    environment: { ...process.env },
    ...invocation,
  };
}

async function capture(
  runner: ProcessRunner,
  terminalRequest: TerminalProcessRequest,
  signal?: AbortSignal,
): Promise<{
  readonly outcome: Awaited<ReturnType<ProcessRunner["runTerminal"]>>;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const chunks: Record<TerminalOutputStream, Buffer[]> = { stdout: [], stderr: [] };
  const outcome = await runner.runTerminal(terminalRequest, {
    write(stream, chunk) {
      chunks[stream].push(Buffer.from(chunk));
    },
  }, signal);
  return {
    outcome,
    stdout: Buffer.concat(chunks.stdout).toString("utf8"),
    stderr: Buffer.concat(chunks.stderr).toString("utf8"),
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
