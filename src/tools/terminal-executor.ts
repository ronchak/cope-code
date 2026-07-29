import type { RepositoryBoundary } from "../repository/boundary.js";
import type {
  SessionPreExistingBaseline,
  WorkspaceObserver,
} from "../repository/workspace-observer.js";
import type { ContentProcessor } from "../repository/types.js";
import {
  TERMINAL_EXEC_CONTRACT,
  TERMINAL_EXEC_RESULT_CONTRACT,
  type TerminalExecMutationResult,
  type TerminalExecResult,
  type TerminalExecStreamResult,
} from "../protocol/terminal-exec.js";
import {
  formatSchemaErrors,
  validateToolArguments,
} from "../protocol/schemas.js";
import type { TerminalExecArguments } from "../protocol/types.js";
import {
  resolveTerminalLaunch,
  type HostPlatform,
} from "../platform/index.js";
import { sha256, stableJson } from "../shared/crypto.js";
import { errorMessage } from "../shared/errors.js";
import {
  TerminalArtifactPersistence,
  type RecoverTerminalResultInput,
  type IncompleteTerminalEvidence,
  type TerminalRecoveryContext,
  type TerminalPrelaunchFailureMetadata,
} from "../session/terminal-artifacts.js";
import type {
  TerminalOutputSink,
  TerminalOutputStream,
  TerminalProcessExecutor,
  TerminalProcessOutcome,
} from "./process-runner.js";

const MAX_RESULT_OUTPUT_SOURCE_BYTES = 768 * 1024;
const DEFAULT_MAX_LIVE_OUTPUT_BYTES = 1024 * 1024;

export interface TerminalExecutorCall {
  readonly operationId: string;
  readonly name: "terminal_exec";
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface TerminalExecutorContext {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly requestHash: string;
  readonly preExistingBaseline?: SessionPreExistingBaseline;
}

export interface TerminalExecutorOutcome {
  readonly operationId: string;
  readonly tool: "terminal_exec";
  readonly status:
    | "success"
    | "failure"
    | "timeout"
    | "cancelled"
    | "indeterminate";
  readonly data: Readonly<Record<string, unknown>>;
  readonly safeMetadata: Readonly<Record<string, unknown>>;
}

export type TerminalLiveOutput = (
  operationId: string,
  stream: TerminalOutputStream,
  chunk: Uint8Array,
  cumulativeBytes: number,
) => void | Promise<void>;

export interface TerminalExecutorDependencies {
  readonly boundary: RepositoryBoundary;
  readonly process: TerminalProcessExecutor;
  readonly persistence: TerminalArtifactPersistence;
  readonly host: HostPlatform;
  readonly contentProcessor?: ContentProcessor;
  readonly environment?: NodeJS.ProcessEnv;
  readonly onTerminalOutput?: TerminalLiveOutput;
  readonly maxLiveOutputBytes?: number;
  readonly observer?: WorkspaceObserver;
}

/**
 * Executes one authorized terminal-exec/1 call. The journal remains owned by
 * AgentRuntime; this layer owns process evidence and persists the complete
 * result before returning it to that journal transaction.
 */
export class TerminalExecutor {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly maxLiveOutputBytes: number;

  public constructor(private readonly dependencies: TerminalExecutorDependencies) {
    this.environment = dependencies.environment ?? process.env;
    this.maxLiveOutputBytes =
      dependencies.maxLiveOutputBytes ?? DEFAULT_MAX_LIVE_OUTPUT_BYTES;
    if (
      !Number.isSafeInteger(this.maxLiveOutputBytes) ||
      this.maxLiveOutputBytes < 0
    ) {
      throw new TypeError("Terminal live-output bound is invalid");
    }
  }

