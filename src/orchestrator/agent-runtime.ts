import type { AuditLog } from "../audit/audit-log.js";
import {
  MODEL_TRANSPORT_CONTRACT_VERSION,
  type CompletedReceiveResult,
  type ModelTransport,
  type ReceiveRequest,
  type ReceiveResult,
  type SubmissionReceipt,
  type SubmissionRequest,
} from "../transport/model-transport.js";
import { newId, sha256, stableJson } from "../shared/crypto.js";
import { AgentError, errorMessage } from "../shared/errors.js";
import type { Clock } from "../shared/time.js";
import { systemClock } from "../shared/time.js";
import { BudgetMeter } from "../session/budgets.js";
import type { SessionArtifactStore } from "../session/artifact-store.js";
import type {
  CompletionHandoffReference,
  CompletionHandoffStore,
} from "../session/completion-handoff-store.js";
import type { OperationJournal, OperationRecord } from "../session/operation-journal.js";
import type { SessionStore } from "../session/store.js";
import {
  isTerminal,
  restoreSessionLifecycle,
  snapshotSessionLifecycle,
  transitionSession,
} from "../session/state-machine.js";
import {
  cleanupTerminalRecoveryArtifacts,
  sessionRetainsSourceArtifacts,
  setTerminalCleanupPolicy,
} from "../session/terminal-cleanup.js";
import type {
  BudgetCounter,
  SessionState,
} from "../session/types.js";
import {
  isBatchableToolName,
  isReadOnlyToolName,
  toolRequiresContext,
  type BudgetMetric,
} from "../protocol/types.js";
import {
  verifyCompletion,
  type CompletionClaim,
  type CompletionRequirements,
  type CompletionVerification,
} from "./completion.js";
import type {
  DisclosureGuard,
  AuthorizationDecision,
  NormalizedModelMessage,
  NormalizedToolCall,
  ProtocolAdapter,
  RuntimePolicy,
  ToolExecutor,
  ToolOutcome,
  UserInteraction,
} from "./contracts.js";
import {
  TOOL_RESULT_ENVELOPE_RESERVE_BYTES,
} from "./disclosure-budget.js";

export interface AgentRuntimeDependencies {
  readonly state: SessionState;
  readonly store: SessionStore;
  readonly journal: OperationJournal;
  readonly audit: AuditLog;
  readonly protocol: ProtocolAdapter;
  readonly policy: RuntimePolicy;
  readonly tools: ToolExecutor;
  readonly transport: ModelTransport;
  readonly disclosure: DisclosureGuard;
  readonly user: UserInteraction;
  readonly completionRequirements: CompletionRequirements;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
  readonly idFactory?: (prefix: string) => string;
  readonly artifacts?: SessionArtifactStore;
  readonly completionHandoffs?: CompletionHandoffStore;
  /** Deterministic, source-free operational events for an interactive CLI. */
  readonly onProgress?: (event: RuntimeProgressEvent) => void;
}

export interface RuntimeProgressEvent {
  readonly kind: "state" | "model" | "tool" | "completion";
  readonly timestamp: string;
  readonly status: SessionState["status"];
  readonly turnId?: string;
  readonly operationId?: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface AgentRunResult {
  readonly status: SessionState["status"];
  readonly sessionId: string;
  readonly taskId: string;
  readonly completion?: CompletionVerification;
  readonly modelSummary?: string;
  readonly modelReport?: CompletionClaim;
  readonly reason?: string;
}

export class AgentRuntime {
  private readonly state: SessionState;
  private readonly meter: BudgetMeter;
  private readonly clock: Clock;
  private readonly controller = new AbortController();
  private lastCompletion?: CompletionVerification;
  private finalModelSummary?: string;
  private finalModelReport?: CompletionClaim;
  private interruption?: { readonly status: "paused" | "aborted"; readonly reason: string };
  private toolResultDisclosureLimit: number | undefined = undefined;
  private toolResultDisclosureReservation = 0;

  public constructor(private readonly dependencies: AgentRuntimeDependencies) {
    this.state = dependencies.state;
    this.meter = new BudgetMeter(this.state);
    this.clock = dependencies.clock ?? systemClock;
    const handleCallerAbort = (): void => {
      const reason = interruptionReason(dependencies.signal?.reason, "Caller requested a resumable stop");
      this.recordInterruption("paused", reason, dependencies.signal?.reason);
      void dependencies.transport.emergencyStop(reason).catch(() => undefined);
    };
    if (dependencies.signal?.aborted === true) handleCallerAbort();
    else dependencies.signal?.addEventListener("abort", handleCallerAbort, { once: true });
  }

  public async run(): Promise<AgentRunResult> {
    try {
      const startupResult = await this.advanceStartup();
      if (startupResult !== undefined) return startupResult;
      let outbound: string | undefined;
      let recovered:
        | {
            readonly turnId: string;
            readonly response: CompletedReceiveResult;
            readonly recoveryReplay: boolean;
          }
        | undefined;
      if (this.state.queuedOutbound !== undefined) {
        outbound = await this.readQueuedOutbound();
      } else if (this.state.submission !== undefined && this.state.turnSequence > 0) {
        const exchange = await this.recoverExchange();
        const response = exchange.result;
        if (response.status !== "completed") {
          const terminal = await this.handleTransportResult(response);
          if (terminal) return terminal;
          throw new AgentError("TRANSPORT_INDETERMINATE", `Unhandled recovered transport state ${response.status}`);
        }
        recovered = {
          turnId: this.state.submission.turnId,
          response,
          recoveryReplay: exchange.recoveryReplay,
        };
      } else if (this.state.turnSequence === 0) {
        const bootstrap = this.dependencies.protocol.renderBootstrap({
          sessionId: this.state.sessionId,
          taskId: this.state.taskId,
          objective: this.state.objective,
          acceptanceCriteria: this.state.acceptanceCriteria,
          policySummary: this.dependencies.policy.summarize(),
          budgetSummary: { limits: this.state.budgetLimits, usage: this.state.budgetUsage },
        });
        outbound = await this.serializeForDisclosure(bootstrap, "bootstrap");
        await this.queueOutbound(outbound, "turn_0001");
      } else {
        throw new AgentError("RECOVERY_REQUIRED", "Session has no recoverable response, submission, or queued message");
      }

      while (!this.controller.signal.aborted) {
        let turnId: string;
        let response: ReceiveResult;
        let recoveryReplay = false;
        if (recovered !== undefined) {
          turnId = recovered.turnId;
          response = recovered.response;
          recoveryReplay = recovered.recoveryReplay;
          recovered = undefined;
        } else {
          if (outbound === undefined) {
            throw new AgentError("RECOVERY_REQUIRED", "No queued outbound message is available for the next turn");
          }
          this.meter.assertTime(this.clock.now().getTime());
          const queuedTurnId = this.state.queuedOutbound?.turnId;
          const accountedTurnId =
            this.state.turnSequence === 0
              ? undefined
              : `turn_${String(this.state.turnSequence).padStart(4, "0")}`;
          if (accountedTurnId !== undefined && queuedTurnId === accountedTurnId) {
            // A crash can land after the queued turn's sequence and budget are
            // durable but before exchange() replaces the queue with a
            // submission intent. Reuse that already-accounted turn.
            turnId = queuedTurnId;
          } else {
            const expectedTurnId = nextTurnId(this.state.turnSequence);
            if (queuedTurnId !== expectedTurnId) {
              throw new AgentError("RECOVERY_REQUIRED", "Queued outbound turn does not match the session sequence", {
                queued: queuedTurnId,
                expected: expectedTurnId,
              });
            }
            this.meter.consume("turns");
            this.state.turnSequence += 1;
            turnId = expectedTurnId;
            await this.persist();
          }
          if (this.interruption !== undefined) return await this.finishInterruption();
          if (this.state.queuedOutbound?.turnId !== turnId) {
            throw new AgentError("RECOVERY_REQUIRED", "Queued outbound turn does not match the session sequence", {
              queued: this.state.queuedOutbound?.turnId,
              expected: turnId,
            });
          }
          response = await this.exchange(turnId, outbound);
          outbound = undefined;
        }
        if (this.interruption !== undefined) return await this.finishInterruption();
        if (response.status !== "completed") {
          const terminal = await this.handleTransportResult(response);
          if (terminal) return terminal;
          throw new AgentError("TRANSPORT_INDETERMINATE", `Unhandled transport state ${response.status}`);
        }
        await this.dependencies.audit.append({
          type: "model.response",
          taskId: this.state.taskId,
          turnId,
          data: { responseId: response.responseId, bytes: Buffer.byteLength(response.content), sha256: sha256(response.content) },
        });
        this.emitProgress("model", {
          status: "received",
          responseBytes: Buffer.byteLength(response.content),
        }, { turnId });
        if (this.interruption !== undefined) return await this.finishInterruption();

        let messages: readonly NormalizedModelMessage[];
        try {
          messages = this.dependencies.protocol.parseModelTurn(response.content, {
            taskId: this.state.taskId,
            turnId,
            ...(recoveryReplay ? { recoveryReplay: true } : {}),
          }).messages;
          this.state.protocolRepairStreak = 0;
        } catch (error) {
          const repairable = this.dependencies.protocol.isRepairableParseError(error);
          const repairAttempt = repairable ? this.state.protocolRepairStreak + 1 : undefined;
          const repairBudgetAvailable =
            repairAttempt !== undefined &&
            repairAttempt <= this.state.budgetLimits.maxProtocolRepairs &&
            this.meter.remaining("protocolRepairs") > 0;
          await this.dependencies.audit.append({
            type: "protocol.error",
            taskId: this.state.taskId,
            turnId,
            data: {
              error: errorMessage(error),
              repairable,
              ...(repairAttempt === undefined
                ? {}
                : {
                    repairAttempt,
                    repairBudgetAvailable,
                    repairBudgetUsed: this.state.budgetUsage.protocolRepairs,
                    repairBudgetLimit: this.state.budgetLimits.maxProtocolRepairs,
                  }),
            },
          });
          if (!repairable) {
            throw new AgentError(
              "PROTOCOL_INVALID",
              `Non-repairable protocol violation: ${errorMessage(error)}`,
              {},
              { cause: error },
            );
          }
          if (!repairBudgetAvailable || repairAttempt === undefined) {
            throw new AgentError("PROTOCOL_INVALID", "Copilot exhausted the protocol-repair budget", {
              repairAttempt,
              used: this.state.budgetUsage.protocolRepairs,
              limit: this.state.budgetLimits.maxProtocolRepairs,
            });
          }
          this.meter.consume("protocolRepairs");
          this.state.protocolRepairStreak = repairAttempt;
          outbound = await this.serializeForDisclosure(
            this.dependencies.protocol.renderProtocolError({
              taskId: this.state.taskId,
              priorTurnId: turnId,
              code: "INVALID_ENVELOPE",
              message: errorMessage(error),
              repairAttempt: this.state.protocolRepairStreak,
            }),
            "repair",
          );
          await this.queueOutbound(outbound, nextTurnId(this.state.turnSequence));
          await this.dependencies.artifacts?.remove("response", turnId);
          continue;
        }

        const action = selectAction(messages);
        if (this.interruption !== undefined) return await this.finishInterruption();
        const next = await this.handleAction(action, turnId);
        if (next.terminal) {
          if (["completed", "rolled_back", "blocked", "aborted", "failed"].includes(this.state.status)) {
            await this.dependencies.artifacts?.remove("response", turnId);
          }
          return next.result;
        }
        outbound = next.outbound;
        await this.queueOutbound(
          outbound,
          nextTurnId(this.state.turnSequence),
          {
            ...(next.returnedOperationIds === undefined
              ? {}
              : { returnedOperationIds: next.returnedOperationIds }),
            ...(next.queueStatus === undefined
              ? {}
              : { nextStatus: next.queueStatus }),
            ...(next.disclosureKind === undefined
              ? {}
              : { disclosureKind: next.disclosureKind }),
          },
        );
        await this.dependencies.artifacts?.remove("response", turnId);
        if (this.interruption !== undefined) return await this.finishInterruption();
      }

      return await this.finishInterruption();
    } catch (error) {
      if (this.interruption !== undefined) return await this.finishInterruption();
      if (
        error instanceof AgentError &&
        (error.code === "TRANSPORT_INDETERMINATE" || error.code === "RECOVERY_REQUIRED") &&
        !["completed", "rolled_back", "blocked", "aborted", "failed", "paused"].includes(this.state.status)
      ) {
        return await this.pauseWithInterruptionPriority(error.message);
      }
      const failed = await this.fail(error);
      return failed;
    } finally {
      try {
        if (isTerminal(this.state.status)) await this.cleanupTerminalArtifacts();
      } finally {
        await this.dependencies.transport.close().catch(() => undefined);
      }
    }
  }

