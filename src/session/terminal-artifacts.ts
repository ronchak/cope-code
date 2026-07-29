import { createHash } from "node:crypto";

import {
  TERMINAL_EXEC_CONTRACT,
  TERMINAL_EXEC_RESULT_CONTRACT,
  TERMINAL_STREAM_ARTIFACT_KINDS,
  type TerminalExecResult,
} from "../protocol/terminal-exec.js";
import {
  WORKSPACE_OBSERVATION_CONTRACT,
  TERMINAL_RESULT_MAX_PATH_BYTES,
  TERMINAL_RESULT_MAX_PATH_ENDPOINTS,
  isWorkspaceObservation,
  type WorkspaceBeforeImage,
  type WorkspaceObservation,
  type WorkspacePostObservationControl,
} from "../repository/workspace-observer.js";
import type { CheckpointFileSnapshot } from "../repository/checkpoint.js";
import type {
  TerminalBeforeImageResolution,
  TerminalBeforeImageResolver,
  TerminalSessionMutationDiffRecord,
} from "../repository/snapshot-diff.js";
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
export const TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT =
  WORKSPACE_OBSERVATION_CONTRACT;
export const TERMINAL_LAUNCH_RECEIPT_ARTIFACT_CONTRACT =
  "terminal-launch-receipt/1" as const;
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

export interface LegacyTerminalObservationArtifact {
  readonly contract: typeof TERMINAL_OBSERVATION_ARTIFACT_CONTRACT;
  readonly operation_id: string;
  readonly request_hash: string;
  readonly phase: "pre" | "post";
  readonly observed_at: string;
  readonly state: "placeholder";
}

export interface TerminalWorkspaceObservationArtifact {
  readonly contract: typeof TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT;
  readonly operation_id: string;
  readonly request_hash: string;
  readonly phase: "pre" | "post";
  readonly observation: WorkspaceObservation;
}

export type TerminalObservationArtifact =
  | LegacyTerminalObservationArtifact
  | TerminalWorkspaceObservationArtifact;