  public async execute(
    call: TerminalExecutorCall,
    context: TerminalExecutorContext,
    signal?: AbortSignal,
  ): Promise<TerminalExecutorOutcome> {
    const validation = validateToolArguments("terminal_exec", call.arguments);
    if (!validation.valid || validation.value === undefined) {
      return prelaunchFailure(
        call.operationId,
        "TERMINAL_ARGUMENTS_INVALID",
        formatSchemaErrors(validation.errors).join("; "),
      );
    }
    if (!validContext(context)) {
      return prelaunchFailure(
        call.operationId,
        "TERMINAL_CONTEXT_INVALID",
        "The authorized terminal execution bounds are invalid.",
      );
    }

    const args = validation.value;
    let prepared: PreparedTerminalExecution;
    try {
      prepared = await this.prepare(args, context);
    } catch (error) {
      return prelaunchFailure(
        call.operationId,
        "TERMINAL_PRELAUNCH_REJECTED",
        errorMessage(error),
      );
    }

    try {
      const requestReference = await this.dependencies.persistence.persistRequest({
        operation_id: call.operationId,
        request_hash: context.requestHash,
        invocation: prepared.invocation,
        execution: prepared.execution,
      });
      const preObservation =
        await this.dependencies.persistence.persistObservation({
          operation_id: call.operationId,
          request_hash: context.requestHash,
          phase: "pre",
          observed_at: new Date().toISOString(),
        });

      const captureLimit = Math.min(
        context.maxOutputBytes,
        MAX_RESULT_OUTPUT_SOURCE_BYTES,
      );
      const stdout = new BoundedRawCapture(captureLimit);
      const stderr = new BoundedRawCapture(captureLimit);
      const sink = this.outputSink(call.operationId, stdout, stderr);
      const processOutcome = await this.dependencies.process.runTerminal(
        {
          operationId: call.operationId,
          cwd: prepared.execution.cwd,
          timeoutMs: context.timeoutMs,
          maxOutputBytes: context.maxOutputBytes,
          environment: prepared.environment,
          ...(args.mode === "shell"
            ? { mode: "shell" as const, command: args.command }
            : {
                mode: "argv" as const,
                executable: args.executable,
                arguments: args.arguments,
              }),
        },
        sink,
        signal,
      );

      const exitReceipt =
        await this.dependencies.persistence.persistExitReceipt({
          operation_id: call.operationId,
          request_hash: context.requestHash,
          outcome: processOutcome.outcome,
          exit_code: processOutcome.exitCode,
          signal: processOutcome.signal,
          started_at: processOutcome.startedAt,
          completed_at: processOutcome.completedAt,
          duration_ms: processOutcome.durationMs,
          timeout_attributed: processOutcome.outcome === "timed_out",
          cancellation_attributed: processOutcome.outcome === "cancelled",
          stdout_bytes: processOutcome.stdoutBytes,
          stderr_bytes: processOutcome.stderrBytes,
        });
      const postObservation =
        await this.dependencies.persistence.persistObservation({
          operation_id: call.operationId,
          request_hash: context.requestHash,
          phase: "post",
          observed_at: new Date().toISOString(),
        });

      const disclosed = await this.disclosedStreams(
        call.operationId,
        stdout,
        stderr,
        processOutcome,
        captureLimit,
      );
      const result: TerminalExecResult = {
        contract: TERMINAL_EXEC_RESULT_CONTRACT,
        operation_id: call.operationId,
        invocation: prepared.invocation,
        outcome: processOutcome.outcome,
        exit_code: processOutcome.exitCode,
        signal: processOutcome.signal,
        started_at: processOutcome.startedAt,
        completed_at: processOutcome.completedAt,
        duration_ms: processOutcome.durationMs,
        timeout_attributed: processOutcome.outcome === "timed_out",
        cancellation_attributed: processOutcome.outcome === "cancelled",
        stdout: disclosed.stdout,
        stderr: disclosed.stderr,
        redaction_count: disclosed.redactionCount,
        disclosure: disclosed.disclosure,
        mutation: placeholderMutation(processOutcome),
        replayed: false,
      };
      const persisted = await this.dependencies.persistence.persistResult({
        operationId: call.operationId,
        requestHash: context.requestHash,
        request: requestReference,
        preObservation,
        exitReceipt,
        postObservation,
        result,
      });
      return {
        operationId: call.operationId,
        tool: "terminal_exec",
        status: toolStatus(processOutcome.outcome),
        data: { ...result },
        safeMetadata: { ...persisted.safeMetadata },
      };
    } catch {
      return persistenceFailure(call.operationId);
    }
  }

  public async recoverCompleted(
    input: RecoverTerminalResultInput,
  ): Promise<TerminalExecutorOutcome | undefined> {
    const evidence =
      await this.dependencies.persistence.recoverCompletedEvidence(input);
    if (evidence === undefined) return undefined;
    return {
      operationId: input.operationId,
      tool: "terminal_exec",
      status: toolStatus(evidence.result.outcome),
      data: { ...evidence.result },
      safeMetadata: { ...evidence.safeMetadata },
    };
  }

