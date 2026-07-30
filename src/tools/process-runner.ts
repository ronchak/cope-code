import { spawn, type ChildProcess } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { AgentError, errorMessage } from "../shared/errors.js";
import type { ContentProcessor } from "../repository/types.js";
import type { RepositoryBoundary } from "../repository/boundary.js";
import type { CommandCatalog, ResolvedCommand, RunCommandRequest } from "./command-catalog.js";
import {
  CURRENT_HOST_PLATFORM,
  resolveTerminalLaunch,
  type HostPlatform,
} from "../platform/index.js";
import { TERMINAL_EXEC_MAX_TOTAL_ARGUMENT_BYTES } from "../protocol/terminal-exec.js";
import {
  spawnSupervisedProcess,
  spawnSupervisedProcessWithExit,
  ProcessSupervisorLaunchError,
  type SupervisedCommandExit,
} from "./process-supervisor.js";

const WINDOWS_PROCESS_CLOSE_GRACE_MS = 1_000;

export type TerminalOutputStream = "stdout" | "stderr";

export interface TerminalOutputSink {
  write(stream: TerminalOutputStream, chunk: Uint8Array): void | Promise<void>;
}

interface TerminalProcessRequestBase {
  readonly operationId: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly environment: NodeJS.ProcessEnv;
}

export type TerminalProcessRequest =
  | (TerminalProcessRequestBase & {
      readonly mode: "shell";
      readonly command: string;
    })
  | (TerminalProcessRequestBase & {
      readonly mode: "argv";
      readonly executable: string;
      readonly arguments: readonly string[];
    });

export type TerminalProcessOutcomeKind =
  | "completed"
  | "completed_nonzero"
  | "spawn_failed"
  | "timed_out"
  | "cancelled"
  | "indeterminate";

export interface TerminalProcessOutcome {
  readonly outcome: TerminalProcessOutcomeKind;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

/**
 * Slice 1 implements this execution surface. C0 deliberately exports only the
 * contract so the existing catalog runner cannot accidentally grant it.
 */
export interface TerminalProcessExecutor {
  runTerminal(
    request: TerminalProcessRequest,
    sink: TerminalOutputSink,
    signal?: AbortSignal,
  ): Promise<TerminalProcessOutcome>;
}

export type CommandOutcomeKind =
  | "success"
  | "failure"
  | "timeout"
  | "cancelled"
  | "policy-denied"
  | "indeterminate";

export interface CommandOutcome {
  readonly commandId: string;
  readonly outcome: CommandOutcomeKind;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly redactionCount: number;
  readonly error?: string;
}

export interface ProcessRunnerOptions {
  readonly contentProcessor?: ContentProcessor;
  readonly inheritedEnvironmentKeys?: readonly string[];
  readonly terminationGraceMs?: number;
  readonly outputFlushGraceMs?: number;
  readonly host?: HostPlatform;
}

export class ProcessRunner implements TerminalProcessExecutor {
  private readonly contentProcessor: ContentProcessor | undefined;
  private readonly inheritedEnvironmentKeys: readonly string[];
  private readonly terminationGraceMs: number;
  private readonly outputFlushGraceMs: number;
  private readonly active = new Map<ChildProcess, () => void>();
  private readonly pendingLaunches = new Set<AbortController>();
  private readonly host: HostPlatform;

  public constructor(
    private readonly boundary: RepositoryBoundary,
    private readonly catalog: CommandCatalog,
    options: ProcessRunnerOptions = {},
  ) {
    this.contentProcessor = options.contentProcessor;
    this.inheritedEnvironmentKeys =
      options.inheritedEnvironmentKeys ??
      [
        "PATH",
        "SystemRoot",
        "SYSTEMROOT",
        "COMSPEC",
        "PATHEXT",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
      ];
    this.terminationGraceMs = options.terminationGraceMs ?? 1_000;
    this.outputFlushGraceMs = options.outputFlushGraceMs ?? 250;
    this.host = options.host ?? CURRENT_HOST_PLATFORM;
  }

  /**
   * Resolves the exact catalog contract without starting a process. The tool
   * host uses this read-only view to establish repository invariants before a
   * command can cross the process boundary.
   */
  public describe(request: RunCommandRequest): ResolvedCommand {
    return this.catalog.resolve(request);
  }

