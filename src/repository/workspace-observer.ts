import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, opendir } from "node:fs/promises";
import path from "node:path";

import { AgentError } from "../shared/errors.js";
import { sha256 } from "../shared/crypto.js";
import { stableJson } from "../shared/crypto.js";
import type { RepositoryBoundary } from "./boundary.js";
import {
  GitInspector,
  type GitObservationEntry,
  type GitStatusEntry,
} from "./git.js";

export const WORKSPACE_OBSERVATION_CONTRACT =
  "terminal-workspace-observation/1" as const;
export const WORKSPACE_OBSERVATION_MAX_IMAGES = 200;
export const WORKSPACE_OBSERVATION_MAX_IMAGE_BYTES = 1024 * 1024;
export const WORKSPACE_OBSERVATION_MAX_RETAINED_BYTES = 3 * 1024 * 1024;
export const WORKSPACE_OBSERVATION_MAX_INDEX_MATERIAL_BYTES = 2 * 1024 * 1024;
export const WORKSPACE_OBSERVATION_MAX_PORCELAIN_BYTES = 1024 * 1024;
export const WORKSPACE_OBSERVATION_MAX_VISIBLE_ENTRIES = 25_000;
export const WORKSPACE_OBSERVATION_MAX_VISIBLE_CONTENT_BYTES = 256 * 1024 * 1024;
export const WORKSPACE_OBSERVATION_MAX_SERIALIZED_BYTES = 6 * 1024 * 1024;
export const WORKSPACE_OBSERVATION_ATTEMPT_TIMEOUT_MS = 20_000;
export const WORKSPACE_OBSERVATION_PHASE_TIMEOUT_MS = 40_000;
export const WORKSPACE_COMPARE_TIMEOUT_MS = 20_000;
export const WORKSPACE_OBSERVATION_MAX_ATTEMPTS = 2;
const WORKSPACE_COMPARE_MAX_TREE_CONTENT_READS = 64;
const WORKSPACE_NESTED_SCAN_MAX_ENTRIES = 100_000;
export const TERMINAL_RESULT_MAX_PATH_ENDPOINTS = 2_048;
export const TERMINAL_RESULT_MAX_PATH_BYTES = 256 * 1024;
export const TERMINAL_SESSION_MAX_PATH_ENDPOINTS = 256;
export const TERMINAL_SESSION_MAX_PATH_BYTES = 64 * 1024;

export type WorkspaceObservationPhase = "pre" | "post";
export type WorkspaceObservationState =
  | "complete"
  | "metadata_limited"
  | "protected_or_hidden_changed"
  | "unknown";

export interface WorkspaceFileIdentity {
  readonly path: string;
  readonly mode: number;
  readonly size: number;
  readonly mtimeNs?: string;
  readonly ctimeNs?: string;
  readonly device?: string;
  readonly fileId?: string;
}

export type WorkspaceBeforeImage =
  | {
      readonly kind: "absent";
      readonly exists: false;
      readonly path: string;
    }
  | {
      readonly kind: "retained";
      readonly exists: true;
      readonly identity: WorkspaceFileIdentity;
      readonly sha256: string;
      readonly binary: boolean;
      readonly contentBase64: string;
    }
  | {
      readonly kind: "git_blob";
      readonly exists: true;
      readonly identity: WorkspaceFileIdentity;
      readonly sha256: string;
      readonly binary: boolean;
      readonly blob: string;
      readonly blobRole: "head" | "index" | "odb";
    }
  | {
      readonly kind: "identity_only";
      readonly exists: true;
      readonly identity: WorkspaceFileIdentity;
      readonly sha256: string;
      readonly binary: boolean;
    };

export interface WorkspaceComponentFingerprints {
  readonly index: string;
  readonly visible: string;
  readonly excluded: string;
  readonly protectedWorktree: string;
  readonly gitTransitions: string;
  readonly gitControls: string;
}

export interface WorkspaceTransitionPathInventory {
  readonly paths: readonly string[];
  readonly total: number;
  readonly omitted: number;
  readonly truncated: boolean;
  readonly completeFactsSha256: string;
}

interface WorkspaceObservationBase {
  readonly contract: typeof WORKSPACE_OBSERVATION_CONTRACT;
  readonly phase: WorkspaceObservationPhase;
  readonly observedAt: string;
  readonly durationMs: number;
  readonly limitationCodes: readonly string[];
}

interface WorkspaceObservationFacts {
  readonly branch: string | null;
  readonly head: string | null;
  readonly components: WorkspaceComponentFingerprints;
  readonly entries: readonly GitObservationEntry[];
  readonly beforeImages: readonly WorkspaceBeforeImage[];
  readonly transitionPaths: WorkspaceTransitionPathInventory;
  readonly ignoredCount: number;
  readonly ignoredSummarySha256: string;
  readonly ignoredSummaryTruncated: boolean;
  readonly nestedRepository: "none" | "present" | "unknown";
}

export type WorkspaceObservation = WorkspaceObservationBase & (
  | WorkspaceObservationFacts & {
      readonly state: "complete";
      readonly repositoryFingerprint: string;
    }
  | WorkspaceObservationFacts & {
      readonly state: "metadata_limited" | "protected_or_hidden_changed";
      readonly repositoryFingerprint?: never;
    }
  | Partial<WorkspaceObservationFacts> & {
      readonly state: "unknown";
      readonly repositoryFingerprint?: never;
    }
);

export interface WorkspacePathFacts {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly deleted: readonly string[];
  readonly renamed: readonly {
    readonly from: string;
    readonly to: string;
  }[];
  readonly preExistingTouched: readonly string[];
  readonly createdTotal: number;
  readonly updatedTotal: number;
  readonly deletedTotal: number;
  readonly renamedTotal: number;
  readonly preExistingTouchedTotal: number;
  readonly endpointTotal: number;
  readonly omittedEndpointTotal: number;
  readonly truncated: boolean;
  readonly completeFactsSha256: string;
}

export interface WorkspacePostObservationControl {
  readonly branch: string | null;
  readonly head: string | null;
  readonly excludedStateFingerprint: string;
}

export interface WorkspaceEffect {
  readonly outcome:
    | "none"
    | "observed"
    | "protected_or_hidden_changed"
    | "unknown";
  readonly paths: WorkspacePathFacts;
  readonly changedFiles: number;
  readonly changedLines: number;
  readonly binaryFiles: number;
  readonly unavailableBaselineCount: number;
  readonly repositoryFingerprint?: string;
  readonly postObservationControl?: WorkspacePostObservationControl;
  readonly limitationCodes: readonly string[];
}

export interface SessionPreExistingBaseline {
  readonly paths: readonly string[];
  readonly pathStateFingerprints?: Readonly<Record<string, string>>;
  readonly hasReconstructibleBaseline: (
    repositoryRelativePath: string,
  ) => Promise<boolean>;
}

export interface WorkspaceObserver {
  capturePre(
    baseline: SessionPreExistingBaseline,
    signal?: AbortSignal,
  ): Promise<WorkspaceObservation>;
  capturePost(
    pre: WorkspaceObservation,
    signal?: AbortSignal,
  ): Promise<WorkspaceObservation>;
  compare(
    pre: WorkspaceObservation,
    post: WorkspaceObservation,
    baseline: SessionPreExistingBaseline,
  ): Promise<WorkspaceEffect>;
}

interface WorktreeSample {
  readonly exists: boolean;
  readonly mode?: number;
  readonly size?: number;
  readonly mtimeNs?: string;
  readonly ctimeNs?: string;
  readonly device?: string;
  readonly fileId?: string;
  readonly sha256?: string;
  readonly binary?: boolean;
  readonly bytes?: Buffer;
  readonly gitBlobSha1?: string;
  readonly gitBlobSha256?: string;
}

interface ObservationBoundary {
  readonly branch: string | null;
  readonly head: string | null;
  readonly repositoryFingerprint?: string;
  readonly components: WorkspaceComponentFingerprints;
  readonly entries: readonly GitObservationEntry[];
  readonly ignoredCount: number;
  readonly ignoredSummarySha256: string;
  readonly ignoredSummaryTruncated: boolean;
  readonly nestedRepository: "none" | "present" | "unknown";
  readonly metadataLimited: boolean;
  readonly limitationCodes: readonly string[];
  readonly samples: ReadonlyMap<string, WorktreeSample>;
  readonly token: string;
}

interface PathState {
  readonly exists: boolean;
  readonly mode?: number;
  readonly sha256?: string;
  readonly binary?: boolean;
  readonly bytes?: Buffer;
  readonly objectId?: string;
}

interface ImmutableTransitionFacts {
  readonly pre: ReadonlyMap<string, PathState>;
  readonly post: ReadonlyMap<string, PathState>;
  readonly lineStats: ReadonlyMap<
    string,
    { readonly lines: number; readonly binary: boolean }
  >;
}

interface CapturedTransitionInventory {
  readonly inventory: WorkspaceTransitionPathInventory;
  readonly hiddenCount: number;
  readonly hiddenSha256: string;
}

class ObservationRaceError extends Error {}

export interface LiveWorkspaceObserverOptions {
  readonly compareTimeoutMs?: number;
}

/**
 * Live, bounded repository observation. The implementation deliberately owns
 * no session or executor state; its only durable inputs and outputs are the
 * frozen observation/effect contracts above.
 */
export class LiveWorkspaceObserver implements WorkspaceObserver {
  private readonly sampleCache = new Map<string, ReadonlyMap<string, WorktreeSample>>();
  private readonly compareTimeoutMs: number;

  public constructor(
    private readonly boundary: RepositoryBoundary,
    private readonly git: GitInspector,
    options: LiveWorkspaceObserverOptions = {},
  ) {
    this.compareTimeoutMs =
      options.compareTimeoutMs ?? WORKSPACE_COMPARE_TIMEOUT_MS;
  }

  public async capturePre(
    baseline: SessionPreExistingBaseline,
    signal?: AbortSignal,
  ): Promise<WorkspaceObservation> {
    return this.capturePhase("pre", baseline, undefined, signal);
  }

  public async capturePost(
    pre: WorkspaceObservation,
    signal?: AbortSignal,
  ): Promise<WorkspaceObservation> {
    const emptyBaseline: SessionPreExistingBaseline = {
      paths: [],
      hasReconstructibleBaseline: async () => false,
    };
    // A terminal timeout/cancellation normally arrives with an already-aborted
    // process signal. Post-observation owns a fresh deadline in that case.
    return this.capturePhase(
      "post",
      emptyBaseline,
      pre,
      signal?.aborted === true ? undefined : signal,
    );
  }

