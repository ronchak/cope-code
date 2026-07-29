import {
  TERMINAL_EXEC_CONTRACT,
  TERMINAL_EXEC_RESULT_CONTRACT,
  type TerminalExecResult,
} from "../protocol/terminal-exec.js";
import { sha256, stableJson } from "../shared/crypto.js";
import { AgentError } from "../shared/errors.js";
import { isJournalOperationId } from "../shared/operation-id.js";
import {
  SessionArtifactStore,
  isArtifactReference,
  type ArtifactReference,
} from "./artifact-store.js";

export const TERMINAL_REQUEST_ARTIFACT_CONTRACT = "terminal-request-artifact/1" as const;
export const TERMINAL_OBSERVATION_ARTIFACT_CONTRACT =
  "terminal-observation-placeholder/1" as const;
export const TERMINAL_EXIT_RECEIPT_ARTIFACT_CONTRACT =
  "terminal-exit-receipt/1" as const;
export const TERMINAL_RESULT_ARTIFACT_CONTRACT = "terminal-result-artifact/1" as const;
export const TERMINAL_JOURNAL_RESULT_CONTRACT = "terminal-journal-result/1" as const;

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_EVIDENCE_KEYS = 16_384;
const MAX_EVIDENCE_KEY_BYTES = 32_768;
const MAX_RESULT_PATHS = 100_000;
const MAX_RESULT_STRING_BYTES = 1_000_000;

export type TerminalInvocation = TerminalExecResult["invocation"];

export interface TerminalExecutionFacts {
  readonly cwd: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly timeout_ms: number;
  readonly max_output_bytes: number;
  readonly inherited_environment_keys: readonly string[];
  readonly removed_environment_keys: readonly string[];
  readonly environment_keys_hash: string;
}

export interface TerminalRequestArtifact {
  readonly contract: typeof TERMINAL_REQUEST_ARTIFACT_CONTRACT;
  readonly operation_id: string;
  readonly tool: "terminal_exec";
  readonly request_hash: string;
  readonly invocation: TerminalInvocation;
  readonly execution: TerminalExecutionFacts;
}

export interface TerminalObservationArtifact {
  readonly contract: typeof TERMINAL_OBSERVATION_ARTIFACT_CONTRACT;
  readonly operation_id: string;
  readonly request_hash: string;
  readonly phase: "pre" | "post";
  readonly observed_at: string;
  readonly state: "placeholder";
}

export interface TerminalExitReceiptArtifact {
  readonly contract: typeof TERMINAL_EXIT_RECEIPT_ARTIFACT_CONTRACT;
  readonly operation_id: string;
  readonly request_hash: string;
  readonly outcome:
    | "completed"
    | "completed_nonzero"
    | "spawn_failed"
    | "timed_out"
    | "cancelled"
    | "indeterminate";
  readonly exit_code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly started_at: string;
  readonly completed_at: string;
  readonly duration_ms: number;
  readonly timeout_attributed: boolean;
  readonly cancellation_attributed: boolean;
  readonly stdout_bytes: number;
  readonly stderr_bytes: number;
}

export interface TerminalResultArtifact {
  readonly contract: typeof TERMINAL_RESULT_ARTIFACT_CONTRACT;
  readonly operation_id: string;
  readonly request_hash: string;
  readonly request: ArtifactReference;
  readonly pre_observation: ArtifactReference;
  readonly exit_receipt: ArtifactReference;
  readonly post_observation: ArtifactReference;
  readonly result: TerminalExecResult;
}

/**
 * The only terminal data intended for OperationRecord.safeResult. It contains
 * references, counters, and outcome facts, but no command, argv, cwd, or
 * stdout/stderr excerpts.
 */
export interface TerminalJournalResultMetadata {
  readonly contract: typeof TERMINAL_JOURNAL_RESULT_CONTRACT;
  readonly operation_id: string;
  readonly request_hash: string;
  readonly terminal_result: ArtifactReference;
  readonly outcome: TerminalExecResult["outcome"];
  readonly exit_code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly completed_at: string;
  readonly duration_ms: number;
  readonly stdout_bytes: number;
  readonly stderr_bytes: number;
  readonly redaction_count: number;
  readonly disclosure: TerminalExecResult["disclosure"];
  readonly mutation_outcome: TerminalExecResult["mutation"]["outcome"];
  readonly changed_files: number;
  readonly changed_lines: number;
}