  public async emergencyStop(reason: string): Promise<void> {
    this.recordInterruption("aborted", reason);
    await this.dependencies.transport.emergencyStop(reason);
  }

  public async requestPause(reason: string): Promise<void> {
    this.recordInterruption("paused", reason);
    await this.dependencies.transport.emergencyStop(reason);
  }

  private async advanceStartup(): Promise<AgentRunResult | undefined> {
    if (this.state.status === "grant_pending") {
      await this.move("transport_starting");
    }
    if (this.state.status === "transport_starting") {
      await this.move("initializing_model");
    }
    if (this.state.status === "paused") {
      await this.move("recovering", this.state.pauseReason ?? "Resuming paused session");
    }
    if (["executing_tools", "returning_results", "awaiting_user", "validating_completion"].includes(this.state.status)) {
      await this.move("recovering", `Recovering interrupted ${this.state.status} state`);
    }
    const uncertainMutation = await this.findUncertainMutation();
    if (uncertainMutation !== undefined) {
      return this.pauseWithInterruptionPriority(
        `Mutation ${uncertainMutation.operationId} may have executed before interruption; rollback or reconcile before resuming`,
      );
    }
    if (this.state.status === "initializing_model" || this.state.status === "recovering") {
      await this.move("awaiting_model");
    }
    if (this.state.status !== "awaiting_model") {
      throw new AgentError("RECOVERY_REQUIRED", `Cannot run session from state ${this.state.status}`);
    }
    return undefined;
  }

  private async findUncertainMutation(): Promise<SessionState["pendingOperations"][number] | undefined> {
    for (const pending of this.state.pendingOperations) {
      const record = await this.dependencies.journal.read(pending.operationId);
      if (
        !pending.mutating &&
        !record.mutating &&
        pending.status === "executing" &&
        record.status === "executing"
      ) {
        await this.dependencies.journal.markNotStarted(record, this.now());
        const specializedCounter = specializedBudgetCounter(pending.tool);
        if (specializedCounter !== undefined) this.meter.refund(specializedCounter);
        this.state.pendingOperations = this.state.pendingOperations.map((operation) =>
          operation.operationId === pending.operationId
            ? { ...operation, status: "accepted" as const }
            : operation,
        );
        await this.persist();
        await this.dependencies.audit.append({
          type: "session.recovered",
          taskId: this.state.taskId,
          operationId: pending.operationId,
          data: {
            decision: "retry",
            reasonCode: "READ_ONLY_EXECUTION_INTERRUPTED",
            journalStatus: record.status,
            sessionStatus: pending.status,
          },
        });
        continue;
      }
      if (pending.status === "accepted" && record.status === "executing") {
        await this.dependencies.journal.markNotStarted(record, this.now());
        await this.persist();
        await this.dependencies.audit.append({
          type: "session.recovered",
          taskId: this.state.taskId,
          operationId: pending.operationId,
          data: {
            decision: "retry",
            reasonCode: "EXECUTION_NOT_DISPATCHED",
            journalStatus: record.status,
            sessionStatus: pending.status,
          },
        });
        continue;
      }
      if (record.status === "accepted") {
        if (pending.status === "executing") {
          const specializedCounter = specializedBudgetCounter(pending.tool);
          if (specializedCounter !== undefined) this.meter.refund(specializedCounter);
          this.state.pendingOperations = this.state.pendingOperations.map((operation) =>
            operation.operationId === pending.operationId
              ? { ...operation, status: "accepted" as const }
              : operation,
          );
          await this.persist();
        }
        continue;
      }
      if (!pending.mutating || record.status === "completed" || record.status === "failed") continue;
      const indeterminate = { ...pending, status: "indeterminate" as const };
      this.state.pendingOperations = this.state.pendingOperations.map((operation) =>
        operation.operationId === pending.operationId ? indeterminate : operation,
      );
      await this.persist();
      await this.dependencies.audit.append({
        type: "session.recovered",
        taskId: this.state.taskId,
        operationId: pending.operationId,
        data: { decision: "pause", reasonCode: "INDETERMINATE_MUTATION", journalStatus: record.status },
      });
      return indeterminate;
    }
    return undefined;
  }

  private async exchange(turnId: string, content: string): Promise<ReceiveResult> {
    const submissionId = (this.dependencies.idFactory ?? newId)("submission");
    const marker = `cba:${this.state.taskId}:${turnId}:${submissionId}`;
    await this.dependencies.artifacts?.put("outbox", submissionId, content);
    this.state.submission = {
      submissionId,
      turnId,
      messageHash: sha256(content),
      marker,
      state: "prepared",
      preparedAt: this.now(),
    };
    const queuedArtifactId = this.state.queuedOutbound?.artifactId;
    delete this.state.queuedOutbound;
    await this.persist();
    if (queuedArtifactId !== undefined) {
      await this.dependencies.artifacts?.remove("outbox", queuedArtifactId);
    }
    await this.dependencies.audit.append({
      type: "model.submission",
      taskId: this.state.taskId,
      turnId,
      data: { submissionId, phase: "prepared", bytes: Buffer.byteLength(content), messageHash: sha256(content) },
    });

    const request: SubmissionRequest = {
      taskId: this.state.taskId,
      turnId,
      submissionId,
      content,
      ...(this.state.transportConversationId === undefined
        ? {}
        : { expectedConversationId: this.state.transportConversationId }),
    };
    let receipt = await this.dependencies.transport.submit(
      request,
      { signal: this.controller.signal },
    );
    this.assertTransportCorrelation(receipt, request, "submission receipt");
    receipt = await this.resolveReceipt(receipt, request);
    if (receipt.status !== "submitted") {
      throw new AgentError("TRANSPORT_INDETERMINATE", "Submission could not be proven delivered", {
        submissionId,
        status: receipt.status,
        diagnosticCode: receipt.diagnosticCode,
      });
    }
    this.state.submission = {
      ...this.state.submission,
      state: "submitted",
      submittedAt: receipt.observedAt,
    };
    await this.persist();
    return this.receiveAndRecord(turnId, submissionId);
  }