  public async compare(
    pre: WorkspaceObservation,
    post: WorkspaceObservation,
    baseline: SessionPreExistingBaseline,
  ): Promise<WorkspaceEffect> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.compareTimeoutMs);
    try {
      return await this.compareBounded(pre, post, baseline, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || isAbortFailure(error)) {
        return emptyEffect("unknown", uniqueSorted([
          ...pre.limitationCodes,
          ...post.limitationCodes,
          "COMPARE_TIMEOUT",
        ]));
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async compareBounded(
    pre: WorkspaceObservation,
    post: WorkspaceObservation,
    baseline: SessionPreExistingBaseline,
    signal: AbortSignal,
  ): Promise<WorkspaceEffect> {
    const limitations = uniqueSorted([
      ...pre.limitationCodes,
      ...post.limitationCodes,
    ]);
    if (
      pre.state === "protected_or_hidden_changed" ||
      post.state === "protected_or_hidden_changed" ||
      protectedComponentsChanged(pre, post)
    ) {
      return emptyEffect("protected_or_hidden_changed", limitations);
    }
    if (
      pre.state !== "complete" ||
      post.state !== "complete" ||
      pre.nestedRepository !== "none" ||
      post.nestedRepository !== "none"
    ) {
      return emptyEffect("unknown", limitations);
    }
    if (
      pre.repositoryFingerprint === post.repositoryFingerprint &&
      stableJson(pre.components) === stableJson(post.components)
    ) {
      return {
        ...emptyEffect("none", limitations),
        repositoryFingerprint: post.repositoryFingerprint,
      };
    }

    const candidates = uniqueSorted([
      ...entryEndpoints(pre.entries),
      ...entryEndpoints(post.entries),
      ...pre.transitionPaths.paths,
      ...post.transitionPaths.paths,
    ]);
    const preEntries = entryMap(pre.entries, this.boundary);
    const postEntries = entryMap(post.entries, this.boundary);
    const preImages = new Map(
      pre.beforeImages.map((image) => [
        this.boundary.pathKey(beforeImagePath(image)),
        image,
      ]),
    );
    const postSamples = this.sampleCache.get(observationCacheKey(post));
    const immutableTransition = await this.immutableTransitionFacts(
      pre,
      post,
      candidates,
      signal,
    );
    const created: string[] = [];
    const updated: string[] = [];
    const deleted: string[] = [];
    const renamed: Array<{ readonly from: string; readonly to: string }> = [];
    const consumed = new Set<string>();
    let changedLines = 0;
    let binaryFiles = 0;
    let unavailableBaselineCount =
      pre.transitionPaths.omitted +
      post.transitionPaths.omitted;

    for (const entry of post.entries) {
      if (entry.kind !== "renamed" || entry.originalPath === undefined) continue;
      const from = entry.originalPath;
      const to = entry.path;
      const preState = await this.pathState(
        from,
        pre,
        preEntries,
        preImages,
        this.sampleCache.get(observationCacheKey(pre)),
        immutableTransition.pre,
        signal,
      );
      const postState = await this.pathState(
        to,
        post,
        postEntries,
        new Map(),
        postSamples,
        immutableTransition.post,
        signal,
      );
      const preMode = canonicalWorktreeMode(
        preState,
        preEntries.get(this.boundary.pathKey(from)),
      );
      const postMode = canonicalWorktreeMode(postState, entry);
      if (
        preState.exists &&
        postState.exists &&
        preState.sha256 !== undefined &&
        preState.sha256 === postState.sha256 &&
        preMode === postMode
      ) {
        renamed.push({ from, to });
        consumed.add(this.boundary.pathKey(from));
        consumed.add(this.boundary.pathKey(to));
        if (postState.binary === true) binaryFiles += 1;
      }
    }

    for (const candidate of candidates) {
      const key = this.boundary.pathKey(candidate);
      if (consumed.has(key)) continue;
      const before = await this.pathState(
        candidate,
        pre,
        preEntries,
        preImages,
        this.sampleCache.get(observationCacheKey(pre)),
        immutableTransition.pre,
        signal,
      );
      const after = await this.pathState(
        candidate,
        post,
        postEntries,
        new Map(),
        postSamples,
        immutableTransition.post,
        signal,
      );
      const gitStateChanged =
        preEntries.get(key)?.stateSha256 !== postEntries.get(key)?.stateSha256;
      if (!before.exists && after.exists) {
        created.push(candidate);
      } else if (before.exists && !after.exists) {
        deleted.push(candidate);
      } else if (
        before.exists &&
        after.exists &&
        (
          before.sha256 !== after.sha256 ||
          before.mode !== after.mode ||
          gitStateChanged
        )
      ) {
        updated.push(candidate);
      } else {
        continue;
      }
      if (before.binary === true || after.binary === true) {
        binaryFiles += 1;
        continue;
      }
      const immutableLineStat = immutableTransition.lineStats.get(candidate);
      if (immutableLineStat !== undefined) {
        if (immutableLineStat.binary) binaryFiles += 1;
        else changedLines += immutableLineStat.lines;
        continue;
      }
      if (before.bytes === undefined && before.exists) {
        unavailableBaselineCount += 1;
        continue;
      }
      if (after.bytes === undefined && after.exists) {
        unavailableBaselineCount += 1;
        continue;
      }
      changedLines += changedLineCount(before.bytes, after.bytes);
    }

    const changedEndpoints = [
      ...created,
      ...updated,
      ...deleted,
      ...renamed.flatMap((entry) => [entry.from, entry.to]),
    ];
    const baselineKeys = new Set(baseline.paths.map((value) => this.boundary.pathKey(value)));
    const preExistingTouched = uniqueSorted(
      changedEndpoints.filter((value) => baselineKeys.has(this.boundary.pathKey(value))),
    );
    const pathInput = {
      created,
      updated,
      deleted,
      renamed,
      preExistingTouched,
    };
    const paths =
      post.transitionPaths.truncated &&
      pre.head !== undefined &&
      post.head !== undefined &&
      pre.head !== post.head &&
      post.head !== null
        ? await this.completeImmutablePathFacts(
            pre,
            post,
            pathInput,
            baseline,
            candidates,
            signal,
          )
        : createWorkspacePathFacts(pathInput);
    const effectLimitations = [...limitations];
    if (pre.transitionPaths.truncated || post.transitionPaths.truncated) {
      effectLimitations.push("TRANSITION_PATHS_TRUNCATED");
    }
    if (unavailableBaselineCount > 0) {
      effectLimitations.push("CHANGED_BASELINE_UNAVAILABLE");
      return {
        outcome: "unknown",
        paths,
        changedFiles:
          paths.createdTotal +
          paths.updatedTotal +
          paths.deletedTotal +
          paths.renamedTotal,
        changedLines,
        binaryFiles,
        unavailableBaselineCount,
        limitationCodes: uniqueSorted(effectLimitations),
      };
    }
    return {
      outcome: "observed",
      paths,
      changedFiles:
        paths.createdTotal +
        paths.updatedTotal +
        paths.deletedTotal +
        paths.renamedTotal,
      changedLines,
      binaryFiles,
      unavailableBaselineCount,
      repositoryFingerprint: post.repositoryFingerprint,
      postObservationControl: {
        branch: post.branch,
        head: post.head,
        excludedStateFingerprint: post.components.excluded,
      },
      limitationCodes: uniqueSorted(effectLimitations),
    };
  }

  private async capturePhase(
    phase: WorkspaceObservationPhase,
    baseline: SessionPreExistingBaseline,
    pre: WorkspaceObservation | undefined,
    callerSignal: AbortSignal | undefined,
  ): Promise<WorkspaceObservation> {
    const started = Date.now();
    const phaseController = new AbortController();
    const phaseTimer = setTimeout(
      () => phaseController.abort(),
      WORKSPACE_OBSERVATION_PHASE_TIMEOUT_MS,
    );
    const detachCaller = linkAbort(callerSignal, phaseController);
    let lastError: unknown;
    try {
      for (let attempt = 0; attempt < WORKSPACE_OBSERVATION_MAX_ATTEMPTS; attempt += 1) {
        const attemptController = new AbortController();
        const attemptTimer = setTimeout(
          () => attemptController.abort(),
          WORKSPACE_OBSERVATION_ATTEMPT_TIMEOUT_MS,
        );
        const detachPhase = linkAbort(phaseController.signal, attemptController);
        try {
          return await this.captureAttempt(
            phase,
            baseline,
            pre,
            started,
            attemptController.signal,
          );
        } catch (error) {
          lastError = error;
          const retryable =
            error instanceof ObservationRaceError &&
            attempt + 1 < WORKSPACE_OBSERVATION_MAX_ATTEMPTS &&
            !phaseController.signal.aborted;
          if (!retryable) break;
        } finally {
          clearTimeout(attemptTimer);
          detachPhase();
        }
      }
    } finally {
      clearTimeout(phaseTimer);
      detachCaller();
    }

    const timedOut = phaseController.signal.aborted || isAbortFailure(lastError);
    const limitationCode = timedOut
      ? phase === "pre"
        ? "PRE_OBSERVATION_TIMEOUT"
        : "POST_OBSERVATION_TIMEOUT"
      : lastError instanceof ObservationRaceError
        ? "OBSERVATION_CHURN"
        : "OBSERVATION_INSUFFICIENT";
    if (phase === "pre") {
      if (
        lastError instanceof AgentError &&
        lastError.details.diagnosticCode ===
          "PREEXISTING_BASELINE_NOT_RECONSTRUCTIBLE"
      ) {
        throw lastError;
      }
      throw new AgentError(
        timedOut ? "COMMAND_CANCELLED" : "RECOVERY_REQUIRED",
        timedOut
          ? "Prelaunch repository observation exceeded its bounded deadline"
          : "Prelaunch repository observation could not establish a stable reconstructible state",
        { diagnosticCode: limitationCode },
        { cause: lastError },
      );
    }
    return {
      contract: WORKSPACE_OBSERVATION_CONTRACT,
      phase,
      observedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - started),
      state: "unknown",
      limitationCodes: [limitationCode],
    };
  }

  private async captureAttempt(
    phase: WorkspaceObservationPhase,
    baseline: SessionPreExistingBaseline,
    pre: WorkspaceObservation | undefined,
    started: number,
    signal: AbortSignal,
  ): Promise<WorkspaceObservation> {
    const first = await this.captureBoundary(signal);
    const beforeImages =
      phase === "pre"
        ? await this.captureBeforeImages(first, baseline, signal)
        : [];
    const second = await this.captureBoundary(signal);
    if (first.token !== second.token) {
      throw new ObservationRaceError("Repository changed during observation");
    }
    const transition =
      phase === "post" && pre !== undefined
        ? await this.transitionInventory(pre, second, signal)
        : {
            inventory: transitionInventory([]),
            hiddenCount: 0,
            hiddenSha256: sha256("[]"),
          };
    const transitionPaths = transition.inventory;
    const components =
      transition.hiddenCount === 0
        ? second.components
        : {
            ...second.components,
            excluded: this.git.observationDigest(stableJson({
              excludedStateSha256: second.components.excluded,
              hiddenTransitionCount: transition.hiddenCount,
              hiddenTransitionSha256: transition.hiddenSha256,
            })),
          };
    let state: WorkspaceObservationState =
      second.metadataLimited ? "metadata_limited" : "complete";
    const limitationCodes = [...second.limitationCodes];
    if (transitionPaths.truncated) {
      limitationCodes.push("TRANSITION_PATHS_TRUNCATED");
    }
    if (
      second.nestedRepository !== "none" ||
      (pre !== undefined && protectedBoundaryChanged(pre, second)) ||
      transition.hiddenCount > 0
    ) {
      state = "protected_or_hidden_changed";
      limitationCodes.push(
        second.nestedRepository !== "none"
          ? "NESTED_REPOSITORY_PRESENT"
          : transition.hiddenCount > 0
            ? "POLICY_HIDDEN_TRANSITION"
            : "PROTECTED_OR_HIDDEN_STATE_CHANGED",
      );
    }
    const common = {
      contract: WORKSPACE_OBSERVATION_CONTRACT,
      phase,
      observedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - started),
      branch: second.branch,
      head: second.head,
      components,
      entries: second.entries,
      beforeImages,
      transitionPaths,
      ignoredCount: second.ignoredCount,
      ignoredSummarySha256: second.ignoredSummarySha256,
      ignoredSummaryTruncated: second.ignoredSummaryTruncated,
      nestedRepository: second.nestedRepository,
      limitationCodes: uniqueSorted(limitationCodes),
    };
    const observation: WorkspaceObservation =
      state === "complete"
        ? {
            ...common,
            state,
            repositoryFingerprint: requiredFingerprint(second),
          }
        : { ...common, state };
    if (
      Buffer.byteLength(JSON.stringify(observation)) >
      WORKSPACE_OBSERVATION_MAX_SERIALIZED_BYTES
    ) {
      throw new AgentError(
        "BUDGET_EXCEEDED",
        "Workspace observation exceeds its serialized artifact bound",
        { diagnosticCode: "OBSERVATION_SERIALIZED_BOUND_EXCEEDED" },
      );
    }
    this.sampleCache.set(observationCacheKey(observation), second.samples);
    if (this.sampleCache.size > 8) {
      const oldest = this.sampleCache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.sampleCache.delete(oldest);
    }
    return observation;
  }

  private async captureBoundary(signal: AbortSignal): Promise<ObservationBoundary> {
    const raw = await this.git.readIsolated(
      [
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
        "--ignore-submodules=all",
      ],
      WORKSPACE_OBSERVATION_MAX_PORCELAIN_BYTES,
      signal,
      true,
    );
    const parseableBytes = raw.truncated
      ? raw.bytes.subarray(0, Math.max(0, raw.bytes.lastIndexOf(0) + 1))
      : raw.bytes;
    const parsed = parseObservationStatus(parseableBytes);
    const nestedRepository = await this.nestedRepositoryState(signal);
    const visibleRaw = parsed.entries.filter(
      (entry) =>
        entry.kind !== "ignored" &&
        this.git.observationPathAllowed(entry.path) &&
        (
          entry.originalPath === undefined ||
          this.git.observationPathAllowed(entry.originalPath)
        ),
    );
    const samples = new Map<string, WorktreeSample>();
    let visibleBytes = 0;
    for (const entry of visibleRaw) {
      const sample = await this.readWorktree(entry.path, false, signal);
      samples.set(this.boundary.pathKey(entry.path), sample);
      if (sample.exists) {
        visibleBytes = Math.min(
          WORKSPACE_OBSERVATION_MAX_VISIBLE_CONTENT_BYTES + 1,
          visibleBytes + (sample.size ?? 0),
        );
      }
    }
    const metadataLimited =
      raw.truncated ||
      visibleRaw.length > WORKSPACE_OBSERVATION_MAX_VISIBLE_ENTRIES ||
      visibleBytes > WORKSPACE_OBSERVATION_MAX_VISIBLE_CONTENT_BYTES;
    const status =
      metadataLimited || nestedRepository !== "none"
        ? undefined
        : await this.git.status(signal);
    const statusEntries = new Map(
      (status?.entries ?? []).map((entry) => [
        observationEntryKey(entry, this.boundary),
        entry,
      ]),
    );
    const retainedRaw = visibleRaw.slice(0, WORKSPACE_OBSERVATION_MAX_VISIBLE_ENTRIES);
    const entries: GitObservationEntry[] = [];
    let sampleRetainedBytes = 0;
    for (const rawEntry of retainedRaw) {
      let sample = await this.readWorktree(
        rawEntry.path,
        !metadataLimited,
        signal,
      );
      if (sample.bytes !== undefined) {
        if (
          sampleRetainedBytes + sample.bytes.length >
          WORKSPACE_OBSERVATION_MAX_RETAINED_BYTES
        ) {
          const { bytes: _bytes, ...identityOnlySample } = sample;
          sample = identityOnlySample;
        } else {
          sampleRetainedBytes += sample.bytes.length;
        }
      }
      samples.set(this.boundary.pathKey(rawEntry.path), sample);
      const authoritative = statusEntries.get(observationEntryKey(rawEntry, this.boundary));
      if (status !== undefined && authoritative === undefined) {
        throw new ObservationRaceError("Git status samples did not describe the same entries");
      }
      entries.push({
        ...rawEntry,
        stateSha256: authoritative?.stateSha256 ?? rawEntry.stateSha256,
        ...(sample.exists && sample.mode !== undefined && sample.size !== undefined
          ? {
              worktreeIdentity: {
                mode: sample.mode,
                size: sample.size,
                ...(sample.mtimeNs === undefined ? {} : { mtimeNs: sample.mtimeNs }),
                ...(sample.ctimeNs === undefined ? {} : { ctimeNs: sample.ctimeNs }),
                ...(sample.device === undefined ? {} : { device: sample.device }),
                ...(sample.fileId === undefined ? {} : { fileId: sample.fileId }),
                ...(sample.sha256 === undefined
                  ? {}
                  : { contentSha256: sample.sha256 }),
              },
            }
          : {}),
      });
    }
    const controls = await this.git.observationControlFingerprints(signal);
    const index = await this.indexFingerprint(signal);
    const ignored = ignoredSummary(parsed.entries);
    const policyHiddenEntries = parsed.entries
      .filter((entry) => entry.kind !== "ignored" && !visibleRaw.includes(entry))
      .map(stripObservationIdentity)
      .sort((left, right) =>
        compareGitPathBytes(left.path, right.path) ||
        compareGitPathBytes(left.originalPath ?? "", right.originalPath ?? ""));
    const policyHiddenStateSha256 = raw.truncated
      ? this.git.observationDigest(stableJson(policyHiddenEntries))
      : await this.git.observationPolicyHiddenStateSha256(signal);
    const components: WorkspaceComponentFingerprints = {
      index,
      visible: this.git.observationDigest(stableJson(
        status?.entries ?? entries.map(stripObservationIdentity),
      )),
      excluded:
        status?.excludedStateSha256 ??
        this.git.observationDigest(stableJson(policyHiddenEntries)),
      protectedWorktree: this.git.observationDigest(stableJson({
        protectedWorktreeSha256: controls.protectedWorktreeSha256,
        policyHiddenStateSha256,
      })),
      gitTransitions: controls.normalTransitionsSha256,
      gitControls: controls.gitControlsSha256,
    };
    const limitationCodes = metadataLimited
      ? [
          raw.truncated
            ? "PORCELAIN_STATUS_BOUND_EXCEEDED"
            : "VISIBLE_STATE_BOUND_EXCEEDED",
        ]
      : [];
    const token = sha256(stableJson({
      branch: raw.branch,
      head: raw.head,
      repositoryFingerprint: status?.snapshotSha256,
      components,
      entries,
      ignored: {
        ...ignored,
        truncated: ignored.truncated || raw.truncated,
      },
      nestedRepository,
      metadataLimited,
    }));
    return {
      branch: raw.branch,
      head: raw.head,
      ...(status === undefined
        ? {}
        : { repositoryFingerprint: status.snapshotSha256 }),
      components,
      entries,
      ignoredCount: ignored.count,
      ignoredSummarySha256: ignored.sha256,
      ignoredSummaryTruncated: ignored.truncated || raw.truncated,
      nestedRepository,
      metadataLimited,
      limitationCodes,
      samples,
      token,
    };
  }

  private async indexFingerprint(signal: AbortSignal): Promise<string> {
    return (await this.git.observationIndexIdentity(signal)).sha256;
  }

  private async captureBeforeImages(
    boundary: ObservationBoundary,
    baseline: SessionPreExistingBaseline,
    signal: AbortSignal,
  ): Promise<readonly WorkspaceBeforeImage[]> {
    const candidates = uniqueSorted([
      ...entryEndpoints(boundary.entries),
      ...baseline.paths,
    ]);
    const baselineKeys = new Set(baseline.paths.map((value) => this.boundary.pathKey(value)));
    const images: WorkspaceBeforeImage[] = [];
    let retainedBytes = 0;
    for (const candidate of candidates) {
      const isBaseline = baselineKeys.has(this.boundary.pathKey(candidate));
      if (images.length >= WORKSPACE_OBSERVATION_MAX_IMAGES) {
        if (
          isBaseline &&
          !(await baseline.hasReconstructibleBaseline(candidate))
        ) {
          throw unreconstructible(candidate);
        }
        continue;
      }
      const sample =
        boundary.samples.get(this.boundary.pathKey(candidate)) ??
        await this.readWorktree(candidate, true, signal);
      if (!sample.exists) {
        if (isBaseline && !(await baseline.hasReconstructibleBaseline(candidate))) {
          throw unreconstructible(candidate);
        }
        images.push({ kind: "absent", exists: false, path: candidate });
        continue;
      }
      if (
        sample.mode === undefined ||
        sample.size === undefined ||
        sample.sha256 === undefined ||
        sample.binary === undefined
      ) {
        if (isBaseline && !(await baseline.hasReconstructibleBaseline(candidate))) {
          throw unreconstructible(candidate);
        }
        continue;
      }
      const identity = fileIdentity(candidate, sample);
      const entry = boundary.entries.find(
        (value) => this.boundary.pathKey(value.path) === this.boundary.pathKey(candidate),
      );
      if (
        sample.bytes !== undefined &&
        sample.size <= WORKSPACE_OBSERVATION_MAX_IMAGE_BYTES &&
        retainedBytes + sample.size <= WORKSPACE_OBSERVATION_MAX_RETAINED_BYTES
      ) {
        images.push({
          kind: "retained",
          exists: true,
          identity,
          sha256: sample.sha256,
          binary: sample.binary,
          contentBase64: sample.bytes.toString("base64"),
        });
        retainedBytes += sample.size;
        continue;
      }
      const matchingBlob = await this.matchingBlob(entry, candidate, sample, signal);
      if (matchingBlob !== undefined) {
        images.push({
          kind: "git_blob",
          exists: true,
          identity,
          sha256: sample.sha256,
          binary: sample.binary,
          blob: matchingBlob.blob,
          blobRole: matchingBlob.role,
        });
        continue;
      }
      images.push({
        kind: "identity_only",
        exists: true,
        identity,
        sha256: sample.sha256,
        binary: sample.binary,
      });
      if (isBaseline && !(await baseline.hasReconstructibleBaseline(candidate))) {
        throw unreconstructible(candidate);
      }
    }
    return images;
  }

  private async matchingBlob(
    entry: GitObservationEntry | undefined,
    _repositoryRelativePath: string,
    sample: WorktreeSample,
    signal: AbortSignal,
  ): Promise<{
    readonly blob: string;
    readonly role: "head" | "index" | "odb";
  } | undefined> {
    if (sample.sha256 === undefined) return undefined;
    const candidates = [
      ...(entry?.indexObject === undefined
        ? []
        : [{ blob: entry.indexObject, role: "index" as const }]),
      ...(entry?.headObject === undefined
        ? []
        : [{ blob: entry.headObject, role: "head" as const }]),
    ];
    const indexed = candidates.find((candidate) =>
      candidate.blob === (
        candidate.blob.length === 64
          ? sample.gitBlobSha256
          : sample.gitBlobSha1
      ));
    if (indexed !== undefined) return indexed;
    const objectFormat = await this.git.observationObjectFormat(signal);
    const objectId =
      objectFormat === "sha256" ? sample.gitBlobSha256 : sample.gitBlobSha1;
    if (
      objectId !== undefined &&
      await this.git.observationBlobExists(objectId, signal)
    ) {
      return { blob: objectId, role: "odb" };
    }
    return undefined;
  }

  private async transitionInventory(
    pre: WorkspaceObservation,
    post: ObservationBoundary,
    signal: AbortSignal,
  ): Promise<CapturedTransitionInventory> {
    const statusPaths = uniqueSorted([
      ...entryEndpoints(pre.entries ?? []),
      ...entryEndpoints(post.entries),
    ]);
    if (
      pre.head !== undefined &&
      post.head !== null &&
      pre.head !== post.head
    ) {
      const transitionArguments = pre.head === null
        ? [
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--name-only",
            "-z",
            "-r",
            "--no-renames",
            post.head,
            "--",
          ]
        : [
            "diff",
            "--name-only",
            "-z",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            pre.head,
            post.head,
            "--",
          ];
      const digest = createHash("sha256");
      digest.update("[");
      const hiddenDigest = createHash("sha256");
      hiddenDigest.update("[");
      const retained: string[] = [];
      let retainedBytes = 0;
      let total = 0;
      let hiddenCount = 0;
      let first = true;
      let hiddenFirst = true;
      let previous: string | undefined;
      let previousRaw: string | undefined;
      let previousHidden: string | undefined;
      let statusIndex = 0;
      const emit = (value: string): void => {
        if (value === previous) return;
        if (previous !== undefined && compareGitPathBytes(previous, value) > 0) {
          throw new ObservationRaceError(
            "Git transition paths were not canonically ordered",
          );
        }
        digest.update(first ? "" : ",");
        digest.update(JSON.stringify(value));
        first = false;
        previous = value;
        total += 1;
        const pathBytes = Buffer.byteLength(value);
        if (
          retained.length < TERMINAL_RESULT_MAX_PATH_ENDPOINTS &&
          retainedBytes + pathBytes <= TERMINAL_RESULT_MAX_PATH_BYTES
        ) {
          retained.push(value);
          retainedBytes += pathBytes;
        }
      };
      await this.git.readIsolatedNul(
        transitionArguments,
        32_768,
        (record) => {
          const value = record.toString("utf8");
          if (
            previousRaw !== undefined &&
            compareGitPathBytes(previousRaw, value) > 0
          ) {
            throw new ObservationRaceError(
              "Git transition paths were not canonically ordered",
            );
          }
          previousRaw = value;
          while (
            statusIndex < statusPaths.length &&
            compareGitPathBytes(statusPaths[statusIndex] ?? "", value) < 0
          ) {
            emit(statusPaths[statusIndex] ?? "");
            statusIndex += 1;
          }
          if (statusPaths[statusIndex] === value) statusIndex += 1;
          if (!this.git.observationPathAllowed(value)) {
            if (value !== previousHidden) {
              hiddenDigest.update(hiddenFirst ? "" : ",");
              hiddenDigest.update(JSON.stringify(value));
              hiddenFirst = false;
              hiddenCount += 1;
              previousHidden = value;
            }
            return;
          }
          emit(value);
        },
        signal,
      );
      while (statusIndex < statusPaths.length) {
        emit(statusPaths[statusIndex] ?? "");
        statusIndex += 1;
      }
      digest.update("]");
      hiddenDigest.update("]");
      return {
        inventory: {
          paths: retained,
          total,
          omitted: total - retained.length,
          truncated: total !== retained.length,
          completeFactsSha256: digest.digest("hex"),
        },
        hiddenCount,
        hiddenSha256: this.git.observationDigest(stableJson({
          count: hiddenCount,
          digest: hiddenDigest.digest("hex"),
        })),
      };
    }
    return {
      inventory: transitionInventory(statusPaths),
      hiddenCount: 0,
      hiddenSha256: sha256("[]"),
    };
  }

  private async readWorktree(
    repositoryRelativePath: string,
    includeContent: boolean,
    signal: AbortSignal,
  ): Promise<WorktreeSample> {
    let resolved;
    try {
      resolved = await this.boundary.resolve(repositoryRelativePath, {
        allowMissingTail: true,
      });
    } catch (error) {
      if (isMissing(error)) return { exists: false };
      if (
        error instanceof AgentError &&
        error.code === "UNSUPPORTED_FILE" &&
        /nested Git repositories/iu.test(error.message)
      ) {
        return { exists: false };
      }
      throw error;
    }
    if (!resolved.exists) return { exists: false };
    const before = await lstat(resolved.absolutePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink > 1n
    ) {
      throw new AgentError(
        "RECOVERY_REQUIRED",
        "Visible repository path is not a safely observable regular file",
        {
          diagnosticCode: "WORKTREE_IDENTITY_UNAVAILABLE",
          path: repositoryRelativePath,
        },
      );
    }
    this.boundary.assertDevice(Number(before.dev), repositoryRelativePath);
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new AgentError(
        "BUDGET_EXCEEDED",
        "Visible repository file size exceeds safe observation identity",
        {
          diagnosticCode: "WORKTREE_IDENTITY_UNAVAILABLE",
          path: repositoryRelativePath,
        },
      );
    }
    const identity = {
      exists: true,
      mode: Number(before.mode),
      size: Number(before.size),
      mtimeNs: before.mtimeNs.toString(),
      ctimeNs: before.ctimeNs.toString(),
      device: before.dev.toString(),
      fileId: before.ino.toString(),
    };
    if (!includeContent) return identity;
    const handle = await open(
      resolved.absolutePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = await handle.stat({ bigint: true });
      const digest = createHash("sha256");
      const gitBlobHeader = Buffer.from(`blob ${String(before.size)}\0`, "utf8");
      const gitBlobSha1 = createHash("sha1").update(gitBlobHeader);
      const gitBlobSha256 = createHash("sha256").update(gitBlobHeader);
      const retained: Buffer[] = [];
      let retainedBytes = 0;
      let binary = false;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        if (signal.aborted) {
          throw new AgentError(
            "COMMAND_CANCELLED",
            "Worktree content observation was cancelled",
          );
        }
        const data = Buffer.from(chunk);
        digest.update(data);
        gitBlobSha1.update(data);
        gitBlobSha256.update(data);
        binary ||= data.includes(0);
        if (
          retainedBytes + data.length <=
          WORKSPACE_OBSERVATION_MAX_IMAGE_BYTES
        ) {
          retained.push(data);
          retainedBytes += data.length;
        } else {
          retained.length = 0;
          retainedBytes = WORKSPACE_OBSERVATION_MAX_IMAGE_BYTES + 1;
        }
      }
      const after = await handle.stat({ bigint: true });
      const afterPath = await lstat(resolved.absolutePath, { bigint: true });
      if (
        !opened.isFile() ||
        opened.dev !== afterPath.dev ||
        opened.ino !== afterPath.ino ||
        opened.size !== after.size ||
        opened.mtimeNs !== after.mtimeNs ||
        opened.ctimeNs !== after.ctimeNs ||
        afterPath.isSymbolicLink() ||
        afterPath.nlink > 1n
      ) {
        throw new ObservationRaceError("File changed while it was fingerprinted");
      }
      return {
        ...identity,
        sha256: digest.digest("hex"),
        binary,
        gitBlobSha1: gitBlobSha1.digest("hex"),
        gitBlobSha256: gitBlobSha256.digest("hex"),
        ...(retainedBytes <= WORKSPACE_OBSERVATION_MAX_IMAGE_BYTES
          ? { bytes: Buffer.concat(retained) }
          : {}),
      };
    } finally {
      await handle.close();
    }
  }

  private async nestedRepositoryState(
    signal: AbortSignal,
  ): Promise<"none" | "present" | "unknown"> {
    const queue = [this.boundary.root];
    let traversed = 0;
    while (queue.length > 0) {
      const directory = queue.shift();
      if (directory === undefined) break;
      if (signal.aborted) {
        throw new AgentError(
          "COMMAND_CANCELLED",
          "Nested repository observation was cancelled",
        );
      }
      let handle;
      try {
        const state = await lstat(directory);
        if (!state.isDirectory() || state.isSymbolicLink()) return "unknown";
        this.boundary.assertDevice(state.dev, path.relative(
          this.boundary.root,
          directory,
        ).replaceAll(path.sep, "/"));
        handle = await opendir(directory);
      } catch {
        return "unknown";
      }
      const children = [];
      for await (const child of handle) children.push(child);
      for (const child of children) {
        if (signal.aborted) {
          throw new AgentError(
            "COMMAND_CANCELLED",
            "Nested repository observation was cancelled",
          );
        }
        traversed += 1;
        if (traversed > WORKSPACE_NESTED_SCAN_MAX_ENTRIES) {
          return "unknown";
        }
        if (
          directory !== this.boundary.root &&
          this.boundary.pathKey(child.name) === this.boundary.pathKey(".git")
        ) {
          return "present";
        }
        if (
          child.isDirectory() &&
          !child.isSymbolicLink() &&
          this.boundary.pathKey(child.name) !== this.boundary.pathKey(".git")
        ) {
          queue.push(path.join(directory, child.name));
        }
      }
    }
    return "none";
  }

  private async pathState(
    repositoryRelativePath: string,
    observation: WorkspaceObservation,
    entries: ReadonlyMap<string, GitObservationEntry>,
    images: ReadonlyMap<string, WorkspaceBeforeImage>,
    samples: ReadonlyMap<string, WorktreeSample> | undefined,
    immutableStates: ReadonlyMap<string, PathState>,
    signal: AbortSignal,
  ): Promise<PathState> {
    const key = this.boundary.pathKey(repositoryRelativePath);
    const image = images.get(key);
    if (image !== undefined) return pathStateFromImage(image);
    const sample = samples?.get(key);
    if (sample !== undefined && sample.exists) return pathStateFromSample(sample);
    const entry = entries.get(key);
    if (entry?.worktreeIdentity !== undefined) {
      return {
        exists: true,
        mode: entry.worktreeIdentity.mode,
        ...(entry.worktreeIdentity.contentSha256 === undefined
          ? {}
          : { sha256: entry.worktreeIdentity.contentSha256 }),
      };
    }
    if (
      entry !== undefined &&
      (entry.worktreeMode === "000000" || entry.kind === "untracked")
    ) {
      return { exists: entry.kind === "untracked" };
    }
    const immutable = immutableStates.get(repositoryRelativePath);
    if (immutable !== undefined) return immutable;
    if (observation.head === undefined || observation.head === null) {
      return { exists: false };
    }
    return this.treePathState(observation.head, repositoryRelativePath, signal);
  }

  private async immutableTransitionFacts(
    pre: WorkspaceObservation,
    post: WorkspaceObservation,
    retainedCandidates: readonly string[],
    signal: AbortSignal,
  ): Promise<ImmutableTransitionFacts> {
    const empty: ImmutableTransitionFacts = {
      pre: new Map(),
      post: new Map(),
      lineStats: new Map(),
    };
    if (
      pre.head === undefined ||
      post.head === undefined
    ) {
      return empty;
    }
    if (pre.head === post.head) {
      if (pre.head === null) {
        const absent = new Map(
          retainedCandidates.map((candidate) => [
            candidate,
            { exists: false } satisfies PathState,
          ]),
        );
        return { pre: absent, post: absent, lineStats: new Map() };
      }
      const states = await this.treeStatesForPaths(
        pre.head,
        retainedCandidates,
        signal,
      );
      return { pre: states, post: states, lineStats: new Map() };
    }
    if (post.head === null) return empty;
    const rawArguments = pre.head === null
      ? [
          "diff-tree",
          "--root",
          "--no-commit-id",
          "--raw",
          "-z",
          "-r",
          "--no-renames",
          post.head,
          "--",
        ]
      : [
          "diff",
          "--raw",
          "-z",
          "--no-renames",
          "--no-ext-diff",
          "--no-textconv",
          pre.head,
          post.head,
          "--",
        ];
    const numstatArguments = pre.head === null
      ? [
          "diff-tree",
          "--root",
          "--no-commit-id",
          "--numstat",
          "-z",
          "-r",
          "--no-renames",
          post.head,
          "--",
        ]
      : [
          "diff",
          "--numstat",
          "-z",
          "--no-renames",
          "--no-ext-diff",
          "--no-textconv",
          pre.head,
          post.head,
          "--",
        ];
    const retained = new Set(retainedCandidates);
    const preStates = new Map<string, PathState>();
    const postStates = new Map<string, PathState>();
    let rawHeader: string | undefined;
    await this.git.readIsolatedNul(
      rawArguments,
      32_768,
      (record) => {
        if (rawHeader === undefined) {
          rawHeader = record.toString("utf8");
          return;
        }
        const repositoryRelativePath = record.toString("utf8");
        const fields = rawHeader.split(" ");
        rawHeader = undefined;
        if (!retained.has(repositoryRelativePath)) return;
        const oldMode = fields[0]?.replace(/^:/u, "") ?? "000000";
        const newMode = fields[1] ?? "000000";
        const oldObject = fields[2];
        const newObject = fields[3];
        preStates.set(
          repositoryRelativePath,
          gitRawPathState(oldMode, oldObject),
        );
        postStates.set(
          repositoryRelativePath,
          gitRawPathState(newMode, newObject),
        );
      },
      signal,
    );
    if (rawHeader !== undefined) {
      throw new AgentError(
        "RECOVERY_REQUIRED",
        "Git raw transition inventory ended with a partial record",
      );
    }
    const lineStats = new Map<
      string,
      { readonly lines: number; readonly binary: boolean }
    >();
    await this.git.readIsolatedNul(
      numstatArguments,
      32_768,
      (record) => {
        const value = record.toString("utf8");
        const firstTab = value.indexOf("\t");
        const secondTab = value.indexOf("\t", firstTab + 1);
        if (firstTab < 0 || secondTab < 0) {
          throw new AgentError(
            "RECOVERY_REQUIRED",
            "Git line transition inventory is malformed",
          );
        }
        const repositoryRelativePath = value.slice(secondTab + 1);
        if (!retained.has(repositoryRelativePath)) return;
        const added = value.slice(0, firstTab);
        const deleted = value.slice(firstTab + 1, secondTab);
        const binary = added === "-" || deleted === "-";
        if (
          !binary &&
          (!/^\d+$/u.test(added) || !/^\d+$/u.test(deleted))
        ) {
          throw new AgentError(
            "RECOVERY_REQUIRED",
            "Git line transition counts are malformed",
          );
        }
        lineStats.set(repositoryRelativePath, {
          lines: binary
            ? 0
            : Number.parseInt(added, 10) + Number.parseInt(deleted, 10),
          binary,
        });
      },
      signal,
    );
    return { pre: preStates, post: postStates, lineStats };
  }

  /**
   * Reprocesses an immutable HEAD transition without retaining every path.
   * Each category is streamed in Git's raw UTF-8 byte order so the public
   * summary carries exact totals and the digest of all facts even when its
   * endpoint arrays are truncated.
   */
  private async completeImmutablePathFacts(
    pre: WorkspaceObservation,
    post: WorkspaceObservation,
    input: WorkspacePathFactsInput,
    baseline: SessionPreExistingBaseline,
    classifiedCandidates: readonly string[],
    signal: AbortSignal,
  ): Promise<WorkspacePathFacts> {
    if (post.head === undefined || post.head === null) {
      return createWorkspacePathFacts(input);
    }
    const rawArguments = immutableRawArguments(pre.head ?? null, post.head);
    const excludedKeys = new Set(
      classifiedCandidates.map((value) => this.boundary.pathKey(value)),
    );
    const baselineKeys = new Set(
      baseline.paths.map((value) => this.boundary.pathKey(value)),
    );
    type StreamCategory =
      | "created"
      | "updated"
      | "deleted"
      | "preExistingTouched";
    const digest = createHash("sha256");
    const prefixes: Record<StreamCategory, string[]> = {
      created: [],
      updated: [],
      deleted: [],
      preExistingTouched: [],
    };
    const totals: Record<StreamCategory, number> = {
      created: 0,
      updated: 0,
      deleted: 0,
      preExistingTouched: 0,
    };
    const candidateValues: Record<StreamCategory, readonly string[]> = {
      created: uniqueSorted(input.created),
      updated: uniqueSorted(input.updated),
      deleted: uniqueSorted(input.deleted),
      preExistingTouched: uniqueSorted(input.preExistingTouched),
    };

    const streamCategory = async (category: StreamCategory): Promise<void> => {
      digest.update("[");
      let first = true;
      let candidateIndex = 0;
      let rawHeader: string | undefined;
      let previousRaw: string | undefined;
      let previousEmittedKey: string | undefined;
      const emit = (value: string): void => {
        const key = this.boundary.pathKey(value);
        if (key === previousEmittedKey) return;
        digest.update(first ? "" : ",");
        digest.update(JSON.stringify(value));
        first = false;
        previousEmittedKey = key;
        totals[category] += 1;
        if (prefixes[category].length < TERMINAL_RESULT_MAX_PATH_ENDPOINTS) {
          prefixes[category].push(value);
        }
      };
      const candidates = candidateValues[category];
      await this.git.readIsolatedNul(
        rawArguments,
        32_768,
        (record) => {
          if (rawHeader === undefined) {
            rawHeader = record.toString("utf8");
            return;
          }
          const repositoryRelativePath = record.toString("utf8");
          if (
            previousRaw !== undefined &&
            compareGitPathBytes(previousRaw, repositoryRelativePath) > 0
          ) {
            throw new ObservationRaceError(
              "Git raw transition facts were not ordered by UTF-8 path bytes",
            );
          }
          previousRaw = repositoryRelativePath;
          const fields = rawHeader.split(" ");
          rawHeader = undefined;
          if (excludedKeys.has(this.boundary.pathKey(repositoryRelativePath))) {
            return;
          }
          const oldMode = fields[0]?.replace(/^:/u, "") ?? "000000";
          const newMode = fields[1] ?? "000000";
          const matches =
            category === "created"
              ? oldMode === "000000" && newMode !== "000000"
              : category === "deleted"
                ? oldMode !== "000000" && newMode === "000000"
                : category === "updated"
                  ? oldMode !== "000000" && newMode !== "000000"
                  : baselineKeys.has(
                      this.boundary.pathKey(repositoryRelativePath),
                    );
          if (!matches) return;
          while (
            candidateIndex < candidates.length &&
            compareGitPathBytes(
              candidates[candidateIndex] ?? "",
              repositoryRelativePath,
            ) < 0
          ) {
            emit(candidates[candidateIndex] ?? "");
            candidateIndex += 1;
          }
          emit(repositoryRelativePath);
        },
        signal,
      );
      if (rawHeader !== undefined) {
        throw new AgentError(
          "RECOVERY_REQUIRED",
          "Git raw transition facts ended with a partial record",
        );
      }
      while (candidateIndex < candidates.length) {
        emit(candidates[candidateIndex] ?? "");
        candidateIndex += 1;
      }
      digest.update("]");
    };

    digest.update('{"created":');
    await streamCategory("created");
    digest.update(',"deleted":');
    await streamCategory("deleted");
    digest.update(',"preExistingTouched":');
    await streamCategory("preExistingTouched");
    const canonicalRenames = [...input.renamed].sort((left, right) =>
      compareGitPathBytes(left.from, right.from) ||
      compareGitPathBytes(left.to, right.to));
    digest.update(',"renamed":[');
    for (let index = 0; index < canonicalRenames.length; index += 1) {
      digest.update(index === 0 ? "" : ",");
      digest.update(stableJson(canonicalRenames[index]));
    }
    digest.update('],"updated":');
    await streamCategory("updated");
    digest.update("}");

    let retainedEndpoints = 0;
    let retainedBytes = 0;
    const retained = {
      created: [] as string[],
      updated: [] as string[],
      deleted: [] as string[],
      renamed: [] as Array<{ readonly from: string; readonly to: string }>,
      preExistingTouched: [] as string[],
    };
    const retainPath = (value: string, target: string[]): void => {
      const bytes = Buffer.byteLength(value);
      if (
        retainedEndpoints < TERMINAL_RESULT_MAX_PATH_ENDPOINTS &&
        retainedBytes + bytes <= TERMINAL_RESULT_MAX_PATH_BYTES
      ) {
        target.push(value);
        retainedEndpoints += 1;
        retainedBytes += bytes;
      }
    };
    for (const value of prefixes.created) retainPath(value, retained.created);
    for (const value of prefixes.updated) retainPath(value, retained.updated);
    for (const value of prefixes.deleted) retainPath(value, retained.deleted);
    for (const value of canonicalRenames) {
      const bytes = Buffer.byteLength(value.from) + Buffer.byteLength(value.to);
      if (
        retainedEndpoints + 2 <= TERMINAL_RESULT_MAX_PATH_ENDPOINTS &&
        retainedBytes + bytes <= TERMINAL_RESULT_MAX_PATH_BYTES
      ) {
        retained.renamed.push(value);
        retainedEndpoints += 2;
        retainedBytes += bytes;
      }
    }
    for (const value of prefixes.preExistingTouched) {
      retainPath(value, retained.preExistingTouched);
    }
    const endpointTotal =
      totals.created +
      totals.updated +
      totals.deleted +
      canonicalRenames.length * 2 +
      totals.preExistingTouched;
    return {
      ...retained,
      createdTotal: totals.created,
      updatedTotal: totals.updated,
      deletedTotal: totals.deleted,
      renamedTotal: canonicalRenames.length,
      preExistingTouchedTotal: totals.preExistingTouched,
      endpointTotal,
      omittedEndpointTotal: endpointTotal - retainedEndpoints,
      truncated: endpointTotal !== retainedEndpoints,
      completeFactsSha256: digest.digest("hex"),
    };
  }

  private async treeStatesForPaths(
    head: string,
    candidates: readonly string[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, PathState>> {
    const result = new Map<string, PathState>();
    const chunks: string[][] = [];
    let chunk: string[] = [];
    let chunkBytes = 0;
    for (const candidate of candidates) {
      const candidateBytes = Buffer.byteLength(candidate);
      if (
        chunk.length > 0 &&
        (chunk.length >= 128 || chunkBytes + candidateBytes > 16 * 1024)
      ) {
        chunks.push(chunk);
        chunk = [];
        chunkBytes = 0;
      }
      chunk.push(candidate);
      chunkBytes += candidateBytes;
    }
    if (chunk.length > 0) chunks.push(chunk);
    for (const pathChunk of chunks) {
      await this.git.readIsolatedNul(
        ["ls-tree", "-z", head, "--", ...pathChunk],
        64 * 1024,
        (record) => {
          const tab = record.indexOf(9);
          if (tab < 0) {
            throw new AgentError(
              "RECOVERY_REQUIRED",
              "Git tree identity record is malformed",
            );
          }
          const fields = record.subarray(0, tab).toString("utf8").split(" ");
          const repositoryRelativePath = record.subarray(tab + 1).toString("utf8");
          result.set(
            repositoryRelativePath,
            gitRawPathState(fields[0] ?? "000000", fields[2]),
          );
        },
        signal,
      );
    }
    for (const candidate of candidates) {
      if (!result.has(candidate)) result.set(candidate, { exists: false });
    }
    let retainedBytes = 0;
    let contentReads = 0;
    for (const candidate of candidates) {
      const state = result.get(candidate);
      if (
        state?.exists !== true ||
        state.objectId === undefined ||
        retainedBytes >= WORKSPACE_OBSERVATION_MAX_RETAINED_BYTES ||
        contentReads >= WORKSPACE_COMPARE_MAX_TREE_CONTENT_READS
      ) {
        continue;
      }
      contentReads += 1;
      const maxBytes = Math.min(
        WORKSPACE_OBSERVATION_MAX_IMAGE_BYTES,
        WORKSPACE_OBSERVATION_MAX_RETAINED_BYTES - retainedBytes,
      );
      const content = await this.git.readIsolated(
        ["cat-file", "blob", state.objectId],
        maxBytes,
        signal,
        true,
      );
      if (content.truncated) continue;
      retainedBytes += content.bytes.length;
      result.set(candidate, {
        ...state,
        sha256: sha256(content.bytes),
        binary: content.bytes.includes(0),
        bytes: content.bytes,
      });
    }
    return result;
  }

  private async treePathState(
    head: string,
    repositoryRelativePath: string,
    signal: AbortSignal,
  ): Promise<PathState> {
    const tree = await this.git.readIsolated(
      ["ls-tree", "-z", head, "--", repositoryRelativePath],
      64 * 1024,
      signal,
    );
    if (tree.bytes.length === 0) return { exists: false };
    const record = tree.bytes.subarray(0, tree.bytes.indexOf(0));
    const tab = record.indexOf(9);
    const header = record.subarray(0, tab).toString("utf8").split(" ");
    const mode = Number.parseInt(header[0] ?? "", 8);
    const type = header[1];
    const object = header[2];
    if (
      type !== "blob" ||
      object === undefined ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(object)
    ) {
      return { exists: true, mode };
    }
    const content = await this.git.readIsolated(
      ["cat-file", "blob", object],
      WORKSPACE_OBSERVATION_MAX_IMAGE_BYTES,
      signal,
      true,
    );
    return {
      exists: true,
      mode,
      ...(content.truncated
        ? {}
        : {
            sha256: sha256(content.bytes),
            binary: content.bytes.includes(0),
            bytes: content.bytes,
          }),
    };
  }
}

export interface WorkspacePathFactsInput {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly deleted: readonly string[];
  readonly renamed: readonly {
    readonly from: string;
    readonly to: string;
  }[];
  readonly preExistingTouched: readonly string[];
}

/**
 * Canonical complete-facts digest and bounded retained summary shared by the
 * observer and persistence. Totals and the digest are always computed before
 * endpoint or UTF-8 truncation.
 */
export function createWorkspacePathFacts(
  input: WorkspacePathFactsInput,
): WorkspacePathFacts {
  const canonical = {
    created: [...input.created].sort(compareGitPathBytes),
    updated: [...input.updated].sort(compareGitPathBytes),
    deleted: [...input.deleted].sort(compareGitPathBytes),
    renamed: [...input.renamed]
      .sort((left, right) =>
        compareGitPathBytes(left.from, right.from) ||
        compareGitPathBytes(left.to, right.to)),
    preExistingTouched: [...input.preExistingTouched].sort(compareGitPathBytes),
  };
  const endpointTotal =
    canonical.created.length +
    canonical.updated.length +
    canonical.deleted.length +
    canonical.renamed.length * 2 +
    canonical.preExistingTouched.length;
  let retainedEndpoints = 0;
  let retainedBytes = 0;
  const retained = {
    created: [] as string[],
    updated: [] as string[],
    deleted: [] as string[],
    renamed: [] as Array<{ readonly from: string; readonly to: string }>,
    preExistingTouched: [] as string[],
  };
  const retainPath = (value: string, target: string[]): void => {
    const bytes = Buffer.byteLength(value);
    if (
      retainedEndpoints + 1 <= TERMINAL_RESULT_MAX_PATH_ENDPOINTS &&
      retainedBytes + bytes <= TERMINAL_RESULT_MAX_PATH_BYTES
    ) {
      target.push(value);
      retainedEndpoints += 1;
      retainedBytes += bytes;
    }
  };
  for (const value of canonical.created) retainPath(value, retained.created);
  for (const value of canonical.updated) retainPath(value, retained.updated);
  for (const value of canonical.deleted) retainPath(value, retained.deleted);
  for (const value of canonical.renamed) {
    const bytes = Buffer.byteLength(value.from) + Buffer.byteLength(value.to);
    if (
      retainedEndpoints + 2 <= TERMINAL_RESULT_MAX_PATH_ENDPOINTS &&
      retainedBytes + bytes <= TERMINAL_RESULT_MAX_PATH_BYTES
    ) {
      retained.renamed.push(value);
      retainedEndpoints += 2;
      retainedBytes += bytes;
    }
  }
  for (const value of canonical.preExistingTouched) {
    retainPath(value, retained.preExistingTouched);
  }
  const omittedEndpointTotal = endpointTotal - retainedEndpoints;
  return {
    ...retained,
    createdTotal: canonical.created.length,
    updatedTotal: canonical.updated.length,
    deletedTotal: canonical.deleted.length,
    renamedTotal: canonical.renamed.length,
    preExistingTouchedTotal: canonical.preExistingTouched.length,
    endpointTotal,
    omittedEndpointTotal,
    truncated: omittedEndpointTotal > 0,
    completeFactsSha256: sha256(stableJson(canonical)),
  };
}

function parseObservationStatus(bytes: Buffer): {
  readonly entries: readonly GitObservationEntry[];
} {
  const records = bytes.toString("utf8").split("\0");
  const entries: GitObservationEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record === "" || record.startsWith("# ")) continue;
    if (record.startsWith("? ") || record.startsWith("! ")) {
      const ignored = record.startsWith("! ");
      entries.push({
        path: record.slice(2).replace(/\/$/u, ""),
        kind: ignored ? "ignored" : "untracked",
        indexStatus: ignored ? "!" : "?",
        worktreeStatus: ignored ? "!" : "?",
        stateSha256: sha256(stableJson({
          kind: ignored ? "ignored" : "untracked",
        })),
      });
      continue;
    }
    const fields = record.split(" ");
    const xy = fields[1] ?? "..";
    if (record.startsWith("1 ")) {
      entries.push({
        path: fields.slice(8).join(" "),
        kind: "ordinary",
        indexStatus: xy[0] ?? ".",
        worktreeStatus: xy[1] ?? ".",
        stateSha256: sha256(stableJson({
          kind: "ordinary",
          git: fields.slice(1, 8),
        })),
        ...(fields[3] === undefined ? {} : { headMode: fields[3] }),
        ...(fields[4] === undefined ? {} : { indexMode: fields[4] }),
        ...(fields[5] === undefined ? {} : { worktreeMode: fields[5] }),
        ...(fields[6] === undefined ? {} : { headObject: fields[6] }),
        ...(fields[7] === undefined ? {} : { indexObject: fields[7] }),
      });
    } else if (record.startsWith("2 ")) {
      const originalPath = records[index + 1] ?? "";
      index += 1;
      entries.push({
        path: fields.slice(9).join(" "),
        originalPath,
        kind: "renamed",
        indexStatus: xy[0] ?? ".",
        worktreeStatus: xy[1] ?? ".",
        stateSha256: sha256(stableJson({
          kind: "renamed",
          git: fields.slice(1, 9),
        })),
        ...(fields[3] === undefined ? {} : { headMode: fields[3] }),
        ...(fields[4] === undefined ? {} : { indexMode: fields[4] }),
        ...(fields[5] === undefined ? {} : { worktreeMode: fields[5] }),
        ...(fields[6] === undefined ? {} : { headObject: fields[6] }),
        ...(fields[7] === undefined ? {} : { indexObject: fields[7] }),
      });
    } else if (record.startsWith("u ")) {
      entries.push({
        path: fields.slice(10).join(" "),
        kind: "unmerged",
        indexStatus: xy[0] ?? "U",
        worktreeStatus: xy[1] ?? "U",
        stateSha256: sha256(stableJson({
          kind: "unmerged",
          git: fields.slice(1, 10),
        })),
        ...(fields[3] === undefined ? {} : { headMode: fields[3] }),
        ...(fields[4] === undefined ? {} : { indexMode: fields[4] }),
        ...(fields[5] === undefined ? {} : { worktreeMode: fields[5] }),
      });
    }
  }
  return { entries };
}

