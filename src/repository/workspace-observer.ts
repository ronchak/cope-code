import { sha256 } from "../shared/crypto.js";
import type { GitObservationEntry } from "./git.js";

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
export const WORKSPACE_OBSERVATION_MAX_ATTEMPTS = 2;
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
      readonly blobRole: "head" | "index";
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
    readonly blobRole?: "head" | "index";
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
      ["head", "index"].includes(item.blobRole ?? "");
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