  private async receiveAndRecord(
    turnId: string,
    submissionId: string,
  ): Promise<ReceiveResult> {
    const request: ReceiveRequest = {
      taskId: this.state.taskId,
      turnId,
      submissionId,
      ...(this.state.transportConversationId === undefined
        ? {}
        : { expectedConversationId: this.state.transportConversationId }),
    };
    const result = await this.dependencies.transport.receive(
      request,
      { signal: this.controller.signal },
    );
    this.assertTransportCorrelation(result, request, "receive result");
    if (result.status === "completed") {
      this.bindConversation(result);
      await this.dependencies.artifacts?.put("response", turnId, result.content);
      if (this.state.submission?.submissionId === submissionId) {
        this.state.submission = {
          ...this.state.submission,
          state: "answered",
          answeredAt: result.observedAt,
        };
      }
      await this.persist();
      await this.dependencies.artifacts?.remove("outbox", submissionId);
    }
    return result;
  }

  private async recoverExchange(): Promise<{
    readonly result: ReceiveResult;
    readonly recoveryReplay: boolean;
  }> {
    const submission = this.state.submission;
    if (submission === undefined) {
      throw new AgentError("RECOVERY_REQUIRED", "No submission is available for recovery");
    }
    if (submission.state === "answered") {
      const content = await this.requireArtifacts().get("response", submission.turnId);
      return {
        recoveryReplay: true,
        result: {
          contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
          taskId: this.state.taskId,
          turnId: submission.turnId,
          submissionId: submission.submissionId,
          ...(this.state.transportConversationId === undefined
            ? {}
            : { conversationId: this.state.transportConversationId }),
          observedAt: submission.answeredAt ?? this.now(),
          status: "completed",
          responseId: `recovered_${submission.turnId}`,
          content,
        },
      };
    }

    const content = await this.requireArtifacts().get("outbox", submission.submissionId);
    const contentHash = sha256(content);
    if (contentHash !== submission.messageHash) {
      throw new AgentError("RECOVERY_REQUIRED", "Recovered outbound message does not match the durable submission intent", {
        submissionId: submission.submissionId,
        expectedMessageHash: submission.messageHash,
        actualMessageHash: contentHash,
      });
    }
    const request: SubmissionRequest = {
      taskId: this.state.taskId,
      turnId: submission.turnId,
      submissionId: submission.submissionId,
      content,
      ...(this.state.transportConversationId === undefined
        ? {}
        : { expectedConversationId: this.state.transportConversationId }),
    };
    let receipt = await this.dependencies.transport.resolveSubmission(
      {
        taskId: request.taskId,
        turnId: request.turnId,
        submissionId: request.submissionId,
        ...(request.expectedConversationId === undefined
          ? {}
          : { expectedConversationId: request.expectedConversationId }),
      },
      { signal: this.controller.signal },
    );
    this.assertTransportCorrelation(receipt, request, "submission resolution");
    if (receipt.status === "not-submitted") {
      receipt = await this.dependencies.transport.submit(
        request,
        { signal: this.controller.signal },
      );
      this.assertTransportCorrelation(receipt, request, "recovery submission receipt");
    }
    receipt = await this.resolveReceipt(receipt, request);
    if (receipt.status !== "submitted") {
      throw new AgentError("TRANSPORT_INDETERMINATE", "Recovery could not prove submission delivery", {
        status: receipt.status,
      });
    }
    this.state.submission = {
      ...submission,
      state: "submitted",
      submittedAt: receipt.observedAt,
    };
    await this.persist();
    return {
      result: await this.receiveAndRecord(submission.turnId, submission.submissionId),
      recoveryReplay: false,
    };
  }

  private async queueOutbound(
    content: string,
    turnId: string,
    options: {
      readonly returnedOperationIds?: readonly string[];
      readonly nextStatus?: "awaiting_model";
      readonly disclosureKind?: "tool_result";
    } = {},
  ): Promise<void> {
    const artifactId = `queued_${turnId}`;
    await this.dependencies.artifacts?.put("outbox", artifactId, content);
    const from = this.state.status;
    if (options.nextStatus !== undefined) {
      transitionSession(this.state, options.nextStatus, this.now());
    }
    const messageHash = sha256(content);
    this.state.queuedOutbound = {
      turnId,
      artifactId,
      messageHash,
      createdAt: this.now(),
      ...(options.disclosureKind === undefined
        ? {}
        : {
            disclosure: {
              kind: options.disclosureKind,
              disclosedBytes: Buffer.byteLength(content),
              sha256: messageHash,
            },
          }),
    };
    if ((options.returnedOperationIds?.length ?? 0) > 0) {
      const returned = new Set(options.returnedOperationIds);
      const remaining = (this.state.unreturnedOperationIds ?? []).filter(
        (operationId) => !returned.has(operationId),
      );
      if (remaining.length === 0) delete this.state.unreturnedOperationIds;
      else this.state.unreturnedOperationIds = remaining;
    }
    await this.persist();
    if (options.nextStatus !== undefined) {
      await this.dependencies.audit.append({
        type: "session.transition",
        taskId: this.state.taskId,
        data: { from, to: options.nextStatus },
      });
      this.emitProgress("state", { from, to: options.nextStatus });
    }
    await this.recordQueuedDisclosure(this.state.queuedOutbound);
  }

  private bindConversation(value: { readonly conversationId?: string }): void {
    if (value.conversationId === undefined) return;
    if (
      this.state.transportConversationId !== undefined &&
      this.state.transportConversationId !== value.conversationId
    ) {
      throw new AgentError("TRANSPORT_INDETERMINATE", "Transport conversation changed during the active task", {
        expectedConversationId: this.state.transportConversationId,
        actualConversationId: value.conversationId,
      });
    }
    this.state.transportConversationId = value.conversationId;
  }

  private async readQueuedOutbound(): Promise<string> {
    const queued = this.state.queuedOutbound;
    if (queued === undefined) throw new AgentError("RECOVERY_REQUIRED", "No queued message exists");
    const content = await this.requireArtifacts().get("outbox", queued.artifactId);
    if (sha256(content) !== queued.messageHash) {
      throw new AgentError("RECOVERY_REQUIRED", "Queued message hash does not match session state");
    }
    if (
      queued.disclosure !== undefined &&
      (
        queued.disclosure.sha256 !== queued.messageHash ||
        queued.disclosure.disclosedBytes !== Buffer.byteLength(content)
      )
    ) {
      throw new AgentError(
        "RECOVERY_REQUIRED",
        "Queued disclosure evidence does not match the outbound artifact",
      );
    }
    await this.recordQueuedDisclosure(queued);
    return content;
  }

  private async recordQueuedDisclosure(
    queued: NonNullable<SessionState["queuedOutbound"]>,
  ): Promise<void> {
    const disclosure = queued.disclosure;
    if (disclosure === undefined) return;
    try {
      await this.dependencies.audit.appendOnce(
        {
          type: "disclosure.recorded",
          taskId: this.state.taskId,
          turnId: queued.turnId,
          data: {
            kind: disclosure.kind,
            disclosedBytes: disclosure.disclosedBytes,
            sha256: disclosure.sha256,
          },
        },
        `disclosure:${this.state.taskId}:${queued.turnId}:${disclosure.sha256}`,
      );
    } catch (error) {
      throw new AgentError(
        "RECOVERY_REQUIRED",
        "Queued disclosure audit evidence could not be reconciled",
        {},
        { cause: error },
      );
    }
  }

  private requireArtifacts(): SessionArtifactStore {
    if (this.dependencies.artifacts === undefined) {
      throw new AgentError("RECOVERY_REQUIRED", "Source-bearing recovery storage is unavailable");
    }
    return this.dependencies.artifacts;
  }

  private async cleanupTerminalArtifacts(): Promise<void> {
    await cleanupTerminalRecoveryArtifacts({
      status: this.state.status,
      retainSourceArtifacts: sessionRetainsSourceArtifacts(this.state),
      ...(this.dependencies.artifacts === undefined ? {} : { artifacts: this.dependencies.artifacts }),
      ...(this.dependencies.completionHandoffs === undefined
        ? {}
        : { completionHandoffs: this.dependencies.completionHandoffs }),
    });
  }

  private async prepareCompletionHandoff(
    claim: CompletionClaim,
    verification: CompletionVerification,
  ): Promise<CompletionHandoffReference | undefined> {
    if (!verification.accepted) {
      delete this.state.completionHandoff;
      return undefined;
    }
    const existing = this.state.completionHandoff;
    const store = this.dependencies.completionHandoffs;
    if (store === undefined) {
      if (existing !== undefined) {
        throw new AgentError(
          "RECOVERY_REQUIRED",
          "Completion handoff state exists without its durable store",
        );
      }
      return undefined;
    }
    if (existing !== undefined) {
      await store.assertReusable(existing, claim, verification);
      return existing;
    }
    return store.save(claim, verification, this.now());
  }

  private async resolveReceipt(
    receipt: SubmissionReceipt,
    request: SubmissionRequest,
  ): Promise<SubmissionReceipt> {
    this.assertTransportCorrelation(receipt, request, "submission receipt");
    if (receipt.status !== "indeterminate") return receipt;
    if (this.state.submission) {
      this.state.submission = { ...this.state.submission, state: "indeterminate" };
      await this.persist();
    }
    const resolved = await this.dependencies.transport.resolveSubmission(
      {
        taskId: request.taskId,
        turnId: request.turnId,
        submissionId: request.submissionId,
        ...(request.expectedConversationId === undefined
          ? {}
          : { expectedConversationId: request.expectedConversationId }),
      },
      { signal: this.controller.signal },
    );
    this.assertTransportCorrelation(resolved, request, "submission resolution");
    if (resolved.status === "not-submitted") {
      const retried = await this.dependencies.transport.submit(
        request,
        { signal: this.controller.signal },
      );
      this.assertTransportCorrelation(retried, request, "retried submission receipt");
      return retried;
    }
    return resolved;
  }