function stripObservationIdentity(entry: GitObservationEntry): GitStatusEntry {
  return {
    path: entry.path,
    ...(entry.originalPath === undefined
      ? {}
      : { originalPath: entry.originalPath }),
    kind: entry.kind,
    indexStatus: entry.indexStatus,
    worktreeStatus: entry.worktreeStatus,
    stateSha256: entry.stateSha256,
  };
}

function observationEntryKey(
  entry: GitStatusEntry,
  boundary: RepositoryBoundary,
): string {
  return `${boundary.pathKey(entry.path)}\0${
    entry.originalPath === undefined ? "" : boundary.pathKey(entry.originalPath)
  }\0${entry.kind}`;
}

function entryMap(
  entries: readonly GitObservationEntry[] | undefined,
  boundary: RepositoryBoundary,
): ReadonlyMap<string, GitObservationEntry> {
  return new Map(
    (entries ?? []).map((entry) => [boundary.pathKey(entry.path), entry]),
  );
}

function entryEndpoints(
  entries: readonly GitObservationEntry[],
): string[] {
  return entries.flatMap((entry) =>
    entry.originalPath === undefined
      ? [entry.path]
      : [entry.originalPath, entry.path]);
}

function ignoredSummary(entries: readonly GitObservationEntry[]): {
  readonly count: number;
  readonly sha256: string;
  readonly truncated: boolean;
} {
  const ignored = entries
    .filter((entry) => entry.kind === "ignored")
    .map((entry) => entry.path)
    .sort(compareGitPathBytes);
  let retainedBytes = 0;
  let retainedCount = 0;
  for (const value of ignored) {
    const bytes = Buffer.byteLength(value);
    if (
      retainedCount >= TERMINAL_RESULT_MAX_PATH_ENDPOINTS ||
      retainedBytes + bytes > TERMINAL_RESULT_MAX_PATH_BYTES
    ) break;
    retainedCount += 1;
    retainedBytes += bytes;
  }
  return {
    count: ignored.length,
    sha256: sha256(stableJson(ignored)),
    truncated: retainedCount < ignored.length,
  };
}