  public async inspectRecoveryEvidence(input: {
    readonly operationId: string;
    readonly requestHash: string;
    readonly recoveryContext: TerminalRecoveryContext;
    readonly journalStatus?: "accepted" | "executing" | "completed" | "failed";
    readonly journalSafeResult?: unknown;
  }): Promise<IncompleteTerminalEvidence> {
    return this.dependencies.persistence.inspectIncompleteEvidence(input);
  }

  private async prepare(
    args: TerminalExecArguments,
    context: TerminalExecutorContext,
  ): Promise<PreparedTerminalExecution> {
    const cwd = await this.dependencies.boundary.resolveExistingDirectory(
      args.cwd ?? ".",
    );
    const environment = terminalEnvironment(this.environment);
    const launch = resolveTerminalLaunch(
      this.dependencies.host,
      args.mode === "shell"
        ? { mode: "shell", command: args.command }
        : {
            mode: "argv",
            executable: args.executable,
            arguments: args.arguments,
          },
      environment.values,
    );
    const invocation: TerminalExecResult["invocation"] =
      args.mode === "shell"
        ? {
            contract: TERMINAL_EXEC_CONTRACT,
            mode: "shell",
            command: args.command,
            cwd: cwd.relativePath === "" ? "." : cwd.relativePath,
          }
        : {
            contract: TERMINAL_EXEC_CONTRACT,
            mode: "argv",
            executable: args.executable,
            arguments: [...args.arguments],
            cwd: cwd.relativePath === "" ? "." : cwd.relativePath,
          };
    return {
      invocation,
      environment: environment.values,
      execution: {
        cwd: cwd.absolutePath,
        executable: launch.executable,
        arguments: launch.arguments,
        timeout_ms: context.timeoutMs,
        max_output_bytes: context.maxOutputBytes,
        inherited_environment_keys: environment.inheritedKeys,
        removed_environment_keys: environment.removedKeys,
        environment_keys_hash: sha256(stableJson({
          inherited: environment.inheritedKeys,
          removed: environment.removedKeys,
        })),
      },
    };
  }

  private outputSink(
    operationId: string,
    stdout: BoundedRawCapture,
    stderr: BoundedRawCapture,
  ): TerminalOutputSink {
    let cumulativeBytes = 0;
    let liveBytes = 0;
    return {
      write: async (stream, chunk) => {
        const bytes = Buffer.from(chunk);
        cumulativeBytes = saturatingAdd(cumulativeBytes, bytes.length);
        (stream === "stdout" ? stdout : stderr).write(bytes);
        const callback = this.dependencies.onTerminalOutput;
        if (callback === undefined || liveBytes >= this.maxLiveOutputBytes) return;
        const available = this.maxLiveOutputBytes - liveBytes;
        const visible = bytes.length <= available ? bytes : bytes.subarray(0, available);
        liveBytes += visible.length;
        if (visible.length > 0) {
          await callback(
            operationId,
            stream,
            visible,
            cumulativeBytes,
          );
        }
      },
    };
  }

  private async disclosedStreams(
    operationId: string,
    stdout: BoundedRawCapture,
    stderr: BoundedRawCapture,
    outcome: TerminalProcessOutcome,
    combinedLimit: number,
  ): Promise<{
    readonly stdout: TerminalExecStreamResult;
    readonly stderr: TerminalExecStreamResult;
    readonly redactionCount: number;
    readonly disclosure: TerminalExecResult["disclosure"];
  }> {
    const [stdoutLimit, stderrLimit] = splitOutputLimit(
      combinedLimit,
      outcome.stdoutBytes,
      outcome.stderrBytes,
    );
    try {
      const [safeStdout, safeStderr] = await Promise.all([
        this.scanCapture(operationId, stdout, outcome.stdoutBytes, stdoutLimit),
        this.scanCapture(operationId, stderr, outcome.stderrBytes, stderrLimit),
      ]);
      return {
        stdout: safeStdout.result,
        stderr: safeStderr.result,
        redactionCount:
          safeStdout.redactionCount + safeStderr.redactionCount,
        disclosure:
          safeStdout.result.truncated || safeStderr.result.truncated
            ? "truncated"
            : "complete",
      };
    } catch {
      return {
        stdout: withheldStream(outcome.stdoutBytes),
        stderr: withheldStream(outcome.stderrBytes),
        redactionCount: 0,
        disclosure: "withheld",
      };
    }
  }