export interface RecoverTerminalResultInput {
  readonly operationId: string;
  readonly tool: string;
  readonly requestHash: string;
}

export interface RecoveredTerminalResult {
  readonly result: TerminalExecResult;
  readonly reference: ArtifactReference;
  readonly safeMetadata: TerminalJournalResultMetadata;
}

export class TerminalArtifactPersistence {
  public constructor(private readonly artifacts: SessionArtifactStore) {}

  public async persistRequest(
    input: Omit<TerminalRequestArtifact, "contract" | "tool">,
  ): Promise<ArtifactReference> {
    const artifact: TerminalRequestArtifact = {
      contract: TERMINAL_REQUEST_ARTIFACT_CONTRACT,
      operation_id: input.operation_id,
      tool: "terminal_exec",
      request_hash: input.request_hash,
      invocation: input.invocation,
      execution: input.execution,
    };
    assertTerminalRequestArtifact(artifact, "INTERNAL_ERROR");
    return this.artifacts.putReferenced("terminal-request", artifact.operation_id, stableJson(artifact));
  }

  public async persistObservation(
    input: Omit<TerminalObservationArtifact, "contract" | "state">,
  ): Promise<ArtifactReference> {
    const artifact: TerminalObservationArtifact = {
      contract: TERMINAL_OBSERVATION_ARTIFACT_CONTRACT,
      operation_id: input.operation_id,
      request_hash: input.request_hash,
      phase: input.phase,
      observed_at: input.observed_at,
      state: "placeholder",
    };
    assertTerminalObservationArtifact(artifact, "INTERNAL_ERROR");
    return this.artifacts.putReferenced(
      artifact.phase === "pre"
        ? "terminal-pre-observation"
        : "terminal-post-observation",
      artifact.operation_id,
      stableJson(artifact),
    );
  }

  public async persistExitReceipt(
    input: Omit<TerminalExitReceiptArtifact, "contract">,
  ): Promise<ArtifactReference> {
    const artifact: TerminalExitReceiptArtifact = {
      contract: TERMINAL_EXIT_RECEIPT_ARTIFACT_CONTRACT,
      ...input,
    };
    assertTerminalExitReceiptArtifact(artifact, "INTERNAL_ERROR");
    return this.artifacts.putReferenced(
      "terminal-exit-receipt",
      artifact.operation_id,
      stableJson(artifact),
    );
  }

  public async persistResult(input: {
    readonly operationId: string;
    readonly requestHash: string;
    readonly request: ArtifactReference;
    readonly preObservation: ArtifactReference;
    readonly exitReceipt: ArtifactReference;
    readonly postObservation: ArtifactReference;
    readonly result: TerminalExecResult;
  }): Promise<{
    readonly reference: ArtifactReference;
    readonly safeMetadata: TerminalJournalResultMetadata;
  }> {
    const request = await this.readRequestReference(input.request);
    const preObservation = await this.readObservationReference(
      input.preObservation,
      "pre",
    );
    const exitReceipt = await this.readExitReceiptReference(input.exitReceipt);
    const postObservation = await this.readObservationReference(
      input.postObservation,
      "post",
    );
    assertEvidenceBinding(
      input.operationId,
      input.requestHash,
      request,
      preObservation,
      exitReceipt,
      postObservation,
      input.result,
    );
    const artifact: TerminalResultArtifact = {
      contract: TERMINAL_RESULT_ARTIFACT_CONTRACT,
      operation_id: input.operationId,
      request_hash: input.requestHash,
      request: input.request,
      pre_observation: input.preObservation,
      exit_receipt: input.exitReceipt,
      post_observation: input.postObservation,
      result: input.result,
    };
    assertTerminalResultArtifact(artifact, "INTERNAL_ERROR");
    const reference = await this.artifacts.putReferenced(
      "terminal-result",
      input.operationId,
      stableJson(artifact),
    );
    return {
      reference,
      safeMetadata: terminalJournalResultMetadata(
        input.requestHash,
        reference,
        input.result,
      ),
    };
  }