function transitionInventory(
  input: readonly string[],
): WorkspaceTransitionPathInventory {
  const complete = uniqueSorted(input);
  const paths: string[] = [];
  let bytes = 0;
  for (const value of complete) {
    const nextBytes = Buffer.byteLength(value);
    if (
      paths.length >= TERMINAL_RESULT_MAX_PATH_ENDPOINTS ||
      bytes + nextBytes > TERMINAL_RESULT_MAX_PATH_BYTES
    ) break;
    paths.push(value);
    bytes += nextBytes;
  }
  return {
    paths,
    total: complete.length,
    omitted: complete.length - paths.length,
    truncated: paths.length !== complete.length,
    completeFactsSha256: sha256(stableJson(complete)),
  };
}

function protectedComponentsChanged(
  pre: WorkspaceObservation,
  post: WorkspaceObservation,
): boolean {
  if (pre.components === undefined || post.components === undefined) return false;
  return (
    pre.components.protectedWorktree !== post.components.protectedWorktree ||
    pre.components.gitControls !== post.components.gitControls
  );
}

function protectedBoundaryChanged(
  pre: WorkspaceObservation,
  post: ObservationBoundary,
): boolean {
  return pre.components !== undefined && (
    pre.components.protectedWorktree !== post.components.protectedWorktree ||
    pre.components.gitControls !== post.components.gitControls
  );
}

