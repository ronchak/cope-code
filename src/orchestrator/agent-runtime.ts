import type { AuditLog } from "../audit/audit-log.js";
import type {
  CompletedReceiveResult,
  ModelTransport,
  ReceiveResult,
  SubmissionReceipt,
} from "../transport/model-transport.js";
import { newId, sha256, stableJson } from "../shared/crypto.js";
import { AgentError, errorMessage } from "../shared/errors.js";
import type { Clock } from "../shared/time.js";
import { systemClock } from "../shared/time.js";
import { BudgetMeter } from "../session/budgets.js";
import type { SessionArtifactStore } from "../session/artifact-store.js";
import type { CompletionHandoffStore } from "../session/completion-handoff-store.js";
import type { OperationJournal, OperationRecord } from "../session/operation-journal.js";
import type { SessionStore } from "../session/store.js";
import { transitionSession } from "../session/state-machine.js";
import type { SessionState } from "../session/types.js";
import {
  verifyCompletion,
  type CompletionClaim,
  type CompletionRequirements,
  type CompletionVerification,
} from "./completion.js";
import type {
  DisclosureGuard,
  NormalizedModelMessage,
  NormalizedToolCall,
  ProtocolAdapter,
  RuntimePolicy,
  ToolExecutor,
  ToolOutcome,
  UserInteraction,
} from "./contracts.js";

