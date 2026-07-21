import { setTimeout as delay } from "node:timers/promises";

import { sha256 } from "../shared/crypto.js";
import { AgentError } from "../shared/errors.js";
import { isoNow, systemClock, type Clock } from "../shared/time.js";
import {
  MODEL_TRANSPORT_CONTRACT_VERSION,
  assertValidCorrelation,
  type ModelTransport,
  type ReceiveRequest,
  type ReceiveResult,
  type SubmissionReceipt,
  type SubmissionRequest,
  type SubmissionResolutionRequest,
  type TransportBlockReason,
  type TransportCallOptions,
} from "../transport/model-transport.js";
import {
  classifyCopilotPage,
  groupMatches,
  observeCopilotPage,
  type PageClassification,
} from "./classifier.js";
import {
  conversationIdFromUrl,
  isApprovedUrl,
  validateBrowserConfig,
  type CopilotBrowserAdapterConfig,
} from "./config.js";
import type { CopilotPageObservation, SemanticPage } from "./contracts.js";
import { minimalBrowserDiagnostic, type MinimalBrowserDiagnostic } from "./diagnostics.js";
import {
  assertKillSwitchEnabled,
  MutableBrowserKillSwitch,
  type BrowserKillSwitch,
} from "./kill-switch.js";

const TASK_MARKER_PREFIX = "[[COPILOT_AGENT_TASK_V1:";
const TASK_MARKER_SUFFIX = "]]";

interface SubmissionRecord {
  readonly taskId: string;
  readonly turnId: string;
  readonly submissionId: string;
  readonly contentSha256: string;
  readonly marker: string;
  readonly conversationId: string;
  readonly baselineResponseCount: number;
  readonly baselineLastResponseSha256: string | undefined;
  readonly baselineKnown: boolean;
  activationAttempted: boolean;
  receipt: SubmissionReceipt;
}

interface SubmissionIdentity {
  readonly taskId: string;
  readonly turnId: string;
  readonly contentSha256: string;
}

interface ResponseBaseline {
  readonly responseCount: number;
  readonly lastResponseSha256?: string;
}

interface RecoveredTaskMarker {
  readonly marker: string;
  readonly baseline?: ResponseBaseline;
}

interface ObservedPageState {
  readonly observation: CopilotPageObservation;
  readonly classification: PageClassification;
}

export interface BrowserStateInspection {
  readonly classification: PageClassification;
  readonly diagnostic: MinimalBrowserDiagnostic;
}

export interface BrowserAdapterDependencies {
  readonly clock?: Clock;
  readonly killSwitch?: BrowserKillSwitch;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly monotonicNow?: () => number;
}

/**
 * Microsoft 365 Copilot-specific interaction logic. It depends only on the
 * internal semantic page interface and is fully testable without Edge.
 */
export class CopilotBrowserAdapter implements ModelTransport {
  public readonly transportKind = "m365-copilot-browser/v1";

  readonly #page: SemanticPage;
  readonly #config: CopilotBrowserAdapterConfig;
  readonly #clock: Clock;
  readonly #killSwitch: BrowserKillSwitch;
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly #monotonicNow: () => number;
  readonly #records = new Map<string, SubmissionRecord>();
  readonly #submissionIdentities = new Map<string, SubmissionIdentity>();
  readonly #taskConversations = new Map<string, string>();
  #stopped = false;
  #closed = false;