  public async readRequest(operationId: string): Promise<TerminalRequestArtifact | undefined> {
    assertRecoveryIdentity(operationId, "0".repeat(64), { skipHash: true });
    const raw = await this.artifacts.getOptional("terminal-request", operationId);
    if (raw === undefined) return undefined;
    const artifact = parseTerminalRequestArtifact(raw);
    if (artifact.operation_id !== operationId) {
      throw recoveryError("Terminal request operation identity does not match", {
        operationId,
        requestHash: artifact.request_hash,
      });
    }
    return artifact;
  }

  /**
   * Returns a replay result only after validating the complete reference
   * chain. Absence before durable process truth is recoverable by the existing
   * journal state machine; an exit receipt without a result is never treated
   * as safe to retry.
   */
  public async recoverCompleted(
    input: RecoverTerminalResultInput,
  ): Promise<TerminalExecResult | undefined> {
    return (await this.recoverCompletedEvidence(input))?.result;
  }

  /**
   * Returns the verified result together with the exact source-free reference
   * and metadata needed to promote or replay the existing journal record.
   */
  public async recoverCompletedEvidence(
    input: RecoverTerminalResultInput,
  ): Promise<RecoveredTerminalResult | undefined> {
    assertRecoveryIdentity(input.operationId, input.requestHash);
    if (input.tool !== "terminal_exec") {
      throw recoveryError("Terminal recovery tool identity does not match", input);
    }
    const raw = await this.artifacts.getOptional("terminal-result", input.operationId);
    if (raw === undefined) {
      const requestRaw = await this.artifacts.getOptional(
        "terminal-request",
        input.operationId,
      );
      const preRaw = await this.artifacts.getOptional(
        "terminal-pre-observation",
        input.operationId,
      );
      const exitRaw = await this.artifacts.getOptional(
        "terminal-exit-receipt",
        input.operationId,
      );
      const postRaw = await this.artifacts.getOptional(
        "terminal-post-observation",
        input.operationId,
      );
      const request =
        requestRaw === undefined ? undefined : parseTerminalRequestArtifact(requestRaw);
      const pre =
        preRaw === undefined ? undefined : parseTerminalObservationArtifact(preRaw);
      const exit =
        exitRaw === undefined ? undefined : parseTerminalExitReceiptArtifact(exitRaw);
      const post =
        postRaw === undefined ? undefined : parseTerminalObservationArtifact(postRaw);
      for (const evidence of [request, pre, exit, post]) {
        if (
          evidence !== undefined &&
          (evidence.operation_id !== input.operationId ||
            evidence.request_hash !== input.requestHash)
        ) {
          throw recoveryError(
            "Incomplete terminal evidence does not match the recovery request",
            input,
          );
        }
      }
      if (pre !== undefined && (pre.phase !== "pre" || request === undefined)) {
        throw recoveryError("Terminal pre-observation has an incomplete evidence chain", input);
      }
      if (post !== undefined && post.phase !== "post") {
        throw recoveryError("Terminal post-observation phase does not match", input);
      }
      if (exit !== undefined || post !== undefined) {
        throw recoveryError(
          "Terminal exit receipt exists without a complete durable result",
          input,
        );
      }
      return undefined;
    }
    const artifact = parseTerminalResultArtifact(raw);
    if (
      artifact.operation_id !== input.operationId ||
      artifact.request_hash !== input.requestHash
    ) {
      throw recoveryError("Terminal result identity or request hash does not match", input);
    }
    const request = await this.readRequestReference(artifact.request);
    const preObservation = await this.readObservationReference(
      artifact.pre_observation,
      "pre",
    );
    const exitReceipt = await this.readExitReceiptReference(artifact.exit_receipt);
    const postObservation = await this.readObservationReference(
      artifact.post_observation,
      "post",
    );
    assertEvidenceBinding(
      input.operationId,
      input.requestHash,
      request,
      preObservation,
      exitReceipt,
      postObservation,
      artifact.result,
    );
    const reference: ArtifactReference = {
      kind: "terminal-result",
      id: input.operationId,
      bytes: Buffer.byteLength(raw),
      sha256: sha256(raw),
    };
    return {
      result: { ...artifact.result, replayed: true },
      reference,
      safeMetadata: terminalJournalResultMetadata(
        input.requestHash,
        reference,
        artifact.result,
      ),
    };
  }