function emptyEffect(
  outcome: WorkspaceEffect["outcome"],
  limitationCodes: readonly string[],
): WorkspaceEffect {
  return {
    outcome,
    paths: createWorkspacePathFacts({
      created: [],
      updated: [],
      deleted: [],
      renamed: [],
      preExistingTouched: [],
    }),
    changedFiles: 0,
    changedLines: 0,
    binaryFiles: 0,
    unavailableBaselineCount: 0,
    limitationCodes,
  };
}

function requiredFingerprint(boundary: ObservationBoundary): string {
  if (boundary.repositoryFingerprint === undefined) {
    throw new AgentError(
      "INTERNAL_ERROR",
      "Complete observation is missing the GitInspector status fingerprint",
    );
  }
  return boundary.repositoryFingerprint;
}

function beforeImagePath(image: WorkspaceBeforeImage): string {
  return image.kind === "absent" ? image.path : image.identity.path;
}

function pathStateFromImage(image: WorkspaceBeforeImage): PathState {
  if (image.kind === "absent") return { exists: false };
  if (image.kind === "retained") {
    const bytes = Buffer.from(image.contentBase64, "base64");
    return {
      exists: true,
      mode: image.identity.mode,
      sha256: image.sha256,
      binary: image.binary,
      bytes,
    };
  }
  return {
    exists: true,
    mode: image.identity.mode,
    sha256: image.sha256,
    binary: image.binary,
  };
}