  private assertTransportCorrelation(
    actual: {
      readonly contractVersion: string;
      readonly taskId: string;
      readonly turnId: string;
      readonly submissionId: string;
      readonly conversationId?: string;
      readonly status: string;
    },
    expected: {
      readonly taskId: string;
      readonly turnId: string;
      readonly submissionId: string;
      readonly expectedConversationId?: string;
    },
    kind: string,
  ): void {
    const expectedConversationId =
      expected.expectedConversationId ?? this.state.transportConversationId;
    const trustedConversationRequired =
      expectedConversationId !== undefined &&
      (actual.status === "submitted" || actual.status === "completed");
    const conversationMismatch =
      expectedConversationId !== undefined &&
      (
        (trustedConversationRequired && actual.conversationId === undefined) ||
        (actual.conversationId !== undefined && actual.conversationId !== expectedConversationId)
      );
    if (
      actual.contractVersion !== MODEL_TRANSPORT_CONTRACT_VERSION ||
      actual.taskId !== expected.taskId ||
      actual.turnId !== expected.turnId ||
      actual.submissionId !== expected.submissionId ||
      conversationMismatch
    ) {
      throw new AgentError("TRANSPORT_INDETERMINATE", `${kind} correlation mismatch`, {
        expectedContractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
        actualContractVersion: actual.contractVersion,
        expectedTaskId: expected.taskId,
        actualTaskId: actual.taskId,
        expectedTurnId: expected.turnId,
        actualTurnId: actual.turnId,
        expectedSubmissionId: expected.submissionId,
        actualSubmissionId: actual.submissionId,
        ...(expectedConversationId === undefined
          ? {}
          : { expectedConversationId, actualConversationId: actual.conversationId }),
      });
    }
  }

  private async handleAction(
    action: NormalizedModelMessage,
    turnId: string,
  ): Promise<
    | {
        readonly terminal: false;
        readonly outbound: string;
        readonly returnedOperationIds?: readonly string[];
        readonly queueStatus?: "awaiting_model";
        readonly disclosureKind?: "tool_result";
      }
    | { readonly terminal: true; readonly result: AgentRunResult }
  > {
    if (this.interruption !== undefined) {
      return { terminal: true, result: await this.finishInterruption() };
    }
    switch (action.type) {
      case "tool_request": {
        await this.move("executing_tools");
        this.throwIfInterrupted();
        this.toolResultDisclosureLimit = undefined;
        this.toolResultDisclosureReservation = 0;
        const outcomes = await this.executeCalls(action.calls, turnId);
        await this.move("returning_results");
        let outbound: string;
        try {
          outbound = await this.serializeForDisclosure(
            this.dependencies.protocol.renderToolOutcomes({ taskId: this.state.taskId, priorTurnId: turnId, outcomes }),
            "tool_result",
            this.toolResultDisclosureLimit,
            true,
          );
        } finally {
          this.toolResultDisclosureLimit = undefined;
          this.toolResultDisclosureReservation = 0;
        }
        return {
          terminal: false,
          outbound,
          returnedOperationIds: action.calls.map((call) => call.operationId),
          queueStatus: "awaiting_model",
          disclosureKind: "tool_result",
        };
      }
      case "request_user_input": {
        await this.move("awaiting_user");
        const decision = await this.executeUserDecision(
          action.requestId,
          "request_user_input",
          action,
          turnId,
          () => this.dependencies.user.requestInput({
            question: action.question,
            ...(action.choices === undefined ? {} : { choices: action.choices }),
            signal: this.controller.signal,
          }),
        );
        this.throwIfInterrupted();
        const outbound = await this.serializeForDisclosure(
          this.dependencies.protocol.renderUserDecision({
            taskId: this.state.taskId,
            priorTurnId: turnId,
            requestId: action.requestId,
            kind: "user_input",
            decision,
          }),
          "decision",
        );
        await this.move("returning_results");
        await this.move("awaiting_model");
        return { terminal: false, outbound };
      }
      case "request_capability": {
        await this.move("awaiting_user");
        const decisionRecord = await this.executeUserDecision(
          action.requestId,
          "request_capability",
          action,
          turnId,
          () => this.dependencies.user.requestCapability({
            capability: action.capability,
            reason: action.reason,
            ...(action.risk === undefined ? {} : { risk: action.risk }),
            signal: this.controller.signal,
          }),
        );
        this.throwIfInterrupted();
        const userDecision = capabilityDecision(decisionRecord);
        let granted = false;
        if (userDecision.decision === "allow_session") {
          this.throwIfInterrupted();
          granted = await this.dependencies.policy.expandSessionGrant(action.capability);
          this.throwIfInterrupted();
        }
        // A standalone capability request has no exact operation to which a
        // one-shot token can safely bind. Copilot must request the operation;
        // the normal policy ask path can then apply allow_once exactly once.
        const decision = {
          ...userDecision,
          effective: granted,
          ...(userDecision.decision === "allow_once"
            ? { reasonCode: "ALLOW_ONCE_REQUIRES_EXACT_OPERATION" }
            : {}),
        };
        await this.dependencies.audit.append({
          type: "capability.decided",
          taskId: this.state.taskId,
          turnId,
          operationId: action.requestId,
          data: { decision: userDecision.decision, effective: granted },
        });
        const outbound = await this.serializeForDisclosure(
          this.dependencies.protocol.renderUserDecision({
            taskId: this.state.taskId,
            priorTurnId: turnId,
            requestId: action.requestId,
            kind: "capability",
            decision,
          }),
          "decision",
        );
        await this.move("returning_results");
        await this.move("awaiting_model");
        return { terminal: false, outbound };
      }
      case "complete_task": {
        await this.move("validating_completion");
        await this.dependencies.audit.append({
          type: "completion.claimed",
          taskId: this.state.taskId,
          turnId,
          data: { summaryHash: sha256(action.claim.summary), riskCount: action.claim.remainingRisks.length },
        });
        if (this.interruption !== undefined) {
          return { terminal: true, result: await this.finishInterruption() };
        }
        const repository = await this.dependencies.tools.inspectCompletionState();
        if (this.interruption !== undefined) {
          return { terminal: true, result: await this.finishInterruption() };
        }
        const verification = verifyCompletion(
          this.state,
          action.claim,
          repository,
          this.dependencies.completionRequirements,
        );
        const completionHandoff = await this.prepareCompletionHandoff(action.claim, verification);
        this.lastCompletion = verification;
        if (completionHandoff !== undefined) {
          this.state.completionHandoff = completionHandoff;
        }
        if (this.interruption !== undefined) {
          return { terminal: true, result: await this.finishInterruption() };
        }
        await this.dependencies.audit.append({
          type: "completion.verified",
          taskId: this.state.taskId,
          turnId,
          data: {
            accepted: verification.accepted,
            reasons: verification.reasons,
            actual: verification.actual,
            ...(completionHandoff === undefined ? {} : { handoffIntegrity: completionHandoff.integrity }),
          },
        });
        if (this.interruption !== undefined) {
          return { terminal: true, result: await this.finishInterruption() };
        }
        if (verification.accepted) {
          this.finalModelSummary = action.claim.summary;
          this.finalModelReport = action.claim;
          this.state.lastModelSummaryHash = sha256(action.claim.summary);
          await this.move("completed");
          this.emitProgress("completion", {
            accepted: true,
            changedFileCount: verification.actual.changedPaths.length,
            successfulCommandCount: verification.actual.successfulCommands.length,
            failedCommandCount: verification.actual.failedCommands.length,
          }, { turnId, operationId: action.operationId });
          return { terminal: true, result: this.result() };
        }
        this.emitProgress("completion", {
          accepted: false,
          rejectionCount: verification.reasons.length,
        }, { turnId, operationId: action.operationId });
        const outbound = await this.serializeForDisclosure(
          this.dependencies.protocol.renderCompletionRejected({
            taskId: this.state.taskId,
            priorTurnId: turnId,
            operationId: action.operationId,
            verification,
          }),
          "repair",
        );
        await this.move("returning_results");
        await this.move("awaiting_model");
        return { terminal: false, outbound };
      }
      case "blocked": {
        await this.move("blocked", action.reason);
        return { terminal: true, result: this.result(action.reason) };
      }
      case "progress": {
        this.state.lastModelSummaryHash = sha256(action.summary);
        await this.dependencies.audit.append({
          type: "model.response",
          taskId: this.state.taskId,
          turnId,
          data: { kind: "progress", summaryHash: this.state.lastModelSummaryHash, bytes: Buffer.byteLength(action.summary) },
        });
        await this.persist();
        const outbound = await this.serializeForDisclosure(
          this.dependencies.protocol.renderProtocolError({
            taskId: this.state.taskId,
            priorTurnId: turnId,
            code: "ACTION_REQUIRED",
            message: "Progress is recorded, but this turn must also request a tool or provide a terminal/action message.",
            repairAttempt: 0,
          }),
          "repair",
        );
        return { terminal: false, outbound };
      }
    }
  }