  private async readRequestReference(
    reference: ArtifactReference,
  ): Promise<TerminalRequestArtifact> {
    assertExpectedReference(reference, "terminal-request");
    return parseTerminalRequestArtifact(await this.artifacts.getReferenced(reference));
  }

  private async readObservationReference(
    reference: ArtifactReference,
    phase: "pre" | "post",
  ): Promise<TerminalObservationArtifact> {
    assertExpectedReference(
      reference,
      phase === "pre"
        ? "terminal-pre-observation"
        : "terminal-post-observation",
    );
    const artifact = parseTerminalObservationArtifact(
      await this.artifacts.getReferenced(reference),
    );
    if (artifact.phase !== phase) {
      throw recoveryError("Terminal observation phase does not match its artifact kind", {
        operationId: artifact.operation_id,
        requestHash: artifact.request_hash,
      });
    }
    return artifact;
  }

  private async readExitReceiptReference(
    reference: ArtifactReference,
  ): Promise<TerminalExitReceiptArtifact> {
    assertExpectedReference(reference, "terminal-exit-receipt");
    return parseTerminalExitReceiptArtifact(
      await this.artifacts.getReferenced(reference),
    );
  }
}

export function terminalJournalResultMetadata(
  requestHash: string,
  terminalResult: ArtifactReference,
  result: TerminalExecResult,
): TerminalJournalResultMetadata {
  if (
    !HASH_PATTERN.test(requestHash) ||
    !isArtifactReference(terminalResult) ||
    terminalResult.kind !== "terminal-result"
  ) {
    throw new AgentError("INTERNAL_ERROR", "Cannot create malformed terminal journal metadata");
  }
  assertTerminalExecResult(result, "INTERNAL_ERROR");
  return {
    contract: TERMINAL_JOURNAL_RESULT_CONTRACT,
    operation_id: result.operation_id,
    request_hash: requestHash,
    terminal_result: terminalResult,
    outcome: result.outcome,
    exit_code: result.exit_code,
    signal: result.signal,
    completed_at: result.completed_at,
    duration_ms: result.duration_ms,
    stdout_bytes: result.stdout.bytes,
    stderr_bytes: result.stderr.bytes,
    redaction_count: result.redaction_count,
    disclosure: result.disclosure,
    mutation_outcome: result.mutation.outcome,
    changed_files: result.mutation.changed_files,
    changed_lines: result.mutation.changed_lines,
  };
}

export function isTerminalJournalResultMetadata(
  value: unknown,
): value is TerminalJournalResultMetadata {
  if (
    !hasExactKeys(value, [
      "contract",
      "operation_id",
      "request_hash",
      "terminal_result",
      "outcome",
      "exit_code",
      "signal",
      "completed_at",
      "duration_ms",
      "stdout_bytes",
      "stderr_bytes",
      "redaction_count",
      "disclosure",
      "mutation_outcome",
      "changed_files",
      "changed_lines",
    ])
  ) {
    return false;
  }
  const item = value as Partial<TerminalJournalResultMetadata>;
  return (
    item.contract === TERMINAL_JOURNAL_RESULT_CONTRACT &&
    isJournalOperationId(item.operation_id) &&
    typeof item.request_hash === "string" &&
    HASH_PATTERN.test(item.request_hash) &&
    isArtifactReference(item.terminal_result) &&
    item.terminal_result.kind === "terminal-result" &&
    isProcessOutcome(item.outcome) &&
    validExitCode(item.exit_code) &&
    validSignal(item.signal) &&
    isIsoTimestamp(item.completed_at) &&
    validNonnegativeInteger(item.duration_ms) &&
    validNonnegativeInteger(item.stdout_bytes) &&
    validNonnegativeInteger(item.stderr_bytes) &&
    validNonnegativeInteger(item.redaction_count) &&
    ["complete", "truncated", "withheld"].includes(item.disclosure ?? "") &&
    isMutationOutcome(item.mutation_outcome) &&
    validNonnegativeInteger(item.changed_files) &&
    validNonnegativeInteger(item.changed_lines)
  );
}

function parseTerminalRequestArtifact(raw: string): TerminalRequestArtifact {
  const value = parseJson(raw, "Terminal request artifact is invalid JSON");
  assertTerminalRequestArtifact(value, "RECOVERY_REQUIRED");
  return value;
}