  public async run(request: RunCommandRequest, signal?: AbortSignal): Promise<CommandOutcome> {
    const startedAt = Date.now();
    let command: ResolvedCommand;
    try {
      command = this.catalog.resolve(request);
      await this.validateRepositoryPaths(command);
      command = { ...command, executable: await this.validateExecutable(command.executable) };
    } catch (error) {
      return outcomeForError(request.command_id, "policy-denied", error, Date.now() - startedAt);
    }
    if (signal?.aborted === true) {
      return emptyOutcome(command.id, "cancelled", Date.now() - startedAt);
    }
    const cwd = await this.boundary.resolveExistingDirectory(
      command.workingDirectory === "" ? "." : command.workingDirectory,
    );

    let child: ChildProcess;
    const launchController = new AbortController();
    const abortLaunch = (): void => launchController.abort();
    signal?.addEventListener("abort", abortLaunch, { once: true });
    this.pendingLaunches.add(launchController);
    try {
      child = this.host.platform === "win32"
        ? spawn(command.executable, command.arguments, {
            cwd: cwd.absolutePath,
            env: this.environmentFor(command),
            shell: false,
            windowsHide: true,
            detached: false,
            stdio: ["ignore", "pipe", "pipe"],
          })
        : await spawnSupervisedProcess({
            executable: command.executable,
            arguments: command.arguments,
            cwd: cwd.absolutePath,
            environment: this.environmentFor(command),
            signal: launchController.signal,
          });
    } catch (error) {
      return outcomeForError(
        command.id,
        isSignalAborted(signal) || launchController.signal.aborted ? "cancelled" : "indeterminate",
        error,
        Date.now() - startedAt,
      );
    } finally {
      this.pendingLaunches.delete(launchController);
      signal?.removeEventListener("abort", abortLaunch);
    }
    if (isSignalAborted(signal)) {
      await this.host.terminateProcessTree(child, this.terminationGraceMs);
      return emptyOutcome(command.id, "cancelled", Date.now() - startedAt);
    }

    return await new Promise((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let retainedBytes = 0;
      let truncated = false;
      let terminalReason: "timeout" | "cancelled" | undefined;
      let settled = false;

      const retain = (target: Buffer[], chunk: Buffer): void => {
        const available = command.maxOutputBytes - retainedBytes;
        if (available <= 0) {
          truncated = true;
          return;
        }
        const retained = chunk.length > available ? chunk.subarray(0, available) : chunk;
        target.push(retained);
        retainedBytes += retained.length;
        truncated ||= retained.length !== chunk.length;
      };
      child.stdout?.on("data", (chunk: Buffer) => retain(stdoutChunks, chunk));
      child.stderr?.on("data", (chunk: Buffer) => retain(stderrChunks, chunk));

      const terminate = (reason: "timeout" | "cancelled"): void => {
        if (terminalReason !== undefined || child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        terminalReason = reason;
        void this.host.terminateProcessTree(child, this.terminationGraceMs);
      };
      const timeout = setTimeout(() => terminate("timeout"), command.timeoutMs);
      timeout.unref();
      const onAbort = (): void => terminate("cancelled");
      this.active.set(child, onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });

      child.once("error", async (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        this.active.delete(child);
        resolve(outcomeForError(command.id, terminalReason ?? "indeterminate", error, Date.now() - startedAt));
      });
      child.once("close", async (exitCode, closeSignal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        this.active.delete(child);
        const rawStdout = Buffer.concat(stdoutChunks).toString("utf8");
        const rawStderr = Buffer.concat(stderrChunks).toString("utf8");
        const disclosureStdout = truncated ? removeTruncatedTail(rawStdout) : rawStdout;
        const disclosureStderr = truncated ? removeTruncatedTail(rawStderr) : rawStderr;
        const operationId = request.operationId ?? `run_command:${command.id}`;
        let stdout;
        let stderr;
        try {
          [stdout, stderr] = await Promise.all([
            this.processOutput(operationId, disclosureStdout),
            this.processOutput(operationId, disclosureStderr),
          ]);
        } catch (error) {
          resolve(outcomeForError(command.id, "policy-denied", error, Date.now() - startedAt));
          return;
        }
        const outcome =
          terminalReason ??
          (exitCode !== null && command.successExitCodes.includes(exitCode)
            ? "success"
            : exitCode !== null || closeSignal !== null
              ? "failure"
              : "indeterminate");
        const bounded = boundCombinedOutput(stdout.content, stderr.content, command.maxOutputBytes);
        truncated ||= bounded.truncated;
        resolve({
          commandId: command.id,
          outcome,
          exitCode,
          signal: closeSignal,
          stdout: bounded.stdout,
          stderr: bounded.stderr,
          truncated,
          durationMs: Date.now() - startedAt,
          redactionCount: stdout.redactionCount + stderr.redactionCount,
        });
      });
    });
  }