  private async executeUserDecision(
    requestId: string,
    tool: "request_user_input" | "request_capability",
    request: unknown,
    turnId: string,
    requester: () => Promise<Readonly<Record<string, unknown>>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    this.throwIfInterrupted();
    const alreadyAccounted =
      this.state.completedOperationIds.includes(requestId) ||
      this.state.pendingOperations.some((operation) => operation.operationId === requestId);
    const registration = await this.dependencies.journal.register(
      requestId,
      tool,
      false,
      request,
      this.now(),
    );
    if (!alreadyAccounted) this.meter.consume("operations");
    const artifactId = `decision_${requestId}`;
    if (registration.kind === "replay_completed") {
      const decision = await this.readDecisionArtifact(artifactId);
      const decisionHash = sha256(stableJson(decision));
      if (registration.record.safeResult?.decisionHash !== decisionHash) {
        throw new AgentError("RECOVERY_REQUIRED", "User decision does not match its durable journal record", {
          requestId,
        });
      }
      this.clearPending(requestId);
      if (!this.state.completedOperationIds.includes(requestId)) {
        this.state.completedOperationIds.push(requestId);
      }
      await this.dependencies.audit.append({
        type: "user.decision_replayed",
        taskId: this.state.taskId,
        turnId,
        operationId: requestId,
        data: { tool, decisionHash },
      });
      await this.persist();
      return decision;
    }
    if (registration.kind === "indeterminate_mutation") {
      throw new AgentError("RECOVERY_REQUIRED", "A user-decision request was classified as a mutation");
    }
    this.setPending({ operationId: requestId, name: tool }, registration.record, "accepted");
    await this.persist();
    this.throwIfInterrupted();
    const executing = await this.dependencies.journal.markExecuting(registration.record, this.now());
    this.setPending({ operationId: requestId, name: tool }, executing, "executing");
    await this.persist();
    this.throwIfInterrupted();
    await this.dependencies.audit.append({
      type: "user.requested",
      taskId: this.state.taskId,
      turnId,
      operationId: requestId,
      data: { tool, requestHash: registration.record.requestHash },
    });
    this.throwIfInterrupted();
    const cached = await this.dependencies.artifacts?.getOptional("decision", artifactId);
    this.throwIfInterrupted();
    const decision = cached === undefined
      ? await requester()
      : parseDecisionArtifact(cached);
    this.throwIfInterrupted();
    if (cached === undefined) {
      await this.requireArtifacts().put("decision", artifactId, stableJson(decision));
      this.throwIfInterrupted();
    }
    const decisionHash = sha256(stableJson(decision));
    await this.dependencies.journal.markCompleted(
      executing,
      this.now(),
      "answered",
      { decisionHash },
    );
    this.clearPending(requestId);
    if (!this.state.completedOperationIds.includes(requestId)) {
      this.state.completedOperationIds.push(requestId);
    }
    await this.dependencies.audit.append({
      type: "user.decided",
      taskId: this.state.taskId,
      turnId,
      operationId: requestId,
      data: { tool, decisionHash },
    });
    await this.persist();
    this.throwIfInterrupted();
    return decision;
  }

  private async readDecisionArtifact(artifactId: string): Promise<Readonly<Record<string, unknown>>> {
    const raw = await this.dependencies.artifacts?.getOptional("decision", artifactId);
    if (raw === undefined) {
      throw new AgentError("RECOVERY_REQUIRED", "A completed user decision lacks its recovery artifact", {
        artifactId,
      });
    }
    return parseDecisionArtifact(raw);
  }

  private async executeCalls(calls: readonly NormalizedToolCall[], turnId: string): Promise<readonly ToolOutcome[]> {
    if (calls.length > 1 && calls.some((call) => !isBatchableToolName(call.name))) {
      return calls.map((call) => ({
        operationId: call.operationId,
        tool: call.name,
        status: "denied" as const,
        data: { code: "SEQUENCING_REQUIRED", message: "Mutations and commands must be requested one at a time." },
        safeMetadata: { reasonCode: "SEQUENCING_REQUIRED" },
      }));
    }
    const outcomes: ToolOutcome[] = [];
    for (const call of calls) {
      this.throwIfInterrupted();
      outcomes.push(await this.executeCall(call, turnId, calls.length === 1));
    }
    return outcomes;
  }

  private async serializeForDisclosure(
    message: string,
    kind: "bootstrap" | "tool_result" | "repair" | "decision",
    oneTimeDisclosedBytesLimit?: number,
    deferAudit = false,
  ): Promise<string> {
    // Reserve against the unredacted upper bound before source-bearing data is
    // handed to the final disclosure guard. The exact serialized size is then
    // charged once, at the browser boundary, rather than per intermediate tool.
    const unredactedBytes = Buffer.byteLength(message);
    if (
      kind === "tool_result" &&
      this.toolResultDisclosureReservation > 0 &&
      unredactedBytes > this.toolResultDisclosureReservation
    ) {
      throw new AgentError(
        "BUDGET_EXCEEDED",
        "Rendered tool result exceeded its authorized disclosure reservation",
        {
          actual: unredactedBytes,
          reserved: this.toolResultDisclosureReservation,
        },
      );
    }
    this.meter.assertCanConsume(
      "disclosedBytes",
      unredactedBytes,
      oneTimeDisclosedBytesLimit,
    );
    const serialized = await this.dependencies.disclosure.inspectAndSerialize(message, { kind });
    const disclosedBytes = Buffer.byteLength(serialized);
    if (
      kind === "tool_result" &&
      this.toolResultDisclosureReservation > 0 &&
      disclosedBytes > this.toolResultDisclosureReservation
    ) {
      throw new AgentError(
        "BUDGET_EXCEEDED",
        "Guarded tool result exceeded its authorized disclosure reservation",
        {
          actual: disclosedBytes,
          reserved: this.toolResultDisclosureReservation,
        },
      );
    }
    this.meter.assertCanConsume(
      "disclosedBytes",
      disclosedBytes,
      oneTimeDisclosedBytesLimit,
    );
    this.meter.consume(
      "disclosedBytes",
      disclosedBytes,
      oneTimeDisclosedBytesLimit,
    );
    if (!deferAudit) {
      await this.dependencies.audit.append({
        type: "disclosure.recorded",
        taskId: this.state.taskId,
        data: { kind, disclosedBytes, sha256: sha256(serialized) },
      });
    }
    return serialized;
  }