function parseTerminalObservationArtifact(raw: string): TerminalObservationArtifact {
  const value = parseJson(raw, "Terminal observation artifact is invalid JSON");
  assertTerminalObservationArtifact(value, "RECOVERY_REQUIRED");
  return value;
}

function parseTerminalExitReceiptArtifact(raw: string): TerminalExitReceiptArtifact {
  const value = parseJson(raw, "Terminal exit receipt is invalid JSON");
  assertTerminalExitReceiptArtifact(value, "RECOVERY_REQUIRED");
  return value;
}

function parseTerminalResultArtifact(raw: string): TerminalResultArtifact {
  const value = parseJson(raw, "Terminal result artifact is invalid JSON");
  assertTerminalResultArtifact(value, "RECOVERY_REQUIRED");
  return value;
}

function assertTerminalRequestArtifact(
  value: unknown,
  code: "INTERNAL_ERROR" | "RECOVERY_REQUIRED",
): asserts value is TerminalRequestArtifact {
  if (
    !hasExactKeys(value, [
      "contract",
      "operation_id",
      "tool",
      "request_hash",
      "invocation",
      "execution",
    ])
  ) {
    throw new AgentError(code, "Terminal request artifact has an invalid shape");
  }
  const item = value as Partial<TerminalRequestArtifact>;
  if (
    item.contract !== TERMINAL_REQUEST_ARTIFACT_CONTRACT ||
    !isJournalOperationId(item.operation_id) ||
    item.tool !== "terminal_exec" ||
    typeof item.request_hash !== "string" ||
    !HASH_PATTERN.test(item.request_hash) ||
    !isTerminalInvocation(item.invocation) ||
    !isTerminalExecutionFacts(item.execution)
  ) {
    throw new AgentError(code, "Terminal request artifact has invalid durable facts");
  }
}

function assertTerminalObservationArtifact(
  value: unknown,
  code: "INTERNAL_ERROR" | "RECOVERY_REQUIRED",
): asserts value is TerminalObservationArtifact {
  if (
    !hasExactKeys(value, [
      "contract",
      "operation_id",
      "request_hash",
      "phase",
      "observed_at",
      "state",
    ])
  ) {
    throw new AgentError(code, "Terminal observation artifact has an invalid shape");
  }
  const item = value as Partial<TerminalObservationArtifact>;
  if (
    item.contract !== TERMINAL_OBSERVATION_ARTIFACT_CONTRACT ||
    !isJournalOperationId(item.operation_id) ||
    typeof item.request_hash !== "string" ||
    !HASH_PATTERN.test(item.request_hash) ||
    (item.phase !== "pre" && item.phase !== "post") ||
    !isIsoTimestamp(item.observed_at) ||
    item.state !== "placeholder"
  ) {
    throw new AgentError(code, "Terminal observation artifact has invalid durable facts");
  }
}

function assertTerminalExitReceiptArtifact(
  value: unknown,
  code: "INTERNAL_ERROR" | "RECOVERY_REQUIRED",
): asserts value is TerminalExitReceiptArtifact {
  if (
    !hasExactKeys(value, [
      "contract",
      "operation_id",
      "request_hash",
      "outcome",
      "exit_code",
      "signal",
      "started_at",
      "completed_at",
      "duration_ms",
      "timeout_attributed",
      "cancellation_attributed",
      "stdout_bytes",
      "stderr_bytes",
    ])
  ) {
    throw new AgentError(code, "Terminal exit receipt has an invalid shape");
  }
  const item = value as Partial<TerminalExitReceiptArtifact>;
  if (
    item.contract !== TERMINAL_EXIT_RECEIPT_ARTIFACT_CONTRACT ||
    !isJournalOperationId(item.operation_id) ||
    typeof item.request_hash !== "string" ||
    !HASH_PATTERN.test(item.request_hash) ||
    !isReceiptOutcome(item.outcome) ||
    !validExitCode(item.exit_code) ||
    !validSignal(item.signal) ||
    !isIsoTimestamp(item.started_at) ||
    !isIsoTimestamp(item.completed_at) ||
    validTimestampOrder(item.started_at, item.completed_at) === false ||
    !validNonnegativeInteger(item.duration_ms) ||
    typeof item.timeout_attributed !== "boolean" ||
    typeof item.cancellation_attributed !== "boolean" ||
    !validNonnegativeInteger(item.stdout_bytes) ||
    !validNonnegativeInteger(item.stderr_bytes)
  ) {
    throw new AgentError(code, "Terminal exit receipt has invalid durable facts");
  }
}

