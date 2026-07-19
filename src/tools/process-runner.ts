import { spawn, type ChildProcess } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { AgentError, errorMessage } from "../shared/errors.js";
import type { ContentProcessor } from "../repository/types.js";
import type { RepositoryBoundary } from "../repository/boundary.js";
import type { CommandCatalog, ResolvedCommand, RunCommandRequest } from "./command-catalog.js";
import { CURRENT_HOST_PLATFORM, type HostPlatform } from "../platform/index.js";
import { spawnSupervisedProcess } from "./process-supervisor.js";

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
  readonly host?: HostPlatform;
}

export class ProcessRunner {
  private readonly contentProcessor: ContentProcessor | undefined;
  private readonly inheritedEnvironmentKeys: readonly string[];
  private readonly terminationGraceMs: number;
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
