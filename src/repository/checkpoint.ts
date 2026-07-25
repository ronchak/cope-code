import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { AgentError } from "../shared/errors.js";
import { CURRENT_HOST_PLATFORM } from "../platform/index.js";
import { newId, sha256, stableJson } from "../shared/crypto.js";
import { isOperationId } from "../shared/operation-id.js";
import type { RepositoryBoundary } from "./boundary.js";
import { normalizeRepositoryPath } from "./boundary.js";
import { readRegularFile } from "./text-file.js";
import {
  MAX_PINNED_FILE_BYTES,
  isPinnedIdentity,
  pinnedIdentityFromBigInts,
  runPinnedMutation,
  type PinnedFileState,
  type PinnedIdentity,
} from "./pinned-mutation-fs.js";

export const CHECKPOINT_VERSION = "checkpoint.v1" as const;

interface CheckpointEntry {
  readonly path: string;
  readonly existed: boolean;
  readonly sizeBytes: number;
  readonly sha256: string | null;
  readonly mode: number | null;
  readonly blob: string | null;
  readonly expectedAfter?: {
    readonly existed: boolean;
    readonly sha256: string | null;
    /** Added compatibly to checkpoint.v1; absent legacy seals require force. */
    readonly mode?: number | null;
  };
}

interface CheckpointBody {
  readonly version: typeof CHECKPOINT_VERSION;
  readonly id: string;
  readonly createdAt: string;
  readonly repositoryFingerprint: string;
  /** Durable association written before the first worktree mutation. */
  readonly operationId?: string;
  readonly sealedAt?: string;
  readonly entries: readonly CheckpointEntry[];
  readonly mutationArtifacts?: readonly CheckpointMutationArtifact[];
  readonly rollback?: CheckpointRollbackState;
  readonly totalBytes: number;
}

interface CheckpointManifest extends CheckpointBody {
  readonly integrity: string;
}

interface CheckpointMutationArtifact {
  readonly path: string;
  readonly directory: StoredDirectoryIdentity;
  readonly temporary: StoredArtifactEvidence | null;
  readonly backup: StoredArtifactEvidence | null;
  readonly probe?: StoredArtifactEvidence | null;
  /** Written before attempting the no-overwrite final link. */
  readonly installAttempted?: true;
}

interface StoredDirectoryIdentity {
  readonly device: string;
  readonly inode: string;
}

interface StoredArtifactIdentity extends StoredDirectoryIdentity {
  readonly sha256: string;
  readonly mode: number;
}

interface StoredArtifactPlan {
  readonly device?: never;
  readonly inode?: never;
  readonly sha256: string;
  readonly mode: number;
}

type StoredArtifactEvidence = StoredArtifactIdentity | StoredArtifactPlan;

interface CheckpointRollbackEntry {
  readonly path: string;
  readonly directory: StoredDirectoryIdentity;
  readonly current: StoredArtifactIdentity | null;
  readonly temporary: StoredArtifactIdentity | null;
  readonly backup: StoredArtifactIdentity | null;
  readonly installed: StoredArtifactIdentity | null;
  /** Written before attempting the no-overwrite rollback link. */
  readonly installAttempted?: true;
  /** Written before attempting to reinstall the pre-rollback object. */
  readonly revertInstallAttempted?: true;
}

interface CheckpointRollbackState {
  readonly startedAt: string;
  readonly forced?: boolean;
  readonly phase: "applying" | "restored" | "reverting" | "reverted";
  readonly entries: readonly CheckpointRollbackEntry[];
}

export interface MutationArtifactIdentity {
  readonly path: string;
  readonly directory: {
    readonly device: string;
    readonly inode: string;
  };
  readonly temporary?: {
    readonly device?: string;
    readonly inode?: string;
    readonly sha256: string;
    readonly mode: number;
  };
  readonly backup?: {
    readonly device?: string;
    readonly inode?: string;
    readonly sha256: string;
    readonly mode: number;
  };
  readonly probe?: {
    readonly device?: string;
    readonly inode?: string;
    readonly sha256: string;
    readonly mode: number;
  };
  readonly installAttempted?: true;
}

interface RollbackSnapshot {
  readonly checkpointId: string;
  readonly entry: CheckpointEntry;
  readonly absoluteTarget: string;
  readonly artifact: CheckpointMutationArtifact;
  readonly current: PinnedFileState | null;
  temporary: PinnedFileState | null;
  backup: PinnedFileState | null;
  installed: PinnedFileState | null;
  installAttempted: boolean;
  revertInstallAttempted: boolean;
  targetMutated: boolean;
}

export interface CheckpointSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly paths: readonly string[];
  readonly totalBytes: number;
  readonly integrity: string;
  readonly operationId?: string;
  readonly sealed: boolean;
  readonly rollbackForced?: boolean;
}

/** Integrity-verified before-image bytes captured for one mutation boundary. */
export interface CheckpointFileSnapshot {
  readonly path: string;
  readonly existed: boolean;
  readonly bytes: Buffer | null;
  readonly mode: number | null;
  readonly sha256: string | null;
}

export interface CheckpointSnapshot {
  readonly id: string;
  readonly createdAt: string;
  readonly operationId?: string;
  readonly entries: readonly CheckpointFileSnapshot[];
}

export interface CheckpointPostState {
  readonly path: string;
  readonly sha256: string | null;
  readonly mode: number | null;
}

export interface RollbackOptions {
  /** Explicitly permits overwriting content that changed after the agent patch. */
  readonly force?: boolean;
}

export interface CheckpointStoreOptions {
  readonly maxCheckpointBytes?: number;
  readonly maxFiles?: number;
  readonly allowInsideRepository?: boolean;
  /** @internal Deterministic rollback race injection points. */
  readonly hooks?: {
    readonly beforeRestoreTarget?: (path: string) => Promise<void>;
    readonly beforeCheckpointFileRead?: (path: string) => Promise<void>;
    readonly beforeRestoreSnapshot?: (path: string) => Promise<void>;
    /** @internal Simulates a filesystem without hard-link support during rollback. */
    readonly failRollbackHardLinkProbe?: (path: string) => boolean;
    readonly afterRollbackStage?: (path: string) => Promise<void>;
    readonly afterRollbackCapture?: (path: string) => Promise<void>;
    readonly afterRollbackInstall?: (path: string) => Promise<void>;
    readonly deleteRollbackInstallBeforeResponse?: (path: string) => boolean;
    readonly afterRollbackRevertInstall?: (path: string) => Promise<void>;
    readonly deleteRollbackRevertInstallBeforeResponse?: (path: string) => boolean;
    readonly afterRollbackCleanup?: () => Promise<void>;
  };
}

export class CheckpointStore {
  private readonly maxCheckpointBytes: number;
  private readonly maxFiles: number;
  private readonly hooks: NonNullable<CheckpointStoreOptions["hooks"]>;

  private constructor(
    private readonly boundary: RepositoryBoundary,
    public readonly storageDirectory: string,
    options: CheckpointStoreOptions,
  ) {
    this.maxCheckpointBytes = options.maxCheckpointBytes ?? 16 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 200;
    this.hooks = options.hooks ?? {};
  }

  public static async create(
    boundary: RepositoryBoundary,
    storageDirectory: string,
    options: CheckpointStoreOptions = {},
  ): Promise<CheckpointStore> {
    const lexicalStorage = await canonicalizeProspectivePath(storageDirectory);
    if (
      options.allowInsideRepository !== true &&
      isWithin(boundary.root, lexicalStorage)
    ) {
      throw new AgentError(
        "CONFIG_INVALID",
        "Checkpoint storage must be outside the repository unless explicitly approved",
        { storageDirectory: lexicalStorage },
      );
    }
    await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
    const canonicalStorage = await realpath(storageDirectory);
    if (
      options.allowInsideRepository !== true &&
      isWithin(boundary.root, canonicalStorage)
    ) {
      throw new AgentError(
        "CONFIG_INVALID",
        "Checkpoint storage must be outside the repository unless explicitly approved",
        { storageDirectory: canonicalStorage },
      );
    }
    return new CheckpointStore(boundary, canonicalStorage, options);
  }