  public async runTerminal(
    request: TerminalProcessRequest,
    sink: TerminalOutputSink,
    signal?: AbortSignal,
  ): Promise<TerminalProcessOutcome> {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    if (signal?.aborted === true) {
      return terminalOutcome("cancelled", null, null, startedAtMs, startedAt, 0, 0);
    }

    let launch: ReturnType<typeof resolveTerminalLaunch>;
    try {
      validateTerminalProcessRequest(request);
      launch = resolveTerminalLaunch(this.host, request, request.environment);
    } catch {
      return terminalOutcome("spawn_failed", null, null, startedAtMs, startedAt, 0, 0);
    }

    const launchController = new AbortController();
    const abortLaunch = (): void => launchController.abort();
    signal?.addEventListener("abort", abortLaunch, { once: true });
    this.pendingLaunches.add(launchController);

    let child: ChildProcess;
    let commandExit: Promise<SupervisedCommandExit> | undefined;
    let spawned = this.host.platform !== "win32";
    try {
      if (this.host.platform === "win32") {
        child = spawn(launch.executable, [...launch.arguments], {
          cwd: request.cwd,
          env: request.environment,
          shell: false,
          windowsHide: true,
          detached: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } else {
        const supervised = await spawnSupervisedProcessWithExit({
          executable: launch.executable,
          arguments: launch.arguments,
          cwd: request.cwd,
          environment: request.environment,
          signal: launchController.signal,
          cleanupTreeOnExit: true,
        });
        child = supervised.child;
        commandExit = supervised.commandExit;
      }
    } catch (error) {
      const outcome =
        Boolean(signal?.aborted) || launchController.signal.aborted
          ? "cancelled"
          : error instanceof ProcessSupervisorLaunchError
            ? error.reason
            : "spawn_failed";
      return terminalOutcome(outcome, null, null, startedAtMs, startedAt, 0, 0);
    } finally {
      this.pendingLaunches.delete(launchController);
      signal?.removeEventListener("abort", abortLaunch);
    }

    return await new Promise<TerminalProcessOutcome>((resolve) => {
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let sinkWrites = Promise.resolve();
      let actualExit: SupervisedCommandExit | undefined;
      let terminalReason: "timed_out" | "cancelled" | undefined;
      let settled = false;
      let sawClose = false;
      let terminationDone = false;
      let flushTimer: ReturnType<typeof setTimeout> | undefined;

      const queueOutput = (stream: TerminalOutputStream, value: Buffer | string): void => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (stream === "stdout") stdoutBytes = saturatingAdd(stdoutBytes, chunk.length);
        else stderrBytes = saturatingAdd(stderrBytes, chunk.length);
        // The sink owns the request's retained-output ceiling so it can keep a
        // truthful head and tail. Pause both pipes while an asynchronous write
        // is pending instead of retaining an unbounded queue of raw chunks here.
        child.stdout?.pause();
        child.stderr?.pause();
        sinkWrites = sinkWrites
          .then(async () => sink.write(stream, chunk))
          .catch(() => undefined)
          .finally(() => {
            if (!settled) {
              child.stdout?.resume();
              child.stderr?.resume();
            }
          });
      };
      const onStdout = (chunk: Buffer | string): void => queueOutput("stdout", chunk);
      const onStderr = (chunk: Buffer | string): void => queueOutput("stderr", chunk);
      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);

      const cleanup = (): void => {
        clearTimeout(timeout);
        if (flushTimer !== undefined) clearTimeout(flushTimer);
        signal?.removeEventListener("abort", onAbort);
        child.stdout?.removeListener("data", onStdout);
        child.stderr?.removeListener("data", onStderr);
        this.active.delete(child);
      };
      const finish = (fallback: TerminalProcessOutcomeKind = "indeterminate"): void => {
        if (settled) return;
        if (terminalReason !== undefined && !terminationDone) return;
        settled = true;
        cleanup();
        const exitCode = actualExit?.exitCode ?? null;
        const exitSignal = actualExit?.signal ?? null;
        const outcome =
          terminalReason ??
          (actualExit === undefined || (exitCode === null && exitSignal === null)
            ? fallback
            : exitCode === 0
              ? "completed"
              : "completed_nonzero");
        void sinkWrites.finally(() => {
          resolve(terminalOutcome(
            outcome,
            exitCode,
            exitSignal,
            startedAtMs,
            startedAt,
            stdoutBytes,
            stderrBytes,
          ));
        });
      };
      const destroyOutput = (): void => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      };
      const waitForClose = async (): Promise<void> => {
        if (sawClose) return;
        await new Promise<void>((resolveClose) => {
          let done = false;
          const finishCloseWait = (): void => {
            if (done) return;
            done = true;
            clearTimeout(deadline);
            child.removeListener("close", onClose);
            resolveClose();
          };
          const onClose = (): void => finishCloseWait();
          const closeGraceMs = this.host.platform === "win32"
            ? Math.max(this.outputFlushGraceMs, WINDOWS_PROCESS_CLOSE_GRACE_MS)
            : this.outputFlushGraceMs;
          const deadline = setTimeout(finishCloseWait, closeGraceMs);
          deadline.unref();
          child.once("close", onClose);
          if (sawClose) finishCloseWait();
        });
      };
      const terminate = (reason: "timed_out" | "cancelled"): void => {
        if (terminalReason !== undefined || actualExit !== undefined || settled) return;
        terminalReason = reason;
        void this.host.terminateProcessTree(child, this.terminationGraceMs)
          .catch(() => undefined)
          .finally(async () => {
            destroyOutput();
            await waitForClose();
            terminationDone = true;
            finish(reason);
          });
      };
      const onAbort = (): void => terminate("cancelled");
      const timeout = setTimeout(() => terminate("timed_out"), request.timeoutMs);
      timeout.unref();
      this.active.set(child, onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });

      const observeExit = (exit: SupervisedCommandExit): void => {
        if (actualExit !== undefined || settled) return;
        actualExit = exit;
        if (terminalReason !== undefined) return;
        if (sawClose) {
          finish();
          return;
        }
        flushTimer = setTimeout(() => {
          void this.host.terminateProcessTree(child, this.terminationGraceMs)
            .catch(() => undefined)
            .finally(async () => {
              destroyOutput();
              await waitForClose();
              finish();
            });
        }, this.outputFlushGraceMs);
        flushTimer.unref();
      };
      if (commandExit === undefined) {
        child.once("exit", (exitCode, exitSignal) => {
          observeExit({ exitCode, signal: exitSignal });
        });
      } else {
        void commandExit.then(observeExit);
      }
      child.once("spawn", () => {
        spawned = true;
      });
      child.once("error", () => {
        if (terminalReason !== undefined) return;
        finish(spawned ? "indeterminate" : "spawn_failed");
      });
      child.once("close", () => {
        sawClose = true;
        queueMicrotask(() => finish());
      });
      if (signal?.aborted === true) onAbort();
    });
  }

  public async cancelAll(): Promise<void> {
    for (const launch of this.pendingLaunches) launch.abort();
    for (const cancel of this.active.values()) {
      cancel();
    }
  }

  private async validateRepositoryPaths(command: ResolvedCommand): Promise<void> {
    for (const parameter of command.repositoryPathParameters) {
      await this.boundary.resolve(parameter.value, {
        allowMissingLeaf: !parameter.mustExist,
      });
    }
  }

  private async validateExecutable(configuredPath: string): Promise<string> {
    let canonical: string;
    try {
      canonical = await realpath(configuredPath);
      const executableStat = await stat(canonical);
      if (!executableStat.isFile()) {
        throw new AgentError("POLICY_DENIED", "Approved command executable is not a regular file");
      }
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError(
        "POLICY_DENIED",
        "Approved command executable cannot be canonicalized",
        { configuredPath },
        { cause: error },
      );
    }
    const relative = path.relative(this.boundary.root, canonical);
    const insideRepository =
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    if (insideRepository) {
      throw new AgentError("POLICY_DENIED", "Repository-writable executables cannot be used by the command catalog", {
        configuredPath,
      });
    }
    return canonical;
  }

  private environmentFor(command: ResolvedCommand): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of this.inheritedEnvironmentKeys) {
      const value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }
    for (const [key, value] of Object.entries(command.environment)) {
      env[key] = value;
    }
    return env;
  }

  private async processOutput(
    operationId: string,
    content: string,
  ): Promise<{ readonly content: string; readonly redactionCount: number }> {
    return (
      (await this.contentProcessor?.process({
        operationId,
        source: "command-output",
        content,
      })) ?? { content, redactionCount: 0 }
    );
  }
}