function assertTerminalResultArtifact(
  value: unknown,
  code: "INTERNAL_ERROR" | "RECOVERY_REQUIRED",
): asserts value is TerminalResultArtifact {
  if (
    !hasExactKeys(value, [
      "contract",
      "operation_id",
      "request_hash",
      "request",
      "pre_observation",
      "exit_receipt",
      "post_observation",
      "result",
    ])
  ) {
    throw new AgentError(code, "Terminal result artifact has an invalid shape");
  }
  const item = value as Partial<TerminalResultArtifact>;
  if (
    item.contract !== TERMINAL_RESULT_ARTIFACT_CONTRACT ||
    !isJournalOperationId(item.operation_id) ||
    typeof item.request_hash !== "string" ||
    !HASH_PATTERN.test(item.request_hash) ||
    !isExpectedReference(item.request, "terminal-request") ||
    !isExpectedReference(item.pre_observation, "terminal-pre-observation") ||
    !isExpectedReference(item.exit_receipt, "terminal-exit-receipt") ||
    !isExpectedReference(item.post_observation, "terminal-post-observation") ||
    item.request.id !== item.operation_id ||
    item.pre_observation.id !== item.operation_id ||
    item.exit_receipt.id !== item.operation_id ||
    item.post_observation.id !== item.operation_id
  ) {
    throw new AgentError(code, "Terminal result artifact has invalid durable bindings");
  }
  assertTerminalExecResult(item.result, code);
}

function assertTerminalExecResult(
  value: unknown,
  code: "INTERNAL_ERROR" | "RECOVERY_REQUIRED",
): asserts value is TerminalExecResult {
  if (
    !hasExactKeys(value, [
      "contract",
      "operation_id",
      "invocation",
      "outcome",
      "exit_code",
      "signal",
      "started_at",
      "completed_at",
      "duration_ms",
      "timeout_attributed",
      "cancellation_attributed",
      "stdout",
      "stderr",
      "redaction_count",
      "disclosure",
      "mutation",
      "replayed",
    ])
  ) {
    throw new AgentError(code, "Terminal result has an invalid shape");
  }
  const item = value as Partial<TerminalExecResult>;
  if (
    item.contract !== TERMINAL_EXEC_RESULT_CONTRACT ||
    !isJournalOperationId(item.operation_id) ||
    !isTerminalInvocation(item.invocation) ||
    !isProcessOutcome(item.outcome) ||
    !validExitCode(item.exit_code) ||
    !validSignal(item.signal) ||
    !isIsoTimestamp(item.started_at) ||
    !isIsoTimestamp(item.completed_at) ||
    validTimestampOrder(item.started_at, item.completed_at) === false ||
    !validNonnegativeInteger(item.duration_ms) ||
    typeof item.timeout_attributed !== "boolean" ||
    typeof item.cancellation_attributed !== "boolean" ||
    !isTerminalStreamResult(item.stdout) ||
    !isTerminalStreamResult(item.stderr) ||
    !validNonnegativeInteger(item.redaction_count) ||
    !["complete", "truncated", "withheld"].includes(item.disclosure ?? "") ||
    !isTerminalMutationResult(item.mutation) ||
    typeof item.replayed !== "boolean"
  ) {
    throw new AgentError(code, "Terminal result has invalid durable facts");
  }
}