export interface TerminalLaunchReceiptArtifact {
  readonly contract: typeof TERMINAL_LAUNCH_RECEIPT_ARTIFACT_CONTRACT;
  readonly operation_id: string;
  readonly request_hash: string;
  readonly request: ArtifactReference;
  readonly pre_observation: ArtifactReference;
  readonly recorded_at: string;
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

export interface LegacyTerminalResultArtifact {
  readonly contract: typeof TERMINAL_RESULT_ARTIFACT_CONTRACT;
  readonly operation_id: string;
  readonly request_hash: string;
  readonly request: ArtifactReference;
  readonly pre_observation: ArtifactReference;
  readonly exit_receipt: ArtifactReference;
  readonly post_observation: ArtifactReference;
  readonly result: TerminalExecResult;
}

interface FullTerminalResultArtifactBase {
  readonly contract: typeof TERMINAL_RESULT_ARTIFACT_CONTRACT;
  readonly operation_id: string;
  readonly request_hash: string;
  readonly request: ArtifactReference;
  readonly pre_observation: ArtifactReference;
  readonly launch_receipt: ArtifactReference;
  readonly exit_receipt: ArtifactReference;
  readonly post_observation: ArtifactReference;
  readonly result: TerminalExecResult;
}

export type FullTerminalResultArtifact = FullTerminalResultArtifactBase & (
  | {
      readonly post_observation_control: WorkspacePostObservationControl;
    }
  | {
      readonly post_observation_control?: never;
    }
);

export type TerminalResultArtifact =
  | LegacyTerminalResultArtifact
  | FullTerminalResultArtifact;

export interface TerminalPrelaunchFailureMetadata {
  readonly reasonCode: string;
  readonly outcome: "spawn_failed";
  readonly mutation_outcome: "none";
  readonly runtimeBudgetLimits?: Readonly<Record<string, number>>;
  readonly plannedDisclosureBytes?: number;
}

export type TerminalRecoveryContext =
  | "ordinary_process_crash"
  | "known_power_or_storage_loss";

export type IncompleteTerminalEvidence =
  | { readonly state: "none"; readonly recoveryContext: TerminalRecoveryContext }
  | {
      readonly state: "request_without_launch";
      readonly recoveryContext: TerminalRecoveryContext;
      readonly preEvidence:
        | "none"
        | "legacy_placeholder"
        | "full_workspace_observation";
    }
  | {
      readonly state: "launch_without_exit";
      readonly recoveryContext: TerminalRecoveryContext;
      readonly launchReceipt: TerminalLaunchReceiptArtifact;
    }
  | {
      readonly state: "exit_without_result";
      readonly recoveryContext: TerminalRecoveryContext;
      readonly advisory: {
        readonly outcome: TerminalExitReceiptArtifact["outcome"];
        readonly exitCode: number | null;
        readonly signal: NodeJS.Signals | null;
        readonly completedAt: string;
        readonly durationMs: number;
        readonly stdoutBytes: number;
        readonly stderrBytes: number;
      };
    }
  | {
      readonly state: "completed_prelaunch_failure";
      readonly recoveryContext: TerminalRecoveryContext;
      readonly metadata: TerminalPrelaunchFailureMetadata;
    }
  | {
      readonly state: "completed_unproven_without_result";
      readonly recoveryContext: TerminalRecoveryContext;
    };

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

/**
 * Receipt absence is usable as no-launch proof only in the documented
 * ordinary-process-crash model. Operator-declared power/storage loss always
 * disables this proof, even when the surviving evidence shape is otherwise
 * identical.
 */
export function terminalEvidenceProvesNoLaunch(
  evidence: IncompleteTerminalEvidence,
): boolean {
  return (
    evidence.recoveryContext === "ordinary_process_crash" &&
    (
      evidence.state === "none" ||
      (
        evidence.state === "request_without_launch" &&
        evidence.preEvidence !== "legacy_placeholder"
      ) ||
      evidence.state === "completed_prelaunch_failure"
    )
  );
}

export interface VerifiedTerminalResultEvidence {
  readonly artifact: TerminalResultArtifact;
  readonly request: TerminalRequestArtifact;
  readonly preObservation: TerminalObservationArtifact;
  readonly launchReceipt?: TerminalLaunchReceiptArtifact;
  readonly exitReceipt: TerminalExitReceiptArtifact;
  readonly postObservation: TerminalObservationArtifact;
  readonly reference: ArtifactReference;
}

export interface TerminalBeforeImageEvidenceReferences {
  readonly terminalResult: ArtifactReference;
  readonly preObservation?: ArtifactReference;
}

export interface TerminalImmutableHeadPath {
  readonly objectId: string;
  readonly mode: number;
  readonly bytes: Buffer;
}

export interface TerminalBeforeImageResolverOptions {
  /**
   * Resolves the durable references stored on the full session mutation.
   * Legacy records may omit preObservation; a full result may not.
   */
  readonly resolveReferences: (
    mutation: TerminalSessionMutationDiffRecord,
    signal?: AbortSignal,
  ) => Promise<TerminalBeforeImageEvidenceReferences | undefined>;
  /** Reads the exact immutable object ID named by a persisted before-image. */
  readonly readGitBlob?: (
    objectId: string,
    signal?: AbortSignal,
  ) => Promise<Buffer | undefined>;
  /** Resolves one path through the exact immutable pre-observation HEAD. */
  readonly readHeadPath?: (
    head: string,
    repositoryRelativePath: string,
    signal?: AbortSignal,
  ) => Promise<TerminalImmutableHeadPath | undefined>;
  /**
   * Returns an already integrity-verified earlier session baseline. The
   * persistence owner still verifies its path and self-authenticating bytes.
   */
  readonly resolvePriorBaseline?: (
    mutation: TerminalSessionMutationDiffRecord,
    repositoryRelativePath: string,
    signal?: AbortSignal,
  ) => Promise<{
    readonly baselineId: string;
    readonly entry: CheckpointFileSnapshot;
  } | undefined>;
  /** RepositoryBoundary.pathKey on case-insensitive repositories. */
  readonly pathKey?: (repositoryRelativePath: string) => string;
}

interface VerifiedFullTerminalResultEvidence
  extends VerifiedTerminalResultEvidence {
  readonly artifact: FullTerminalResultArtifact;
  readonly preObservation: TerminalWorkspaceObservationArtifact;
  readonly launchReceipt: TerminalLaunchReceiptArtifact;
  readonly postObservation: TerminalWorkspaceObservationArtifact;
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
    input: Omit<LegacyTerminalObservationArtifact, "contract" | "state">,
  ): Promise<ArtifactReference> {
    const artifact: LegacyTerminalObservationArtifact = {
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

  public async persistWorkspaceObservation(input: {
    readonly operationId: string;
    readonly requestHash: string;
    readonly observation: WorkspaceObservation;
  }): Promise<ArtifactReference> {
    const artifact: TerminalWorkspaceObservationArtifact = {
      contract: TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT,
      operation_id: input.operationId,
      request_hash: input.requestHash,
      phase: input.observation.phase,
      observation: input.observation,
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

  public async persistLaunchReceipt(input: {
    readonly operationId: string;
    readonly requestHash: string;
    readonly request: ArtifactReference;
    readonly preObservation: ArtifactReference;
    readonly recordedAt: string;
  }): Promise<ArtifactReference> {
    const request = await this.readRequestReference(input.request);
    const preObservation = await this.readObservationReference(
      input.preObservation,
      "pre",
    );
    if (
      preObservation.contract !==
      TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT ||
      request.operation_id !== input.operationId ||
      request.request_hash !== input.requestHash ||
      preObservation.operation_id !== input.operationId ||
      preObservation.request_hash !== input.requestHash
    ) {
      throw new AgentError(
        "INTERNAL_ERROR",
        "Terminal launch receipt evidence does not bind",
      );
    }
    assertLaunchablePreObservation(preObservation, "INTERNAL_ERROR");
    const artifact: TerminalLaunchReceiptArtifact = {
      contract: TERMINAL_LAUNCH_RECEIPT_ARTIFACT_CONTRACT,
      operation_id: input.operationId,
      request_hash: input.requestHash,
      request: input.request,
      pre_observation: input.preObservation,
      recorded_at: input.recordedAt,
    };
    assertTerminalLaunchReceiptArtifact(artifact, "INTERNAL_ERROR");
    return this.artifacts.putReferencedDurable(
      "terminal-launch-receipt",
      artifact.operation_id,
      stableJson(artifact),
      { syncDirectories: true },
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
    if (
      preObservation.contract ===
        TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT ||
      postObservation.contract ===
        TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT
    ) {
      throw new AgentError(
        "INTERNAL_ERROR",
        "Legacy terminal results require legacy placeholder observations",
      );
    }
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

  public async persistFullResult(input: {
    readonly operationId: string;
    readonly requestHash: string;
    readonly request: ArtifactReference;
    readonly preObservation: ArtifactReference;
    readonly launchReceipt: ArtifactReference;
    readonly exitReceipt: ArtifactReference;
    readonly postObservation: ArtifactReference;
    readonly result: TerminalExecResult;
    readonly postObservationControl?: WorkspacePostObservationControl;
  }): Promise<{
    readonly reference: ArtifactReference;
    readonly safeMetadata: TerminalJournalResultMetadata;
  }> {
    const request = await this.readRequestReference(input.request);
    const preObservation = await this.readObservationReference(
      input.preObservation,
      "pre",
    );
    const launchReceipt = await this.readLaunchReceiptReference(
      input.launchReceipt,
    );
    const exitReceipt = await this.readExitReceiptReference(input.exitReceipt);
    const postObservation = await this.readObservationReference(
      input.postObservation,
      "post",
    );
    if (
      preObservation.contract !==
        TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT ||
      postObservation.contract !==
        TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT
    ) {
      throw new AgentError(
        "INTERNAL_ERROR",
        "A full terminal result requires full workspace observations",
      );
    }
    assertLaunchablePreObservation(preObservation, "INTERNAL_ERROR");
    assertEvidenceBinding(
      input.operationId,
      input.requestHash,
      request,
      preObservation,
      exitReceipt,
      postObservation,
      input.result,
    );
    assertLaunchReceiptBinding(
      launchReceipt,
      input.operationId,
      input.requestHash,
      input.request,
      input.preObservation,
    );
    assertPostObservationControl(
      input.result.mutation.outcome,
      input.postObservationControl,
      preObservation,
      postObservation,
      input.result,
      "INTERNAL_ERROR",
    );
    const artifact: FullTerminalResultArtifact = {
      contract: TERMINAL_RESULT_ARTIFACT_CONTRACT,
      operation_id: input.operationId,
      request_hash: input.requestHash,
      request: input.request,
      pre_observation: input.preObservation,
      launch_receipt: input.launchReceipt,
      exit_receipt: input.exitReceipt,
      post_observation: input.postObservation,
      result: input.result,
      ...(input.postObservationControl === undefined
        ? {}
        : { post_observation_control: input.postObservationControl }),
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

  public async inspectIncompleteEvidence(input: {
    readonly operationId: string;
    readonly requestHash: string;
    readonly recoveryContext: TerminalRecoveryContext;
    readonly journalStatus?: "accepted" | "executing" | "completed" | "failed";
    readonly journalSafeResult?: unknown;
  }): Promise<IncompleteTerminalEvidence> {
    assertRecoveryIdentity(input.operationId, input.requestHash);
    const [requestRaw, preRaw, launchRaw, exitRaw, postRaw, resultRaw] =
      await Promise.all([
        this.artifacts.getOptional("terminal-request", input.operationId),
        this.artifacts.getOptional("terminal-pre-observation", input.operationId),
        this.artifacts.getOptional("terminal-launch-receipt", input.operationId),
        this.artifacts.getOptional("terminal-exit-receipt", input.operationId),
        this.artifacts.getOptional("terminal-post-observation", input.operationId),
        this.artifacts.getOptional("terminal-result", input.operationId),
      ]);
    if (resultRaw !== undefined) {
      throw recoveryError(
        "Complete terminal evidence is not an incomplete-evidence state",
        input,
      );
    }
    const request = requestRaw === undefined
      ? undefined
      : parseTerminalRequestArtifact(requestRaw);
    const pre = preRaw === undefined
      ? undefined
      : parseTerminalObservationArtifact(preRaw);
    const launch = launchRaw === undefined
      ? undefined
      : parseTerminalLaunchReceiptArtifact(launchRaw);
    const exit = exitRaw === undefined
      ? undefined
      : parseTerminalExitReceiptArtifact(exitRaw);
    const post = postRaw === undefined
      ? undefined
      : parseTerminalObservationArtifact(postRaw);
    if (
      request === undefined &&
      (pre !== undefined ||
        launch !== undefined ||
        exit !== undefined ||
        post !== undefined)
    ) {
      throw recoveryError(
        "Terminal evidence exists without its persisted request",
        input,
      );
    }
    for (const evidence of [request, pre, launch, exit, post]) {
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
      throw recoveryError(
        "Terminal pre-observation has an incomplete evidence chain",
        input,
      );
    }
    if (launch !== undefined) {
      if (request === undefined || pre === undefined) {
        throw recoveryError(
          "Terminal launch receipt has an incomplete evidence chain",
          input,
        );
      }
      if (
        pre.contract !== TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT
      ) {
        throw recoveryError(
          "Terminal launch receipt does not bind a full pre-observation",
          input,
        );
      }
      assertLaunchablePreObservation(pre, "RECOVERY_REQUIRED");
      assertLaunchReceiptBinding(
        launch,
        input.operationId,
        input.requestHash,
        referenceFor("terminal-request", requestRaw ?? "", input.operationId),
        referenceFor(
          "terminal-pre-observation",
          preRaw ?? "",
          input.operationId,
        ),
      );
    }
    if (post !== undefined && (post.phase !== "post" || exit === undefined)) {
      throw recoveryError(
        "Terminal post-observation has an incomplete evidence chain",
        input,
      );
    }
    if (exit !== undefined && pre === undefined) {
      throw recoveryError(
        "Terminal exit receipt has no pre-observation",
        input,
      );
    }
    if (
      pre !== undefined &&
      post !== undefined &&
      pre.contract !== post.contract
    ) {
      throw recoveryError(
        "Terminal pre/post observations use incompatible contracts",
        input,
      );
    }
    if (
      exit !== undefined &&
      pre?.contract ===
        TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT &&
      launch === undefined
    ) {
      throw recoveryError(
        "A full terminal exit receipt has no launch receipt",
        input,
      );
    }
    if (
      post?.contract === TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT &&
      launch === undefined
    ) {
      throw recoveryError(
        "A full terminal post-observation has no launch receipt",
        input,
      );
    }
    if (exit !== undefined) {
      return {
        state: "exit_without_result",
        recoveryContext: input.recoveryContext,
        advisory: {
          outcome: exit.outcome,
          exitCode: exit.exit_code,
          signal: exit.signal,
          completedAt: exit.completed_at,
          durationMs: exit.duration_ms,
          stdoutBytes: exit.stdout_bytes,
          stderrBytes: exit.stderr_bytes,
        },
      };
    }
    if (launch !== undefined) {
      return {
        state: "launch_without_exit",
        recoveryContext: input.recoveryContext,
        launchReceipt: launch,
      };
    }
    if (
      input.journalStatus === "completed" ||
      input.journalStatus === "failed"
    ) {
      if (
        isTerminalPrelaunchFailureMetadata(input.journalSafeResult) &&
        pre?.contract !== TERMINAL_OBSERVATION_ARTIFACT_CONTRACT
      ) {
        return {
          state: "completed_prelaunch_failure",
          recoveryContext: input.recoveryContext,
          metadata: input.journalSafeResult,
        };
      }
      return {
        state: "completed_unproven_without_result",
        recoveryContext: input.recoveryContext,
      };
    }
    if (request === undefined) {
      return { state: "none", recoveryContext: input.recoveryContext };
    }
    return {
      state: "request_without_launch",
      recoveryContext: input.recoveryContext,
      preEvidence:
        pre === undefined
          ? "none"
          : pre.contract === TERMINAL_OBSERVATION_ARTIFACT_CONTRACT
            ? "legacy_placeholder"
            : "full_workspace_observation",
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
   * chain. An absent result returns undefined after validating any partial
   * evidence so the journal state machine can distinguish retry-safe accepted
   * work from executing work that must become indeterminate. In particular,
   * an exit receipt without a result is never treated as completed or replayed.
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
      await this.inspectIncompleteEvidence({
        operationId: input.operationId,
        requestHash: input.requestHash,
        recoveryContext: "ordinary_process_crash",
      });
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
    const launchReceipt = "launch_receipt" in artifact
      ? await this.readLaunchReceiptReference(artifact.launch_receipt)
      : undefined;
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
    if (launchReceipt !== undefined) {
      assertLaunchReceiptBinding(
        launchReceipt,
        input.operationId,
        input.requestHash,
        artifact.request,
        artifact.pre_observation,
      );
      if (
        preObservation.contract !==
          TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT ||
        postObservation.contract !==
          TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT
      ) {
        throw recoveryError(
          "Full terminal result contains legacy observations",
          input,
        );
      }
      assertLaunchablePreObservation(
        preObservation,
        "RECOVERY_REQUIRED",
      );
      assertPostObservationControl(
        artifact.result.mutation.outcome,
        (artifact as FullTerminalResultArtifact).post_observation_control,
        preObservation,
        postObservation,
        artifact.result,
        "RECOVERY_REQUIRED",
      );
    } else if (
      preObservation.contract ===
        TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT ||
      postObservation.contract ===
        TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT
    ) {
      throw recoveryError(
        "Legacy terminal result contains full observations without a launch receipt",
        input,
      );
    }
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

  public async readWorkspaceObservationReference(
    reference: ArtifactReference,
    phase: "pre" | "post",
  ): Promise<TerminalWorkspaceObservationArtifact> {
    const artifact = await this.readObservationReference(reference, phase);
    if (
      artifact.contract !==
      TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT
    ) {
      throw recoveryError(
        "Terminal observation is a legacy placeholder",
        {
          operationId: artifact.operation_id,
          requestHash: artifact.request_hash,
        },
      );
    }
    return artifact;
  }

  /**
   * Reads one result through its durable reference and validates the complete
   * request/observation/receipt chain before returning any source-bearing
   * evidence to an effect or diff consumer.
   */
  public async readResultReference(input: {
    readonly operationId: string;
    readonly reference: ArtifactReference;
    readonly requestHash?: string;
  }): Promise<VerifiedTerminalResultEvidence> {
    assertExpectedReference(input.reference, "terminal-result");
    if (
      input.reference.id !== input.operationId ||
      !isJournalOperationId(input.operationId)
    ) {
      throw recoveryError(
        "Terminal result reference does not match the requested operation",
        {
          operationId: input.operationId,
          requestHash: input.requestHash ?? "0".repeat(64),
        },
      );
    }
    const raw = await this.artifacts.getReferenced(input.reference);
    const artifact = parseTerminalResultArtifact(raw);
    const requestHash = input.requestHash ?? artifact.request_hash;
    assertRecoveryIdentity(input.operationId, requestHash);
    if (
      artifact.operation_id !== input.operationId ||
      artifact.request_hash !== requestHash
    ) {
      throw recoveryError(
        "Terminal result identity or request hash does not match",
        { operationId: input.operationId, requestHash },
      );
    }
    const request = await this.readRequestReference(artifact.request);
    const preObservation = await this.readObservationReference(
      artifact.pre_observation,
      "pre",
    );
    const exitReceipt = await this.readExitReceiptReference(
      artifact.exit_receipt,
    );
    const postObservation = await this.readObservationReference(
      artifact.post_observation,
      "post",
    );
    assertEvidenceBinding(
      input.operationId,
      requestHash,
      request,
      preObservation,
      exitReceipt,
      postObservation,
      artifact.result,
    );
    if (!("launch_receipt" in artifact)) {
      if (
        preObservation.contract ===
          TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT ||
        postObservation.contract ===
          TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT
      ) {
        throw recoveryError(
          "Legacy terminal result contains full observations without a launch receipt",
          { operationId: input.operationId, requestHash },
        );
      }
      return {
        artifact,
        request,
        preObservation,
        exitReceipt,
        postObservation,
        reference: input.reference,
      };
    }
    const launchReceipt = await this.readLaunchReceiptReference(
      artifact.launch_receipt,
    );
    if (
      preObservation.contract !==
        TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT ||
      postObservation.contract !==
        TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT
    ) {
      throw recoveryError(
        "Full terminal result contains legacy observations",
        { operationId: input.operationId, requestHash },
      );
    }
    assertLaunchablePreObservation(preObservation, "RECOVERY_REQUIRED");
    assertLaunchReceiptBinding(
      launchReceipt,
      input.operationId,
      requestHash,
      artifact.request,
      artifact.pre_observation,
    );
    assertPostObservationControl(
      artifact.result.mutation.outcome,
      artifact.post_observation_control,
      preObservation,
      postObservation,
      artifact.result,
      "RECOVERY_REQUIRED",
    );
    return {
      artifact,
      request,
      preObservation,
      launchReceipt,
      exitReceipt,
      postObservation,
      reference: input.reference,
    };
  }

  /**
   * Produces the narrow callback consumed by SnapshotDiffInspector. Every
   * operation is loaded through the integrity-bound result reference before a
   * retained image, immutable Git object, or prior verified baseline is used.
   */
  public createBeforeImageResolver(
    options: TerminalBeforeImageResolverOptions,
  ): TerminalBeforeImageResolver {
    const loaded = new Map<
      string,
      Promise<
        | { readonly kind: "legacy" }
        | { readonly kind: "missing" }
        | {
            readonly kind: "full";
            readonly evidence: VerifiedFullTerminalResultEvidence;
          }
      >
    >();
    return async (
      mutation,
      repositoryRelativePath,
      signal,
    ): Promise<TerminalBeforeImageResolution> => {
      throwIfAborted(signal);
      const references = await options.resolveReferences(mutation, signal);
      throwIfAborted(signal);
      if (references === undefined) {
        return { available: false, reason: "missing_evidence" };
      }
      const evidenceKey = stableJson({
        operationId: mutation.operationId,
        terminalResult: references.terminalResult,
        preObservation: references.preObservation ?? null,
      });
      let evidencePromise = loaded.get(evidenceKey);
      if (evidencePromise === undefined) {
        evidencePromise = this.loadBeforeImageEvidence(
          mutation,
          references,
          signal,
        );
        loaded.set(evidenceKey, evidencePromise);
      }
      let loadedEvidence:
        | { readonly kind: "legacy" }
        | { readonly kind: "missing" }
        | {
            readonly kind: "full";
            readonly evidence: VerifiedFullTerminalResultEvidence;
          };
      try {
        loadedEvidence = await evidencePromise;
      } catch (error) {
        loaded.delete(evidenceKey);
        throw error;
      }
      throwIfAborted(signal);
      if (loadedEvidence.kind === "legacy") {
        return { available: false, reason: "legacy_placeholder" };
      }
      if (loadedEvidence.kind === "missing") {
        return { available: false, reason: "missing_evidence" };
      }
      return resolveBeforeImage(
        loadedEvidence.evidence,
        mutation,
        repositoryRelativePath,
        options,
        signal,
      );
    };
  }

  private async loadBeforeImageEvidence(
    mutation: TerminalSessionMutationDiffRecord,
    references: TerminalBeforeImageEvidenceReferences,
    signal: AbortSignal | undefined,
  ): Promise<
    | { readonly kind: "legacy" }
    | { readonly kind: "missing" }
    | {
        readonly kind: "full";
        readonly evidence: VerifiedFullTerminalResultEvidence;
      }
  > {
    assertExpectedReference(references.terminalResult, "terminal-result");
    if (references.terminalResult.id !== mutation.operationId) {
      throw recoveryError(
        "Terminal mutation result reference has a mismatched operation ID",
        {
          operationId: mutation.operationId,
          requestHash: "0".repeat(64),
        },
      );
    }
    const resultRaw = await this.artifacts.getOptionalReferenced(
      references.terminalResult,
    );
    if (resultRaw === undefined) return { kind: "missing" };
    const resultArtifact = parseTerminalResultArtifact(resultRaw);
    if (resultArtifact.operation_id !== mutation.operationId) {
      throw recoveryError(
        "Terminal mutation does not bind its result operation",
        {
          operationId: mutation.operationId,
          requestHash: resultArtifact.request_hash,
        },
      );
    }
    if (!("launch_receipt" in resultArtifact)) {
      if (
        references.preObservation !== undefined &&
        stableJson(references.preObservation) !==
          stableJson(resultArtifact.pre_observation)
      ) {
        throw recoveryError(
          "Legacy terminal mutation does not bind the result pre-observation",
          {
            operationId: mutation.operationId,
            requestHash: resultArtifact.request_hash,
          },
        );
      }
      for (const reference of [
        resultArtifact.request,
        resultArtifact.pre_observation,
        resultArtifact.exit_receipt,
        resultArtifact.post_observation,
      ]) {
        if (
          await this.artifacts.getOptionalReferenced(reference) === undefined
        ) {
          return { kind: "missing" };
        }
      }
      await this.readResultReference({
        operationId: mutation.operationId,
        reference: references.terminalResult,
      });
      return { kind: "legacy" };
    }
    if (
      references.preObservation === undefined ||
      stableJson(references.preObservation) !==
        stableJson(resultArtifact.pre_observation)
    ) {
      throw recoveryError(
        "Terminal mutation does not bind the result pre-observation",
        {
          operationId: mutation.operationId,
          requestHash: resultArtifact.request_hash,
        },
      );
    }
    const sourceReferences = [
      resultArtifact.request,
      resultArtifact.pre_observation,
      resultArtifact.launch_receipt,
      resultArtifact.exit_receipt,
      resultArtifact.post_observation,
    ];
    for (const reference of sourceReferences) {
      if (
        await this.artifacts.getOptionalReferenced(reference) === undefined
      ) {
        return { kind: "missing" };
      }
    }
    const evidence = await this.readResultReference({
      operationId: mutation.operationId,
      reference: references.terminalResult,
    });
    if (
      evidence.preObservation.contract !==
        TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT ||
      evidence.postObservation.contract !==
        TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT ||
      evidence.launchReceipt === undefined
    ) {
      throw recoveryError(
        "Terminal mutation does not bind the verified pre-observation",
        {
          operationId: mutation.operationId,
          requestHash: evidence.artifact.request_hash,
        },
      );
    }
    return {
      kind: "full",
      evidence: evidence as VerifiedFullTerminalResultEvidence,
    };
  }

  private async readLaunchReceiptReference(
    reference: ArtifactReference,
  ): Promise<TerminalLaunchReceiptArtifact> {
    assertExpectedReference(reference, "terminal-launch-receipt");
    return parseTerminalLaunchReceiptArtifact(
      await this.artifacts.getReferenced(reference),
    );
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

async function resolveBeforeImage(
  evidence: VerifiedFullTerminalResultEvidence,
  mutation: TerminalSessionMutationDiffRecord,
  repositoryRelativePath: string,
  options: TerminalBeforeImageResolverOptions,
  signal: AbortSignal | undefined,
): Promise<TerminalBeforeImageResolution> {
  const observation = evidence.preObservation.observation;
  const key = options.pathKey ?? ((value: string) => value);
  const requestedKey = safePathKey(
    key,
    repositoryRelativePath,
    mutation.operationId,
    evidence.artifact.request_hash,
  );
  const matchingImages = (observation.beforeImages ?? []).filter(
    (image) =>
      safePathKey(
        key,
        beforeImagePath(image),
        mutation.operationId,
        evidence.artifact.request_hash,
      ) === requestedKey,
  );
  if (matchingImages.length > 1) {
    throw recoveryError(
      "Terminal pre-observation contains ambiguous before-images",
      {
        operationId: mutation.operationId,
        requestHash: evidence.artifact.request_hash,
      },
    );
  }
  const image = matchingImages[0];
  const prior = await options.resolvePriorBaseline?.(
    mutation,
    repositoryRelativePath,
    signal,
  );
  throwIfAborted(signal);
  if (prior !== undefined) {
    assertVerifiedPriorBaseline(
      prior,
      repositoryRelativePath,
      image,
      key,
      mutation.operationId,
      evidence.artifact.request_hash,
    );
    return { available: true, ...prior };
  }
  if (image !== undefined) {
    return resolvePersistedBeforeImage(
      image,
      mutation.operationId,
      options,
      signal,
      evidence.artifact.request_hash,
    );
  }
  if (observation.state === "unknown") {
    return { available: false, reason: "unknown_observation" };
  }

  const matchingEntries = (observation.entries ?? []).filter(
    (entry) =>
      safePathKey(
        key,
        entry.path,
        mutation.operationId,
        evidence.artifact.request_hash,
      ) === requestedKey ||
      (
        entry.originalPath !== undefined &&
        safePathKey(
          key,
          entry.originalPath,
          mutation.operationId,
          evidence.artifact.request_hash,
        ) === requestedKey
      ),
  );
  if (matchingEntries.length > 1) {
    throw recoveryError(
      "Terminal pre-observation contains ambiguous path entries",
      {
        operationId: mutation.operationId,
        requestHash: evidence.artifact.request_hash,
      },
    );
  }
  if (matchingEntries.length > 0) {
    // Dirty, staged, untracked, and rename-origin paths require an explicit
    // before-image. Falling back to HEAD would erase the user's actual
    // pre-command worktree bytes.
    return {
      available: false,
      reason:
        evidence.artifact.result.mutation.path_facts_truncated === true
          ? "bounded_out"
          : "missing_evidence",
    };
  }

  const result = evidence.artifact.result;
  const isCreated =
    result.mutation.outcome === "observed" &&
    (
      includesPath(
        result.mutation.created,
        requestedKey,
        key,
        mutation.operationId,
        evidence.artifact.request_hash,
      ) ||
      result.mutation.renamed.some(
        (rename) => safePathKey(
          key,
          rename.to,
          mutation.operationId,
          evidence.artifact.request_hash,
        ) === requestedKey,
      )
    );
  if (isCreated) {
    return {
      available: true,
      baselineId: `terminal:${mutation.operationId}:pre`,
      entry: {
        path: repositoryRelativePath,
        existed: false,
        bytes: null,
        mode: null,
        sha256: null,
      },
    };
  }

  const wasTracked =
    includesPath(
      result.mutation.updated,
      requestedKey,
      key,
      mutation.operationId,
      evidence.artifact.request_hash,
    ) ||
    includesPath(
      result.mutation.deleted,
      requestedKey,
      key,
      mutation.operationId,
      evidence.artifact.request_hash,
    ) ||
    result.mutation.renamed.some(
      (rename) => safePathKey(
        key,
        rename.from,
        mutation.operationId,
        evidence.artifact.request_hash,
      ) === requestedKey,
    );
  if (wasTracked && typeof observation.head === "string") {
    if (options.readHeadPath === undefined) {
      return { available: false, reason: "missing_evidence" };
    }
    const resolved = await options.readHeadPath(
      observation.head,
      repositoryRelativePath,
      signal,
    );
    throwIfAborted(signal);
    if (resolved === undefined) {
      return { available: false, reason: "missing_evidence" };
    }
    assertImmutableHeadPath(
      resolved,
      mutation.operationId,
      evidence.artifact.request_hash,
    );
    return {
      available: true,
      baselineId:
        `terminal:${mutation.operationId}:head:${resolved.objectId}`,
      entry: checkpointEntry(
        repositoryRelativePath,
        resolved.bytes,
        resolved.mode,
      ),
    };
  }

  return {
    available: false,
    reason:
      observation.state === "metadata_limited" ||
      result.mutation.path_facts_truncated === true
        ? "bounded_out"
        : "missing_evidence",
  };
}

async function resolvePersistedBeforeImage(
  image: WorkspaceBeforeImage,
  operationId: string,
  options: TerminalBeforeImageResolverOptions,
  signal: AbortSignal | undefined,
  requestHash: string,
): Promise<TerminalBeforeImageResolution> {
  if (image.kind === "absent") {
    return {
      available: true,
      baselineId: `terminal:${operationId}:pre`,
      entry: {
        path: image.path,
        existed: false,
        bytes: null,
        mode: null,
        sha256: null,
      },
    };
  }
  if (image.kind === "identity_only") {
    return { available: false, reason: "bounded_out" };
  }
  let bytes: Buffer;
  if (image.kind === "retained") {
    bytes = Buffer.from(image.contentBase64, "base64");
  } else {
    if (options.readGitBlob === undefined) {
      return { available: false, reason: "missing_evidence" };
    }
    const loaded = await options.readGitBlob(image.blob, signal);
    throwIfAborted(signal);
    if (loaded === undefined) {
      return { available: false, reason: "missing_evidence" };
    }
    bytes = loaded;
  }
  if (
    bytes.length !== image.identity.size ||
    sha256(bytes) !== image.sha256 ||
    (
      image.kind === "git_blob" &&
      gitBlobObjectId(bytes, image.blob.length) !== image.blob
    )
  ) {
    throw recoveryError(
      "Terminal before-image bytes do not match their persisted identity",
      { operationId, requestHash },
    );
  }
  return {
    available: true,
    baselineId:
      image.kind === "git_blob"
        ? `terminal:${operationId}:blob:${image.blob}`
        : `terminal:${operationId}:pre`,
    entry: checkpointEntry(
      image.identity.path,
      bytes,
      image.identity.mode,
    ),
  };
}

function assertVerifiedPriorBaseline(
  prior: {
    readonly baselineId: string;
    readonly entry: CheckpointFileSnapshot;
  },
  repositoryRelativePath: string,
  image: WorkspaceBeforeImage | undefined,
  pathKey: (repositoryRelativePath: string) => string,
  operationId: string,
  requestHash: string,
): void {
  const priorKey = safePathKey(
    pathKey,
    prior.entry.path,
    operationId,
    requestHash,
  );
  const requestedKey = safePathKey(
    pathKey,
    repositoryRelativePath,
    operationId,
    requestHash,
  );
  if (
    prior.baselineId.length === 0 ||
    priorKey !== requestedKey ||
    (
      prior.entry.bytes === null
        ? prior.entry.existed ||
          prior.entry.sha256 !== null ||
          prior.entry.mode !== null
        : !prior.entry.existed ||
          prior.entry.sha256 !== sha256(prior.entry.bytes) ||
          !validNonnegativeInteger(prior.entry.mode)
    )
  ) {
    throw recoveryError(
      "Verified prior terminal baseline is malformed or mismatched",
      { operationId, requestHash },
    );
  }
  if (image === undefined) return;
  if (image.kind === "absent") {
    if (
      prior.entry.existed ||
      prior.entry.bytes !== null ||
      prior.entry.mode !== null ||
      prior.entry.sha256 !== null
    ) {
      throw recoveryError(
        "Verified prior terminal baseline conflicts with an absent pre-image",
        { operationId, requestHash },
      );
    }
    return;
  }
  if (
    prior.entry.bytes === null ||
    prior.entry.sha256 !== image.sha256 ||
    prior.entry.bytes.length !== image.identity.size ||
    prior.entry.mode !== image.identity.mode
  ) {
    throw recoveryError(
      "Verified prior terminal baseline does not match the pre-observation",
      { operationId, requestHash },
    );
  }
}

function assertImmutableHeadPath(
  value: TerminalImmutableHeadPath,
  operationId: string,
  requestHash: string,
): void {
  if (
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value.objectId) ||
    !validNonnegativeInteger(value.mode) ||
    !Buffer.isBuffer(value.bytes) ||
    gitBlobObjectId(value.bytes, value.objectId.length) !== value.objectId
  ) {
    throw recoveryError(
      "Immutable pre-HEAD baseline is malformed",
      { operationId, requestHash },
    );
  }
}

function gitBlobObjectId(bytes: Buffer, objectIdLength: number): string {
  const algorithm = objectIdLength === 40 ? "sha1" : "sha256";
  const header = Buffer.from(`blob ${bytes.length}\0`, "utf8");
  return createHash(algorithm).update(header).update(bytes).digest("hex");
}

function checkpointEntry(
  repositoryRelativePath: string,
  bytes: Buffer,
  mode: number,
): CheckpointFileSnapshot {
  return {
    path: repositoryRelativePath,
    existed: true,
    bytes,
    mode,
    sha256: sha256(bytes),
  };
}

function beforeImagePath(image: WorkspaceBeforeImage): string {
  return image.kind === "absent" ? image.path : image.identity.path;
}

function includesPath(
  paths: readonly string[],
  requestedKey: string,
  pathKey: (repositoryRelativePath: string) => string,
  operationId: string,
  requestHash: string,
): boolean {
  return paths.some(
    (path) =>
      safePathKey(pathKey, path, operationId, requestHash) === requestedKey,
  );
}

function safePathKey(
  pathKey: (repositoryRelativePath: string) => string,
  repositoryRelativePath: string,
  operationId: string,
  requestHash: string,
): string {
  try {
    const value = pathKey(repositoryRelativePath);
    if (typeof value !== "string" || value.length === 0) throw new Error();
    return value;
  } catch (error) {
    throw new AgentError(
      "RECOVERY_REQUIRED",
      "Terminal before-image path identity is invalid",
      { operationId, requestHash },
      { cause: error },
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new AgentError(
        "COMMAND_CANCELLED",
        "Terminal before-image resolution was cancelled",
      );
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

export function isTerminalPrelaunchFailureMetadata(
  value: unknown,
): value is TerminalPrelaunchFailureMetadata {
  if (!hasExactKeys(value, [
    "reasonCode",
    "outcome",
    "mutation_outcome",
    "runtimeBudgetLimits",
    "plannedDisclosureBytes",
  ], true)) return false;
  const item = value as Partial<TerminalPrelaunchFailureMetadata>;
  const limits = item.runtimeBudgetLimits;
  return (
    validBoundedString(item.reasonCode, 256) &&
    item.outcome === "spawn_failed" &&
    item.mutation_outcome === "none" &&
    (limits === undefined ||
      (
        limits !== null &&
        typeof limits === "object" &&
        !Array.isArray(limits) &&
        Object.keys(limits).length <= 32 &&
        Object.entries(limits).every(([key, amount]) =>
          validBoundedString(key, 128) && validNonnegativeInteger(amount)
        )
      )) &&
    (item.plannedDisclosureBytes === undefined ||
      validNonnegativeInteger(item.plannedDisclosureBytes))
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

function parseTerminalLaunchReceiptArtifact(
  raw: string,
): TerminalLaunchReceiptArtifact {
  const value = parseJson(raw, "Terminal launch receipt is invalid JSON");
  assertTerminalLaunchReceiptArtifact(value, "RECOVERY_REQUIRED");
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
  if (hasExactKeys(value, [
    "contract",
    "operation_id",
    "request_hash",
    "phase",
    "observation",
  ])) {
    const full = value as Partial<TerminalWorkspaceObservationArtifact>;
    if (
      full.contract !== TERMINAL_WORKSPACE_OBSERVATION_ARTIFACT_CONTRACT ||
      !isJournalOperationId(full.operation_id) ||
      typeof full.request_hash !== "string" ||
      !HASH_PATTERN.test(full.request_hash) ||
      (full.phase !== "pre" && full.phase !== "post") ||
      !isWorkspaceObservation(full.observation) ||
      full.observation.phase !== full.phase
    ) {
      throw new AgentError(
        code,
        "Terminal workspace observation has invalid durable facts",
      );
    }
    return;
  }
  if (!hasExactKeys(value, [
      "contract",
      "operation_id",
      "request_hash",
      "phase",
      "observed_at",
      "state",
    ])) {
    throw new AgentError(code, "Terminal observation artifact has an invalid shape");
  }
  const item = value as Partial<LegacyTerminalObservationArtifact>;
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

function assertTerminalLaunchReceiptArtifact(
  value: unknown,
  code: "INTERNAL_ERROR" | "RECOVERY_REQUIRED",
): asserts value is TerminalLaunchReceiptArtifact {
  if (!hasExactKeys(value, [
    "contract",
    "operation_id",
    "request_hash",
    "request",
    "pre_observation",
    "recorded_at",
  ])) {
    throw new AgentError(code, "Terminal launch receipt has an invalid shape");
  }
  const item = value as Partial<TerminalLaunchReceiptArtifact>;
  if (
    item.contract !== TERMINAL_LAUNCH_RECEIPT_ARTIFACT_CONTRACT ||
    !isJournalOperationId(item.operation_id) ||
    typeof item.request_hash !== "string" ||
    !HASH_PATTERN.test(item.request_hash) ||
    !isExpectedReference(item.request, "terminal-request") ||
    !isExpectedReference(item.pre_observation, "terminal-pre-observation") ||
    item.request.id !== item.operation_id ||
    item.pre_observation.id !== item.operation_id ||
    !isIsoTimestamp(item.recorded_at)
  ) {
    throw new AgentError(
      code,
      "Terminal launch receipt has invalid durable bindings",
    );
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
  const full = value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "launch_receipt" in value;
  const allowed = full
    ? [
        "contract", "operation_id", "request_hash", "request",
        "pre_observation", "launch_receipt", "exit_receipt",
        "post_observation", "result", "post_observation_control",
      ]
    : [
        "contract", "operation_id", "request_hash", "request",
        "pre_observation", "exit_receipt", "post_observation", "result",
      ];
  if (!hasExactKeys(value, allowed, full)) {
    throw new AgentError(code, "Terminal result artifact has an invalid shape");
  }
  const item = value as Partial<FullTerminalResultArtifact> &
    Partial<LegacyTerminalResultArtifact>;
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
  if (!full) return;
  if (
    !isExpectedReference(item.launch_receipt, "terminal-launch-receipt") ||
    item.launch_receipt.id !== item.operation_id ||
    (item.result.mutation.outcome === "observed"
      ? !isWorkspacePostObservationControl(item.post_observation_control)
      : item.post_observation_control !== undefined)
  ) {
    throw new AgentError(
      code,
      "Full terminal result artifact has invalid durable bindings",
    );
  }
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

function assertLaunchReceiptBinding(
  receipt: TerminalLaunchReceiptArtifact,
  operationId: string,
  requestHash: string,
  request: ArtifactReference,
  preObservation: ArtifactReference,
): void {
  if (
    receipt.operation_id !== operationId ||
    receipt.request_hash !== requestHash ||
    stableJson(receipt.request) !== stableJson(request) ||
    stableJson(receipt.pre_observation) !== stableJson(preObservation)
  ) {
    throw recoveryError(
      "Terminal launch receipt does not bind to the exact prelaunch evidence",
      { operationId, requestHash },
    );
  }
}

function assertPostObservationControl(
  outcome: TerminalExecResult["mutation"]["outcome"],
  control: WorkspacePostObservationControl | undefined,
  preObservation: TerminalWorkspaceObservationArtifact,
  postObservation: TerminalWorkspaceObservationArtifact,
  result: TerminalExecResult,
  code: "INTERNAL_ERROR" | "RECOVERY_REQUIRED",
): void {
  if (!hasFullTerminalPathSummary(result.mutation)) {
    throw new AgentError(
      code,
      "A full terminal result requires bounded path-summary facts",
    );
  }
  if (
    preObservation.observation.state !== "complete" &&
    outcome !== "unknown"
  ) {
    throw new AgentError(
      code,
      "A limited pre-observation can only produce unknown attribution",
    );
  }
  if (outcome === "observed") {
    if (
      !isWorkspacePostObservationControl(control) ||
      postObservation.observation.state !== "complete" ||
      control.branch !== postObservation.observation.branch ||
      control.head !== postObservation.observation.head ||
      control.excludedStateFingerprint !==
        postObservation.observation.components.excluded ||
      result.mutation.repository_fingerprint !==
        postObservation.observation.repositoryFingerprint
    ) {
      throw new AgentError(
        code,
        "Terminal control anchor does not match the post-observation",
      );
    }
    return;
  }
  if (control !== undefined) {
    throw new AgentError(
      code,
      "A non-observed terminal result cannot carry a control anchor",
    );
  }
  if (outcome === "none") {
    if (
      preObservation.observation.state !== "complete" ||
      postObservation.observation.state !== "complete" ||
      preObservation.observation.repositoryFingerprint !==
        postObservation.observation.repositoryFingerprint ||
      preObservation.observation.branch !==
        postObservation.observation.branch ||
      preObservation.observation.head !==
        postObservation.observation.head ||
      stableJson(preObservation.observation.components) !==
        stableJson(postObservation.observation.components) ||
      preObservation.observation.nestedRepository !==
        postObservation.observation.nestedRepository ||
      result.mutation.repository_fingerprint !==
        postObservation.observation.repositoryFingerprint
    ) {
      throw new AgentError(
        code,
        "A no-effect terminal result does not match its complete observations",
      );
    }
    return;
  }
  if (result.mutation.repository_fingerprint !== undefined) {
    throw new AgentError(
      code,
      "A non-clean terminal result cannot invent a repository fingerprint",
    );
  }
}

function assertLaunchablePreObservation(
  preObservation: TerminalWorkspaceObservationArtifact,
  code: "INTERNAL_ERROR" | "RECOVERY_REQUIRED",
): void {
  if (
    preObservation.observation.state !== "complete" &&
    preObservation.observation.state !== "metadata_limited"
  ) {
    throw new AgentError(
      code,
      "Terminal launch requires a complete or metadata-limited pre-observation",
    );
  }
}

function isWorkspacePostObservationControl(
  value: unknown,
): value is WorkspacePostObservationControl {
  if (!hasExactKeys(value, [
    "branch",
    "head",
    "excludedStateFingerprint",
  ])) return false;
  const item = value as Partial<WorkspacePostObservationControl>;
  return (
    (item.branch === null || typeof item.branch === "string") &&
    (item.head === null || typeof item.head === "string") &&
    typeof item.excludedStateFingerprint === "string" &&
    HASH_PATTERN.test(item.excludedStateFingerprint)
  );
}

function referenceFor(
  kind: ArtifactReference["kind"],
  raw: string,
  id: string,
): ArtifactReference {
  return {
    kind,
    id,
    bytes: Buffer.byteLength(raw),
    sha256: sha256(raw),
  };
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
      "created_total",
      "updated_total",
      "deleted_total",
      "renamed_total",
      "pre_existing_touched_total",
      "path_endpoint_total",
      "path_endpoint_omitted",
      "path_facts_truncated",
      "path_facts_sha256",
      "unavailable_baseline_count",
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
        HASH_PATTERN.test(item.repository_fingerprint))) &&
    validOptionalTerminalPathSummary(item)
  );
}

function isTerminalArtifactReference(value: unknown): boolean {
  return (
    isArtifactReference(value) &&
    (TERMINAL_STREAM_ARTIFACT_KINDS as readonly string[]).includes(value.kind)
  );
}

function validOptionalTerminalPathSummary(
  item: Partial<TerminalExecResult["mutation"]>,
): boolean {
  const values = [
    item.created_total,
    item.updated_total,
    item.deleted_total,
    item.renamed_total,
    item.pre_existing_touched_total,
    item.path_endpoint_total,
    item.path_endpoint_omitted,
    item.path_facts_truncated,
    item.path_facts_sha256,
    item.unavailable_baseline_count,
  ];
  if (values.every((value) => value === undefined)) return true;
  if (values.some((value) => value === undefined)) return false;
  if (
    !validNonnegativeInteger(item.created_total) ||
    !validNonnegativeInteger(item.updated_total) ||
    !validNonnegativeInteger(item.deleted_total) ||
    !validNonnegativeInteger(item.renamed_total) ||
    !validNonnegativeInteger(item.pre_existing_touched_total) ||
    !validNonnegativeInteger(item.path_endpoint_total) ||
    !validNonnegativeInteger(item.path_endpoint_omitted) ||
    !validNonnegativeInteger(item.unavailable_baseline_count) ||
    typeof item.path_facts_truncated !== "boolean" ||
    typeof item.path_facts_sha256 !== "string" ||
    !HASH_PATTERN.test(item.path_facts_sha256)
  ) return false;
  const retained =
    (item.created?.length ?? 0) +
    (item.updated?.length ?? 0) +
    (item.deleted?.length ?? 0) +
    (item.renamed?.length ?? 0) * 2 +
    (item.pre_existing_touched?.length ?? 0);
  const total =
    item.created_total +
    item.updated_total +
    item.deleted_total +
    item.renamed_total * 2 +
    item.pre_existing_touched_total;
  return item.created_total >= (item.created?.length ?? 0) &&
    item.updated_total >= (item.updated?.length ?? 0) &&
    item.deleted_total >= (item.deleted?.length ?? 0) &&
    item.renamed_total >= (item.renamed?.length ?? 0) &&
    item.pre_existing_touched_total >=
      (item.pre_existing_touched?.length ?? 0) &&
    item.path_endpoint_total === total &&
    item.path_endpoint_omitted === total - retained &&
    item.path_endpoint_omitted >= 0 &&
    item.path_facts_truncated === (item.path_endpoint_omitted > 0);
}

function hasFullTerminalPathSummary(
  item: TerminalExecResult["mutation"],
): boolean {
  if (
    item.created_total === undefined ||
    item.updated_total === undefined ||
    item.deleted_total === undefined ||
    item.renamed_total === undefined ||
    item.pre_existing_touched_total === undefined ||
    item.path_endpoint_total === undefined ||
    item.path_endpoint_omitted === undefined ||
    item.path_facts_truncated === undefined ||
    item.path_facts_sha256 === undefined ||
    item.unavailable_baseline_count === undefined ||
    !validOptionalTerminalPathSummary(item)
  ) return false;
  const retainedEndpoints =
    item.created.length +
    item.updated.length +
    item.deleted.length +
    item.renamed.length * 2 +
    item.pre_existing_touched.length;
  const retainedBytes = [
    ...item.created,
    ...item.updated,
    ...item.deleted,
    ...item.renamed.flatMap((rename) => [rename.from, rename.to]),
    ...item.pre_existing_touched,
  ].reduce((total, path) => total + Buffer.byteLength(path), 0);
  return retainedEndpoints <= TERMINAL_RESULT_MAX_PATH_ENDPOINTS &&
    retainedBytes <= TERMINAL_RESULT_MAX_PATH_BYTES;
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