  private async executeCall(
    call: NormalizedToolCall,
    turnId: string,
    allowCapabilityPrompt = true,
  ): Promise<ToolOutcome> {
    this.throwIfInterrupted();
    const mutating = !isReadOnlyToolName(call.name);
    const wasPending = this.state.pendingOperations.some(
      (operation) => operation.operationId === call.operationId,
    );
    const wasUnreturned =
      this.state.unreturnedOperationIds?.includes(call.operationId) ?? false;
    const operationAlreadyAccounted =
      this.state.completedOperationIds.includes(call.operationId) ||
      wasPending;
    const registration = await this.dependencies.journal.register(
      call.operationId,
      call.name,
      mutating,
      call,
      this.now(),
    );
    // The state record and the counter are committed together. If the journal
    // exists but state does not, a restart charges once; if state already
    // tracks the operation, recovery must not charge it again.
    if (!operationAlreadyAccounted) this.meter.consume("operations");
    if (registration.kind === "replay_completed") {
      if (!wasPending && !wasUnreturned) {
        return {
          operationId: call.operationId,
          tool: call.name,
          status: "denied",
          data: {
            code: "DUPLICATE_OPERATION",
            message: "A completed operation cannot be replayed after its result was delivered.",
          },
          safeMetadata: { reasonCode: "DUPLICATE_OPERATION", replayed: false },
        };
      }
      const replayBudgetLimits = storedRuntimeBudgetLimits(registration.record.safeResult);
      const replayPlannedDisclosureBytes = storedPlannedDisclosureBytes(
        registration.record.safeResult,
      );
      this.reserveToolResultDisclosure(
        replayPlannedDisclosureBytes,
        replayBudgetLimits,
      );
      const outcome = outcomeFromRecord(call, registration.record);
      if (registration.record.status === "completed") {
        await this.recordToolEffects(
          call,
          outcome,
          turnId,
          replayBudgetLimits,
        );
      }
      this.clearPending(call.operationId);
      this.markOperationAwaitingReturn(call.operationId);
      await this.persist();
      return outcome;
    }
    if (registration.kind === "indeterminate_mutation") {
      this.setPending(call, registration.record, "indeterminate");
      await this.persist();
      return {
        operationId: call.operationId,
        tool: call.name,
        status: "indeterminate",
        data: { code: "RECOVERY_REQUIRED", message: "Prior mutation outcome is uncertain; it was not replayed." },
        safeMetadata: { recoveryRequired: true },
      };
    }
    this.setPending(call, registration.record, "accepted");
    await this.persist();
    this.throwIfInterrupted();

    await this.dependencies.audit.append({
      type: "tool.requested",
      taskId: this.state.taskId,
      turnId,
      operationId: call.operationId,
      data: { tool: call.name, requestHash: registration.record.requestHash },
    });
    this.throwIfInterrupted();
    let policy: AuthorizationDecision = await this.dependencies.policy.authorize(call);
    this.throwIfInterrupted();
    if (policy.outcome === "ask" && !allowCapabilityPrompt) {
      policy = {
        outcome: "deny",
        reasonCode: "SEQUENCING_REQUIRED",
        explanation:
          "A capability approval must be requested in a single-call tool turn.",
      };
    }
    await this.dependencies.audit.append({
      type: "policy.decision",
      taskId: this.state.taskId,
      turnId,
      operationId: call.operationId,
      data: { tool: call.name, ...policy },
    });
    this.throwIfInterrupted();
    let allowed = policy.outcome === "allow";
    let oneTimeBudgetLimits: RuntimeBudgetLimits = {};
    if (policy.outcome === "ask") {
      await this.move("awaiting_user", policy.explanation);
      this.throwIfInterrupted();
      await this.dependencies.audit.append({
        type: "capability.requested",
        taskId: this.state.taskId,
        turnId,
        operationId: call.operationId,
        data: { reasonCode: policy.reasonCode, capability: policy.capability },
      });
      this.throwIfInterrupted();
      const decisionArtifactId = `decision_policy_${call.operationId}`;
      const cachedDecision = await this.dependencies.artifacts?.getOptional("decision", decisionArtifactId);
      this.throwIfInterrupted();
      const decision = cachedDecision === undefined
        ? await this.dependencies.user.requestCapability({
            capability: policy.capability,
            reason: policy.explanation,
            signal: this.controller.signal,
          })
        : capabilityDecision(parseDecisionArtifact(cachedDecision));
      this.throwIfInterrupted();
      if (cachedDecision === undefined) {
        await this.requireArtifacts().put("decision", decisionArtifactId, stableJson(decision));
        this.throwIfInterrupted();
      }
      if (decision.decision === "allow_session") {
        this.throwIfInterrupted();
        const expanded = await this.dependencies.policy.expandSessionGrant(policy.capability);
        this.throwIfInterrupted();
        policy = expanded
          ? await this.dependencies.policy.authorize(call)
          : {
              outcome: "deny",
              reasonCode: "CAPABILITY_EXPANSION_DENIED",
              explanation: "The approved session capability could not be applied.",
            };
        this.throwIfInterrupted();
        allowed = policy.outcome === "allow";
      } else if (decision.decision === "allow_once") {
        this.throwIfInterrupted();
        policy = this.dependencies.policy.authorizeOnce === undefined
          ? {
              outcome: "deny",
              reasonCode: "ONE_TIME_REAUTHORIZATION_UNSUPPORTED",
              explanation: "This runtime cannot safely reauthorize a one-time capability.",
            }
          : await this.dependencies.policy.authorizeOnce(call, policy.capability);
        this.throwIfInterrupted();
        allowed = policy.outcome === "allow";
        oneTimeBudgetLimits = runtimeBudgetLimits(policy);
      } else {
        allowed = false;
      }
      if (allowed) {
        try {
          assertExecutionBudgets(
            this.meter,
            call,
            policy,
            oneTimeBudgetLimits,
          );
        } catch (error) {
          policy = {
            outcome: "deny",
            reasonCode: error instanceof AgentError ? error.code : "BUDGET_EXCEEDED",
            explanation: errorMessage(error),
          };
          allowed = false;
        }
      }
      if (decision.decision !== "deny") {
        await this.dependencies.audit.append({
          type: "policy.decision",
          taskId: this.state.taskId,
          turnId,
          operationId: call.operationId,
          data: { tool: call.name, phase: "post_approval", ...policy },
        });
      }
      await this.dependencies.audit.append({
        type: "capability.decided",
        taskId: this.state.taskId,
        turnId,
        operationId: call.operationId,
        data: { decision: decision.decision, effective: allowed },
      });
      this.throwIfInterrupted();
      await this.move("executing_tools");
      this.throwIfInterrupted();
    }
    this.throwIfInterrupted();
    if (!allowed) {
      const status = policy.outcome === "conflict" ? "conflict" : "denied";
      const failed = await this.dependencies.journal.markFailed(
        registration.record,
        this.now(),
        policy.outcome === "ask" ? "denied_after_ask" : policy.outcome,
        { reasonCode: policy.reasonCode },
      );
      this.clearPending(call.operationId);
      this.markOperationAwaitingReturn(call.operationId);
      await this.persist();
      return {
        operationId: call.operationId,
        tool: call.name,
        status,
        data: { code: policy.reasonCode, decision: policy.outcome, message: policy.explanation },
        safeMetadata: failed.safeResult ?? {},
      };
    }

    if (policy.outcome === "allow") {
      try {
        if (policy.plannedMutation !== undefined) {
          this.meter.assertCanConsume(
            "changedFiles",
            policy.plannedMutation.changedFiles,
            oneTimeBudgetLimits.changedFiles,
          );
          this.meter.assertCanConsume(
            "changedLines",
            policy.plannedMutation.changedLines,
            oneTimeBudgetLimits.changedLines,
          );
        }
        this.reserveToolResultDisclosure(
          policy.plannedDisclosureBytes ?? TOOL_RESULT_ENVELOPE_RESERVE_BYTES,
          oneTimeBudgetLimits,
        );
      } catch (error) {
        const safe = {
          reasonCode: error instanceof AgentError ? error.code : "BUDGET_EXCEEDED",
        };
        const failed = await this.dependencies.journal.markFailed(
          registration.record,
          this.now(),
          "denied_before_execution",
          safe,
        );
        this.clearPending(call.operationId);
        this.markOperationAwaitingReturn(call.operationId);
        await this.persist();
        return {
          operationId: call.operationId,
          tool: call.name,
          status: "denied",
          data: {
            code: safe.reasonCode,
            decision: "deny",
            message: errorMessage(error),
          },
          safeMetadata: failed.safeResult ?? safe,
        };
      }
    }
    const specializedCounter = specializedBudgetCounter(call.name);
    if (specializedCounter !== undefined) {
      this.meter.consume(
        specializedCounter,
        1,
        oneTimeBudgetLimits[specializedCounter],
      );
    }
    this.throwIfInterrupted();
    let executing: OperationRecord;
    try {
      executing = await this.dependencies.journal.markExecuting(registration.record, this.now());
    } catch (error) {
      if (specializedCounter !== undefined) this.meter.refund(specializedCounter);
      throw error;
    }
    if (this.interruption !== undefined) {
      await this.restoreUnstartedOperation(call, executing, specializedCounter);
      this.throwIfInterrupted();
    }
    this.setPending(call, executing, "executing");
    await this.persist();
    if (this.interruption !== undefined) {
      await this.restoreUnstartedOperation(call, executing, specializedCounter);
      this.throwIfInterrupted();
    }
    this.throwIfInterrupted();
    let operationWasCommitted = false;
    try {
      const outcome = await this.dependencies.tools.execute(
        call,
        this.controller.signal,
        policy.outcome === "allow" && policy.plannedMutation !== undefined
          ? { plannedMutation: policy.plannedMutation }
          : undefined,
      );
      if (outcome.status === "indeterminate" && mutating) {
        const uncertain = await this.dependencies.journal.markIndeterminate(
          executing,
          this.now(),
          "indeterminate",
          outcome.safeMetadata,
        );
        this.setPending(call, uncertain, "indeterminate");
        await this.dependencies.audit.append({
          type: "tool.completed",
          taskId: this.state.taskId,
          turnId,
          operationId: call.operationId,
          data: { tool: call.name, status: "indeterminate", ...outcome.safeMetadata },
        });
        await this.persist();
        throw new AgentError(
          "RECOVERY_REQUIRED",
          `Mutating operation ${call.operationId} has an indeterminate outcome and requires rollback or reconciliation`,
        );
      }
      if (
        outcome.status === "success" &&
        policy.outcome === "allow" &&
        policy.plannedMutation !== undefined &&
        toolRequiresContext(call.name, "change")
      ) {
        const actualChangedFiles = numericMetadata(outcome.safeMetadata, "changedFileCount");
        const actualChangedLines = numericMetadata(outcome.safeMetadata, "changedLines");
        if (
          actualChangedFiles !== policy.plannedMutation.changedFiles ||
          actualChangedLines !== policy.plannedMutation.changedLines
        ) {
          const safe = {
            ...outcome.safeMetadata,
            recoveryRequired: true,
            reasonCode: "MUTATION_ACCOUNTING_MISMATCH",
            plannedChangedFiles: policy.plannedMutation.changedFiles,
            plannedChangedLines: policy.plannedMutation.changedLines,
            actualChangedFiles,
            actualChangedLines,
          };
          const uncertain = await this.dependencies.journal.markIndeterminate(
            executing,
            this.now(),
            "mutation_accounting_mismatch",
            safe,
          );
          this.setPending(call, uncertain, "indeterminate");
          await this.dependencies.audit.append({
            type: "tool.completed",
            taskId: this.state.taskId,
            turnId,
            operationId: call.operationId,
            data: { tool: call.name, status: "indeterminate", ...safe },
          });
          await this.persist();
          throw new AgentError(
            "RECOVERY_REQUIRED",
            `Mutation ${call.operationId} committed with unexpected budget accounting`,
          );
        }
      }
      const completedSafeResult = withRuntimeBudgetLimits(
        outcome.safeMetadata,
        oneTimeBudgetLimits,
        policy.outcome === "allow"
          ? policy.plannedDisclosureBytes ?? TOOL_RESULT_ENVELOPE_RESERVE_BYTES
          : TOOL_RESULT_ENVELOPE_RESERVE_BYTES,
      );
      await this.dependencies.journal.markCompleted(
        executing,
        this.now(),
        outcome.status,
        completedSafeResult,
      );
      operationWasCommitted = true;
      this.clearPending(call.operationId);
      this.markOperationAwaitingReturn(call.operationId);
      await this.recordToolEffects(
        call,
        outcome,
        turnId,
        oneTimeBudgetLimits,
      );
      await this.dependencies.audit.append({
        type: "tool.completed",
        taskId: this.state.taskId,
        turnId,
        operationId: call.operationId,
        data: { tool: call.name, status: outcome.status, ...outcome.safeMetadata },
      });
      this.emitProgress("tool", {
        tool: call.name,
        outcome: outcome.status,
      }, { turnId, operationId: call.operationId });
      await this.persist();
      return outcome;
    } catch (error) {
      if (this.state.pendingOperations.some(
        (operation) => operation.operationId === call.operationId && operation.status === "indeterminate",
      )) {
        throw error;
      }
      if (operationWasCommitted) {
        this.clearPending(call.operationId);
        this.markOperationAwaitingReturn(call.operationId);
        await this.persist();
        throw error;
      }
      const safe = { errorCode: error instanceof AgentError ? error.code : "INTERNAL_ERROR", message: errorMessage(error) };
      await this.dependencies.journal.markFailed(executing, this.now(), "failure", safe);
      this.clearPending(call.operationId);
      this.markOperationAwaitingReturn(call.operationId);
      await this.persist();
      return {
        operationId: call.operationId,
        tool: call.name,
        status: "failure",
        data: safe,
        safeMetadata: safe,
      };
    }
  }