function assertEvidenceBinding(
  operationId: string,
  requestHash: string,
  request: TerminalRequestArtifact,
  preObservation: TerminalObservationArtifact,
  exitReceipt: TerminalExitReceiptArtifact,
  postObservation: TerminalObservationArtifact,
  result: TerminalExecResult,
): void {
  assertRecoveryIdentity(operationId, requestHash);
  const evidence = [request, preObservation, exitReceipt, postObservation];
  if (
    evidence.some(
      (entry) =>
        entry.operation_id !== operationId ||
        entry.request_hash !== requestHash,
    ) ||
    result.operation_id !== operationId ||
    stableJson(result.invocation) !== stableJson(request.invocation) ||
    result.replayed ||
    result.outcome === "persistence_failed" ||
    result.outcome !== exitReceipt.outcome ||
    result.exit_code !== exitReceipt.exit_code ||
    result.signal !== exitReceipt.signal ||
    result.started_at !== exitReceipt.started_at ||
    result.completed_at !== exitReceipt.completed_at ||
    result.duration_ms !== exitReceipt.duration_ms ||
    result.timeout_attributed !== exitReceipt.timeout_attributed ||
    result.cancellation_attributed !== exitReceipt.cancellation_attributed ||
    result.stdout.bytes !== exitReceipt.stdout_bytes ||
    result.stderr.bytes !== exitReceipt.stderr_bytes
  ) {
    throw recoveryError("Terminal durable evidence does not bind to one exact result", {
      operationId,
      requestHash,
    });
  }
}

function isTerminalInvocation(value: unknown): value is TerminalInvocation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<TerminalInvocation> & {
    readonly command?: unknown;
    readonly executable?: unknown;
    readonly arguments?: unknown;
  };
  if (item.contract !== TERMINAL_EXEC_CONTRACT || !validBoundedString(item.cwd, 32_768)) {
    return false;
  }
  if (item.mode === "shell") {
    return (
      hasExactKeys(item, ["contract", "mode", "command", "cwd"]) &&
      validBoundedString(item.command, MAX_RESULT_STRING_BYTES)
    );
  }
  return (
    item.mode === "argv" &&
    hasExactKeys(item, ["contract", "mode", "executable", "arguments", "cwd"]) &&
    validBoundedString(item.executable, 32_768) &&
    boundedStringArray(item.arguments, 1_024, 32_768)
  );
}

function isTerminalExecutionFacts(value: unknown): value is TerminalExecutionFacts {
  if (
    !hasExactKeys(value, [
      "cwd",
      "executable",
      "arguments",
      "timeout_ms",
      "max_output_bytes",
      "inherited_environment_keys",
      "removed_environment_keys",
      "environment_keys_hash",
    ])
  ) {
    return false;
  }
  const item = value as Partial<TerminalExecutionFacts>;
  return (
    validBoundedString(item.cwd, 32_768) &&
    validBoundedString(item.executable, 32_768) &&
    boundedStringArray(item.arguments, 1_024, 32_768) &&
    validNonnegativeInteger(item.timeout_ms) &&
    (item.timeout_ms ?? 0) > 0 &&
    validNonnegativeInteger(item.max_output_bytes) &&
    boundedStringArray(
      item.inherited_environment_keys,
      MAX_EVIDENCE_KEYS,
      MAX_EVIDENCE_KEY_BYTES,
    ) &&
    boundedStringArray(
      item.removed_environment_keys,
      MAX_EVIDENCE_KEYS,
      MAX_EVIDENCE_KEY_BYTES,
    ) &&
    typeof item.environment_keys_hash === "string" &&
    HASH_PATTERN.test(item.environment_keys_hash)
  );
}

function isTerminalStreamResult(
  value: unknown,
): value is TerminalExecResult["stdout"] {
  if (!hasExactKeys(value, ["bytes", "head", "tail", "truncated", "artifact"], true)) {
    return false;
  }
  const item = value as Partial<TerminalExecResult["stdout"]>;
  return (
    validNonnegativeInteger(item.bytes) &&
    validBoundedString(item.head, MAX_RESULT_STRING_BYTES, true) &&
    validBoundedString(item.tail, MAX_RESULT_STRING_BYTES, true) &&
    typeof item.truncated === "boolean" &&
    (item.artifact === undefined || isTerminalArtifactReference(item.artifact))
  );
}