  public constructor(
    page: SemanticPage,
    config: CopilotBrowserAdapterConfig,
    dependencies: BrowserAdapterDependencies = {},
  ) {
    validateBrowserConfig(config);
    this.#page = page;
    this.#config = config;
    this.#clock = dependencies.clock ?? systemClock;
    this.#killSwitch = dependencies.killSwitch ?? new MutableBrowserKillSwitch();
    this.#sleep = dependencies.sleep ?? sleepWithAbort;
    this.#monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  }

  public async inspectState(): Promise<BrowserStateInspection> {
    this.#assertUsable();
    const { observation, classification } = await this.#observe();
    return this.#inspection(observation, classification);
  }

  /** Waits for the user to complete sign-in, MFA, or consent; never interacts with those controls. */
  public async waitForManualReadiness(
    maxWaitMs = this.#config.waits.manualReadinessMs,
    signal?: AbortSignal,
  ): Promise<BrowserStateInspection> {
    const boundedWait = Math.min(maxWaitMs, this.#config.waits.manualReadinessMs);
    if (!Number.isFinite(boundedWait) || boundedWait <= 0) {
      throw new TypeError("Manual readiness wait must be positive and bounded");
    }
    const deadline = this.#monotonicNow() + boundedWait;
    let observed = await this.#observe();
    let inspection = this.#inspection(observed.observation, observed.classification);
    while (inspection.classification.state !== "ready" && this.#monotonicNow() < deadline) {
      const approvedManualAuthenticationRedirect =
        inspection.classification.state === "unapproved-host" &&
        isApprovedUrl(
          observed.observation.url,
          this.#config.manualAuthenticationHosts ?? [],
        );
      if (
        inspection.classification.state === "changed-selector" ||
        (inspection.classification.state === "unapproved-host" &&
          !approvedManualAuthenticationRedirect) ||
        inspection.classification.state === "identity-unverified" ||
        inspection.classification.state === "protection-unverified" ||
        inspection.classification.state === "blocking-modal"
      ) {
        return inspection;
      }
      await this.#boundedSleep(deadline, signal);
      observed = await this.#observe();
      inspection = this.#inspection(observed.observation, observed.classification);
    }
    return inspection;
  }

  public async submit(
    request: SubmissionRequest,
    options: TransportCallOptions = {},
  ): Promise<SubmissionReceipt> {
    this.#assertUsable(options.signal);
    assertValidCorrelation(request);
    this.#validateContent(request.content);
    this.#registerSubmissionIdentity(request);

    const existing = this.#records.get(request.submissionId);
    if (existing !== undefined) {
      this.#assertRecordMatches(existing, request, true);
      if (existing.receipt.status === "submitted") return existing.receipt;
      if (existing.receipt.status === "indeterminate") {
        const resolved = await this.resolveSubmission(request, options);
        if (resolved.status !== "not-submitted") return resolved;
      }
      // A repeated call is an explicit retry and is only allowed after the
      // prior status is known to be not-submitted.
    }

    const first = await this.#observe();
    // The caller's signal is intentionally checked again after the trust
    // observation. The signal can change while page state is being sampled,
    // and no prompt content may be disclosed after that cancellation.
    this.#assertUsable(options.signal);
    if (first.classification.state !== "ready") {
      return this.#storeKnownNotSubmitted(request, first.classification.diagnosticCode);
    }
    const conversationId = conversationIdFromUrl(first.observation.url);
    if (
      request.expectedConversationId !== undefined &&
      request.expectedConversationId !== conversationId
    ) {
      return this.#storeKnownNotSubmitted(request, "CONVERSATION_MISMATCH", conversationId);
    }
    const establishedConversation = this.#taskConversations.get(request.taskId);
    if (
      establishedConversation !== undefined &&
      establishedConversation !== conversationId
    ) {
      return this.#storeKnownNotSubmitted(
        request,
        "TASK_CONVERSATION_MISMATCH",
        conversationId,
      );
    }

    const initialResponses = responseTexts(first.observation);
    const initialLastResponse = initialResponses.at(-1);
    const marker = createTaskMarker(request, {
      responseCount: initialResponses.length,
      ...(initialLastResponse === undefined ? {} : { lastResponseSha256: sha256(initialLastResponse) }),
    });
    const fullContent = `${request.content}\n\n${marker}`;
    const existingMarker = findTaskMarker(first.observation, request);
    if (existingMarker !== undefined) {
      const record = this.#createRecord(
        request,
        existingMarker.marker,
        conversationId,
        first.observation,
        existingMarker.baseline !== undefined,
        existingMarker.baseline,
      );
      record.receipt = this.#receipt(request, "submitted", conversationId, existingMarker.marker, "MARKER_RECOVERED");
      this.#records.set(request.submissionId, record);
      this.#taskConversations.set(request.taskId, conversationId);
      return record.receipt;
    }

    const record = this.#createRecord(
      request,
      marker,
      conversationId,
      first.observation,
      true,
    );
    this.#records.set(request.submissionId, record);
    const actionGuard = this.#actionGuard(options.signal);