function validateTerminalProcessRequest(request: TerminalProcessRequest): void {
  if (
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    !Number.isSafeInteger(request.maxOutputBytes) ||
    request.maxOutputBytes < 1 ||
    request.cwd.length === 0 ||
    request.cwd.includes("\0")
  ) {
    throw new TypeError("Terminal process request bounds are invalid");
  }
  for (const [key, value] of Object.entries(request.environment)) {
    if (
      key.length === 0 ||
      key.includes("\0") ||
      key.includes("=") ||
      (value !== undefined && value.includes("\0"))
    ) {
      throw new TypeError("Terminal process environment is invalid");
    }
  }
  if (request.mode === "argv") {
    const totalArgumentBytes = request.arguments.reduce(
      (total, argument) => saturatingAdd(total, Buffer.byteLength(argument)),
      0,
    );
    if (totalArgumentBytes > TERMINAL_EXEC_MAX_TOTAL_ARGUMENT_BYTES) {
      throw new RangeError("Terminal arguments exceed the aggregate byte limit");
    }
  }
}

function terminalOutcome(
  outcome: TerminalProcessOutcomeKind,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  startedAtMs: number,
  startedAt: string,
  stdoutBytes: number,
  stderrBytes: number,
): TerminalProcessOutcome {
  const completedAtMs = Date.now();
  return {
    outcome,
    exitCode,
    signal,
    startedAt,
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: Math.max(0, completedAtMs - startedAtMs),
    stdoutBytes,
    stderrBytes,
  };
}