  private setPending(
    call: { readonly operationId: string; readonly name: string },
    record: OperationRecord,
    status: "accepted" | "executing" | "indeterminate",
  ): void {
    this.clearPending(call.operationId);
    this.state.pendingOperations.push({
      operationId: call.operationId,
      tool: call.name,
      mutating: record.mutating,
      requestHash: record.requestHash,
      status,
      acceptedAt: record.acceptedAt,
    });
  }

  private clearPending(operationId: string): void {
    this.state.pendingOperations = this.state.pendingOperations.filter(
      (operation) => operation.operationId !== operationId,
    );
  }

  private markOperationAwaitingReturn(operationId: string): void {
    if (!this.state.completedOperationIds.includes(operationId)) {
      this.state.completedOperationIds.push(operationId);
    }
    const unreturned = this.state.unreturnedOperationIds ?? [];
    if (!unreturned.includes(operationId)) {
      this.state.unreturnedOperationIds = [...unreturned, operationId];
    }
  }

  private async restoreUnstartedOperation(
    call: { readonly operationId: string; readonly name: string },
    executing: OperationRecord,
    specializedCounter?: "commands" | "readFiles",
  ): Promise<void> {
    const accepted = await this.dependencies.journal.markNotStarted(executing, this.now());
    if (specializedCounter !== undefined) this.meter.refund(specializedCounter);
    this.setPending(call, accepted, "accepted");
    await this.persist();
  }

  private throwIfInterrupted(): void {
    if (this.interruption !== undefined) {
      throw new AgentError("INTERNAL_ERROR", "Execution stopped at an interruption boundary");
    }
  }

  private async recordToolEffects(
    call: NormalizedToolCall,
    outcome: ToolOutcome,
    turnId: string,
    oneTimeBudgetLimits: RuntimeBudgetLimits = {},
  ): Promise<void> {
    const metadata = outcome.safeMetadata;
    if (
      toolRequiresContext(call.name, "change") &&
      outcome.status === "success" &&
      !this.state.mutations.some((record) => record.operationId === call.operationId)
    ) {
      const changedFiles = numericMetadata(metadata, "changedFileCount");
      const changedLines = numericMetadata(metadata, "changedLines");
      this.state.mutationSequence += 1;
      const checkpointId = stringMetadata(metadata, "checkpointId", "unknown");
      const changedPaths = stringArrayMetadata(metadata, "changedPaths");
      const repositoryFingerprint = stringMetadata(metadata, "repositoryFingerprint", "unknown");
      this.state.lastCheckpointId = checkpointId;
      this.state.mutations.push({
        operationId: call.operationId,
        checkpointId,
        changedPaths,
        changedLines,
        completedAt: this.now(),
        repositoryFingerprint,
      });
      this.meter.consume(
        "changedFiles",
        changedFiles,
        oneTimeBudgetLimits.changedFiles,
      );
      this.meter.consume(
        "changedLines",
        changedLines,
        oneTimeBudgetLimits.changedLines,
      );
      await this.dependencies.audit.append({
        type: "checkpoint.created",
        taskId: this.state.taskId,
        turnId,
        operationId: call.operationId,
        data: { checkpointId, changedFileCount: changedFiles },
      });
      await this.dependencies.audit.append({
        type: "mutation.completed",
        taskId: this.state.taskId,
        turnId,
        operationId: call.operationId,
        data: { checkpointId, changedPaths, changedLines, repositoryFingerprint },
      });
    }

    if (
      call.name === "run_command" &&
      !this.state.validations.some((record) => record.operationId === call.operationId)
    ) {
      const commandId = stringMetadata(metadata, "commandId", String(call.arguments.command_id ?? "unknown"));
      const mappedOutcome = mapValidationOutcome(outcome.status, metadata.outcome);
      const exitCode = typeof metadata.exitCode === "number" ? metadata.exitCode : undefined;
      const repositoryFingerprint = hashMetadata(metadata, "repositoryFingerprint");
      this.state.validations.push({
        operationId: call.operationId,
        commandId,
        outcome: mappedOutcome,
        ...(exitCode === undefined ? {} : { exitCode }),
        completedAt: this.now(),
        mutationSequence: this.state.mutationSequence,
        ...(repositoryFingerprint === undefined ? {} : { repositoryFingerprint }),
      });
      await this.dependencies.audit.append({
        type: "command.completed",
        taskId: this.state.taskId,
        turnId,
        operationId: call.operationId,
        data: {
          commandId,
          outcome: mappedOutcome,
          ...(exitCode === undefined ? {} : { exitCode }),
          outputBytes: numericMetadata(metadata, "outputBytes"),
          ...(repositoryFingerprint === undefined ? {} : { repositoryFingerprint }),
        },
      });
      const outputBytes = numericMetadata(metadata, "outputBytes");
      if (outputBytes > 0) {
        this.meter.consume(
          "commandOutputBytes",
          outputBytes,
          oneTimeBudgetLimits.commandOutputBytes,
        );
      }
    }
  }

  private reserveToolResultDisclosure(
    plannedDisclosureBytes: number,
    oneTimeBudgetLimits: RuntimeBudgetLimits,
  ): void {
    const approvedLimit = oneTimeBudgetLimits.disclosedBytes;
    if (
      !Number.isSafeInteger(plannedDisclosureBytes) ||
      plannedDisclosureBytes < TOOL_RESULT_ENVELOPE_RESERVE_BYTES
    ) {
      throw new AgentError(
        "INTERNAL_ERROR",
        "Tool-result disclosure reservation is invalid",
        { plannedDisclosureBytes },
      );
    }
    if (
      approvedLimit !== undefined &&
      this.toolResultDisclosureReservation !== 0
    ) {
      throw new AgentError(
        "BUDGET_EXCEEDED",
        "One-time disclosure approval cannot be combined with another tool result",
      );
    }
    if (
      approvedLimit === undefined &&
      this.toolResultDisclosureLimit !== undefined
    ) {
      throw new AgentError(
        "BUDGET_EXCEEDED",
        "A tool result cannot be added to a one-time disclosure approval",
      );
    }
    const reservation =
      this.toolResultDisclosureReservation + plannedDisclosureBytes;
    if (!Number.isSafeInteger(reservation)) {
      throw new AgentError(
        "BUDGET_EXCEEDED",
        "Combined tool-result disclosure reservation is invalid",
      );
    }
    this.meter.assertCanConsume(
      "disclosedBytes",
      reservation,
      approvedLimit,
    );
    this.toolResultDisclosureReservation = reservation;
    if (approvedLimit !== undefined) {
      this.toolResultDisclosureLimit = approvedLimit;
    }
  }

  private async handleTransportResult(result: Exclude<ReceiveResult, { status: "completed" }>): Promise<AgentRunResult | undefined> {
    if (this.interruption !== undefined) return this.finishInterruption();
    if (result.status === "cancelled") return this.abort(result.diagnosticCode);
    if (result.status === "blocked" && !result.retryable) {
      await this.move("blocked", result.reason);
      return this.result(result.reason);
    }
    if (result.status === "blocked" || result.status === "timed-out") {
      return this.pauseWithInterruptionPriority(
        result.status === "blocked" ? result.reason : result.diagnosticCode,
      );
    }
    if (result.status === "indeterminate") {
      throw new AgentError("TRANSPORT_INDETERMINATE", result.diagnosticCode);
    }
    return undefined;
  }

  private async abort(reason: string): Promise<AgentRunResult> {
    if (!["completed", "rolled_back", "blocked", "aborted", "failed"].includes(this.state.status)) {
      await this.move("aborted", reason);
    }
    return this.result(reason);
  }

  private async pauseWithInterruptionPriority(reason: string): Promise<AgentRunResult> {
    const interruption = this.interruption;
    if (interruption?.status === "aborted") return this.abort(interruption.reason);
    const effectiveReason = interruption?.status === "paused" ? interruption.reason : reason;
    if (["completed", "rolled_back", "blocked", "aborted", "failed"].includes(this.state.status)) {
      return this.result(effectiveReason);
    }
    if (this.state.status !== "paused") await this.move("paused", effectiveReason);
    const currentInterruption = this.interruption;
    if (currentInterruption?.status === "aborted") {
      return this.abort(currentInterruption.reason);
    }
    return this.result(currentInterruption?.reason ?? effectiveReason);
  }

  private async finishInterruption(): Promise<AgentRunResult> {
    const interruption = this.interruption ?? {
      status: "aborted" as const,
      reason: "User or caller cancelled the session",
    };
    if (interruption.status === "aborted") return this.abort(interruption.reason);
    if (["completed", "rolled_back", "blocked", "aborted", "failed"].includes(this.state.status)) {
      return this.result(interruption.reason);
    }
    return this.pauseWithInterruptionPriority(interruption.reason);
  }

  private recordInterruption(
    status: "paused" | "aborted",
    reason: string,
    signalReason: unknown = reason,
  ): void {
    if (this.interruption?.status !== "aborted") {
      if (this.interruption === undefined || status === "aborted") {
        this.interruption = { status, reason };
      }
    }
    if (!this.controller.signal.aborted) this.controller.abort(signalReason);
  }