    try {
      await this.#page.fill(
        this.#config.uiContract.groups.composer,
        fullContent,
        actionGuard,
      );
    } catch (error) {
      record.receipt = this.#receipt(
        request,
        "not-submitted",
        conversationId,
        marker,
        knownPreActivationDiagnostic(error) ?? "COMPOSER_FILL_FAILED",
      );
      return record.receipt;
    }

    // Trust assertions are deliberately repeated immediately before the one
    // consequential browser action.
    let second: ObservedPageState;
    try {
      second = await this.#observe();
      // Likewise, cancellation during the post-fill trust observation must
      // prevent the consequential send action.
      this.#assertUsable(options.signal);
    } catch {
      record.receipt = this.#receipt(
        request,
        "not-submitted",
        conversationId,
        marker,
        "PRE_SUBMISSION_ASSERTION_ABORTED",
      );
      return record.receipt;
    }
    if (
      second.classification.state !== "ready" ||
      conversationIdFromUrl(second.observation.url) !== conversationId
    ) {
      record.receipt = this.#receipt(
        request,
        "not-submitted",
        conversationId,
        marker,
        second.classification.state === "ready"
          ? "CONVERSATION_CHANGED_BEFORE_SUBMIT"
          : second.classification.diagnosticCode,
      );
      return record.receipt;
    }

    const strategy = this.#config.uiContract.submissionStrategy;
    if (strategy === "send-control") {
      const send = second.observation.send;
      if (
        !groupMatches(send, this.#config.uiContract.groups.send.minimumCandidateMatches) ||
        send.enabledElements === 0
      ) {
        record.activationAttempted = false;
        record.receipt = this.#receipt(
          request,
          "not-submitted",
          conversationId,
          marker,
          "SEND_CONTROL_NOT_ACTIONABLE",
        );
        return record.receipt;
      }
    }
    record.activationAttempted = true;
    this.#taskConversations.set(request.taskId, conversationId);
    try {
      if (strategy === "send-control") {
        await this.#page.click(this.#config.uiContract.groups.send, actionGuard);
      } else {
        await this.#page.press(
          this.#config.uiContract.groups.composer,
          "Enter",
          actionGuard,
        );
      }
    } catch (error) {
      const diagnosticCode = knownPreActivationDiagnostic(error);
      if (diagnosticCode !== undefined) {
        record.activationAttempted = false;
        if (establishedConversation === undefined) {
          this.#taskConversations.delete(request.taskId);
        }
        record.receipt = this.#receipt(
          request,
          "not-submitted",
          conversationId,
          marker,
          diagnosticCode,
        );
        return record.receipt;
      }
      // Playwright can throw after dispatch. Resolve only through page evidence.
    }

    record.receipt = await this.#confirmSubmission(record, options.signal);
    return record.receipt;
  }

  public async resolveSubmission(
    request: SubmissionResolutionRequest,
    options: TransportCallOptions = {},
  ): Promise<SubmissionReceipt> {
    this.#assertUsable(options.signal);
    assertValidCorrelation(request);
    this.#assertKnownCorrelation(request);
    const record = this.#records.get(request.submissionId);
    if (record !== undefined) this.#assertRecordMatches(record, request, false);
    if (record?.receipt.status === "submitted") return record.receipt;

    const state = await this.#observe();
    const recoveredMarker = record === undefined ? findTaskMarker(state.observation, request) : undefined;
    const marker = record?.marker ?? recoveredMarker?.marker ?? createTaskMarker(request);
    if (state.classification.state === "unapproved-host") {
      return this.#receipt(request, "indeterminate", undefined, marker, "HOST_NOT_APPROVED");
    }
    const conversationId = conversationIdFromUrl(state.observation.url);
    if (
      request.expectedConversationId !== undefined &&
      request.expectedConversationId !== conversationId
    ) {
      return this.#receipt(
        request,
        "indeterminate",
        conversationId,
        marker,
        "CONVERSATION_MISMATCH",
      );
    }
    if (record !== undefined && record.conversationId !== conversationId) {
      return this.#receipt(
        request,
        "indeterminate",
        conversationId,
        marker,
        "CONVERSATION_CHANGED_AFTER_ATTEMPT",
      );
    }
    if (record !== undefined ? containsMarker(state.observation, marker) : recoveredMarker !== undefined) {
      const receipt = this.#receipt(request, "submitted", conversationId, marker, "MARKER_CONFIRMED");
      this.#taskConversations.set(request.taskId, conversationId);
      if (record !== undefined) record.receipt = receipt;
      else {
        const recovered = this.#createRecord(
          { ...request, content: "" },
          marker,
          conversationId,
          state.observation,
          recoveredMarker?.baseline !== undefined,
          recoveredMarker?.baseline,
        );
        recovered.receipt = receipt;
        this.#records.set(request.submissionId, recovered);
      }
      return receipt;
    }
    if (record === undefined) {
      return this.#receipt(
        request,
        "indeterminate",
        conversationId,
        marker,
        "NO_LOCAL_SUBMISSION_RECORD",
      );
    }
    if (!record.activationAttempted) {
      record.receipt = this.#receipt(
        request,
        "not-submitted",
        conversationId,
        marker,
        "ACTIVATION_NOT_ATTEMPTED",
      );
      return record.receipt;
    }
    record.receipt = this.#receipt(
      request,
      "indeterminate",
      conversationId,
      marker,
      "SUBMISSION_EVIDENCE_INCONCLUSIVE",
    );
    return record.receipt;
  }

  public async receive(
    request: ReceiveRequest,
    options: TransportCallOptions = {},
  ): Promise<ReceiveResult> {
    if (isAborted(options.signal)) return this.#cancelled(request, "ABORTED");
    try {
      this.#assertUsable(options.signal);
      assertValidCorrelation(request);
      this.#assertKnownCorrelation(request);
    } catch (error) {
      if (this.#stopped || !this.#killSwitch.status().enabled) {
        return this.#cancelled(request, "KILL_SWITCH");
      }
      throw error;
    }

    const record = this.#records.get(request.submissionId);
    if (record !== undefined) this.#assertRecordMatches(record, request, false);
    const resolution = await this.resolveSubmission(request, options);
    if (resolution.status !== "submitted") {
      return this.#receiveBase(request, {
        status: "blocked",
        reason: "submission-unresolved",
        retryable: resolution.status === "not-submitted",
        diagnosticCode: resolution.diagnosticCode ?? "SUBMISSION_UNRESOLVED",
      }, resolution.conversationId);
    }

    const activeRecord = this.#records.get(request.submissionId);
    if (activeRecord === undefined || !activeRecord.baselineKnown) {
      return this.#receiveBase(request, {
        status: "indeterminate",
        diagnosticCode: "RESPONSE_BASELINE_UNKNOWN",
      }, resolution.conversationId);
    }
    const maxWaitMs = Math.min(
      request.maxWaitMs ?? this.#config.waits.responseMs,
      this.#config.waits.responseMs,
    );
    if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0) {
      throw new TypeError("Response wait must be positive and bounded");
    }
    const deadline = this.#monotonicNow() + maxWaitMs;
    let lastCandidateSha: string | undefined;
    let stableSamples = 0;
    let stableSince = this.#monotonicNow();
    let sawCandidate = false;

    while (this.#monotonicNow() < deadline) {
      if (isAborted(options.signal)) return this.#cancelled(request, "ABORTED");
      if (this.#stopped || !this.#killSwitch.status().enabled) {
        return this.#cancelled(request, "KILL_SWITCH");
      }
      let state: ObservedPageState;
      try {
        state = await this.#observe();
      } catch {
        if (this.#stopped || !this.#killSwitch.status().enabled) {
          return this.#cancelled(request, "KILL_SWITCH");
        }
        return this.#receiveBase(request, {
          status: "indeterminate",
          diagnosticCode: "PAGE_OBSERVATION_FAILED",
        }, activeRecord.conversationId);
      }
      const conversationId = conversationIdFromUrl(state.observation.url);
      if (conversationId !== activeRecord.conversationId) {
        return this.#receiveBase(request, {
          status: "indeterminate",
          diagnosticCode: "CONVERSATION_CHANGED_DURING_RESPONSE",
        }, conversationId);
      }
      if (
        state.classification.state !== "ready" &&
        state.classification.state !== "streaming"
      ) {
        return this.#blockedForClassification(request, state.classification, conversationId);
      }
      if (!containsMarker(state.observation, activeRecord.marker)) {
        return this.#receiveBase(request, {
          status: "indeterminate",
          diagnosticCode: "TASK_MARKER_NOT_OBSERVED",
        }, conversationId);
      }

      const candidate = associatedResponse(state.observation, activeRecord);
      if (candidate !== undefined) {
        sawCandidate = true;
        if (candidate.length > this.#config.maxResponseChars) {
          return this.#receiveBase(request, {
            status: "indeterminate",
            diagnosticCode: "RESPONSE_EXCEEDS_BOUND",
          }, conversationId);
        }
        const candidateSha = sha256(candidate);
        if (candidateSha === lastCandidateSha) {
          stableSamples += 1;
        } else {
          lastCandidateSha = candidateSha;
          stableSamples = 1;
          stableSince = this.#monotonicNow();
        }
        const stable =
          stableSamples >= this.#config.waits.stableSamples &&
          this.#monotonicNow() - stableSince >= this.#config.waits.minimumStableMs;
        const notStreaming = state.observation.streaming.visibleElements === 0;
        const composerAvailable = state.observation.composer.enabledElements > 0;
        // Four independent signals: correlated response, stable content,
        // streaming ended, and composer available for the next turn.
        if (stable && notStreaming && composerAvailable) {
          return this.#receiveBase(request, {
            status: "completed",
            responseId: `copilot-response:${sha256(`${request.submissionId}:${candidate}`).slice(0, 24)}`,
            content: candidate,
          }, conversationId);
        }
      }
      try {
        await this.#boundedSleep(deadline, options.signal);
      } catch {
        return this.#cancelled(request, "ABORTED");
      }
    }
    return this.#receiveBase(request, {
      status: "timed-out",
      diagnosticCode: sawCandidate ? "RESPONSE_INCOMPLETE" : "NO_RESPONSE",
    }, activeRecord.conversationId);
  }

  public async emergencyStop(_reason: string): Promise<void> {
    this.#stopped = true;
    if (this.#killSwitch instanceof MutableBrowserKillSwitch) {
      this.#killSwitch.disable("OPERATOR_KILL_SWITCH");
    }
  }

  public async close(): Promise<void> {
    this.#closed = true;
  }

  async #confirmSubmission(record: SubmissionRecord, signal?: AbortSignal): Promise<SubmissionReceipt> {
    const deadline = this.#monotonicNow() + this.#config.waits.submissionConfirmationMs;
    while (this.#monotonicNow() < deadline) {
      if (signal?.aborted === true || this.#stopped || !this.#killSwitch.status().enabled) {
        return this.#receipt(
          record,
          "indeterminate",
          record.conversationId,
          record.marker,
          "SUBMISSION_CONFIRMATION_CANCELLED",
        );
      }
      let state: ObservedPageState;
      try {
        state = await this.#observe();
      } catch {
        return this.#receipt(
          record,
          "indeterminate",
          record.conversationId,
          record.marker,
          "SUBMISSION_CONFIRMATION_INTERRUPTED",
        );
      }
      if (conversationIdFromUrl(state.observation.url) !== record.conversationId) {
        return this.#receipt(
          record,
          "indeterminate",
          record.conversationId,
          record.marker,
          "CONVERSATION_CHANGED_AFTER_ACTIVATION",
        );
      }
      if (containsMarker(state.observation, record.marker)) {
        return this.#receipt(
          record,
          "submitted",
          record.conversationId,
          record.marker,
          "MARKER_CONFIRMED",
        );
      }
      if (state.classification.state === "unapproved-host") {
        return this.#receipt(
          record,
          "indeterminate",
          record.conversationId,
          record.marker,
          "HOST_CHANGED_AFTER_ACTIVATION",
        );
      }
      await this.#boundedSleep(deadline, signal).catch(() => undefined);
    }
    return this.#receipt(
      record,
      "indeterminate",
      record.conversationId,
      record.marker,
      "SUBMISSION_CONFIRMATION_INCONCLUSIVE",
    );
  }

  async #observe(): Promise<ObservedPageState> {
    this.#assertUsable();
    const observation = await observeCopilotPage(this.#page, this.#config.uiContract);
    this.#assertUsable();
    const classification = classifyCopilotPage(
      observation,
      this.#config.uiContract,
      this.#config,
    );
    return { observation, classification };
  }

  #inspection(
    observation: CopilotPageObservation,
    classification: PageClassification,
  ): BrowserStateInspection {
    return {
      classification,
      diagnostic: minimalBrowserDiagnostic(observation, this.#config.uiContract, classification),
    };
  }

  #createRecord(
    request: SubmissionRequest,
    marker: string,
    conversationId: string,
    observation: CopilotPageObservation,
    baselineKnown: boolean,
    recoveredBaseline?: ResponseBaseline,
  ): SubmissionRecord {
    const responses = responseTexts(observation);
    const lastResponse = responses.at(-1);
    return {
      taskId: request.taskId,
      turnId: request.turnId,
      submissionId: request.submissionId,
      contentSha256: sha256(request.content),
      marker,
      conversationId,
      baselineResponseCount: recoveredBaseline?.responseCount ?? responses.length,
      baselineLastResponseSha256: recoveredBaseline === undefined
        ? (lastResponse === undefined ? undefined : sha256(lastResponse))
        : recoveredBaseline.lastResponseSha256,
      baselineKnown,
      activationAttempted: false,
      receipt: this.#receipt(request, "not-submitted", conversationId, marker, "NOT_ACTIVATED"),
    };
  }

  #storeKnownNotSubmitted(
    request: SubmissionRequest,
    diagnosticCode: string,
    conversationId?: string,
  ): SubmissionReceipt {
    const marker = createTaskMarker(request);
    const receipt = this.#receipt(
      request,
      "not-submitted",
      conversationId,
      marker,
      diagnosticCode,
    );
    if (conversationId !== undefined) {
      this.#records.set(request.submissionId, {
        taskId: request.taskId,
        turnId: request.turnId,
        submissionId: request.submissionId,
        contentSha256: sha256(request.content),
        marker,
        conversationId,
        baselineResponseCount: 0,
        baselineLastResponseSha256: undefined,
        baselineKnown: false,
        activationAttempted: false,
        receipt,
      });
    }
    return receipt;
  }

  #receipt(
    correlation: Pick<SubmissionResolutionRequest, "taskId" | "turnId" | "submissionId">,
    status: SubmissionReceipt["status"],
    conversationId: string | undefined,
    marker: string,
    diagnosticCode: string,
  ): SubmissionReceipt {
    const base = {
      contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
      taskId: correlation.taskId,
      turnId: correlation.turnId,
      submissionId: correlation.submissionId,
      status,
      observedAt: isoNow(this.#clock),
      transportMarker: marker,
      diagnosticCode,
    } as const;
    return conversationId === undefined ? base : { ...base, conversationId };
  }

  #receiveBase(
    request: ReceiveRequest,
    payload:
      | Omit<Extract<ReceiveResult, { readonly status: "completed" }>, CommonReceiveKeys>
      | Omit<Extract<ReceiveResult, { readonly status: "blocked" }>, CommonReceiveKeys>
      | Omit<Extract<ReceiveResult, { readonly status: "timed-out" }>, CommonReceiveKeys>
      | Omit<Extract<ReceiveResult, { readonly status: "indeterminate" }>, CommonReceiveKeys>,
    conversationId?: string,
  ): ReceiveResult {
    const base = {
      contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
      taskId: request.taskId,
      turnId: request.turnId,
      submissionId: request.submissionId,
      observedAt: isoNow(this.#clock),
    } as const;
    return (conversationId === undefined
      ? { ...base, ...payload }
      : { ...base, conversationId, ...payload }) as ReceiveResult;
  }

  #cancelled(
    request: ReceiveRequest,
    diagnosticCode: "ABORTED" | "KILL_SWITCH",
  ): ReceiveResult {
    return {
      contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
      taskId: request.taskId,
      turnId: request.turnId,
      submissionId: request.submissionId,
      observedAt: isoNow(this.#clock),
      status: "cancelled",
      diagnosticCode,
    };
  }

  #blockedForClassification(
    request: ReceiveRequest,
    classification: PageClassification,
    conversationId: string,
  ): ReceiveResult {
    const reason = blockReason(classification.state);
    return this.#receiveBase(request, {
      status: "blocked",
      reason,
      retryable: classification.retryable,
      diagnosticCode: classification.diagnosticCode,
    }, conversationId);
  }

  #validateContent(content: string): void {
    if (content.length === 0 || content.length > this.#config.maxMessageChars) {
      throw new AgentError("PROTOCOL_INVALID", "Transport message is empty or exceeds its bound", {
        contentLength: content.length,
        maximumLength: this.#config.maxMessageChars,
      });
    }
    if (content.includes(TASK_MARKER_PREFIX)) {
      throw new AgentError("PROTOCOL_INVALID", "Transport message contains a reserved marker");
    }
  }

  #registerSubmissionIdentity(request: SubmissionRequest): void {
    const prior = this.#submissionIdentities.get(request.submissionId);
    const identity: SubmissionIdentity = {
      taskId: request.taskId,
      turnId: request.turnId,
      contentSha256: sha256(request.content),
    };
    if (prior === undefined) {
      this.#submissionIdentities.set(request.submissionId, identity);
      return;
    }
    if (prior.taskId !== identity.taskId || prior.turnId !== identity.turnId) {
      throw new AgentError("DUPLICATE_OPERATION", "Submission id correlation changed", {
        submissionId: request.submissionId,
      });
    }
    if (prior.contentSha256 !== identity.contentSha256) {
      throw new AgentError("DUPLICATE_OPERATION", "Submission id content changed", {
        submissionId: request.submissionId,
      });
    }
  }

  #assertKnownCorrelation(request: SubmissionResolutionRequest | ReceiveRequest): void {
    const prior = this.#submissionIdentities.get(request.submissionId);
    if (prior !== undefined && (prior.taskId !== request.taskId || prior.turnId !== request.turnId)) {
      throw new AgentError("DUPLICATE_OPERATION", "Submission id correlation changed", {
        submissionId: request.submissionId,
      });
    }
  }

  #assertRecordMatches(
    record: SubmissionRecord,
    request: SubmissionResolutionRequest | SubmissionRequest | ReceiveRequest,
    checkContent: boolean,
  ): void {
    if (record.taskId !== request.taskId || record.turnId !== request.turnId) {
      throw new AgentError("DUPLICATE_OPERATION", "Submission id correlation changed", {
        submissionId: request.submissionId,
      });
    }
    if (checkContent && "content" in request && record.contentSha256 !== sha256(request.content)) {
      throw new AgentError("DUPLICATE_OPERATION", "Submission id content changed", {
        submissionId: request.submissionId,
      });
    }
  }

  #assertUsable(signal?: AbortSignal): void {
    if (signal?.aborted === true) throw signal.reason ?? new Error("Browser operation aborted");
    assertKillSwitchEnabled(this.#killSwitch);
    if (this.#stopped) {
      throw new AgentError("TRANSPORT_UNAVAILABLE", "Browser transport has been stopped");
    }
    if (this.#closed) {
      throw new AgentError("TRANSPORT_UNAVAILABLE", "Browser transport is closed");
    }
  }

  #actionGuard(signal?: AbortSignal): () => void {
    return () => {
      try {
        this.#assertUsable(signal);
      } catch (error) {
        throw new AgentError(
          "TRANSPORT_INDETERMINATE",
          "The browser action was cancelled before dispatch",
          {
            diagnosticCode: "PRE_SUBMISSION_ASSERTION_ABORTED",
            dispatchAttempted: false,
          },
          { cause: error },
        );
      }
    };
  }

  async #boundedSleep(deadline: number, signal?: AbortSignal): Promise<void> {
    const remaining = Math.max(0, deadline - this.#monotonicNow());
    await this.#sleep(Math.min(this.#config.waits.pollMs, remaining), signal);
  }
}