  public async createCheckpoint(
    untrustedPaths: readonly string[],
    operationId?: string,
  ): Promise<CheckpointSummary> {
    if (operationId !== undefined && !isOperationId(operationId)) {
      throw new AgentError("PROTOCOL_INVALID", "Checkpoint operation identifier is invalid");
    }
    const normalizedPaths = new Map<string, string>();
    for (const value of untrustedPaths) {
      const normalized = normalizeRepositoryPath(value);
      const key = this.boundary.pathKey(normalized);
      if (normalizedPaths.has(key)) {
        throw new AgentError("PROTOCOL_INVALID", "Checkpoint paths contain filesystem aliases", {
          path: normalized,
        });
      }
      normalizedPaths.set(key, normalized);
    }
    const paths = [...normalizedPaths.values()].sort();
    if (paths.length === 0 || paths.length > this.maxFiles) {
      throw new AgentError("BUDGET_EXCEEDED", "Checkpoint file count is outside the configured bound", {
        fileCount: paths.length,
        maxFiles: this.maxFiles,
      });
    }

    const id = newId("checkpoint");
    const checkpointDirectory = path.join(this.storageDirectory, id);
    const blobDirectory = path.join(checkpointDirectory, "blobs");
    await mkdir(blobDirectory, { recursive: true, mode: 0o700 });
    const entries: CheckpointEntry[] = [];
    let totalBytes = 0;

    try {
      for (let index = 0; index < paths.length; index += 1) {
        const relativePath = paths[index];
        if (relativePath === undefined) {
          throw new AgentError("INTERNAL_ERROR", "Checkpoint path unexpectedly missing");
        }
        const resolved = await this.boundary.resolve(relativePath, { allowMissingLeaf: true });
        if (!resolved.exists) {
          entries.push({
            path: relativePath,
            existed: false,
            sizeBytes: 0,
            sha256: null,
            mode: null,
            blob: null,
          });
          continue;
        }
        const existing = await this.boundary.resolveExistingFile(relativePath);
        const entryStat = await stat(existing.absolutePath);
        if (entryStat.size > MAX_PINNED_FILE_BYTES) {
          throw new AgentError(
            "BUDGET_EXCEEDED",
            "Checkpoint file exceeds the pinned filesystem protocol limit",
            {
              path: relativePath,
              sizeBytes: entryStat.size,
              protocolLimit: MAX_PINNED_FILE_BYTES,
            },
          );
        }
        await this.hooks.beforeCheckpointFileRead?.(relativePath);
        const source = await readRegularFile(
          existing.absolutePath,
          relativePath,
          MAX_PINNED_FILE_BYTES,
        );
        const bytes = source.bytes;
        totalBytes += bytes.length;
        if (totalBytes > this.maxCheckpointBytes) {
          throw new AgentError("BUDGET_EXCEEDED", "Checkpoint exceeds the configured size limit", {
            totalBytes,
            maxBytes: this.maxCheckpointBytes,
          });
        }
        const blob = `${index}.bin`;
        await writeFile(path.join(blobDirectory, blob), bytes, {
          flag: "wx",
          mode: 0o600,
          flush: true,
        });
        entries.push({
          path: relativePath,
          existed: true,
          sizeBytes: bytes.length,
          sha256: sha256(bytes),
          mode: source.mode,
          blob,
        });
      }

      const body: CheckpointBody = {
        version: CHECKPOINT_VERSION,
        id,
        createdAt: new Date().toISOString(),
        repositoryFingerprint: repositoryFingerprint(this.boundary),
        ...(operationId === undefined ? {} : { operationId }),
        entries,
        totalBytes,
      };
      const manifest: CheckpointManifest = { ...body, integrity: sha256(stableJson(body)) };
      const temporaryManifest = path.join(checkpointDirectory, "manifest.json.tmp");
      await writeFile(temporaryManifest, `${stableJson(manifest)}\n`, {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      await rename(temporaryManifest, path.join(checkpointDirectory, "manifest.json"));
      return summary(manifest);
    } catch (error) {
      await rm(checkpointDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  public async verify(checkpointId: string): Promise<CheckpointSummary> {
    return summary(await this.loadAndVerify(checkpointId));
  }

  /**
   * Durably binds the target directory and each flat mutation artifact to the
   * filesystem objects created by PatchEngine before target installation.
   */
  public async recordMutationArtifacts(
    checkpointId: string,
    artifacts: readonly MutationArtifactIdentity[],
  ): Promise<void> {
    const manifest = await this.loadAndVerify(checkpointId);
    if (manifest.sealedAt !== undefined) {
      throw new AgentError("RECOVERY_REQUIRED", "Sealed checkpoint cannot accept mutation artifacts", {
        checkpointId,
      });
    }
    const normalized = new Map<string, CheckpointMutationArtifact>();
    for (const artifact of artifacts) {
      const normalizedPath = normalizeRepositoryPath(artifact.path);
      const key = this.boundary.pathKey(normalizedPath);
      if (
        normalizedPath !== artifact.path ||
        normalized.has(key) ||
        !validArtifactIdentity(artifact.directory) ||
        (artifact.temporary !== undefined && !validMutationFileIdentity(artifact.temporary)) ||
        (artifact.backup !== undefined && !validMutationFileIdentity(artifact.backup)) ||
        (artifact.probe !== undefined && !validMutationFileIdentity(artifact.probe)) ||
        (artifact.installAttempted !== undefined && artifact.installAttempted !== true)
      ) {
        throw new AgentError("PROTOCOL_INVALID", "Mutation artifact identity is invalid", {
          checkpointId,
          path: artifact.path,
        });
      }
      normalized.set(key, {
        path: normalizedPath,
        directory: storeDirectoryIdentity(artifact.directory),
        temporary:
          artifact.temporary === undefined ? null : storeArtifactIdentity(artifact.temporary),
        backup: artifact.backup === undefined ? null : storeArtifactIdentity(artifact.backup),
        probe: artifact.probe === undefined ? null : storeArtifactIdentity(artifact.probe),
        ...(artifact.installAttempted === true ? { installAttempted: true } : {}),
      });
    }
    if (
      normalized.size !== manifest.entries.length ||
      manifest.entries.some((entry) => !normalized.has(this.boundary.pathKey(entry.path)))
    ) {
      throw new AgentError("RECOVERY_REQUIRED", "Mutation artifact inventory is incomplete", {
        checkpointId,
      });
    }
    const mutationArtifacts = manifest.entries.map((entry) => {
      const artifact = normalized.get(this.boundary.pathKey(entry.path));
      if (artifact === undefined) {
        throw new AgentError("RECOVERY_REQUIRED", "Mutation artifact inventory is incomplete", {
          checkpointId,
          path: entry.path,
        });
      }
      return artifact;
    });
    if (manifest.mutationArtifacts !== undefined) {
      for (let index = 0; index < mutationArtifacts.length; index += 1) {
        const prior = manifest.mutationArtifacts[index];
        const next = mutationArtifacts[index];
        if (
          prior === undefined ||
          next === undefined ||
          prior.path !== next.path ||
          stableJson(prior.directory) !== stableJson(next.directory) ||
          (prior.temporary !== null &&
            !artifactEvidenceCanAdvance(prior.temporary, next.temporary)) ||
          (prior.backup !== null && !artifactEvidenceCanAdvance(prior.backup, next.backup)) ||
          (prior.probe != null && !artifactEvidenceCanAdvance(prior.probe, next.probe ?? null)) ||
          (prior.installAttempted === true && next.installAttempted !== true)
        ) {
          throw new AgentError("RECOVERY_REQUIRED", "Mutation artifact identity was already bound", {
            checkpointId,
          });
        }
      }
    }
    const { integrity: _integrity, ...priorBody } = manifest;
    const body: CheckpointBody = { ...priorBody, mutationArtifacts };
    await this.replaceManifest({ ...body, integrity: sha256(stableJson(body)) });
  }

  /**
   * Loads checkpoint before-images through the same integrity boundary used by
   * rollback. Returned buffers are local repository data and must still pass
   * path/disclosure policy before leaving the repository layer.
   */
  public async snapshot(checkpointId: string): Promise<CheckpointSnapshot> {
    const manifest = await this.loadAndVerify(checkpointId);
    const checkpointDirectory = path.join(this.storageDirectory, checkpointId);
    const entries: CheckpointFileSnapshot[] = [];
    for (const entry of manifest.entries) {
      if (!entry.existed) {
        entries.push({
          path: entry.path,
          existed: false,
          bytes: null,
          mode: null,
          sha256: null,
        });
        continue;
      }
      if (entry.blob === null || entry.sha256 === null || entry.mode === null) {
        throw new AgentError("CHECKPOINT_CORRUPT", "Verified checkpoint entry became invalid", {
          checkpointId,
        });
      }
      // Recheck after the manifest verification so a blob replacement between
      // verification and this read cannot cross the snapshot boundary.
      const bytes = await readCheckpointBytes(
        path.join(checkpointDirectory, "blobs", entry.blob),
        `${checkpointId}/${entry.blob}`,
        this.maxCheckpointBytes,
        entry.sizeBytes,
        entry.sha256,
      );
      entries.push({
        path: entry.path,
        existed: true,
        bytes,
        mode: entry.mode,
        sha256: entry.sha256,
      });
    }
    return {
      id: manifest.id,
      createdAt: manifest.createdAt,
      ...(manifest.operationId === undefined ? {} : { operationId: manifest.operationId }),
      entries,
    };
  }

  /**
   * Returns the newest integrity-verified checkpoint in this session store.
   * The optional operation filter recovers the durable mutation intent even
   * when a process stopped before SessionState learned the checkpoint ID.
   */
  public async latest(operationId?: string): Promise<CheckpointSummary | undefined> {
    if (operationId !== undefined && !isOperationId(operationId)) {
      throw new AgentError("PROTOCOL_INVALID", "Checkpoint operation identifier is invalid");
    }
    const directoryEntries = await readdir(this.storageDirectory, { withFileTypes: true });
    const checkpoints: CheckpointSummary[] = [];
    for (const entry of directoryEntries) {
      if (!entry.isDirectory() || !/^checkpoint_[0-9a-f-]{36}$/iu.test(entry.name)) continue;
      const manifest = await this.loadAndVerify(entry.name);
      if (operationId === undefined || manifest.operationId === operationId) {
        checkpoints.push(summary(manifest));
      }
    }
    checkpoints.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    return checkpoints.at(-1);
  }

  /**
   * Records the exact post-mutation hashes. Sealing turns rollback into a
   * compare-and-restore operation so later user edits cannot be overwritten
   * silently. An unsealed checkpoint is an interrupted transaction. It remains
   * recoverable, but only through the explicit force path because the harness
   * cannot distinguish partial agent writes from later user edits.
   */
  public async seal(
    checkpointId: string,
    states: readonly CheckpointPostState[],
    now = new Date().toISOString(),
  ): Promise<CheckpointSummary> {
    const manifest = await this.loadAndVerify(checkpointId);
    const normalizedStates = new Map<string, { readonly sha256: string | null; readonly mode: number | null }>();
    for (const state of states) {
      const normalized = normalizeRepositoryPath(state.path);
      const key = this.boundary.pathKey(normalized);
      if (
        normalizedStates.has(key) ||
        (state.sha256 !== null && !/^[0-9a-f]{64}$/u.test(state.sha256)) ||
        (state.mode !== null &&
          (!Number.isSafeInteger(state.mode) || state.mode < 0 || state.mode > 0o777)) ||
        ((state.sha256 === null) !== (state.mode === null))
      ) {
        throw new AgentError("PROTOCOL_INVALID", "Checkpoint post-state inventory is invalid", {
          path: state.path,
        });
      }
      normalizedStates.set(key, { sha256: state.sha256, mode: state.mode });
    }
    if (normalizedStates.size !== manifest.entries.length) {
      throw new AgentError("RECOVERY_REQUIRED", "Checkpoint post-state inventory is incomplete", {
        checkpointId,
      });
    }
    const entries = manifest.entries.map((entry) => {
      const entryKey = this.boundary.pathKey(entry.path);
      if (!normalizedStates.has(entryKey)) {
        throw new AgentError("RECOVERY_REQUIRED", "Checkpoint post-state inventory path does not match", {
          checkpointId,
          path: entry.path,
        });
      }
      const postState = normalizedStates.get(entryKey);
      if (postState === undefined) {
        throw new AgentError("RECOVERY_REQUIRED", "Checkpoint post-state inventory path does not match", {
          checkpointId,
          path: entry.path,
        });
      }
      return {
        ...entry,
        expectedAfter: {
          existed: postState.sha256 !== null,
          sha256: postState.sha256,
          mode: postState.mode,
        },
      };
    });
    if (manifest.sealedAt !== undefined) {
      if (stableJson(entries) !== stableJson(manifest.entries)) {
        throw new AgentError("RECOVERY_REQUIRED", "Checkpoint was already sealed with a different post-state", {
          checkpointId,
        });
      }
      return summary(manifest);
    }
    const { integrity: _integrity, ...priorBody } = manifest;
    const mutationArtifacts = priorBody.mutationArtifacts?.map((artifact) => ({
      ...artifact,
      temporary: null,
      backup: null,
      probe: null,
    }));
    const body: CheckpointBody = {
      ...priorBody,
      entries,
      sealedAt: now,
      ...(mutationArtifacts === undefined ? {} : { mutationArtifacts }),
    };
    const sealed: CheckpointManifest = { ...body, integrity: sha256(stableJson(body)) };
    await this.replaceManifest(sealed);
    return summary(sealed);
  }

  public async rollback(checkpointId: string, options: RollbackOptions = {}): Promise<CheckpointSummary> {
    let manifest = await this.loadAndVerify(checkpointId);
    const forced = manifest.rollback?.forced ?? options.force === true;
    if (manifest.sealedAt === undefined && !forced) {
      throw new AgentError(
        "STALE_STATE",
        "Interrupted checkpoint has no verified post-mutation state; reconcile it or use the explicit force override",
        { checkpointId },
      );
    }
    const rollbackState =
      manifest.rollback === undefined
        ? await this.preflightRollback(
            manifest,
            manifest.sealedAt !== undefined && !forced,
          )
        : await this.resumeRollback(manifest);
    if (manifest.rollback === undefined) {
      manifest = await this.persistRollbackState(manifest, rollbackState, "applying", forced);
    }
    if (manifest.rollback?.phase === "reverted") {
      verifyPreRollbackTargets(rollbackState);
      await cleanupRollbackArtifacts(rollbackState);
      await this.clearRollbackState(manifest);
      throw new AgentError(
        "RECOVERY_REQUIRED",
        "A prior rollback attempt failed; its pre-rollback target state was restored",
        { checkpointId },
      );
    }
    if (manifest.rollback?.phase === "reverting") {
      try {
        await this.restoreSnapshots(manifest, rollbackState);
        verifyPreRollbackTargets(rollbackState);
        manifest = await this.persistRollbackState(manifest, rollbackState, "reverted", forced);
        await cleanupRollbackArtifacts(rollbackState);
        await this.clearRollbackState(manifest);
      } catch (error) {
        throw new AgentError(
          "RECOVERY_REQUIRED",
          "Interrupted rollback recovery remains incomplete",
          { checkpointId },
          { cause: error },
        );
      }
      throw new AgentError(
        "RECOVERY_REQUIRED",
        "An interrupted rollback was safely reverted to its pre-rollback target state",
        { checkpointId },
      );
    }

    try {
      if (manifest.rollback?.phase !== "restored") {
        await this.restoreManifest(manifest, rollbackState);
        verifyRollbackTargets(rollbackState);
        manifest = await this.persistRollbackState(manifest, rollbackState, "restored", forced);
      } else {
        verifyRollbackTargets(rollbackState);
      }
    } catch (error) {
      if (
        error instanceof AgentError &&
        error.code === "UNSUPPORTED_FILE" &&
        rollbackState.every((snapshot) => !snapshot.targetMutated)
      ) {
        try {
          await cleanupRollbackArtifacts(rollbackState);
          await this.clearRollbackState(manifest);
        } catch (cleanupError) {
          throw new AgentError(
            "RECOVERY_REQUIRED",
            "Rollback hard-link preflight failed and staged artifact cleanup is incomplete",
            { checkpointId },
            { cause: cleanupError },
          );
        }
        throw error;
      }
      if (manifest.rollback?.phase === "restored") {
        throw new AgentError(
          "RECOVERY_REQUIRED",
          "Restored checkpoint target changed before rollback cleanup completed",
          { checkpointId },
          { cause: error },
        );
      }
      try {
        manifest = await this.persistRollbackState(manifest, rollbackState, "reverting", forced);
        await this.restoreSnapshots(manifest, rollbackState);
        verifyPreRollbackTargets(rollbackState);
        manifest = await this.persistRollbackState(manifest, rollbackState, "reverted", forced);
        await cleanupRollbackArtifacts(rollbackState);
      } catch (restoreError) {
        throw new AgentError(
          "RECOVERY_REQUIRED",
          "Checkpoint rollback failed and the pre-rollback state could not be restored",
          { checkpointId, restoreError: String(restoreError) },
          { cause: error },
        );
      }
      await this.clearRollbackState(manifest);
      throw new AgentError(
        "RECOVERY_REQUIRED",
        "Checkpoint rollback failed; the pre-rollback state was restored",
        { checkpointId },
        { cause: error },
      );
    }
    try {
      await cleanupRollbackArtifacts(rollbackState);
      for (const snapshot of rollbackState) {
        await cleanupMutationArtifacts(
          snapshot.absoluteTarget,
          snapshot.entry.path,
          snapshot.checkpointId,
          snapshot.artifact,
        );
      }
    } catch (error) {
      throw new AgentError(
        "RECOVERY_REQUIRED",
        "Checkpoint content was restored but rollback artifact cleanup is incomplete",
        { checkpointId },
        { cause: error },
      );
    }
    await this.hooks.afterRollbackCleanup?.();
    // Keep the authenticated terminal marker. The CLI audit/state handoff is
    // a separate durable transaction; retaining "restored" makes a retry
    // idempotent if the process dies anywhere in that handoff.
    return summary(manifest);
  }

  private async replaceManifest(manifest: CheckpointManifest): Promise<void> {
    const destination = path.join(this.storageDirectory, manifest.id, "manifest.json");
    const temporary = `${destination}.${newId("seal")}.tmp`;
    try {
      await writeFile(temporary, `${stableJson(manifest)}\n`, {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async loadAndVerify(checkpointId: string): Promise<CheckpointManifest> {
    if (!/^checkpoint_[0-9a-f-]{36}$/iu.test(checkpointId)) {
      throw new AgentError("CHECKPOINT_CORRUPT", "Checkpoint identifier is invalid", {
        checkpointId,
      });
    }
    const checkpointDirectory = path.join(this.storageDirectory, checkpointId);
    const manifestPath = path.join(checkpointDirectory, "manifest.json");
    let raw: string;
    try {
      raw = (
        await readCheckpointBytes(
          manifestPath,
          `${checkpointId}/manifest.json`,
          1024 * 1024,
        )
      ).toString("utf8");
    } catch (error) {
      if (error instanceof AgentError) {
        throw error;
      }
      throw new AgentError(
        "CHECKPOINT_CORRUPT",
        "Checkpoint manifest is unavailable",
        { checkpointId },
        { cause: error },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new AgentError(
        "CHECKPOINT_CORRUPT",
        "Checkpoint manifest is not valid JSON",
        { checkpointId },
        { cause: error },
      );
    }
    if (!isManifest(parsed)) {
      throw new AgentError("CHECKPOINT_CORRUPT", "Checkpoint manifest has an invalid shape", {
        checkpointId,
      });
    }
    const { integrity: _integrity, ...body } = parsed;
    if (sha256(stableJson(body)) !== parsed.integrity) {
      throw new AgentError("CHECKPOINT_CORRUPT", "Checkpoint manifest integrity check failed", {
        checkpointId,
      });
    }
    if (parsed.id !== checkpointId) {
      throw new AgentError("CHECKPOINT_CORRUPT", "Checkpoint manifest identifier does not match", {
        checkpointId,
      });
    }
    if (parsed.repositoryFingerprint !== repositoryFingerprint(this.boundary)) {
      throw new AgentError("CHECKPOINT_CORRUPT", "Checkpoint belongs to a different repository", {
        checkpointId,
      });
    }
    if (parsed.entries.length > this.maxFiles || parsed.totalBytes > this.maxCheckpointBytes) {
      throw new AgentError("CHECKPOINT_CORRUPT", "Checkpoint exceeds configured recovery limits", {
        checkpointId,
      });
    }

    const seen = new Set<string>();
    let observedTotal = 0;
    for (const entry of parsed.entries) {
      const normalized = normalizeRepositoryPath(entry.path);
      const key = this.boundary.pathKey(normalized);
      if (normalized !== entry.path || seen.has(key)) {
        throw new AgentError("CHECKPOINT_CORRUPT", "Checkpoint contains an unsafe path", {
          checkpointId,
          path: entry.path,
        });
      }
      seen.add(key);
      try {
        await this.boundary.resolve(normalized, { allowMissingLeaf: true });
      } catch (error) {
        const rollbackEntry = parsed.rollback?.entries.find(
          (candidate) => this.boundary.pathKey(candidate.path) === key,
        );
        const mutationArtifact = parsed.mutationArtifacts?.find(
          (candidate) => this.boundary.pathKey(candidate.path) === key,
        );
        if (
          !(error instanceof AgentError) ||
          error.code !== "UNSUPPORTED_FILE" ||
          error.details.linkCount !== 2 ||
          !authenticatedTransactionHardLink(
            this.boundary.root,
            entry.path,
            parsed.id,
            mutationArtifact,
            rollbackEntry,
          )
        ) {
          throw error;
        }
        // A crash during a no-overwrite probe or after installation can leave
        // the target hard linked to an authenticated transaction leaf.
        // Recovery validates both names and identities before proceeding.
      }
      if (!entry.existed) {
        if (
          entry.blob !== null ||
          entry.sha256 !== null ||
          entry.mode !== null ||
          entry.sizeBytes !== 0
        ) {
          throw new AgentError("CHECKPOINT_CORRUPT", "Absent checkpoint entry is inconsistent", {
            checkpointId,
            path: entry.path,
          });
        }
        continue;
      }
      if (entry.blob === null || !/^\d+\.bin$/u.test(entry.blob) || entry.sha256 === null) {
        throw new AgentError("CHECKPOINT_CORRUPT", "Checkpoint blob reference is invalid", {
          checkpointId,
          path: entry.path,
        });
      }
      const blobPath = path.join(checkpointDirectory, "blobs", entry.blob);
      const bytes = await readCheckpointBytes(
        blobPath,
        `${checkpointId}/${entry.blob}`,
        this.maxCheckpointBytes,
        entry.sizeBytes,
        entry.sha256,
      );
      observedTotal += bytes.length;
    }
    if (parsed.mutationArtifacts !== undefined) {
      if (parsed.mutationArtifacts.length !== parsed.entries.length) {
        throw new AgentError("CHECKPOINT_CORRUPT", "Mutation artifact inventory is incomplete", {
          checkpointId,
        });
      }
      const artifactPaths = new Set<string>();
      for (const artifact of parsed.mutationArtifacts) {
        const normalized = normalizeRepositoryPath(artifact.path);
        const key = this.boundary.pathKey(normalized);
        if (
          normalized !== artifact.path ||
          artifactPaths.has(key) ||
          !seen.has(key)
        ) {
          throw new AgentError("CHECKPOINT_CORRUPT", "Mutation artifact path is invalid", {
            checkpointId,
            path: artifact.path,
          });
        }
        artifactPaths.add(key);
      }
    }
    if (parsed.rollback !== undefined) {
      if (parsed.rollback.entries.length !== parsed.entries.length) {
        throw new AgentError("CHECKPOINT_CORRUPT", "Rollback state inventory is incomplete", {
          checkpointId,
        });
      }
      const rollbackPaths = new Set<string>();
      for (const rollbackEntry of parsed.rollback.entries) {
        const normalized = normalizeRepositoryPath(rollbackEntry.path);
        const key = this.boundary.pathKey(normalized);
        if (
          normalized !== rollbackEntry.path ||
          rollbackPaths.has(key) ||
          !seen.has(key)
        ) {
          throw new AgentError("CHECKPOINT_CORRUPT", "Rollback state path is invalid", {
            checkpointId,
            path: rollbackEntry.path,
          });
        }
        rollbackPaths.add(key);
      }
    }
    if (observedTotal !== parsed.totalBytes) {
      throw new AgentError("CHECKPOINT_CORRUPT", "Checkpoint byte inventory is inconsistent", {
        checkpointId,
      });
    }
    return parsed;
  }

  private async preflightRollback(
    manifest: CheckpointManifest,
    requireExpectedPostState: boolean,
  ): Promise<readonly RollbackSnapshot[]> {
    const recordedArtifacts = new Map(
      (manifest.mutationArtifacts ?? []).map((artifact) => [
        this.boundary.pathKey(artifact.path),
        artifact,
      ]),
    );
    const snapshots: RollbackSnapshot[] = [];
    for (const entry of manifest.entries) {
      if (entry.existed && entry.sizeBytes > MAX_PINNED_FILE_BYTES) {
        throw new AgentError(
          "RECOVERY_REQUIRED",
          "Checkpoint entry exceeds the pinned rollback protocol limit; restore it manually",
          {
            checkpointId: manifest.id,
            path: entry.path,
            sizeBytes: entry.sizeBytes,
            protocolLimit: MAX_PINNED_FILE_BYTES,
          },
        );
      }
      let target: { readonly absolutePath: string; readonly exists: boolean };
      try {
        target = await this.boundary.resolve(entry.path, { allowMissingLeaf: true });
      } catch (error) {
        const recorded = recordedArtifacts.get(this.boundary.pathKey(entry.path));
        if (
          !(error instanceof AgentError) ||
          error.code !== "UNSUPPORTED_FILE" ||
          error.details.linkCount !== 2 ||
          !authenticatedTransactionHardLink(
            this.boundary.root,
            entry.path,
            manifest.id,
            recorded,
            manifest.rollback?.entries.find(
              (candidate) =>
                this.boundary.pathKey(candidate.path) ===
                this.boundary.pathKey(entry.path),
            ),
          )
        ) {
          throw error;
        }
        target = {
          absolutePath: path.resolve(this.boundary.root, entry.path),
          exists: true,
        };
      }
      const artifact =
        recordedArtifacts.get(this.boundary.pathKey(entry.path)) ??
        await this.legacyRecoveryArtifact(entry.path, target.absolutePath);
      const current = target.exists
        ? pinnedFileState(runPinnedMutation(
            path.dirname(target.absolutePath),
            storedDirectoryIdentity(artifact),
            { kind: "read", name: path.basename(target.absolutePath) },
          ))
        : (runPinnedMutation(
            path.dirname(target.absolutePath),
            storedDirectoryIdentity(artifact),
            { kind: "verify_absent", name: path.basename(target.absolutePath) },
          ), null);
      if (requireExpectedPostState) {
        if (entry.expectedAfter === undefined) {
          throw new AgentError("CHECKPOINT_CORRUPT", "Sealed checkpoint lacks post-state evidence", {
            checkpointId: manifest.id,
            path: entry.path,
          });
        }
        if (
          (current !== null) !== entry.expectedAfter.existed ||
          (current?.sha256 ?? null) !== entry.expectedAfter.sha256 ||
          entry.expectedAfter.mode === undefined ||
          (current?.mode ?? null) !== entry.expectedAfter.mode
        ) {
          if (entry.expectedAfter.mode === undefined) {
            throw new AgentError(
              "RECOVERY_REQUIRED",
              "Legacy sealed checkpoint lacks post-mutation mode evidence; use explicit force after reconciliation",
              { checkpointId: manifest.id, path: entry.path },
            );
          }
          throw new AgentError("STALE_STATE", "Rollback target changed after the agent mutation", {
            checkpointId: manifest.id,
            path: entry.path,
            expectedSha256: entry.expectedAfter.sha256,
            actualSha256: current?.sha256 ?? null,
            expectedMode: entry.expectedAfter.mode,
            actualMode: current?.mode ?? null,
          });
        }
      }
      await preflightMutationArtifacts(target.absolutePath, entry.path, manifest.id, artifact);
      const rollbackArtifacts = checkpointRollbackArtifactPaths(
        target.absolutePath,
        entry.path,
        manifest.id,
      );
      for (const rollbackArtifact of [
        rollbackArtifacts.temporaryPath,
        rollbackArtifacts.backupPath,
        rollbackArtifacts.probePath,
      ]) {
        runPinnedMutation(
          path.dirname(target.absolutePath),
          storedDirectoryIdentity(artifact),
          { kind: "verify_absent", name: path.basename(rollbackArtifact) },
        );
      }
      snapshots.push({
        checkpointId: manifest.id,
        entry,
        absoluteTarget: target.absolutePath,
        artifact,
        current,
        temporary: null,
        backup: null,
        installed: null,
        installAttempted: false,
        revertInstallAttempted: false,
        targetMutated: false,
      });
    }
    return snapshots;
  }

  private async legacyRecoveryArtifact(
    repositoryPath: string,
    absoluteTarget: string,
  ): Promise<CheckpointMutationArtifact> {
    const parent = path.dirname(absoluteTarget);
    const linkState = await lstat(parent, { bigint: true });
    const parentState = await stat(parent, { bigint: true });
    if (
      linkState.isSymbolicLink() ||
      !parentState.isDirectory() ||
      (await realpath(parent)) !== parent
    ) {
      throw new AgentError("RECOVERY_REQUIRED", "Legacy checkpoint parent is not stable", {
        path: repositoryPath,
      });
    }
    return {
      path: repositoryPath,
      directory: pinnedIdentityFromBigInts(parentState.dev, parentState.ino),
      temporary: null,
      backup: null,
      probe: null,
    };
  }

  private async restoreManifest(
    manifest: CheckpointManifest,
    snapshots: readonly RollbackSnapshot[],
  ): Promise<void> {
    const checkpointDirectory = path.join(this.storageDirectory, manifest.id);
    // Stage all before-images first. Capability probing below is complete for
    // the entire transaction before any repository target is parked.
    for (const snapshot of snapshots) {
      const { entry, artifact } = snapshot;
      await this.hooks.beforeRestoreTarget?.(entry.path);
      const paths = checkpointRollbackArtifactPaths(
        snapshot.absoluteTarget,
        entry.path,
        manifest.id,
      );
      const directory = storedDirectoryIdentity(artifact);
      if (entry.existed && snapshot.temporary === null) {
        if (entry.blob === null || entry.mode === null || entry.sha256 === null) {
          throw new AgentError("CHECKPOINT_CORRUPT", "Verified checkpoint entry became invalid");
        }
        const bytes = await readCheckpointBytes(
          path.join(checkpointDirectory, "blobs", entry.blob),
          `${manifest.id}/${entry.blob}`,
          this.maxCheckpointBytes,
          entry.sizeBytes,
          entry.sha256,
        );
        snapshot.temporary = writeOrReconcileArtifact(
          path.dirname(snapshot.absoluteTarget),
          directory,
          path.basename(paths.temporaryPath),
          bytes,
          entry.mode,
        );
        await this.persistRollbackState(manifest, snapshots, "applying");
        await this.hooks.afterRollbackStage?.(entry.path);
      }
    }

    for (const snapshot of snapshots) {
      const source = snapshot.temporary ?? snapshot.current;
      if (source === null) continue;
      const paths = checkpointRollbackArtifactPaths(
        snapshot.absoluteTarget,
        snapshot.entry.path,
        manifest.id,
      );
      const directory = storedDirectoryIdentity(snapshot.artifact);
      try {
        runPinnedMutation(path.dirname(snapshot.absoluteTarget), directory, {
          kind: "probe_link",
          source:
            snapshot.temporary === null
              ? path.basename(snapshot.absoluteTarget)
              : path.basename(paths.temporaryPath),
          destination: path.basename(paths.probePath),
          sourceIdentity: fileIdentity(source),
          sourceSha256: source.sha256,
          sourceMode: source.mode,
          ...(this.hooks.failRollbackHardLinkProbe?.(snapshot.entry.path) === true
            ? { failBeforeLink: true }
            : {}),
        });
      } catch (error) {
        const probe = tryReadPinnedExact(
          path.dirname(snapshot.absoluteTarget),
          directory,
          path.basename(paths.probePath),
          fileIdentity(source),
          source.sha256,
          source.mode,
        );
        if (probe !== null) {
          removePinnedArtifactOrConfirmAbsent(
            path.dirname(snapshot.absoluteTarget),
            directory,
            path.basename(paths.probePath),
            probe,
          );
        }
        if (
          tryReadPinnedExact(
            path.dirname(snapshot.absoluteTarget),
            directory,
            snapshot.temporary === null
              ? path.basename(snapshot.absoluteTarget)
              : path.basename(paths.temporaryPath),
            fileIdentity(source),
            source.sha256,
            source.mode,
          ) === null
        ) {
          throw new AgentError(
            "RECOVERY_REQUIRED",
            "Rollback hard-link probe source changed during preflight",
            { checkpointId: manifest.id, path: snapshot.entry.path },
            { cause: error },
          );
        }
        throw new AgentError(
          "UNSUPPORTED_FILE",
          "Repository filesystem does not support safe no-overwrite hard-link rollback",
          { checkpointId: manifest.id, path: snapshot.entry.path },
          { cause: error },
        );
      }
    }

    for (const snapshot of snapshots) {
      const { entry, artifact, current } = snapshot;
      const paths = checkpointRollbackArtifactPaths(
        snapshot.absoluteTarget,
        entry.path,
        manifest.id,
      );
      const directory = storedDirectoryIdentity(artifact);
      if (current !== null && snapshot.backup === null) {
        snapshot.backup = captureOrReconcile(
          path.dirname(snapshot.absoluteTarget),
          directory,
          path.basename(snapshot.absoluteTarget),
          path.basename(paths.backupPath),
          current,
        );
        snapshot.targetMutated = true;
        await this.persistRollbackState(manifest, snapshots, "applying");
        await this.hooks.afterRollbackCapture?.(entry.path);
      }
      if (snapshot.temporary !== null && snapshot.installed === null) {
        if (snapshot.installAttempted) {
          throw new AgentError(
            "RECOVERY_REQUIRED",
            "An unacknowledged rollback installation is now absent; preserving that deletion",
            { checkpointId: manifest.id, path: entry.path },
          );
        }
        snapshot.installAttempted = true;
        await this.persistRollbackState(manifest, snapshots, "applying");
        snapshot.installed = installOrReconcile(
          path.dirname(snapshot.absoluteTarget),
          directory,
          path.basename(paths.temporaryPath),
          path.basename(snapshot.absoluteTarget),
          snapshot.temporary,
          this.hooks.deleteRollbackInstallBeforeResponse?.(entry.path) === true,
        );
        snapshot.installAttempted = false;
        snapshot.targetMutated = true;
        await this.persistRollbackState(manifest, snapshots, "applying");
        await this.hooks.afterRollbackInstall?.(entry.path);
      }
    }
  }

  private async restoreSnapshots(
    manifest: CheckpointManifest,
    snapshots: readonly RollbackSnapshot[],
  ): Promise<void> {
    // Undo the transaction in reverse target order so a later captured target
    // is restored before an earlier target's fallback can itself fail.
    for (const snapshot of [...snapshots].reverse()) {
      if (!snapshot.targetMutated) continue;
      await this.hooks.beforeRestoreSnapshot?.(snapshot.entry.path);
      const directory = storedDirectoryIdentity(snapshot.artifact);
      const paths = checkpointRollbackArtifactPaths(
        snapshot.absoluteTarget,
        snapshot.entry.path,
        snapshot.checkpointId,
      );
      if (snapshot.installed === null) {
        runPinnedMutation(
          path.dirname(snapshot.absoluteTarget),
          directory,
          { kind: "verify_absent", name: path.basename(snapshot.absoluteTarget) },
        );
        if (snapshot.installAttempted && snapshot.current !== null) {
          throw new Error(
            "Unacknowledged rollback installation is now absent; preserving the concurrent deletion",
          );
        }
      } else {
        if (snapshot.temporary !== null) {
          removePinnedArtifactOrConfirmAbsent(
            path.dirname(snapshot.absoluteTarget),
            directory,
            path.basename(paths.temporaryPath),
            snapshot.temporary,
          );
          snapshot.temporary = null;
          await this.persistRollbackState(manifest, snapshots, "reverting");
        }
        snapshot.temporary = captureOrReconcile(
          path.dirname(snapshot.absoluteTarget),
          directory,
          path.basename(snapshot.absoluteTarget),
          path.basename(paths.temporaryPath),
          snapshot.installed,
        );
        snapshot.installed = null;
        await this.persistRollbackState(manifest, snapshots, "reverting");
      }
      if (snapshot.current !== null) {
        if (snapshot.backup === null) {
          throw new Error("Rollback backup evidence is unavailable");
        }
        if (snapshot.revertInstallAttempted) {
          runPinnedMutation(
            path.dirname(snapshot.absoluteTarget),
            directory,
            { kind: "verify_absent", name: path.basename(snapshot.absoluteTarget) },
          );
          throw new Error(
            "Unacknowledged rollback recovery installation is now absent; preserving the concurrent deletion",
          );
        }
        snapshot.revertInstallAttempted = true;
        await this.persistRollbackState(manifest, snapshots, "reverting");
        installOrReconcile(
          path.dirname(snapshot.absoluteTarget),
          directory,
          path.basename(paths.backupPath),
          path.basename(snapshot.absoluteTarget),
          snapshot.backup,
          this.hooks.deleteRollbackRevertInstallBeforeResponse?.(snapshot.entry.path) === true,
        );
        snapshot.revertInstallAttempted = false;
        await this.hooks.afterRollbackRevertInstall?.(snapshot.entry.path);
      }
      snapshot.targetMutated = false;
      await this.persistRollbackState(manifest, snapshots, "reverting");
    }
  }

  private async persistRollbackState(
    manifest: CheckpointManifest,
    snapshots: readonly RollbackSnapshot[],
    phase: CheckpointRollbackState["phase"],
    forced = manifest.rollback?.forced ?? false,
  ): Promise<CheckpointManifest> {
    const current = await this.loadAndVerify(manifest.id);
    if (current.rollback?.forced !== undefined && current.rollback.forced !== forced) {
      throw new AgentError(
        "CHECKPOINT_CORRUPT",
        "Persisted rollback force decision changed",
        { checkpointId: manifest.id },
      );
    }
    const rollback: CheckpointRollbackState = {
      startedAt: current.rollback?.startedAt ?? new Date().toISOString(),
      forced: current.rollback?.forced ?? forced,
      phase,
      entries: snapshots.map((snapshot) => ({
        path: snapshot.entry.path,
        directory: snapshot.artifact.directory,
        current: snapshot.current === null ? null : storePinnedState(snapshot.current),
        temporary: snapshot.temporary === null ? null : storePinnedState(snapshot.temporary),
        backup: snapshot.backup === null ? null : storePinnedState(snapshot.backup),
        installed: snapshot.installed === null ? null : storePinnedState(snapshot.installed),
        ...(snapshot.installAttempted ? { installAttempted: true } : {}),
        ...(snapshot.revertInstallAttempted ? { revertInstallAttempted: true } : {}),
      })),
    };
    const { integrity: _integrity, ...priorBody } = current;
    const body: CheckpointBody = { ...priorBody, rollback };
    const updated: CheckpointManifest = { ...body, integrity: sha256(stableJson(body)) };
    await this.replaceManifest(updated);
    return updated;
  }

  private async clearRollbackState(manifest: CheckpointManifest): Promise<CheckpointManifest> {
    const current = await this.loadAndVerify(manifest.id);
    if (current.rollback === undefined) return current;
    const { integrity: _integrity, rollback: _rollback, ...body } = current;
    const updated: CheckpointManifest = { ...body, integrity: sha256(stableJson(body)) };
    await this.replaceManifest(updated);
    return updated;
  }

  private async resumeRollback(
    manifest: CheckpointManifest,
  ): Promise<readonly RollbackSnapshot[]> {
    const rollback = manifest.rollback;
    if (rollback === undefined) {
      throw new AgentError("CHECKPOINT_CORRUPT", "Rollback state disappeared during recovery", {
        checkpointId: manifest.id,
      });
    }
    const entries = new Map(
      rollback.entries.map((entry) => [this.boundary.pathKey(entry.path), entry]),
    );
    const snapshots: RollbackSnapshot[] = [];
    for (const entry of manifest.entries) {
      const recorded = entries.get(this.boundary.pathKey(entry.path));
      if (recorded === undefined) {
        throw new AgentError("CHECKPOINT_CORRUPT", "Rollback state inventory is incomplete", {
          checkpointId: manifest.id,
          path: entry.path,
        });
      }
      const absoluteTarget = path.resolve(this.boundary.root, entry.path);
      const artifact: CheckpointMutationArtifact = {
        path: entry.path,
        directory: recorded.directory,
        ...(manifest.mutationArtifacts?.find(
          (candidate) => this.boundary.pathKey(candidate.path) === this.boundary.pathKey(entry.path),
        )?.installAttempted === true
          ? { installAttempted: true }
          : {}),
        temporary:
          manifest.mutationArtifacts?.find(
            (candidate) => this.boundary.pathKey(candidate.path) === this.boundary.pathKey(entry.path),
          )?.temporary ?? null,
        backup:
          manifest.mutationArtifacts?.find(
            (candidate) => this.boundary.pathKey(candidate.path) === this.boundary.pathKey(entry.path),
          )?.backup ?? null,
        probe:
          manifest.mutationArtifacts?.find(
            (candidate) => this.boundary.pathKey(candidate.path) === this.boundary.pathKey(entry.path),
          )?.probe ?? null,
      };
      const parent = path.dirname(absoluteTarget);
      const directory = storedDirectoryIdentity(artifact);
      const paths = checkpointRollbackArtifactPaths(absoluteTarget, entry.path, manifest.id);
      const targetState = await readAnyPinned(parent, directory, path.basename(absoluteTarget));
      const targetIsRecordedTemporary =
        recorded.temporary !== null &&
        targetState !== null &&
        matchesStoredState(targetState, recorded.temporary);
      const temporary = await readRollbackArtifact(
        parent,
        directory,
        path.basename(paths.temporaryPath),
        recorded.temporary,
        entry.existed && entry.sha256 !== null && entry.mode !== null
          ? { sha256: entry.sha256, mode: entry.mode }
          : null,
        rollback.phase === "restored" ||
          rollback.phase === "reverted" ||
          (rollback.phase === "reverting" && targetIsRecordedTemporary),
      );
      const backup = await readRollbackArtifact(
        parent,
        directory,
        path.basename(paths.backupPath),
        recorded.backup,
        recorded.current,
        rollback.phase === "restored" || rollback.phase === "reverted",
      );
      let current: PinnedFileState | null = null;
      if (recorded.current !== null) {
        if (backup !== null && matchesStoredState(backup, recorded.current)) {
          current = backup;
        } else if (targetState !== null && matchesStoredState(targetState, recorded.current)) {
          current = targetState;
        } else if (rollback.phase === "applying" || rollback.phase === "reverting") {
          throw new AgentError(
            "RECOVERY_REQUIRED",
            "Persisted pre-rollback target evidence is missing",
            { checkpointId: manifest.id, path: entry.path },
          );
        }
      }
      const probe = await readAnyPinned(
        parent,
        directory,
        path.basename(paths.probePath),
      );
      if (probe !== null) {
        const probeSource = temporary ?? current;
        if (
          probeSource === null ||
          !samePinnedIdentity(probe, probeSource) ||
          probe.sha256 !== probeSource.sha256 ||
          probe.mode !== probeSource.mode
        ) {
          throw new AgentError(
            "RECOVERY_REQUIRED",
            "Interrupted rollback hard-link probe is not authentic",
            { checkpointId: manifest.id, path: entry.path },
          );
        }
        removePinnedArtifactOrConfirmAbsent(
          parent,
          directory,
          path.basename(paths.probePath),
          probe,
        );
      }
      let installed: PinnedFileState | null = null;
      let targetAlreadyReverted = false;
      if (
        rollback.phase === "restored" &&
        !entry.existed &&
        targetState === null
      ) {
        // A completed rollback of a created path is the authenticated absence;
        // its parked post-state may already have been cleaned.
      } else if (
        (rollback.phase === "reverting" || rollback.phase === "reverted") &&
        current !== null &&
        targetState !== null &&
        samePinnedIdentity(current, targetState) &&
        current.sha256 === targetState.sha256 &&
        current.mode === targetState.mode
      ) {
        // Fallback restored the exact pre-rollback inode.
        targetAlreadyReverted = true;
      } else if (
        (rollback.phase === "reverting" || rollback.phase === "reverted") &&
        recorded.current === null &&
        targetState === null &&
        temporary !== null &&
        recorded.installed !== null &&
        matchesStoredState(temporary, recorded.installed)
      ) {
        // Fallback restored the exact pre-rollback absence.
        targetAlreadyReverted = true;
      } else
      if (
        recorded.installed !== null &&
        targetState !== null &&
        matchesStoredState(targetState, recorded.installed)
      ) {
        installed = targetState;
      } else if (
        temporary !== null &&
        targetState !== null &&
        samePinnedIdentity(temporary, targetState) &&
        targetState.sha256 === temporary.sha256 &&
        targetState.mode === temporary.mode
      ) {
        installed = targetState;
      } else if (backup !== null && targetState === null) {
        // Capture completed and installation has not, or deletion is complete.
      } else if (
        current !== null &&
        targetState !== null &&
        samePinnedIdentity(current, targetState) &&
        targetState.sha256 === current.sha256 &&
        targetState.mode === current.mode &&
        backup === null
      ) {
        current = targetState;
      } else if (
        recorded.current === null &&
        targetState === null &&
        backup === null
      ) {
        // The original target was absent and no install has happened.
      } else {
        throw new AgentError(
          "RECOVERY_REQUIRED",
          "Rollback target or artifacts do not match the persisted transaction",
          { checkpointId: manifest.id, path: entry.path },
        );
      }
      if (recorded.installed !== null) {
        if (
          (installed === null ||
            !matchesStoredState(installed, recorded.installed)) &&
          !(
            rollback.phase === "reverting" &&
            temporary !== null &&
            matchesStoredState(temporary, recorded.installed) &&
            (targetState === null || targetAlreadyReverted)
          )
        ) {
          throw new AgentError(
            "RECOVERY_REQUIRED",
            "Persisted rollback installation evidence is missing",
            { checkpointId: manifest.id, path: entry.path },
          );
        }
      }
      snapshots.push({
        checkpointId: manifest.id,
        entry,
        absoluteTarget,
        artifact,
        current,
        temporary,
        backup,
        installed,
        installAttempted: recorded.installAttempted === true && installed === null,
        revertInstallAttempted:
          recorded.revertInstallAttempted === true && !targetAlreadyReverted,
        targetMutated:
          !targetAlreadyReverted &&
          (backup !== null || installed !== null || recorded.installAttempted === true),
      });
    }
    return snapshots;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function canonicalizeProspectivePath(candidate: string): Promise<string> {
  let cursor = path.resolve(candidate);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      const canonicalAncestor = await realpath(cursor);
      return path.join(canonicalAncestor, ...missingSegments.reverse());
    } catch (error) {
      if (
        error === null ||
        typeof error !== "object" ||
        !("code" in error) ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw error;
      }
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function checkpointMutationArtifactPaths(
  absoluteTarget: string,
  relativePath: string,
  checkpointId: string,
): {
  readonly temporaryPath: string;
  readonly backupPath: string;
  readonly probePath: string;
} {
  const key = sha256(relativePath).slice(0, 20);
  const prefix = path.join(path.dirname(absoluteTarget), `.cba-${checkpointId}-${key}`);
  return {
    temporaryPath: `${prefix}.new`,
    backupPath: `${prefix}.old`,
    probePath: `${prefix}.link-probe`,
  };
}

function checkpointRollbackArtifactPaths(
  absoluteTarget: string,
  relativePath: string,
  checkpointId: string,
): {
  readonly temporaryPath: string;
  readonly backupPath: string;
  readonly probePath: string;
} {
  const artifacts = checkpointMutationArtifactPaths(absoluteTarget, relativePath, checkpointId);
  return {
    temporaryPath: `${artifacts.temporaryPath}.rollback`,
    backupPath: `${artifacts.backupPath}.rollback`,
    probePath: `${artifacts.probePath}.rollback`,
  };
}

function authenticatedTransactionHardLink(
  repositoryRoot: string,
  relativePath: string,
  checkpointId: string,
  mutationArtifact: CheckpointMutationArtifact | undefined,
  rollbackEntry: CheckpointRollbackEntry | undefined,
): boolean {
  const directoryEvidence = mutationArtifact?.directory ?? rollbackEntry?.directory;
  if (directoryEvidence === undefined) return false;
  const directory: PinnedIdentity = {
    device: directoryEvidence.device,
    inode: directoryEvidence.inode,
  };
  const absoluteTarget = path.resolve(repositoryRoot, relativePath);
  const parent = path.dirname(absoluteTarget);
  let target: PinnedFileState | null;
  try {
    target = readAnyPinned(parent, directory, path.basename(absoluteTarget));
  } catch {
    return false;
  }
  if (target === null) return false;

  const mutationPaths = checkpointMutationArtifactPaths(
    absoluteTarget,
    relativePath,
    checkpointId,
  );
  const rollbackPaths = checkpointRollbackArtifactPaths(
    absoluteTarget,
    relativePath,
    checkpointId,
  );
  const candidates: Array<{
    readonly name: string;
    readonly evidence: StoredArtifactEvidence | null | undefined;
  }> = [
    { name: path.basename(mutationPaths.temporaryPath), evidence: mutationArtifact?.temporary },
    { name: path.basename(mutationPaths.backupPath), evidence: mutationArtifact?.backup },
    { name: path.basename(mutationPaths.probePath), evidence: mutationArtifact?.probe },
    { name: path.basename(rollbackPaths.temporaryPath), evidence: rollbackEntry?.temporary },
    { name: path.basename(rollbackPaths.backupPath), evidence: rollbackEntry?.backup },
    {
      name: path.basename(rollbackPaths.probePath),
      evidence: rollbackEntry?.temporary ?? rollbackEntry?.current,
    },
  ];
  for (const candidate of candidates) {
    if (
      candidate.evidence === null ||
      candidate.evidence === undefined ||
      !isStoredArtifactIdentity(candidate.evidence) ||
      !matchesStoredState(target, candidate.evidence)
    ) {
      continue;
    }
    try {
      const leaf = readAnyPinned(parent, directory, candidate.name);
      if (
        leaf !== null &&
        matchesStoredState(leaf, candidate.evidence) &&
        samePinnedIdentity(leaf, target)
      ) {
        return true;
      }
    } catch {
      // Try the next exact, deterministic transaction leaf.
    }
  }
  return false;
}

async function preflightMutationArtifacts(
  absoluteTarget: string,
  relativePath: string,
  checkpointId: string,
  expected: CheckpointMutationArtifact,
): Promise<void> {
  const artifacts = checkpointMutationArtifactPaths(absoluteTarget, relativePath, checkpointId);
  const directory = storedDirectoryIdentity(expected);
  for (const [artifactPath, identity] of [
    [artifacts.temporaryPath, expected.temporary],
    [artifacts.backupPath, expected.backup],
    [artifacts.probePath, expected.probe ?? null],
  ] as const) {
    if (identity === null) {
      runPinnedMutation(path.dirname(absoluteTarget), directory, {
        kind: "verify_absent",
        name: path.basename(artifactPath),
      });
      continue;
    }
    const current = readAnyPinned(
      path.dirname(absoluteTarget),
      directory,
      path.basename(artifactPath),
    );
    if (current === null) {
      // Non-null evidence is write-ahead: the artifact may be anticipated
      // before materialization or already consumed before sealing. Checkpoint
      // blobs remain authoritative. A present object must still match exactly.
      continue;
    }
    if (
      (isStoredArtifactIdentity(identity) && !matchesStoredState(current, identity)) ||
      (!isStoredArtifactIdentity(identity) &&
        (current.sha256 !== identity.sha256 || !modeMatches(identity.mode, current.mode)))
    ) {
      throw new AgentError(
        "RECOVERY_REQUIRED",
        "Mutation artifact changed before checkpoint rollback",
        { checkpointId, path: relativePath },
      );
    }
  }
}

async function readCheckpointBytes(
  filename: string,
  label: string,
  maxBytes: number,
  expectedSizeBytes?: number,
  expectedSha256?: string,
): Promise<Buffer> {
  try {
    return (
      await readRegularFile(filename, label, maxBytes, {
        ...(expectedSizeBytes === undefined ? {} : { sizeBytes: expectedSizeBytes }),
        ...(expectedSha256 === undefined ? {} : { sha256: expectedSha256 }),
      })
    ).bytes;
  } catch (error) {
    throw new AgentError(
      "CHECKPOINT_CORRUPT",
      "Checkpoint file failed bounded integrity verification",
      { file: label },
      { cause: error },
    );
  }
}

function writeOrReconcileArtifact(
  parent: string,
  directory: PinnedIdentity,
  name: string,
  bytes: Buffer,
  mode: number,
): PinnedFileState {
  try {
    const staged = pinnedFileState(runPinnedMutation(parent, directory, {
      kind: "write",
      name,
      bytes: bytes.toString("base64"),
      mode,
    }));
    if (staged.sha256 !== sha256(bytes) || !modeMatches(mode, staged.mode)) {
      throw new AgentError("RECOVERY_REQUIRED", "Pinned staged-file evidence is inconsistent");
    }
    return staged;
  } catch (error) {
    const staged = tryReadPinnedEquivalent(parent, directory, name, sha256(bytes), mode);
    if (staged === null) throw error;
    return staged;
  }
}

function captureOrReconcile(
  parent: string,
  directory: PinnedIdentity,
  source: string,
  destination: string,
  expected: PinnedFileState,
): PinnedFileState {
  try {
    const captured = pinnedFileState(runPinnedMutation(parent, directory, {
      kind: "capture",
      source,
      destination,
      expectedSha256: expected.sha256,
      expectedMode: expected.mode,
    }));
    return requirePinnedExact(
      captured,
      fileIdentity(expected),
      expected.sha256,
      expected.mode,
    );
  } catch (error) {
    const captured = tryReadPinnedExact(
      parent,
      directory,
      destination,
      fileIdentity(expected),
      expected.sha256,
      expected.mode,
    );
    if (captured === null) throw error;
    return captured;
  }
}

function installOrReconcile(
  parent: string,
  directory: PinnedIdentity,
  source: string,
  destination: string,
  expected: PinnedFileState,
  testDeleteDestinationAfterLink = false,
): PinnedFileState {
  try {
    const installed = pinnedFileState(runPinnedMutation(parent, directory, {
      kind: "install",
      source,
      destination,
      sourceIdentity: fileIdentity(expected),
      sourceSha256: expected.sha256,
      sourceMode: expected.mode,
      ...(testDeleteDestinationAfterLink
        ? { testDeleteDestinationAfterLink: true }
        : {}),
    }));
    return requirePinnedExact(
      installed,
      fileIdentity(expected),
      expected.sha256,
      expected.mode,
    );
  } catch (error) {
    const installed = tryReadPinnedExact(
      parent,
      directory,
      destination,
      fileIdentity(expected),
      expected.sha256,
      expected.mode,
    );
    if (installed === null) throw error;
    return installed;
  }
}

function tryReadPinnedExact(
  parent: string,
  directory: PinnedIdentity,
  name: string,
  identity: PinnedIdentity | undefined,
  expectedSha256: string,
  expectedMode: number,
): PinnedFileState | null {
  try {
    const current = pinnedFileState(runPinnedMutation(parent, directory, {
      kind: "read",
      name,
      ...(identity === undefined ? {} : { identity }),
    }));
    return current.sha256 === expectedSha256 && current.mode === expectedMode
      ? current
      : null;
  } catch {
    return null;
  }
}

function tryReadPinnedEquivalent(
  parent: string,
  directory: PinnedIdentity,
  name: string,
  expectedSha256: string,
  expectedMode: number,
): PinnedFileState | null {
  try {
    const current = pinnedFileState(runPinnedMutation(parent, directory, {
      kind: "read",
      name,
    }));
    return current.sha256 === expectedSha256 && modeMatches(expectedMode, current.mode)
      ? current
      : null;
  } catch {
    return null;
  }
}

function modeMatches(expected: number, actual: number): boolean {
  return CURRENT_HOST_PLATFORM.supportsPosixModes
    ? expected === actual
    : (expected & 0o200) === (actual & 0o200);
}

function requirePinnedExact(
  current: PinnedFileState,
  identity: PinnedIdentity | undefined,
  expectedSha256: string,
  expectedMode: number,
): PinnedFileState {
  if (
    (identity !== undefined &&
      (current.device !== identity.device || current.inode !== identity.inode)) ||
    current.sha256 !== expectedSha256 ||
    current.mode !== expectedMode
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Pinned mutation result evidence is inconsistent");
  }
  return current;
}

function storePinnedState(state: PinnedFileState): StoredArtifactIdentity {
  return {
    device: state.device,
    inode: state.inode,
    sha256: state.sha256,
    mode: state.mode,
  };
}

function samePinnedIdentity(left: PinnedIdentity, right: PinnedIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function matchesStoredState(
  current: PinnedFileState,
  expected: StoredArtifactIdentity,
): boolean {
  return (
    current.device === expected.device &&
    current.inode === expected.inode &&
    current.sha256 === expected.sha256 &&
    current.mode === expected.mode
  );
}

function readAnyPinned(
  parent: string,
  directory: PinnedIdentity,
  name: string,
): PinnedFileState | null {
  try {
    return pinnedFileState(runPinnedMutation(parent, directory, { kind: "read", name }));
  } catch (error) {
    try {
      runPinnedMutation(parent, directory, { kind: "verify_absent", name });
      return null;
    } catch {
      throw error;
    }
  }
}

function readRollbackArtifact(
  parent: string,
  directory: PinnedIdentity,
  name: string,
  recorded: StoredArtifactIdentity | null,
  inferred: { readonly sha256: string; readonly mode: number } | null,
  allowRecordedAbsent: boolean,
): PinnedFileState | null {
  const current = readAnyPinned(parent, directory, name);
  if (current === null) {
    if (recorded !== null && !allowRecordedAbsent) {
      throw new AgentError("RECOVERY_REQUIRED", "Persisted rollback artifact is missing", {
        artifact: name,
      });
    }
    return null;
  }
  if (recorded !== null) {
    if (!matchesStoredState(current, recorded)) {
      throw new AgentError("RECOVERY_REQUIRED", "Persisted rollback artifact changed", {
        artifact: name,
      });
    }
    return current;
  }
  if (
    inferred === null ||
    current.sha256 !== inferred.sha256 ||
    !modeMatches(inferred.mode, current.mode)
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Unpersisted rollback artifact is not authentic", {
      artifact: name,
    });
  }
  return current;
}

function verifyRollbackTargets(snapshots: readonly RollbackSnapshot[]): void {
  for (const snapshot of snapshots) {
    const parent = path.dirname(snapshot.absoluteTarget);
    const directory = storedDirectoryIdentity(snapshot.artifact);
    const name = path.basename(snapshot.absoluteTarget);
    if (!snapshot.entry.existed) {
      runPinnedMutation(parent, directory, { kind: "verify_absent", name });
      continue;
    }
    if (snapshot.installed === null) {
      throw new AgentError("RECOVERY_REQUIRED", "Rollback installation evidence is unavailable", {
        checkpointId: snapshot.checkpointId,
        path: snapshot.entry.path,
      });
    }
    const current = pinnedFileState(runPinnedMutation(parent, directory, {
      kind: "read",
      name,
      identity: fileIdentity(snapshot.installed),
    }));
    requirePinnedExact(
      current,
      fileIdentity(snapshot.installed),
      snapshot.installed.sha256,
      snapshot.installed.mode,
    );
  }
}

function verifyPreRollbackTargets(snapshots: readonly RollbackSnapshot[]): void {
  for (const snapshot of snapshots) {
    const parent = path.dirname(snapshot.absoluteTarget);
    const directory = storedDirectoryIdentity(snapshot.artifact);
    const name = path.basename(snapshot.absoluteTarget);
    if (snapshot.current === null) {
      runPinnedMutation(parent, directory, { kind: "verify_absent", name });
      continue;
    }
    const current = pinnedFileState(runPinnedMutation(parent, directory, {
      kind: "read",
      name,
      identity: fileIdentity(snapshot.current),
    }));
    requirePinnedExact(
      current,
      fileIdentity(snapshot.current),
      snapshot.current.sha256,
      snapshot.current.mode,
    );
  }
}

function removePinnedArtifactOrConfirmAbsent(
  parent: string,
  directory: PinnedIdentity,
  name: string,
  expected: PinnedFileState,
): void {
  try {
    runPinnedMutation(parent, directory, {
      kind: "remove",
      name,
      identity: fileIdentity(expected),
      expectedSha256: expected.sha256,
      expectedMode: expected.mode,
    });
  } catch (error) {
    try {
      runPinnedMutation(parent, directory, { kind: "verify_absent", name });
    } catch {
      throw error;
    }
  }
}

async function cleanupRollbackArtifacts(
  snapshots: readonly RollbackSnapshot[],
): Promise<void> {
  for (const snapshot of snapshots) {
    const directory = storedDirectoryIdentity(snapshot.artifact);
    const artifacts = checkpointRollbackArtifactPaths(
      snapshot.absoluteTarget,
      snapshot.entry.path,
      snapshot.checkpointId,
    );
    const probe = await readAnyPinned(
      path.dirname(snapshot.absoluteTarget),
      directory,
      path.basename(artifacts.probePath),
    );
    if (probe !== null) {
      const probeSource = snapshot.temporary ?? snapshot.current;
      if (
        probeSource === null ||
        !samePinnedIdentity(probe, probeSource) ||
        probe.sha256 !== probeSource.sha256 ||
        probe.mode !== probeSource.mode
      ) {
        throw new AgentError(
          "RECOVERY_REQUIRED",
          "Rollback hard-link probe artifact is not authentic",
          { checkpointId: snapshot.checkpointId, path: snapshot.entry.path },
        );
      }
      removePinnedArtifactOrConfirmAbsent(
        path.dirname(snapshot.absoluteTarget),
        directory,
        path.basename(artifacts.probePath),
        probe,
      );
    }
    if (snapshot.temporary !== null) {
      removePinnedArtifactOrConfirmAbsent(
        path.dirname(snapshot.absoluteTarget),
        directory,
        path.basename(artifacts.temporaryPath),
        snapshot.temporary,
      );
      snapshot.temporary = null;
    }
    if (snapshot.backup !== null) {
      removePinnedArtifactOrConfirmAbsent(
        path.dirname(snapshot.absoluteTarget),
        directory,
        path.basename(artifacts.backupPath),
        snapshot.backup,
      );
      snapshot.backup = null;
    }
  }
}

async function cleanupMutationArtifacts(
  absoluteTarget: string,
  relativePath: string,
  checkpointId: string,
  expectedIdentity?: CheckpointMutationArtifact,
): Promise<void> {
  const artifacts = checkpointMutationArtifactPaths(absoluteTarget, relativePath, checkpointId);
  if (expectedIdentity === undefined) {
    for (const artifact of [
      artifacts.temporaryPath,
      artifacts.backupPath,
      artifacts.probePath,
    ]) {
      try {
        await access(artifact, constants.F_OK);
        throw new AgentError(
          "RECOVERY_REQUIRED",
          "Unauthenticated mutation artifact requires manual reconciliation",
          { checkpointId, path: relativePath },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return;
  }
  const directory = storedDirectoryIdentity(expectedIdentity);
  cleanupRecordedArtifact(
    path.dirname(absoluteTarget),
    directory,
    path.basename(artifacts.temporaryPath),
    expectedIdentity.temporary,
  );
  cleanupRecordedArtifact(
    path.dirname(absoluteTarget),
    directory,
    path.basename(artifacts.backupPath),
    expectedIdentity.backup,
  );
  cleanupRecordedArtifact(
    path.dirname(absoluteTarget),
    directory,
    path.basename(artifacts.probePath),
    expectedIdentity.probe ?? null,
  );
}

function cleanupRecordedArtifact(
  parent: string,
  directory: PinnedIdentity,
  name: string,
  expected: StoredArtifactEvidence | null,
): void {
  if (expected === null) {
    runPinnedMutation(parent, directory, { kind: "verify_absent", name });
    return;
  }
  const current = readAnyPinned(parent, directory, name);
  if (current === null) return;
  if (
    (isStoredArtifactIdentity(expected) && !matchesStoredState(current, expected)) ||
    (!isStoredArtifactIdentity(expected) &&
      (current.sha256 !== expected.sha256 || !modeMatches(expected.mode, current.mode)))
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Recorded mutation artifact changed before cleanup", {
      artifact: name,
    });
  }
  removePinnedArtifactOrConfirmAbsent(parent, directory, name, current);
}

function pinnedFileState(
  value: PinnedFileState | Readonly<Record<string, unknown>>,
): PinnedFileState {
  if (
    !isPinnedIdentity(value) ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.sha256) ||
    !Number.isSafeInteger(value.mode) ||
    typeof value.modifiedAtMs !== "number" ||
    !Number.isFinite(value.modifiedAtMs) ||
    (value.bytes !== undefined && typeof value.bytes !== "string")
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Pinned checkpoint evidence is invalid");
  }
  return value as PinnedFileState;
}

function storedDirectoryIdentity(artifact: CheckpointMutationArtifact): PinnedIdentity {
  return {
    device: artifact.directory.device,
    inode: artifact.directory.inode,
  };
}

function fileIdentity(state: PinnedIdentity): PinnedIdentity {
  return { device: state.device, inode: state.inode };
}

function repositoryFingerprint(boundary: RepositoryBoundary): string {
  return sha256(boundary.pathKey(boundary.root));
}

function summary(manifest: CheckpointManifest): CheckpointSummary {
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    paths: manifest.entries.map((entry) => entry.path),
    totalBytes: manifest.totalBytes,
    integrity: manifest.integrity,
    ...(manifest.operationId === undefined ? {} : { operationId: manifest.operationId }),
    sealed: manifest.sealedAt !== undefined,
    ...(manifest.rollback?.forced === undefined
      ? {}
      : { rollbackForced: manifest.rollback.forced }),
  };
}

function isManifest(value: unknown): value is CheckpointManifest {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CheckpointManifest>;
  return (
    candidate.version === CHECKPOINT_VERSION &&
    typeof candidate.id === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.repositoryFingerprint === "string" &&
    (candidate.operationId === undefined || isOperationId(candidate.operationId)) &&
    (candidate.sealedAt === undefined || typeof candidate.sealedAt === "string") &&
    typeof candidate.integrity === "string" &&
    typeof candidate.totalBytes === "number" &&
    Array.isArray(candidate.entries) &&
    candidate.entries.every(
      (entry: unknown) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as CheckpointEntry).path === "string" &&
        typeof (entry as CheckpointEntry).existed === "boolean" &&
        typeof (entry as CheckpointEntry).sizeBytes === "number" &&
        (typeof (entry as CheckpointEntry).sha256 === "string" ||
          (entry as CheckpointEntry).sha256 === null) &&
        (typeof (entry as CheckpointEntry).mode === "number" ||
          (entry as CheckpointEntry).mode === null) &&
        (typeof (entry as CheckpointEntry).blob === "string" ||
          (entry as CheckpointEntry).blob === null) &&
        ((entry as CheckpointEntry).expectedAfter === undefined ||
          (typeof (entry as CheckpointEntry).expectedAfter?.existed === "boolean" &&
            ((entry as CheckpointEntry).expectedAfter?.sha256 === null ||
              (typeof (entry as CheckpointEntry).expectedAfter?.sha256 === "string" &&
                /^[0-9a-f]{64}$/u.test((entry as CheckpointEntry).expectedAfter?.sha256 ?? ""))) &&
            ((entry as CheckpointEntry).expectedAfter?.existed ===
              ((entry as CheckpointEntry).expectedAfter?.sha256 !== null)) &&
            ((entry as CheckpointEntry).expectedAfter?.mode === undefined ||
              (((entry as CheckpointEntry).expectedAfter?.mode === null ||
                (Number.isSafeInteger((entry as CheckpointEntry).expectedAfter?.mode) &&
                  ((entry as CheckpointEntry).expectedAfter?.mode ?? -1) >= 0 &&
                  ((entry as CheckpointEntry).expectedAfter?.mode ?? 0o1000) <= 0o777)) &&
                (((entry as CheckpointEntry).expectedAfter?.sha256 === null) ===
                  ((entry as CheckpointEntry).expectedAfter?.mode === null)))))),
    ) &&
    (candidate.mutationArtifacts === undefined ||
      (Array.isArray(candidate.mutationArtifacts) &&
        candidate.mutationArtifacts.every(
          (artifact: unknown) =>
            artifact !== null &&
            typeof artifact === "object" &&
            typeof (artifact as CheckpointMutationArtifact).path === "string" &&
            isStoredDirectoryIdentity((artifact as CheckpointMutationArtifact).directory) &&
            ((artifact as CheckpointMutationArtifact).temporary === null ||
              isStoredArtifactEvidence((artifact as CheckpointMutationArtifact).temporary)) &&
            ((artifact as CheckpointMutationArtifact).backup === null ||
              isStoredArtifactEvidence((artifact as CheckpointMutationArtifact).backup)) &&
            ((artifact as CheckpointMutationArtifact).probe === undefined ||
              (artifact as CheckpointMutationArtifact).probe === null ||
              isStoredArtifactEvidence((artifact as CheckpointMutationArtifact).probe)) &&
            ((artifact as CheckpointMutationArtifact).installAttempted === undefined ||
              (artifact as CheckpointMutationArtifact).installAttempted === true),
        ))) &&
    (candidate.rollback === undefined ||
      (candidate.rollback !== null &&
        typeof candidate.rollback === "object" &&
        typeof candidate.rollback.startedAt === "string" &&
        (candidate.rollback.forced === undefined ||
          typeof candidate.rollback.forced === "boolean") &&
        (candidate.rollback.phase === "applying" ||
          candidate.rollback.phase === "restored" ||
          candidate.rollback.phase === "reverting" ||
          candidate.rollback.phase === "reverted") &&
        Array.isArray(candidate.rollback.entries) &&
        candidate.rollback.entries.every(
          (entry: unknown) =>
            entry !== null &&
            typeof entry === "object" &&
            typeof (entry as CheckpointRollbackEntry).path === "string" &&
            isStoredDirectoryIdentity((entry as CheckpointRollbackEntry).directory) &&
            ((entry as CheckpointRollbackEntry).current === null ||
              isStoredArtifactIdentity((entry as CheckpointRollbackEntry).current)) &&
            ((entry as CheckpointRollbackEntry).temporary === null ||
              isStoredArtifactIdentity((entry as CheckpointRollbackEntry).temporary)) &&
            ((entry as CheckpointRollbackEntry).backup === null ||
              isStoredArtifactIdentity((entry as CheckpointRollbackEntry).backup)) &&
            ((entry as CheckpointRollbackEntry).installed === null ||
              isStoredArtifactIdentity((entry as CheckpointRollbackEntry).installed)) &&
            ((entry as CheckpointRollbackEntry).installAttempted === undefined ||
              (entry as CheckpointRollbackEntry).installAttempted === true) &&
            ((entry as CheckpointRollbackEntry).revertInstallAttempted === undefined ||
              (entry as CheckpointRollbackEntry).revertInstallAttempted === true),
        ))) &&
    (candidate.sealedAt === undefined ||
      candidate.entries.every((entry) => (entry as CheckpointEntry).expectedAfter !== undefined))
  );
}

function validArtifactIdentity(
  value: unknown,
): value is PinnedIdentity & { readonly sha256?: string; readonly mode?: number } {
  return (
    isPinnedIdentity(value) &&
    (!("sha256" in value) ||
      (typeof (value as { readonly sha256?: unknown }).sha256 === "string" &&
        /^[0-9a-f]{64}$/u.test((value as { readonly sha256: string }).sha256))) &&
    (!("mode" in value) ||
      (Number.isSafeInteger((value as { readonly mode?: unknown }).mode) &&
        (value as { readonly mode: number }).mode >= 0 &&
        (value as { readonly mode: number }).mode <= 0o777))
  );
}

function storeArtifactIdentity(
  value: {
    readonly device?: string;
    readonly inode?: string;
    readonly sha256: string;
    readonly mode: number;
  },
): StoredArtifactEvidence {
  return {
    ...(value.device === undefined || value.inode === undefined
      ? {}
      : { device: value.device, inode: value.inode }),
    sha256: value.sha256,
    mode: value.mode,
  };
}

function validMutationFileIdentity(value: unknown): value is {
  readonly device?: string;
  readonly inode?: string;
  readonly sha256: string;
  readonly mode: number;
} {
  return (
    value !== null &&
    typeof value === "object" &&
    (
      (!("device" in value) && !("inode" in value)) ||
      (validArtifactIdentity(value) && "device" in value && "inode" in value)
    ) &&
    "sha256" in value &&
    "mode" in value &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(value.sha256) &&
    Number.isSafeInteger(value.mode) &&
    typeof value.mode === "number" &&
    value.mode >= 0 &&
    value.mode <= 0o777
  );
}

function artifactEvidenceCanAdvance(
  prior: StoredArtifactEvidence,
  next: StoredArtifactEvidence | null,
): boolean {
  if (
    next === null ||
    prior.sha256 !== next.sha256 ||
    !modeMatches(prior.mode, next.mode)
  ) {
    return false;
  }
  if (isStoredArtifactIdentity(prior)) {
    return (
      isStoredArtifactIdentity(next) &&
      prior.device === next.device &&
      prior.inode === next.inode
    );
  }
  return true;
}

function storeDirectoryIdentity(
  value: PinnedIdentity,
): StoredDirectoryIdentity {
  return { device: value.device, inode: value.inode };
}

function isStoredArtifactIdentity(value: unknown): value is StoredArtifactIdentity {
  return (
    isStoredDirectoryIdentity(value) &&
    /^[0-9a-f]{64}$/u.test((value as StoredArtifactIdentity).sha256) &&
    Number.isSafeInteger((value as StoredArtifactIdentity).mode) &&
    (value as StoredArtifactIdentity).mode >= 0 &&
    (value as StoredArtifactIdentity).mode <= 0o777
  );
}

function isStoredArtifactEvidence(value: unknown): value is StoredArtifactEvidence {
  return (
    isStoredArtifactIdentity(value) ||
    (
      value !== null &&
      typeof value === "object" &&
      !("device" in value) &&
      !("inode" in value) &&
      typeof (value as StoredArtifactPlan).sha256 === "string" &&
      /^[0-9a-f]{64}$/u.test((value as StoredArtifactPlan).sha256) &&
      Number.isSafeInteger((value as StoredArtifactPlan).mode) &&
      (value as StoredArtifactPlan).mode >= 0 &&
      (value as StoredArtifactPlan).mode <= 0o777
    )
  );
}

function isStoredDirectoryIdentity(value: unknown): value is StoredDirectoryIdentity {
  return (
    value !== null &&
    typeof value === "object" &&
    /^(?:0|[1-9]\d*)$/u.test((value as StoredDirectoryIdentity).device) &&
    /^(?:0|[1-9]\d*)$/u.test((value as StoredDirectoryIdentity).inode)
  );
}