  private async fail(error: unknown): Promise<AgentRunResult> {
    const message = errorMessage(error);
    if (!["completed", "rolled_back", "blocked", "aborted", "failed"].includes(this.state.status)) {
      const prior = snapshotSessionLifecycle(this.state);
      delete this.state.completionHandoff;
      transitionSession(this.state, "failed", this.now(), {
        reason: message,
        failure: { code: error instanceof AgentError ? error.code : "INTERNAL_ERROR", message },
      });
      setTerminalCleanupPolicy(this.state);
      try {
        await this.persist();
      } catch (persistError) {
        restoreSessionLifecycle(this.state, prior);
        throw persistError;
      }
      await this.dependencies.audit.append({
        type: "session.ended",
        taskId: this.state.taskId,
        data: { status: "failed", code: error instanceof AgentError ? error.code : "INTERNAL_ERROR", message },
      });
    }
    return this.result(message);
  }

  private async move(status: SessionState["status"], reason?: string): Promise<void> {
    const from = this.state.status;
    const prior = snapshotSessionLifecycle(this.state);
    transitionSession(this.state, status, this.now(), reason === undefined ? {} : { reason });
    if (isTerminal(status) && status !== "completed") {
      delete this.state.completionHandoff;
    }
    if (isTerminal(status)) {
      setTerminalCleanupPolicy(this.state);
    }
    try {
      await this.persist();
    } catch (error) {
      restoreSessionLifecycle(this.state, prior);
      throw error;
    }
    await this.dependencies.audit.append({
      type: status === "completed" || status === "blocked" || status === "aborted" || status === "failed"
        ? "session.ended"
        : "session.transition",
      taskId: this.state.taskId,
      data: { from, to: status, ...(reason === undefined ? {} : { reason }) },
    });
    this.emitProgress("state", {
      from,
      to: status,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  private async persist(): Promise<void> {
    this.state.updatedAt = this.now();
    await this.dependencies.store.write(this.state);
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  private emitProgress(
    kind: RuntimeProgressEvent["kind"],
    detail: Readonly<Record<string, unknown>>,
    correlation: { readonly turnId?: string; readonly operationId?: string } = {},
  ): void {
    try {
      this.dependencies.onProgress?.({
        kind,
        timestamp: this.now(),
        status: this.state.status,
        ...correlation,
        detail,
      });
    } catch {
      // Progress rendering is observational and cannot alter agent execution.
    }
  }

  private result(reason?: string): AgentRunResult {
    const completed = this.state.status === "completed";
    return {
      status: this.state.status,
      sessionId: this.state.sessionId,
      taskId: this.state.taskId,
      ...(!completed || this.lastCompletion === undefined
        ? {}
        : { completion: this.lastCompletion }),
      ...(!completed || this.finalModelSummary === undefined ? {} : { modelSummary: this.finalModelSummary }),
      ...(!completed || this.finalModelReport === undefined ? {} : { modelReport: this.finalModelReport }),
      ...(reason === undefined ? {} : { reason }),
    };
  }
}

function selectAction(messages: readonly NormalizedModelMessage[]): NormalizedModelMessage {
  const actionable = messages.filter((message) => message.type !== "progress");
  if (actionable.length > 1) {
    throw new AgentError("PROTOCOL_INVALID", "A model turn contains more than one dependent action class");
  }
  return actionable[0] ?? messages[0] ?? (() => { throw new AgentError("PROTOCOL_INVALID", "Empty model turn"); })();
}

function specializedBudgetCounter(tool: string): "commands" | "readFiles" | undefined {
  if (tool === "run_command") return "commands";
  if (tool === "read_file") return "readFiles";
  return undefined;
}

type RuntimeBudgetLimits = Readonly<Partial<Record<BudgetCounter, number>>>;

const POLICY_BUDGET_COUNTERS: Readonly<
  Partial<Record<BudgetMetric, BudgetCounter>>
> = {
  read_files: "readFiles",
  changed_files: "changedFiles",
  changed_lines: "changedLines",
  disclosed_bytes: "disclosedBytes",
  commands: "commands",
  command_output_bytes: "commandOutputBytes",
};

function runtimeBudgetLimits(policy: AuthorizationDecision): RuntimeBudgetLimits {
  if (policy.outcome !== "allow" || policy.oneTimeBudgetLimits === undefined) return {};
  const limits: Partial<Record<BudgetCounter, number>> = {};
  for (const [metric, limit] of Object.entries(policy.oneTimeBudgetLimits)) {
    const counter = POLICY_BUDGET_COUNTERS[metric as BudgetMetric];
    if (
      counter !== undefined &&
      typeof limit === "number" &&
      Number.isSafeInteger(limit) &&
      limit >= 0
    ) {
      limits[counter] = limit;
    }
  }
  return limits;
}

function assertExecutionBudgets(
  meter: BudgetMeter,
  call: NormalizedToolCall,
  policy: AuthorizationDecision,
  oneTimeBudgetLimits: RuntimeBudgetLimits,
): void {
  if (policy.outcome !== "allow") return;
  if (policy.plannedMutation !== undefined) {
    meter.assertCanConsume(
      "changedFiles",
      policy.plannedMutation.changedFiles,
      oneTimeBudgetLimits.changedFiles,
    );
    meter.assertCanConsume(
      "changedLines",
      policy.plannedMutation.changedLines,
      oneTimeBudgetLimits.changedLines,
    );
  }
  const specializedCounter = specializedBudgetCounter(call.name);
  if (specializedCounter !== undefined) {
    meter.assertCanConsume(
      specializedCounter,
      1,
      oneTimeBudgetLimits[specializedCounter],
    );
  }
}

function withRuntimeBudgetLimits(
  safeMetadata: Readonly<Record<string, unknown>>,
  oneTimeBudgetLimits: RuntimeBudgetLimits,
  plannedDisclosureBytes: number,
): Readonly<Record<string, unknown>> {
  return {
    ...safeMetadata,
    plannedDisclosureBytes,
    ...(Object.keys(oneTimeBudgetLimits).length === 0
      ? {}
      : { runtimeBudgetLimits: oneTimeBudgetLimits }),
  };
}

function storedRuntimeBudgetLimits(
  safeMetadata: Readonly<Record<string, unknown>> | undefined,
): RuntimeBudgetLimits {
  const value = safeMetadata?.runtimeBudgetLimits;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const limits: Partial<Record<BudgetCounter, number>> = {};
  for (const counter of Object.values(POLICY_BUDGET_COUNTERS)) {
    if (counter === undefined) continue;
    const limit = (value as Readonly<Record<string, unknown>>)[counter];
    if (typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0) {
      limits[counter] = limit;
    }
  }
  return limits;
}

function storedPlannedDisclosureBytes(
  safeMetadata: Readonly<Record<string, unknown>> | undefined,
): number {
  const value = safeMetadata?.plannedDisclosureBytes;
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= TOOL_RESULT_ENVELOPE_RESERVE_BYTES
    ? value
    : TOOL_RESULT_ENVELOPE_RESERVE_BYTES;
}

function outcomeFromRecord(call: NormalizedToolCall, record: OperationRecord): ToolOutcome {
  const status = record.status === "completed" && record.outcome === "success" ? "success" : "failure";
  const {
    runtimeBudgetLimits: _runtimeBudgetLimits,
    plannedDisclosureBytes: _plannedDisclosureBytes,
    ...safeResult
  } = record.safeResult ?? {};
  return {
    operationId: call.operationId,
    tool: call.name,
    status,
    data: { replayed: true, outcome: record.outcome, ...safeResult },
    safeMetadata: { replayed: true, ...safeResult },
  };
}

function numericMetadata(metadata: Readonly<Record<string, unknown>>, key: string): number {
  const value = metadata[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function stringMetadata(metadata: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function hashMetadata(metadata: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
}

function stringArrayMetadata(metadata: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = metadata[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function mapValidationOutcome(
  status: ToolOutcome["status"],
  detailedOutcome: unknown,
): "success" | "failure" | "timeout" | "cancelled" | "policy_denied" | "indeterminate" {
  if (status === "success") return "success";
  if (status === "timeout") return "timeout";
  if (status === "cancelled") return "cancelled";
  if (status === "denied") return "policy_denied";
  if (status === "indeterminate") return "indeterminate";
  if (detailedOutcome === "timeout" || detailedOutcome === "cancelled" || detailedOutcome === "indeterminate") {
    return detailedOutcome;
  }
  return "failure";
}

function nextTurnId(currentSequence: number): string {
  return `turn_${String(currentSequence + 1).padStart(4, "0")}`;
}

function parseDecisionArtifact(raw: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AgentError("RECOVERY_REQUIRED", "User-decision recovery artifact is invalid JSON", {}, {
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentError("RECOVERY_REQUIRED", "User-decision recovery artifact has an invalid shape");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function capabilityDecision(
  value: Readonly<Record<string, unknown>>,
): { readonly decision: "deny" | "allow_once" | "allow_session"; readonly note?: string } {
  if (
    value.decision !== "deny" &&
    value.decision !== "allow_once" &&
    value.decision !== "allow_session"
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Capability decision artifact is invalid");
  }
  if (value.note !== undefined && typeof value.note !== "string") {
    throw new AgentError("RECOVERY_REQUIRED", "Capability decision note is invalid");
  }
  return {
    decision: value.decision,
    ...(value.note === undefined ? {} : { note: value.note }),
  };
}

function interruptionReason(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message.trim().length > 0) return value.message;
  if (typeof value === "string" && value.trim().length > 0) return value;
  return fallback;
}