type CommonReceiveKeys =
  | "contractVersion"
  | "taskId"
  | "turnId"
  | "submissionId"
  | "observedAt"
  | "conversationId";

export function createTaskMarker(
  correlation: Pick<SubmissionResolutionRequest, "taskId" | "turnId" | "submissionId">,
  baseline?: ResponseBaseline,
): string {
  assertValidCorrelation(correlation);
  const encoded = Buffer.from(
    JSON.stringify([
      correlation.taskId,
      correlation.turnId,
      correlation.submissionId,
      ...(baseline === undefined
        ? []
        : [baseline.responseCount, baseline.lastResponseSha256 ?? null]),
    ]),
    "utf8",
  ).toString("base64url");
  return `${TASK_MARKER_PREFIX}${encoded}${TASK_MARKER_SUFFIX}`;
}

function knownPreActivationDiagnostic(error: unknown): string | undefined {
  if (!(error instanceof AgentError) || error.details.dispatchAttempted !== false) {
    return undefined;
  }
  const diagnosticCode = error.details.diagnosticCode;
  return typeof diagnosticCode === "string" && diagnosticCode.length > 0
    ? diagnosticCode
    : "PRE_ACTIVATION_GUARD_FAILED";
}

function responseTexts(observation: CopilotPageObservation): readonly string[] {
  return observation.responses.elements
    .map((element) => element.text.trim())
    .filter((text) => text.length > 0);
}