function isTerminalMutationResult(
  value: unknown,
): value is TerminalExecResult["mutation"] {
  if (
    !hasExactKeys(value, [
      "outcome",
      "created",
      "updated",
      "deleted",
      "renamed",
      "pre_existing_touched",
      "changed_files",
      "changed_lines",
      "binary_files",
      "ignored_summary",
      "repository_fingerprint",
    ], true)
  ) {
    return false;
  }
  const item = value as Partial<TerminalExecResult["mutation"]>;
  return (
    isMutationOutcome(item.outcome) &&
    boundedStringArray(item.created, MAX_RESULT_PATHS, 32_768) &&
    boundedStringArray(item.updated, MAX_RESULT_PATHS, 32_768) &&
    boundedStringArray(item.deleted, MAX_RESULT_PATHS, 32_768) &&
    Array.isArray(item.renamed) &&
    item.renamed.length <= MAX_RESULT_PATHS &&
    item.renamed.every(
      (rename) =>
        hasExactKeys(rename, ["from", "to"]) &&
        validBoundedString(rename.from, 32_768) &&
        validBoundedString(rename.to, 32_768),
    ) &&
    boundedStringArray(item.pre_existing_touched, MAX_RESULT_PATHS, 32_768) &&
    validNonnegativeInteger(item.changed_files) &&
    validNonnegativeInteger(item.changed_lines) &&
    validNonnegativeInteger(item.binary_files) &&
    validBoundedString(item.ignored_summary, MAX_RESULT_STRING_BYTES, true) &&
    (item.repository_fingerprint === undefined ||
      (typeof item.repository_fingerprint === "string" &&
        HASH_PATTERN.test(item.repository_fingerprint)))
  );
}

function isTerminalArtifactReference(value: unknown): boolean {
  return (
    isArtifactReference(value) &&
    value.kind.startsWith("terminal-")
  );
}

function assertExpectedReference(
  value: unknown,
  kind: ArtifactReference["kind"],
): asserts value is ArtifactReference {
  if (!isExpectedReference(value, kind)) {
    throw new AgentError("RECOVERY_REQUIRED", "Terminal artifact reference has the wrong kind", {
      expectedKind: kind,
    });
  }
}

function isExpectedReference(
  value: unknown,
  kind: ArtifactReference["kind"],
): value is ArtifactReference {
  return isArtifactReference(value) && value.kind === kind;
}

function assertRecoveryIdentity(
  operationId: string,
  requestHash: string,
  options: { readonly skipHash?: boolean } = {},
): void {
  if (
    !isJournalOperationId(operationId) ||
    (options.skipHash !== true && !HASH_PATTERN.test(requestHash))
  ) {
    throw recoveryError("Terminal recovery identity is malformed", {
      operationId,
      requestHash,
    });
  }
}

function parseJson(raw: string, message: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new AgentError("RECOVERY_REQUIRED", message, {}, { cause: error });
  }
}

function recoveryError(
  message: string,
  identity: { readonly operationId: string; readonly requestHash: string },
): AgentError {
  return new AgentError("RECOVERY_REQUIRED", message, {
    operationId: identity.operationId,
    requestHash: identity.requestHash,
  });
}

function isReceiptOutcome(value: unknown): value is TerminalExitReceiptArtifact["outcome"] {
  return [
    "completed",
    "completed_nonzero",
    "spawn_failed",
    "timed_out",
    "cancelled",
    "indeterminate",
  ].includes(value as string);
}

function isProcessOutcome(value: unknown): value is TerminalExecResult["outcome"] {
  return (
    isReceiptOutcome(value) ||
    value === "persistence_failed"
  );
}

function isMutationOutcome(
  value: unknown,
): value is TerminalExecResult["mutation"]["outcome"] {
  return [
    "none",
    "observed",
    "protected_or_hidden_changed",
    "unknown",
  ].includes(value as string);
}

function validExitCode(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function validSignal(value: unknown): value is NodeJS.Signals | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length <= 32 &&
      /^SIG[A-Z0-9]+$/u.test(value))
  );
}

function validNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validBoundedString(
  value: unknown,
  maxBytes: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= maxBytes
  );
}

function boundedStringArray(
  value: unknown,
  maxItems: number,
  maxBytes: number,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((entry) => validBoundedString(entry, maxBytes, true))
  );
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validTimestampOrder(startedAt: string, completedAt: string): boolean {
  return Date.parse(completedAt) >= Date.parse(startedAt);
}

function hasExactKeys(
  value: unknown,
  allowed: readonly string[],
  allowMissingOptional = false,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.every((key) => allowed.includes(key)) &&
    (allowMissingOptional || allowed.every((key) => keys.includes(key)))
  );
}