  private async scanCapture(
    operationId: string,
    capture: BoundedRawCapture,
    actualBytes: number,
    limit: number,
  ): Promise<{
    readonly result: TerminalExecStreamResult;
    readonly redactionCount: number;
  }> {
    if (actualBytes === 0 || limit === 0) {
      return {
        result: {
          bytes: actualBytes,
          head: "",
          tail: "",
          truncated: actualBytes > 0,
        },
        redactionCount: 0,
      };
    }
    const raw = capture.excerpt(limit, actualBytes);
    const [head, tail] = await Promise.all([
      this.processOutput(operationId, raw.head.toString("utf8")),
      this.processOutput(operationId, raw.tail.toString("utf8")),
    ]);
    const boundedHead = boundUtf8(
      head.content,
      raw.truncated ? Math.ceil(limit / 2) : limit,
    );
    const boundedTail = boundUtf8(
      tail.content,
      raw.truncated ? Math.floor(limit / 2) : 0,
    );
    const truncated =
      raw.truncated || boundedHead.truncated || boundedTail.truncated;
    return {
      result: {
        bytes: actualBytes,
        head: boundedHead.value,
        tail: truncated ? boundedTail.value : "",
        truncated,
      },
      redactionCount: head.redactionCount + tail.redactionCount,
    };
  }

  private async processOutput(
    operationId: string,
    content: string,
  ): Promise<{ readonly content: string; readonly redactionCount: number }> {
    return (
      (await this.dependencies.contentProcessor?.process({
        operationId,
        source: "command-output",
        content,
      })) ?? { content, redactionCount: 0 }
    );
  }
}

interface PreparedTerminalExecution {
  readonly invocation: TerminalExecResult["invocation"];
  readonly environment: NodeJS.ProcessEnv;
  readonly execution: {
    readonly cwd: string;
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly timeout_ms: number;
    readonly max_output_bytes: number;
    readonly inherited_environment_keys: readonly string[];
    readonly removed_environment_keys: readonly string[];
    readonly environment_keys_hash: string;
  };
}

class BoundedRawCapture {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);

  public constructor(private readonly maximumBytes: number) {}

  public write(chunk: Buffer): void {
    if (this.maximumBytes === 0 || chunk.length === 0) return;
    const headLimit = Math.ceil(this.maximumBytes / 2);
    if (this.head.length < headLimit) {
      const available = headLimit - this.head.length;
      const retained = chunk.length <= available ? chunk : chunk.subarray(0, available);
      this.head = Buffer.concat([this.head, retained]);
      chunk = chunk.subarray(retained.length);
    }
    const tailLimit = Math.floor(this.maximumBytes / 2);
    if (tailLimit === 0 || chunk.length === 0) return;
    if (chunk.length >= tailLimit) {
      this.tail = Buffer.from(chunk.subarray(chunk.length - tailLimit));
      return;
    }
    const combined = Buffer.concat([this.tail, chunk]);
    this.tail =
      combined.length <= tailLimit
        ? combined
        : combined.subarray(combined.length - tailLimit);
  }

  public excerpt(
    limit: number,
    actualBytes: number,
  ): { readonly head: Buffer; readonly tail: Buffer; readonly truncated: boolean } {
    const headLimit = Math.ceil(limit / 2);
    const tailLimit = Math.floor(limit / 2);
    const head = this.head.subarray(0, headLimit);
    const tail =
      this.tail.length <= tailLimit
        ? this.tail
        : this.tail.subarray(this.tail.length - tailLimit);
    const retainedBytes = head.length + tail.length;
    const truncated = actualBytes > retainedBytes;
    if (!truncated) {
      return {
        head: Buffer.concat([head, tail]),
        tail: Buffer.alloc(0),
        truncated: false,
      };
    }
    return { head, tail, truncated: true };
  }
}