const READ_ONLY_TOOLS = new Set(["list_files", "search_text", "read_file", "git_status", "git_diff", "lsp_query"]);

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
  readonly retainSourceArtifactsOnCompletion?: boolean;
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

  public constructor(private readonly dependencies: AgentRuntimeDependencies) {
    this.state = dependencies.state;
    this.meter = new BudgetMeter(this.state);
    this.clock = dependencies.clock ?? systemClock;
    const handleCallerAbort = (): void => {
      const reason = interruptionReason(dependencies.signal?.reason, "Caller requested a resumable stop");
      this.interruption = { status: "paused", reason };
      this.controller.abort(dependencies.signal?.reason);
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
      let recovered: { readonly turnId: string; readonly response: CompletedReceiveResult } | undefined;
      if (this.state.queuedOutbound !== undefined) {
        outbound = await this.readQueuedOutbound();
      } else if (this.state.submission !== undefined && this.state.turnSequence > 0) {
        const response = await this.recoverExchange();
        if (response.status !== "completed") {
          const terminal = await this.handleTransportResult(response);
          if (terminal) return terminal;
          throw new AgentError("TRANSPORT_INDETERMINATE", `Unhandled recovered transport state ${response.status}`);
        }
        recovered = { turnId: this.state.submission.turnId, response };
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
        if (recovered !== undefined) {
          turnId = recovered.turnId;
          response = recovered.response;
          recovered = undefined;
        } else {
          if (outbound === undefined) {
            throw new AgentError("RECOVERY_REQUIRED", "No queued outbound message is available for the next turn");
          }
          this.meter.assertTime(this.clock.now().getTime());
          this.meter.consume("turns");
          turnId = `turn_${String(++this.state.turnSequence).padStart(4, "0")}`;
          if (this.state.queuedOutbound?.turnId !== turnId) {
            throw new AgentError("RECOVERY_REQUIRED", "Queued outbound turn does not match the session sequence", {
              queued: this.state.queuedOutbound?.turnId,
              expected: turnId,
            });
          }
          await this.persist();
          response = await this.exchange(turnId, outbound);
          outbound = undefined;
        }
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

        let messages: readonly NormalizedModelMessage[];
        try {
          messages = this.dependencies.protocol.parseModelTurn(response.content, {
            taskId: this.state.taskId,
            turnId,
            ...(response.responseId.startsWith("recovered_") ? { recoveryReplay: true } : {}),
          }).messages;
          this.state.protocolRepairStreak = 0;
        } catch (error) {
          this.meter.consume("protocolRepairs");
          this.state.protocolRepairStreak += 1;
          await this.dependencies.audit.append({
            type: "protocol.error",
            taskId: this.state.taskId,
            turnId,
            data: { error: errorMessage(error), repairAttempt: this.state.protocolRepairStreak },
          });
          if (this.state.protocolRepairStreak > this.state.budgetLimits.maxProtocolRepairs) {
            throw new AgentError("PROTOCOL_INVALID", "Copilot exceeded the consecutive protocol-repair limit");
          }
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
        const next = await this.handleAction(action, turnId);
        if (next.terminal) {
          await this.dependencies.artifacts?.remove("response", turnId);
          await this.cleanupTerminalArtifacts();
          return next.result;
        }
        outbound = next.outbound;
        await this.queueOutbound(outbound, nextTurnId(this.state.turnSequence));
        await this.dependencies.artifacts?.remove("response", turnId);
      }

      return await this.finishInterruption();
    } catch (error) {
      if (this.interruption !== undefined) return await this.finishInterruption();
      if (
        error instanceof AgentError &&
        (error.code === "TRANSPORT_INDETERMINATE" || error.code === "RECOVERY_REQUIRED") &&
        !["completed", "rolled_back", "blocked", "aborted", "failed", "paused"].includes(this.state.status)
      ) {
        await this.move("paused", error.message);
        return this.result(error.message);
      }
      return await this.fail(error);
    } finally {
      await this.dependencies.transport.close().catch(() => undefined);
    }
  }

  public async emergencyStop(reason: string): Promise<void> {
    this.interruption = { status: "aborted", reason };
    this.controller.abort(reason);
    await this.dependencies.transport.emergencyStop(reason);
  }

  public async requestPause(reason: string): Promise<void> {
    this.interruption = { status: "paused", reason };
    this.controller.abort(reason);
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
      await this.move(
        "paused",
        `Mutation ${uncertainMutation.operationId} may have executed before interruption; rollback or reconcile before resuming`,
      );
      return this.result(this.state.pauseReason);
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
      if (!pending.mutating) continue;
      const record = await this.dependencies.journal.read(pending.operationId);
      if (record.status === "completed" || record.status === "failed" || record.status === "accepted") continue;
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

    let receipt = await this.dependencies.transport.submit(
      {
        taskId: this.state.taskId,
        turnId,
        submissionId,
        content,
        ...(this.state.transportConversationId === undefined
          ? {}
          : { expectedConversationId: this.state.transportConversationId }),
      },
      { signal: this.controller.signal },
    );
    receipt = await this.resolveReceipt(receipt, content);
    if (receipt.status !== "submitted") {
      throw new AgentError("TRANSPORT_INDETERMINATE", "Submission could not be proven delivered", {
        submissionId,
        status: receipt.status,
        diagnosticCode: receipt.diagnosticCode,
      });
    }
    this.bindConversation(receipt);
    this.state.submission = {
      ...this.state.submission,
      state: "submitted",
      submittedAt: receipt.observedAt,
    };
    await this.persist();
    return this.receiveAndRecord(
      receipt,
      turnId,
      submissionId,
    );
  }

  private async receiveAndRecord(
    receipt: SubmissionReceipt,
    turnId: string,
    submissionId: string,
  ): Promise<ReceiveResult> {
    const result = await this.dependencies.transport.receive(
      {
        taskId: this.state.taskId,
        turnId,
        submissionId,
        ...(this.state.transportConversationId === undefined
          ? {}
          : { expectedConversationId: this.state.transportConversationId }),
      },
      { signal: this.controller.signal },
    );
    if (result.status === "completed") {
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

  private async recoverExchange(): Promise<ReceiveResult> {
    const submission = this.state.submission;
    if (submission === undefined) {
      throw new AgentError("RECOVERY_REQUIRED", "No submission is available for recovery");
    }
    if (submission.state === "answered") {
      const content = await this.requireArtifacts().get("response", submission.turnId);
      return {
        contractVersion: "model-transport/v1",
        taskId: this.state.taskId,
        turnId: submission.turnId,
        submissionId: submission.submissionId,
        ...(this.state.transportConversationId === undefined
          ? {}
          : { expectedConversationId: this.state.transportConversationId }),
        observedAt: submission.answeredAt ?? this.now(),
        status: "completed",
        responseId: `recovered_${submission.turnId}`,
        content,
      };
    }

    const content = await this.requireArtifacts().get("outbox", submission.submissionId);
    let receipt = await this.dependencies.transport.resolveSubmission(
      {
        taskId: this.state.taskId,
        turnId: submission.turnId,
        submissionId: submission.submissionId,
        ...(this.state.transportConversationId === undefined
          ? {}
          : { expectedConversationId: this.state.transportConversationId }),
      },
      { signal: this.controller.signal },
    );
    if (receipt.status === "not-submitted") {
      receipt = await this.dependencies.transport.submit(
        {
          taskId: this.state.taskId,
          turnId: submission.turnId,
          submissionId: submission.submissionId,
          content,
          ...(this.state.transportConversationId === undefined
            ? {}
            : { expectedConversationId: this.state.transportConversationId }),
        },
        { signal: this.controller.signal },
      );
    }
    receipt = await this.resolveReceipt(receipt, content);
    if (receipt.status !== "submitted") {
      throw new AgentError("TRANSPORT_INDETERMINATE", "Recovery could not prove submission delivery", {
        status: receipt.status,
      });
    }
    this.bindConversation(receipt);
    this.state.submission = {
      ...submission,
      state: "submitted",
      submittedAt: receipt.observedAt,
    };
    await this.persist();
    return this.receiveAndRecord(receipt, submission.turnId, submission.submissionId);
  }

  private async queueOutbound(content: string, turnId: string): Promise<void> {
    const artifactId = `queued_${turnId}`;
    await this.dependencies.artifacts?.put("outbox", artifactId, content);
    this.state.queuedOutbound = {
      turnId,
      artifactId,
      messageHash: sha256(content),
      createdAt: this.now(),
    };
    await this.persist();
  }

  private bindConversation(receipt: SubmissionReceipt): void {
    if (receipt.conversationId === undefined) return;
    if (
      this.state.transportConversationId !== undefined &&
      this.state.transportConversationId !== receipt.conversationId
    ) {
      throw new AgentError("TRANSPORT_INDETERMINATE", "Transport conversation changed during the active task", {
        expectedConversationId: this.state.transportConversationId,
        actualConversationId: receipt.conversationId,
      });
    }
    this.state.transportConversationId = receipt.conversationId;
  }

  private async readQueuedOutbound(): Promise<string> {
    const queued = this.state.queuedOutbound;
    if (queued === undefined) throw new AgentError("RECOVERY_REQUIRED", "No queued message exists");
    const content = await this.requireArtifacts().get("outbox", queued.artifactId);
    if (sha256(content) !== queued.messageHash) {
      throw new AgentError("RECOVERY_REQUIRED", "Queued message hash does not match session state");
    }
    return content;
  }

  private requireArtifacts(): SessionArtifactStore {
    if (this.dependencies.artifacts === undefined) {
      throw new AgentError("RECOVERY_REQUIRED", "Source-bearing recovery storage is unavailable");
    }
    return this.dependencies.artifacts;
  }

  private async cleanupTerminalArtifacts(): Promise<void> {
    if (this.dependencies.retainSourceArtifactsOnCompletion !== true) {
      await this.dependencies.artifacts?.clear();
    }
  }

  private async resolveReceipt(receipt: SubmissionReceipt, content: string): Promise<SubmissionReceipt> {
    if (receipt.status !== "indeterminate") return receipt;
    if (this.state.submission) {
      this.state.submission = { ...this.state.submission, state: "indeterminate" };
      await this.persist();
    }
    const resolved = await this.dependencies.transport.resolveSubmission(
      {
        taskId: receipt.taskId,
        turnId: receipt.turnId,
        submissionId: receipt.submissionId,
        ...(this.state.transportConversationId === undefined
          ? {}
          : { expectedConversationId: this.state.transportConversationId }),
      },
      { signal: this.controller.signal },
    );
    if (resolved.status === "not-submitted") {
      return this.dependencies.transport.submit(
        {
          taskId: receipt.taskId,
          turnId: receipt.turnId,
          submissionId: receipt.submissionId,
          content,
          ...(this.state.transportConversationId === undefined
            ? {}
            : { expectedConversationId: this.state.transportConversationId }),
        },
        { signal: this.controller.signal },
      );
    }
    return resolved;
  }

  private async handleAction(
    action: NormalizedModelMessage,
    turnId: string,
  ): Promise<{ readonly terminal: false; readonly outbound: string } | { readonly terminal: true; readonly result: AgentRunResult }> {
    switch (action.type) {
      case "tool_request": {
        await this.move("executing_tools");
        const outcomes = await this.executeCalls(action.calls, turnId);
        await this.move("returning_results");
        const outbound = await this.serializeForDisclosure(
          this.dependencies.protocol.renderToolOutcomes({ taskId: this.state.taskId, priorTurnId: turnId, outcomes }),
          "tool_result",
        );
        await this.move("awaiting_model");
        return { terminal: false, outbound };
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
          }),
        );
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
          }),
        );
        const userDecision = capabilityDecision(decisionRecord);
        let granted = false;
        if (userDecision.decision === "allow_session") {
          granted = await this.dependencies.policy.expandSessionGrant(action.capability);
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
        const repository = await this.dependencies.tools.inspectCompletionState();
        const verification = verifyCompletion(
          this.state,
          action.claim,
          repository,
          this.dependencies.completionRequirements,
        );
        this.lastCompletion = verification;
        const completionHandoff = verification.accepted
          ? await this.dependencies.completionHandoffs?.save(action.claim, verification, this.now())
          : undefined;
        if (completionHandoff !== undefined) {
          this.state.completionHandoff = completionHandoff;
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
    const alreadyAccounted = this.state.completedOperationIds.includes(requestId);
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
    const executing = await this.dependencies.journal.markExecuting(registration.record, this.now());
    await this.dependencies.audit.append({
      type: "user.requested",
      taskId: this.state.taskId,
      turnId,
      operationId: requestId,
      data: { tool, requestHash: registration.record.requestHash },
    });
    const cached = await this.dependencies.artifacts?.getOptional("decision", artifactId);
    const decision = cached === undefined
      ? await requester()
      : parseDecisionArtifact(cached);
    if (cached === undefined) {
      await this.requireArtifacts().put("decision", artifactId, stableJson(decision));
    }
    const decisionHash = sha256(stableJson(decision));
    await this.dependencies.journal.markCompleted(
      executing,
      this.now(),
      "answered",
      { decisionHash },
    );
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
    if (calls.length > 1 && calls.some((call) => !READ_ONLY_TOOLS.has(call.name))) {
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
      outcomes.push(await this.executeCall(call, turnId));
    }
    return outcomes;
  }

  private async serializeForDisclosure(
    message: string,
    kind: "bootstrap" | "tool_result" | "repair" | "decision",
  ): Promise<string> {
    // Reserve against the unredacted upper bound before source-bearing data is
    // handed to the final disclosure guard. The exact serialized size is then
    // charged once, at the browser boundary, rather than per intermediate tool.
    this.meter.assertCanConsume("disclosedBytes", Buffer.byteLength(message));
    const serialized = await this.dependencies.disclosure.inspectAndSerialize(message, { kind });
    const disclosedBytes = Buffer.byteLength(serialized);
    this.meter.assertCanConsume("disclosedBytes", disclosedBytes);
    this.meter.consume("disclosedBytes", disclosedBytes);
    await this.dependencies.audit.append({
      type: "disclosure.recorded",
      taskId: this.state.taskId,
      data: { kind, disclosedBytes, sha256: sha256(serialized) },
    });
    return serialized;
  }

  private async executeCall(call: NormalizedToolCall, turnId: string): Promise<ToolOutcome> {
    const mutating = !READ_ONLY_TOOLS.has(call.name);
    const operationAlreadyAccounted =
      this.state.completedOperationIds.includes(call.operationId) ||
      this.state.pendingOperations.some((operation) => operation.operationId === call.operationId);
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
      const outcome = outcomeFromRecord(call, registration.record);
      if (registration.record.status === "completed") {
        await this.recordToolEffects(call, outcome, turnId);
      }
      this.clearPending(call.operationId);
      if (!this.state.completedOperationIds.includes(call.operationId)) {
        this.state.completedOperationIds.push(call.operationId);
      }
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

    await this.dependencies.audit.append({
      type: "tool.requested",
      taskId: this.state.taskId,
      turnId,
      operationId: call.operationId,
      data: { tool: call.name, requestHash: registration.record.requestHash },
    });
    const policy = await this.dependencies.policy.authorize(call);
    await this.dependencies.audit.append({
      type: "policy.decision",
      taskId: this.state.taskId,
      turnId,
      operationId: call.operationId,
      data: { tool: call.name, ...policy },
    });
    let allowed = policy.outcome === "allow";
    if (policy.outcome === "ask") {
      await this.move("awaiting_user", policy.explanation);
      await this.dependencies.audit.append({
        type: "capability.requested",
        taskId: this.state.taskId,
        turnId,
        operationId: call.operationId,
        data: { reasonCode: policy.reasonCode, capability: policy.capability },
      });
      const decisionArtifactId = `decision_policy_${call.operationId}`;
      const cachedDecision = await this.dependencies.artifacts?.getOptional("decision", decisionArtifactId);
      const decision = cachedDecision === undefined
        ? await this.dependencies.user.requestCapability({
            capability: policy.capability,
            reason: policy.explanation,
          })
        : capabilityDecision(parseDecisionArtifact(cachedDecision));
      if (cachedDecision === undefined) {
        await this.requireArtifacts().put("decision", decisionArtifactId, stableJson(decision));
      }
      if (decision.decision === "allow_session") {
        allowed = await this.dependencies.policy.expandSessionGrant(policy.capability);
      } else {
        allowed = decision.decision === "allow_once";
      }
      await this.dependencies.audit.append({
        type: "capability.decided",
        taskId: this.state.taskId,
        turnId,
        operationId: call.operationId,
        data: { decision: decision.decision, effective: allowed },
      });
      await this.move("executing_tools");
    }
    if (!allowed) {
      const failed = await this.dependencies.journal.markFailed(
        registration.record,
        this.now(),
        policy.outcome === "ask" ? "denied_after_ask" : policy.outcome,
        { reasonCode: policy.reasonCode },
      );
      this.clearPending(call.operationId);
      if (!this.state.completedOperationIds.includes(call.operationId)) {
        this.state.completedOperationIds.push(call.operationId);
      }
      await this.persist();
      return {
        operationId: call.operationId,
        tool: call.name,
        status: "denied",
        data: { code: policy.reasonCode, decision: policy.outcome, message: policy.explanation },
        safeMetadata: failed.safeResult ?? {},
      };
    }

    if (call.name === "run_command") this.meter.consume("commands");
    if (call.name === "read_file") this.meter.consume("readFiles");
    const executing = await this.dependencies.journal.markExecuting(registration.record, this.now());
    this.setPending(call, executing, "executing");
    await this.persist();
    let operationWasCommitted = false;
    try {
      const outcome = await this.dependencies.tools.execute(call, this.controller.signal);
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
      await this.dependencies.journal.markCompleted(
        executing,
        this.now(),
        outcome.status,
        outcome.safeMetadata,
      );
      operationWasCommitted = true;
      if (!this.state.completedOperationIds.includes(call.operationId)) {
        this.state.completedOperationIds.push(call.operationId);
      }
      this.clearPending(call.operationId);
      await this.recordToolEffects(call, outcome, turnId);
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
        if (!this.state.completedOperationIds.includes(call.operationId)) {
          this.state.completedOperationIds.push(call.operationId);
        }
        await this.persist();
        throw error;
      }
      const safe = { errorCode: error instanceof AgentError ? error.code : "INTERNAL_ERROR", message: errorMessage(error) };
      await this.dependencies.journal.markFailed(executing, this.now(), "failure", safe);
      this.clearPending(call.operationId);
      if (!this.state.completedOperationIds.includes(call.operationId)) {
        this.state.completedOperationIds.push(call.operationId);
      }
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
    call: NormalizedToolCall,
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

  private async recordToolEffects(
    call: NormalizedToolCall,
    outcome: ToolOutcome,
    turnId: string,
  ): Promise<void> {
    const metadata = outcome.safeMetadata;
    if (
      call.name === "apply_patch" &&
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
      this.meter.consume("changedFiles", changedFiles);
      this.meter.consume("changedLines", changedLines);
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
      if (outputBytes > 0) this.meter.consume("commandOutputBytes", outputBytes);
    }
  }

  private async handleTransportResult(result: Exclude<ReceiveResult, { status: "completed" }>): Promise<AgentRunResult | undefined> {
    if (result.status === "cancelled") return this.abort(result.diagnosticCode);
    if (result.status === "blocked" && !result.retryable) {
      await this.move("blocked", result.reason);
      return this.result(result.reason);
    }
    if (result.status === "blocked" || result.status === "timed-out") {
      await this.move("paused", result.status === "blocked" ? result.reason : result.diagnosticCode);
      return this.result(result.status === "blocked" ? result.reason : result.diagnosticCode);
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

  private async finishInterruption(): Promise<AgentRunResult> {
    const interruption = this.interruption ?? {
      status: "aborted" as const,
      reason: "User or caller cancelled the session",
    };
    if (interruption.status === "aborted") return this.abort(interruption.reason);
    if (["completed", "rolled_back", "blocked", "aborted", "failed"].includes(this.state.status)) {
      return this.result(interruption.reason);
    }
    if (this.state.status !== "paused") await this.move("paused", interruption.reason);
    return this.result(interruption.reason);
  }

  private async fail(error: unknown): Promise<AgentRunResult> {
    const message = errorMessage(error);
    if (!["completed", "rolled_back", "blocked", "aborted", "failed"].includes(this.state.status)) {
      transitionSession(this.state, "failed", this.now(), {
        reason: message,
        failure: { code: error instanceof AgentError ? error.code : "INTERNAL_ERROR", message },
      });
      await this.persist();
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
    transitionSession(this.state, status, this.now(), reason === undefined ? {} : { reason });
    await this.persist();
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
    return {
      status: this.state.status,
      sessionId: this.state.sessionId,
      taskId: this.state.taskId,
      ...(this.lastCompletion === undefined ? {} : { completion: this.lastCompletion }),
      ...(this.finalModelSummary === undefined ? {} : { modelSummary: this.finalModelSummary }),
      ...(this.finalModelReport === undefined ? {} : { modelReport: this.finalModelReport }),
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

function outcomeFromRecord(call: NormalizedToolCall, record: OperationRecord): ToolOutcome {
  const status = record.status === "completed" && record.outcome === "success" ? "success" : "failure";
  return {
    operationId: call.operationId,
    tool: call.name,
    status,
    data: { replayed: true, outcome: record.outcome, ...(record.safeResult ?? {}) },
    safeMetadata: { replayed: true, ...(record.safeResult ?? {}) },
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