function pathStateFromSample(sample: WorktreeSample): PathState {
  return {
    exists: sample.exists,
    ...(sample.mode === undefined ? {} : { mode: sample.mode }),
    ...(sample.sha256 === undefined ? {} : { sha256: sample.sha256 }),
    ...(sample.binary === undefined ? {} : { binary: sample.binary }),
    ...(sample.bytes === undefined ? {} : { bytes: sample.bytes }),
  };
}

/**
 * Git tree identities use canonical Git modes, while Node's Windows stat mode
 * commonly includes writable bits (for example 100666 for a 100644 blob).
 * Porcelain v2's worktree mode keeps rename comparison in Git's mode domain
 * without weakening the required byte match or explicit rename origin.
 */
function canonicalWorktreeMode(
  state: PathState,
  entry: GitObservationEntry | undefined,
): number | undefined {
  const worktreeMode = entry?.worktreeMode;
  return worktreeMode !== undefined && /^[0-7]{6}$/u.test(worktreeMode)
    ? Number.parseInt(worktreeMode, 8)
    : state.mode;
}

function gitRawPathState(
  mode: string,
  objectId: string | undefined,
): PathState {
  if (
    mode === "000000" ||
    objectId === undefined ||
    /^0+$/u.test(objectId)
  ) {
    return { exists: false };
  }
  return {
    exists: true,
    mode: Number.parseInt(mode, 8),
    sha256: `git-object:${objectId}`,
    objectId,
  };
}