function terminalEnvironment(source: NodeJS.ProcessEnv): {
  readonly values: NodeJS.ProcessEnv;
  readonly inheritedKeys: readonly string[];
  readonly removedKeys: readonly string[];
} {
  const values: NodeJS.ProcessEnv = {};
  const removed: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (
      key.length === 0 ||
      key.includes("\0") ||
      key.includes("=") ||
      value === undefined ||
      value.includes("\0") ||
      /^(?:_?COPE|_?CBA)_/iu.test(key) ||
      key === "NODE_CHANNEL_FD" ||
      key === "NODE_UNIQUE_ID"
    ) {
      removed.push(key);
      continue;
    }
    values[key] = value;
  }
  return {
    values,
    inheritedKeys: Object.keys(values).sort(),
    removedKeys: removed.sort(),
  };
}

function splitOutputLimit(
  combinedLimit: number,
  stdoutBytes: number,
  stderrBytes: number,
): readonly [number, number] {
  if (stdoutBytes === 0) return [0, combinedLimit];
  if (stderrBytes === 0) return [combinedLimit, 0];
  const stdout = Math.ceil(combinedLimit / 2);
  return [stdout, combinedLimit - stdout];
}

function boundUtf8(
  value: string,
  maximumBytes: number,
): { readonly value: string; readonly truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return { value, truncated: false };
  let retained = bytes.subarray(0, maximumBytes);
  let bounded = retained.toString("utf8");
  while (Buffer.byteLength(bounded) > maximumBytes && retained.length > 0) {
    retained = retained.subarray(0, retained.length - 1);
    bounded = retained.toString("utf8");
  }
  if (bounded.endsWith("\ufffd")) bounded = bounded.slice(0, -1);
  return { value: bounded, truncated: true };
}

function withheldStream(bytes: number): TerminalExecStreamResult {
  return {
    bytes,
    head: "",
    tail: "",
    truncated: bytes > 0,
  };
}

function placeholderMutation(
  outcome: TerminalProcessOutcome,
): TerminalExecMutationResult {
  return {
    outcome: outcome.outcome === "spawn_failed" ? "none" : "unknown",
    created: [],
    updated: [],
    deleted: [],
    renamed: [],
    pre_existing_touched: [],
    changed_files: 0,
    changed_lines: 0,
    binary_files: 0,
    ignored_summary:
      outcome.outcome === "spawn_failed"
        ? "The process did not launch."
        : "Project-effect attribution is deferred to the repository observation slice.",
  };
}

function toolStatus(
  outcome: TerminalProcessOutcome["outcome"] | TerminalExecResult["outcome"],
): TerminalExecutorOutcome["status"] {
  switch (outcome) {
    case "completed":
      return "success";
    case "completed_nonzero":
    case "spawn_failed":
    case "persistence_failed":
      return "failure";
    case "timed_out":
      return "timeout";
    case "cancelled":
      return "cancelled";
    case "indeterminate":
      return "indeterminate";
  }
}

function prelaunchFailure(
  operationId: string,
  reasonCode: string,
  message: string,
): TerminalExecutorOutcome {
  const safeMetadata = {
    reasonCode,
    outcome: "spawn_failed",
    mutation_outcome: "none",
  } satisfies TerminalPrelaunchFailureMetadata;
  return {
    operationId,
    tool: "terminal_exec",
    status: "failure",
    data: {
      code: reasonCode,
      message,
      outcome: "spawn_failed",
    },
    safeMetadata,
  };
}

function persistenceFailure(operationId: string): TerminalExecutorOutcome {
  return {
    operationId,
    tool: "terminal_exec",
    status: "indeterminate",
    data: {
      code: "TERMINAL_PERSISTENCE_FAILED",
      message:
        "Terminal result persistence failed; the command will not be replayed.",
      outcome: "persistence_failed",
    },
    safeMetadata: {
      reasonCode: "TERMINAL_PERSISTENCE_FAILED",
      outcome: "persistence_failed",
      mutation_outcome: "unknown",
      recoveryRequired: true,
    },
  };
}

function validContext(context: TerminalExecutorContext): boolean {
  return (
    Number.isSafeInteger(context.timeoutMs) &&
    context.timeoutMs > 0 &&
    Number.isSafeInteger(context.maxOutputBytes) &&
    context.maxOutputBytes > 0 &&
    /^[a-f0-9]{64}$/u.test(context.requestHash)
  );
}

function saturatingAdd(current: number, increment: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + increment);
}