function associatedResponse(
  observation: CopilotPageObservation,
  record: SubmissionRecord,
): string | undefined {
  const responses = responseTexts(observation);
  const last = responses.at(-1);
  if (last === undefined) return undefined;
  if (responses.length > record.baselineResponseCount) return last;
  if (
    responses.length === record.baselineResponseCount &&
    record.baselineLastResponseSha256 !== sha256(last)
  ) {
    return last;
  }
  return undefined;
}

function containsMarker(observation: CopilotPageObservation, marker: string): boolean {
  return observation["user-messages"].elements.some((element) => element.text.includes(marker));
}

function findTaskMarker(
  observation: CopilotPageObservation,
  correlation: Pick<SubmissionResolutionRequest, "taskId" | "turnId" | "submissionId">,
): RecoveredTaskMarker | undefined {
  const pattern = /\[\[COPILOT_AGENT_TASK_V1:([A-Za-z0-9_-]+)\]\]/gu;
  for (const element of observation["user-messages"].elements) {
    for (const match of element.text.matchAll(pattern)) {
      const marker = match[0];
      const encoded = match[1];
      if (marker === undefined || encoded === undefined) continue;
      let value: unknown;
      try {
        value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
      } catch {
        continue;
      }
      if (
        !Array.isArray(value) ||
        (value.length !== 3 && value.length !== 5) ||
        value[0] !== correlation.taskId ||
        value[1] !== correlation.turnId ||
        value[2] !== correlation.submissionId
      ) continue;
      if (value.length === 3) return { marker };
      const responseCount = value[3];
      const lastResponseSha256 = value[4];
      if (
        typeof responseCount !== "number" ||
        !Number.isSafeInteger(responseCount) ||
        responseCount < 0 ||
        (lastResponseSha256 !== null &&
          (typeof lastResponseSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(lastResponseSha256)))
      ) continue;
      return {
        marker,
        baseline: {
          responseCount,
          ...(lastResponseSha256 === null ? {} : { lastResponseSha256 }),
        },
      };
    }
  }
  return undefined;
}

function blockReason(state: PageClassification["state"]): TransportBlockReason {
  switch (state) {
    case "sign-in-required":
    case "mfa-required":
    case "consent-required":
      return "authentication-required";
    case "identity-unverified":
      return "identity-unverified";
    case "protection-unverified":
      return "protection-unverified";
    case "unapproved-host":
      return "unapproved-host";
    case "throttled":
      return "throttled";
    case "service-error":
      return "service-error";
    case "blocking-modal":
      return "blocking-modal";
    case "changed-selector":
      return "transport-incompatible";
    case "streaming":
    case "ready":
    case "unknown":
      return "unknown";
  }
}

async function sleepWithAbort(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    await delay(milliseconds);
  } else {
    await delay(milliseconds, undefined, { signal });
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