function immutableRawArguments(
  preHead: string | null,
  postHead: string,
): readonly string[] {
  return preHead === null
    ? [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--raw",
        "-z",
        "-r",
        "--no-renames",
        postHead,
        "--",
      ]
    : [
        "diff",
        "--raw",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        preHead,
        postHead,
        "--",
      ];
}

function fileIdentity(
  repositoryRelativePath: string,
  sample: WorktreeSample,
): WorkspaceFileIdentity {
  if (sample.mode === undefined || sample.size === undefined) {
    throw new AgentError("INTERNAL_ERROR", "File identity is incomplete");
  }
  return {
    path: repositoryRelativePath,
    mode: sample.mode,
    size: sample.size,
    ...(sample.mtimeNs === undefined ? {} : { mtimeNs: sample.mtimeNs }),
    ...(sample.ctimeNs === undefined ? {} : { ctimeNs: sample.ctimeNs }),
    ...(sample.device === undefined ? {} : { device: sample.device }),
    ...(sample.fileId === undefined ? {} : { fileId: sample.fileId }),
  };
}

function observationCacheKey(observation: WorkspaceObservation): string {
  return sha256(stableJson({
    phase: observation.phase,
    observedAt: observation.observedAt,
    state: observation.state,
    repositoryFingerprint: observation.repositoryFingerprint,
    components: observation.components,
  }));
}

function changedLineCount(
  before: Buffer | undefined,
  after: Buffer | undefined,
): number {
  const left = normalizedLines(before);
  const right = normalizedLines(after);
  let prefix = 0;
  while (
    prefix < left.length &&
    prefix < right.length &&
    left[prefix] === right[prefix]
  ) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) suffix += 1;
  return (
    left.length - prefix - suffix +
    right.length - prefix - suffix
  );
}

function normalizedLines(value: Buffer | undefined): string[] {
  if (value === undefined || value.length === 0) return [];
  const lines = value.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareGitPathBytes);
}

function compareGitPathBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function linkAbort(
  source: AbortSignal | undefined,
  destination: AbortController,
): () => void {
  if (source === undefined) return () => undefined;
  const abort = (): void => destination.abort();
  if (source.aborted) destination.abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function isAbortFailure(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (
      error instanceof AgentError &&
      ["COMMAND_CANCELLED", "COMMAND_TIMEOUT"].includes(error.code)
    )
  );
}

function isMissing(error: unknown): boolean {
  return (
    (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) ||
    (
      error instanceof AgentError &&
      error.code === "PATH_OUTSIDE_REPOSITORY" &&
      /does not exist/iu.test(error.message)
    )
  );
}

function unreconstructible(repositoryRelativePath: string): AgentError {
  return new AgentError(
    "RECOVERY_REQUIRED",
    "Session-start work lacks a reconstructible prelaunch baseline",
    {
      diagnosticCode: "PREEXISTING_BASELINE_NOT_RECONSTRUCTIBLE",
      path: repositoryRelativePath,
    },
  );
}

export function isWorkspaceObservation(
  value: unknown,
): value is WorkspaceObservation {
  if (!exactKeys(value, [
    "contract", "phase", "observedAt", "durationMs", "state", "branch", "head",
    "repositoryFingerprint", "components", "entries", "beforeImages",
    "transitionPaths", "ignoredCount", "ignoredSummarySha256",
    "ignoredSummaryTruncated", "nestedRepository", "limitationCodes",
  ], true)) return false;
  const item = value as Partial<WorkspaceObservation>;
  if (
    item.contract !== WORKSPACE_OBSERVATION_CONTRACT ||
    !["pre", "post"].includes(item.phase ?? "") ||
    !isoTimestamp(item.observedAt) ||
    !nonnegativeInteger(item.durationMs) ||
    ![
      "complete", "metadata_limited", "protected_or_hidden_changed", "unknown",
    ].includes(item.state ?? "") ||
    !boundedStrings(item.limitationCodes, 1_024, 1_024)
  ) return false;
  const fullFacts = validObservationFacts(item);
  const partialFacts = validPartialObservationFacts(item);
  if (item.state === "unknown" ? !partialFacts : !fullFacts) return false;
  const beforeImages = item.beforeImages ?? [];
  const retainedBytes = beforeImages.reduce(
    (total, image) =>
      total +
      (image.kind === "retained"
        ? Buffer.from(image.contentBase64, "base64").length
        : 0),
    0,
  );
  if (
    retainedBytes > WORKSPACE_OBSERVATION_MAX_RETAINED_BYTES ||
    Buffer.byteLength(JSON.stringify(value)) >
      WORKSPACE_OBSERVATION_MAX_SERIALIZED_BYTES
  ) return false;
  return item.state === "complete"
    ? hash(item.repositoryFingerprint)
    : item.repositoryFingerprint === undefined;
}

function validObservationFacts(
  item: Partial<WorkspaceObservationFacts>,
): boolean {
  return (
    (item.branch === null || validString(item.branch, 32_768, true)) &&
    (item.head === null || validString(item.head, 128, true)) &&
    validComponents(item.components) &&
    validEntries(item.entries) &&
    validBeforeImages(item.beforeImages) &&
    validTransitionPaths(item.transitionPaths) &&
    nonnegativeInteger(item.ignoredCount) &&
    hash(item.ignoredSummarySha256) &&
    typeof item.ignoredSummaryTruncated === "boolean" &&
    ["none", "present", "unknown"].includes(item.nestedRepository ?? "")
  );
}

function validPartialObservationFacts(
  item: Partial<WorkspaceObservationFacts>,
): boolean {
  return (
    (item.branch === undefined ||
      item.branch === null ||
      validString(item.branch, 32_768, true)) &&
    (item.head === undefined ||
      item.head === null ||
      validString(item.head, 128, true)) &&
    (item.components === undefined || validComponents(item.components)) &&
    (item.entries === undefined || validEntries(item.entries)) &&
    (item.beforeImages === undefined ||
      validBeforeImages(item.beforeImages)) &&
    (item.transitionPaths === undefined ||
      validTransitionPaths(item.transitionPaths)) &&
    (item.ignoredCount === undefined ||
      nonnegativeInteger(item.ignoredCount)) &&
    (item.ignoredSummarySha256 === undefined ||
      hash(item.ignoredSummarySha256)) &&
    (item.ignoredSummaryTruncated === undefined ||
      typeof item.ignoredSummaryTruncated === "boolean") &&
    (item.nestedRepository === undefined ||
      ["none", "present", "unknown"].includes(item.nestedRepository))
  );
}

function validComponents(value: unknown): boolean {
  if (!exactKeys(value, [
    "index", "visible", "excluded", "protectedWorktree", "gitTransitions",
    "gitControls",
  ])) return false;
  return Object.values(value as Record<string, unknown>).every(hash);
}

function validEntries(value: unknown): value is readonly GitObservationEntry[] {
  return Array.isArray(value) &&
    value.length <= WORKSPACE_OBSERVATION_MAX_VISIBLE_ENTRIES &&
    value.every(validEntry);
}

function validEntry(value: unknown): boolean {
  if (!exactKeys(value, [
    "path", "originalPath", "kind", "indexStatus", "worktreeStatus",
    "stateSha256", "headMode", "indexMode", "worktreeMode", "headObject",
    "indexObject", "worktreeIdentity",
  ], true)) return false;
  const entry = value as Partial<GitObservationEntry>;
  return validString(entry.path, 32_768) &&
    (entry.originalPath === undefined ||
      validString(entry.originalPath, 32_768)) &&
    ["ordinary", "renamed", "unmerged", "untracked", "ignored"].includes(
      entry.kind ?? "",
    ) &&
    validString(entry.indexStatus, 16, true) &&
    validString(entry.worktreeStatus, 16, true) &&
    hash(entry.stateSha256) &&
    [entry.headMode, entry.indexMode, entry.worktreeMode].every(
      (mode) => mode === undefined || validString(mode, 16, true),
    ) &&
    [entry.headObject, entry.indexObject].every(
      (object) =>
        object === undefined ||
        (
          typeof object === "string" &&
          /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(object)
        ),
    ) &&
    (entry.worktreeIdentity === undefined ||
      validWorktreeIdentity(entry.worktreeIdentity));
}

function validWorktreeIdentity(value: unknown): boolean {
  if (!exactKeys(value, [
    "mode", "size", "mtimeNs", "ctimeNs", "device", "fileId",
    "contentSha256",
  ], true)) return false;
  const identity = value as NonNullable<
    GitObservationEntry["worktreeIdentity"]
  >;
  return nonnegativeInteger(identity.mode) &&
    nonnegativeInteger(identity.size) &&
    [identity.mtimeNs, identity.ctimeNs, identity.device, identity.fileId]
      .every((entry) =>
        entry === undefined || validString(entry, 128, true)) &&
    (identity.contentSha256 === undefined ||
      hash(identity.contentSha256));
}

function validBeforeImages(
  value: unknown,
): value is readonly WorkspaceBeforeImage[] {
  return Array.isArray(value) &&
    value.length <= WORKSPACE_OBSERVATION_MAX_IMAGES &&
    value.every(validBeforeImage);
}

function validBeforeImage(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const item = value as {
    readonly kind?: WorkspaceBeforeImage["kind"];
    readonly exists?: boolean;
    readonly path?: string;
    readonly identity?: WorkspaceFileIdentity;
    readonly sha256?: string;
    readonly binary?: boolean;
    readonly contentBase64?: string;
    readonly blob?: string;
    readonly blobRole?: "head" | "index" | "odb";
  };
  if (item.kind === "absent") {
    return exactKeys(item, ["kind", "exists", "path"]) &&
      item.exists === false &&
      validString(item.path, 32_768);
  }
  const common = validFileIdentity(item.identity) &&
    hash(item.sha256) &&
    typeof item.binary === "boolean" &&
    item.exists === true;
  if (!common) return false;
  if (item.kind === "retained") {
    if (!exactKeys(item, [
      "kind", "exists", "identity", "sha256", "binary", "contentBase64",
    ])) return false;
    if (typeof item.contentBase64 !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        item.contentBase64,
      )) return false;
    const content = Buffer.from(item.contentBase64, "base64");
    return content.length <= WORKSPACE_OBSERVATION_MAX_IMAGE_BYTES &&
      content.length === item.identity?.size &&
      sha256(content) === item.sha256;
  }
  if (item.kind === "git_blob") {
    return exactKeys(item, [
      "kind", "exists", "identity", "sha256", "binary", "blob", "blobRole",
    ]) &&
      typeof item.blob === "string" &&
      /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(item.blob) &&
      ["head", "index", "odb"].includes(item.blobRole ?? "");
  }
  return item.kind === "identity_only" &&
    exactKeys(item, ["kind", "exists", "identity", "sha256", "binary"]);
}

function validFileIdentity(value: unknown): boolean {
  if (!exactKeys(value, [
    "path", "mode", "size", "mtimeNs", "ctimeNs", "device", "fileId",
  ], true)) return false;
  const identity = value as Partial<WorkspaceFileIdentity>;
  return validString(identity.path, 32_768) &&
    nonnegativeInteger(identity.mode) &&
    nonnegativeInteger(identity.size) &&
    [identity.mtimeNs, identity.ctimeNs, identity.device, identity.fileId]
      .every((entry) => entry === undefined || validString(entry, 128, true));
}

function validTransitionPaths(value: unknown): boolean {
  if (!exactKeys(value, [
    "paths", "total", "omitted", "truncated", "completeFactsSha256",
  ])) return false;
  const item = value as Partial<WorkspaceTransitionPathInventory>;
  return boundedStrings(
    item.paths,
    TERMINAL_RESULT_MAX_PATH_ENDPOINTS,
    32_768,
  ) &&
    item.paths.reduce(
      (total, path) => total + Buffer.byteLength(path),
      0,
    ) <= TERMINAL_RESULT_MAX_PATH_BYTES &&
    nonnegativeInteger(item.total) &&
    nonnegativeInteger(item.omitted) &&
    item.total >= item.paths.length &&
    item.omitted === item.total - item.paths.length &&
    typeof item.truncated === "boolean" &&
    item.truncated === (item.omitted > 0) &&
    hash(item.completeFactsSha256);
}

function exactKeys(
  value: unknown,
  allowed: readonly string[],
  optional = false,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) &&
    (optional || allowed.every((key) => keys.includes(key)));
}

function validString(
  value: unknown,
  maxBytes: number,
  allowEmpty = false,
): value is string {
  return typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= maxBytes;
}

function boundedStrings(
  value: unknown,
  maxItems: number,
  maxBytes: number,
): value is readonly string[] {
  return Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((entry) => validString(entry, maxBytes, true));
}

function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value;
}