function saturatingAdd(current: number, increment: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + increment);
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function removeTruncatedTail(value: string): string {
  if (value === "") {
    return value;
  }
  const marker = "[OUTPUT_TAIL_REDACTED_AFTER_TRUNCATION]";
  const bytes = Buffer.from(value, "utf8");
  const retained = bytes.subarray(0, Math.max(0, bytes.length - 256)).toString("utf8");
  return `${retained}${marker}`;
}

function boundCombinedOutput(
  stdout: string,
  stderr: string,
  maxBytes: number,
): { readonly stdout: string; readonly stderr: string; readonly truncated: boolean } {
  const stdoutResult = boundUtf8(stdout, maxBytes);
  const remaining = Math.max(0, maxBytes - Buffer.byteLength(stdoutResult.value));
  const stderrResult = boundUtf8(stderr, remaining);
  return {
    stdout: stdoutResult.value,
    stderr: stderrResult.value,
    truncated: stdoutResult.truncated || stderrResult.truncated,
  };
}

function boundUtf8(value: string, maxBytes: number): { readonly value: string; readonly truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) {
    return { value, truncated: false };
  }
  if (maxBytes === 0) {
    return { value: "", truncated: true };
  }
  let end = maxBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) {
    end -= 1;
  }
  return { value: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

function terminationEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function emptyOutcome(
  commandId: string,
  outcome: CommandOutcomeKind,
  durationMs: number,
): CommandOutcome {
  return {
    commandId,
    outcome,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    durationMs,
    redactionCount: 0,
  };
}

function outcomeForError(
  commandId: string,
  outcome: CommandOutcomeKind,
  error: unknown,
  durationMs: number,
): CommandOutcome {
  const normalizedOutcome =
    error instanceof AgentError && error.code === "POLICY_DENIED" ? "policy-denied" : outcome;
  return { ...emptyOutcome(commandId, normalizedOutcome, durationMs), error: errorMessage(error) };
}
