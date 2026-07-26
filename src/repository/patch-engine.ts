import {
  lstat,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";

import { AgentError } from "../shared/errors.js";
import { sha256 } from "../shared/crypto.js";
import type { PathProtectionPolicy } from "../security/protected-paths.js";
import type { RepositoryBoundary } from "./boundary.js";
import { normalizeRepositoryPath } from "./boundary.js";
import { checkpointMutationArtifactPaths, type CheckpointStore } from "./checkpoint.js";
import { countChangedLines, planExactTextEdit } from "./exact-text-edit.js";
import { looksBinary, readRegularFile, readTextFile } from "./text-file.js";
import type { FileState } from "./types.js";
import { CURRENT_HOST_PLATFORM } from "../platform/index.js";
import {
  MAX_PINNED_FILE_BYTES,
  isPinnedIdentity,
  pinnedIdentityFromBigInts,
  runPinnedMutation,
  type PinnedFileState,
  type PinnedIdentity,
  type PinnedQuarantine,
} from "./pinned-mutation-fs.js";

export type PatchChange =
  | { readonly kind: "create"; readonly path: string; readonly content: string }
  | {
      readonly kind: "update";
      readonly path: string;
      readonly base_sha256: string;
      readonly content: string;
    }
  | { readonly kind: "delete"; readonly path: string; readonly base_sha256: string };

export interface ApplyPatchRequest {
  readonly changes: readonly PatchChange[];
  /** Journal operation associated with the pre-mutation checkpoint. */
  readonly operationId?: string;
}

export interface EditTextRequest {
  readonly path: string;
  readonly base_sha256: string;
  readonly old_text: string;
  readonly new_text: string;
  readonly expected_occurrences: number;
  /** Journal operation associated with the pre-mutation checkpoint. */
  readonly operationId?: string;
}

export interface PatchBudgets {
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxChangedLines?: number;
  readonly allowCreate?: boolean;
  readonly allowDelete?: boolean;
}

export interface MutationBudgetReservation {
  readonly maxFiles: number;
  readonly maxChangedLines: number;
}

export interface PatchEngineHooks {
  /** @internal Deterministic checkpoint race injection point. */
  readonly beforeCheckpoint?: () => Promise<void>;
  /** @internal Deterministic checkpoint race injection point. */
  readonly afterCheckpoint?: () => Promise<void>;
  /** @internal Deterministic size/path race immediately before a source read. */
  readonly beforeSourceRead?: (path: string) => Promise<void>;
  /** @internal Deterministic fault/race injection point used by repository tests. */
  readonly beforeCapture?: (path: string) => Promise<void>;
  /** @internal Deterministic fault/race injection point used by repository tests. */
  readonly afterCapture?: (path: string) => Promise<void>;
  /** @internal Process-interruption point after staging but before identity binding. */
  readonly afterStage?: (path: string) => Promise<void>;
  /** @internal Makes the pinned worker fail after linking the final path. */
  readonly failAfterLink?: (path: string) => boolean;
  /** @internal Deletes the installed link before the worker can acknowledge it. */
  readonly deleteAfterLinkBeforeResponse?: (path: string) => boolean;
  /** @internal Simulates a filesystem without hard-link support. */
  readonly failHardLinkProbe?: (path: string) => boolean;
  /** @internal Deterministic post-install race injection point. */
  readonly afterInstall?: (path: string) => Promise<void>;
  /** @internal Process-interruption point after staged-link cleanup. */
  readonly afterTemporaryCleanup?: (path: string) => Promise<void>;
  /** @internal Process-interruption point after backup cleanup and before seal. */
  readonly afterBackupCleanup?: (path: string) => Promise<void>;
}

export interface AppliedPath {
  readonly path: string;
  readonly kind: PatchChange["kind"];
  readonly state: FileState | null;
}

export interface ApplyPatchResult {
  readonly checkpointId: string;
  readonly changedPaths: readonly AppliedPath[];
  readonly changedLines: number;
  readonly totalBytes: number;
  readonly warnings: readonly string[];
}

interface MutationPlan {
  readonly path: string;
  readonly absolutePath: string;
  readonly kind: PatchChange["kind"];
  readonly oldBytes: Buffer | null;
  readonly oldMode: number | null;
  readonly newBytes: Buffer | null;
  readonly expectedSha256: string | null;
  readonly directoryIdentities: readonly MutationDirectoryIdentity[];
  temporaryPath: string | null;
  backupPath: string | null;
  probePath: string | null;
  quarantinePath: string | null;
  probeIdentity: PinnedIdentity | null;
  quarantineIdentity: PinnedIdentity | null;
  temporaryIdentity: PinnedIdentity | null;
  backupIdentity: PinnedIdentity | null;
  finalIdentity: PinnedIdentity | null;
  finalMode: number;
  temporaryCreated: boolean;
  backupCreated: boolean;
  backupDeleted: boolean;
  quarantineCreated: boolean;
  finalInstallAttempted: boolean;
  finalInstalled: boolean;
}

interface MutationDirectoryIdentity {
  readonly absolutePath: string;
  readonly device: string;
  readonly inode: string;
}

export class PatchEngine {
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxChangedLines: number;
  private readonly allowCreate: boolean;
  private readonly allowDelete: boolean;

  public constructor(
    private readonly boundary: RepositoryBoundary,
    private readonly checkpoints: CheckpointStore,
    private readonly protectedPaths: PathProtectionPolicy,
    budgets: PatchBudgets = {},
    private readonly hooks: PatchEngineHooks = {},
  ) {
    this.maxFiles = budgets.maxFiles ?? 50;
    this.maxFileBytes = budgets.maxFileBytes ?? 1024 * 1024;
    this.maxTotalBytes = budgets.maxTotalBytes ?? 4 * 1024 * 1024;
    this.maxChangedLines = budgets.maxChangedLines ?? 2_000;
    this.allowCreate = budgets.allowCreate ?? true;
    this.allowDelete = budgets.allowDelete ?? false;
    if (this.maxFileBytes > MAX_PINNED_FILE_BYTES) {
      throw new AgentError(
        "CONFIG_INVALID",
        "Per-file mutation budget exceeds the pinned filesystem protocol limit",
        { maxFileBytes: this.maxFileBytes, protocolLimit: MAX_PINNED_FILE_BYTES },
      );
    }
  }

  /**
   * Builds a targeted update from an exact, hash-guarded before-image, then
   * delegates commit/checkpoint/rollback/post-state verification to applyPatch.
   */
  public async editText(
    request: EditTextRequest,
    reservation?: MutationBudgetReservation,
  ): Promise<ApplyPatchResult> {
    const normalizedPath = normalizeRepositoryPath(request.path);
    assertSupportedMutationPath(normalizedPath);
    this.protectedPaths.assertAllowed(normalizedPath, "update");
    const resolved = await this.boundary.resolve(normalizedPath, { allowMissingLeaf: true });
    if (!resolved.exists) {
      throw new AgentError("STALE_STATE", "Edit target no longer exists", {
        path: normalizedPath,
      });
    }
    const existing = await this.boundary.resolveExistingFile(normalizedPath);
    const existingStat = await stat(existing.absolutePath);
    if (existingStat.size > this.maxFileBytes) {
      throw new AgentError("BUDGET_EXCEEDED", "Existing file exceeds the mutation size limit", {
        path: normalizedPath,
        sizeBytes: existingStat.size,
      });
    }
    const mode = existingStat.mode & 0o777;
    if (CURRENT_HOST_PLATFORM.supportsPosixModes && (mode & 0o111) !== 0) {
      throw new AgentError("UNSUPPORTED_FILE", "Executable files cannot be modified", { path: normalizedPath });
    }
    const snapshot = await readTextFile(existing.absolutePath, normalizedPath, this.maxFileBytes);
    const edit = planExactTextEdit(
      {
        content: snapshot.content,
        bytes: snapshot.bytes,
        sha256: snapshot.state.sha256,
      },
      {
        path: normalizedPath,
        baseSha256: request.base_sha256,
        oldText: request.old_text,
        newText: request.new_text,
        expectedOccurrences: request.expected_occurrences,
      },
      Math.min(this.maxFileBytes, this.maxTotalBytes),
    );
    return this.applyPatch(
      {
        changes: [{
          kind: "update",
          path: normalizedPath,
          base_sha256: snapshot.state.sha256,
          content: edit.content,
        }],
        ...(request.operationId === undefined ? {} : { operationId: request.operationId }),
      },
      reservation,
    );
  }

  public async applyPatch(
    request: ApplyPatchRequest,
    reservation?: MutationBudgetReservation,
  ): Promise<ApplyPatchResult> {
    const maxFiles = reservation?.maxFiles ?? this.maxFiles;
    const maxChangedLines = reservation?.maxChangedLines ?? this.maxChangedLines;
    assertMutationBudgetReservation(maxFiles, maxChangedLines);
    if (!Array.isArray(request.changes) || request.changes.length === 0) {
      throw new AgentError("PROTOCOL_INVALID", "Patch transaction must contain at least one change");
    }
    if (request.changes.length > maxFiles) {
      throw new AgentError("BUDGET_EXCEEDED", "Patch exceeds the changed-file budget", {
        fileCount: request.changes.length,
        maxFiles,
      });
    }

    const plans: MutationPlan[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    let changedLines = 0;
    for (const change of request.changes) {
      validateChangeShape(change);
      const normalizedPath = normalizeRepositoryPath(change.path);
      assertSupportedMutationPath(normalizedPath);
      const pathKey = this.boundary.pathKey(normalizedPath);
      if (seen.has(pathKey)) {
        throw new AgentError("PROTOCOL_INVALID", "A path may appear only once in a patch transaction", {
          path: normalizedPath,
        });
      }
      seen.add(pathKey);
      this.protectedPaths.assertAllowed(normalizedPath, change.kind);

      if (change.kind === "create" && !this.allowCreate) {
        throw new AgentError("POLICY_DENIED", "File creation is not permitted", {
          path: normalizedPath,
        });
      }
      if (change.kind === "delete" && !this.allowDelete) {
        throw new AgentError("POLICY_DENIED", "File deletion is not permitted", {
          path: normalizedPath,
        });
      }

      const resolved = await this.boundary.resolve(normalizedPath, { allowMissingLeaf: true });
      let oldBytes: Buffer | null = null;
      let oldMode: number | null = null;
      if (resolved.exists) {
        const existing = await this.boundary.resolveExistingFile(normalizedPath);
        const existingStat = await stat(existing.absolutePath);
        if (existingStat.size > this.maxFileBytes) {
          throw new AgentError("BUDGET_EXCEEDED", "Existing file exceeds the mutation size limit", {
            path: normalizedPath,
            sizeBytes: existingStat.size,
          });
        }
        await this.hooks.beforeSourceRead?.(normalizedPath);
        const snapshot = await readRegularFile(
          existing.absolutePath,
          normalizedPath,
          this.maxFileBytes,
        );
        oldBytes = snapshot.bytes;
        oldMode = snapshot.mode;
        if (CURRENT_HOST_PLATFORM.supportsPosixModes && (oldMode & 0o111) !== 0) {
          throw new AgentError("UNSUPPORTED_FILE", "Executable files cannot be modified", {
            path: normalizedPath,
          });
        }
        if (looksBinary(oldBytes)) {
          throw new AgentError("UNSUPPORTED_FILE", "Binary files cannot be modified", {
            path: normalizedPath,
          });
        }
      }

      if (change.kind === "create" && oldBytes !== null) {
        throw new AgentError("STALE_STATE", "Create target already exists", { path: normalizedPath });
      }
      if (change.kind !== "create") {
        if (oldBytes === null) {
          throw new AgentError("STALE_STATE", "Patch base file no longer exists", {
            path: normalizedPath,
          });
        }
        if (
          !/^[0-9a-f]{64}$/iu.test(change.base_sha256) ||
          sha256(oldBytes) !== change.base_sha256.toLowerCase()
        ) {
          throw new AgentError("STALE_STATE", "Patch base hash does not match current file state", {
            path: normalizedPath,
            expectedSha256: change.base_sha256,
            actualSha256: sha256(oldBytes),
          });
        }
      }

      const newBytes = change.kind === "delete" ? null : encodeText(change.content, normalizedPath);
      if (newBytes !== null && newBytes.length > this.maxFileBytes) {
        throw new AgentError("BUDGET_EXCEEDED", "Resulting file exceeds the mutation size limit", {
          path: normalizedPath,
          sizeBytes: newBytes.length,
          maxBytes: this.maxFileBytes,
        });
      }
      totalBytes += newBytes?.length ?? 0;
      changedLines += countChangedLines(oldBytes?.toString("utf8") ?? "", newBytes?.toString("utf8") ?? "");
      const directoryIdentities = await captureMutationDirectoryIdentities(
        this.boundary.root,
        path.dirname(resolved.absolutePath),
        normalizedPath,
      );
      plans.push({
        path: normalizedPath,
        absolutePath: resolved.absolutePath,
        kind: change.kind,
        oldBytes,
        oldMode,
        newBytes,
        expectedSha256: oldBytes === null ? null : sha256(oldBytes),
        directoryIdentities,
        temporaryPath: null,
        backupPath: null,
        probePath: null,
        quarantinePath: null,
        probeIdentity: null,
        quarantineIdentity: null,
        temporaryIdentity: null,
        backupIdentity: null,
        finalIdentity: null,
        finalMode: oldMode ?? 0o600,
        temporaryCreated: false,
        backupCreated: false,
        backupDeleted: false,
        quarantineCreated: false,
        finalInstallAttempted: false,
        finalInstalled: false,
      });
    }

    if (totalBytes > this.maxTotalBytes || changedLines > maxChangedLines) {
      throw new AgentError("BUDGET_EXCEEDED", "Patch exceeds the configured change budget", {
        totalBytes,
        maxTotalBytes: this.maxTotalBytes,
        changedLines,
        maxChangedLines,
      });
    }

    await this.hooks.beforeCheckpoint?.();
    const checkpoint = await this.checkpoints.createCheckpoint(
      plans.map((plan) => plan.path),
      request.operationId,
    );
    await this.hooks.afterCheckpoint?.();
    await this.assertCheckpointMatchesPlans(checkpoint.id, plans);
    for (const plan of plans) {
      const artifacts = checkpointMutationArtifactPaths(
        plan.absolutePath,
        plan.path,
        checkpoint.id,
      );
      plan.temporaryPath = plan.newBytes === null ? null : artifacts.temporaryPath;
      plan.backupPath = plan.oldBytes === null ? null : artifacts.backupPath;
      plan.probePath = artifacts.probePath;
      plan.quarantinePath = artifacts.quarantinePath;
    }
    await this.recordMutationArtifacts(checkpoint.id, plans);
    let checkpointSealed = false;
    try {
      await this.commit(checkpoint.id, plans);

      const changedPaths: AppliedPath[] = [];
      for (const plan of plans) {
        const resolved = await this.boundary.resolve(plan.path, { allowMissingLeaf: true });
        if (plan.newBytes === null) {
          if (resolved.exists) {
            throw new AgentError("RECOVERY_REQUIRED", "Deleted path still exists after mutation", {
              path: plan.path,
              checkpointId: checkpoint.id,
            });
          }
          await assertMutationDirectoriesStable(plan);
          const parent = mutationParentIdentity(plan);
          runPinnedMutation(parent.absolutePath, parent, {
            kind: "verify_absent",
            name: path.basename(plan.absolutePath),
          });
          changedPaths.push({ path: plan.path, kind: plan.kind, state: null });
        } else {
          if (plan.finalIdentity === null) {
            throw new AgentError("RECOVERY_REQUIRED", "Final mutation identity is unavailable", {
              path: plan.path,
              checkpointId: checkpoint.id,
            });
          }
          await assertMutationDirectoriesStable(plan);
          const parent = mutationParentIdentity(plan);
          const current = pinnedFileState(runPinnedMutation(
            parent.absolutePath,
            parent,
            {
              kind: "read",
              name: path.basename(plan.absolutePath),
              identity: plan.finalIdentity,
            },
          ));
          if (
            current.sha256 !== sha256(plan.newBytes) ||
            current.mode !== plan.finalMode
          ) {
            throw new AgentError("RECOVERY_REQUIRED", "Resulting file inventory failed verification", {
              path: plan.path,
              checkpointId: checkpoint.id,
            });
          }
          changedPaths.push({
            path: plan.path,
            kind: plan.kind,
            state: {
              sha256: current.sha256,
              sizeBytes: plan.newBytes.length,
              modifiedAtMs: current.modifiedAtMs,
            },
          });
        }
      }

      await this.checkpoints.seal(
        checkpoint.id,
        plans.map((plan) => ({
          path: plan.path,
          sha256: plan.newBytes === null ? null : sha256(plan.newBytes),
          mode: plan.newBytes === null ? null : plan.finalMode,
        })),
      );
      checkpointSealed = true;
      for (const plan of plans) {
        removeMutationQuarantine(plan);
      }

      return {
        checkpointId: checkpoint.id,
        changedPaths,
        changedLines,
        totalBytes,
        warnings: [],
      };
    } catch (error) {
      if (checkpointSealed) {
        throw new AgentError(
          "RECOVERY_REQUIRED",
          "Patch was sealed but private artifact cleanup is incomplete",
          { checkpointId: checkpoint.id },
          { cause: error },
        );
      }
      try {
        await this.restorePlans(plans);
      } catch (restoreError) {
        throw new AgentError(
          "RECOVERY_REQUIRED",
          "Patch failed and automatic restoration was incomplete",
          { checkpointId: checkpoint.id, restoreError: String(restoreError) },
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async commit(checkpointId: string, plans: readonly MutationPlan[]): Promise<void> {
    for (const plan of plans) {
      if (plan.quarantinePath === null) {
        throw new AgentError("INTERNAL_ERROR", "Mutation quarantine path is missing");
      }
      await assertMutationDirectoriesStable(plan);
      const parent = mutationParentIdentity(plan);
      const created = runPinnedMutation(parent.absolutePath, parent, {
        kind: "create_quarantine",
        name: path.basename(plan.quarantinePath),
      });
      if (!isPinnedIdentity(created)) {
        throw new AgentError("RECOVERY_REQUIRED", "Pinned quarantine evidence is invalid");
      }
      plan.quarantineIdentity = fileIdentity(created);
      plan.quarantineCreated = true;
      // The exact directory identity is durable before any target or artifact
      // can be moved into this private namespace.
      await this.recordMutationArtifacts(checkpointId, plans);
    }
    for (const plan of plans) {
      if (plan.newBytes !== null && plan.temporaryPath !== null) {
        await assertMutationDirectoriesStable(plan);
        const parent = mutationParentIdentity(plan);
        const staged = pinnedFileState(runPinnedMutation(
          parent.absolutePath,
          parent,
          {
            kind: "write",
            name: path.basename(plan.temporaryPath),
            bytes: plan.newBytes.toString("base64"),
            mode: plan.oldMode ?? 0o600,
          },
        ));
        await this.hooks.afterStage?.(plan.path);
        plan.temporaryIdentity = fileIdentity(staged);
        plan.finalMode = staged.mode;
        plan.temporaryCreated = true;
      }
    }
    await this.recordMutationArtifacts(checkpointId, plans);
    await this.preflightHardLinkSupport(checkpointId, plans);

    for (const plan of plans) {
      const current = await this.boundary.resolve(plan.path, { allowMissingLeaf: true });
      if ((plan.oldBytes === null) === current.exists) {
        throw new AgentError("STALE_STATE", "Path existence changed before patch commit", {
          path: plan.path,
        });
      }
      if (current.exists) {
        const currentFile = await this.boundary.resolveExistingFile(plan.path);
        const currentBytes = (await readRegularFile(
          currentFile.absolutePath,
          plan.path,
          this.maxFileBytes,
          plan.expectedSha256 === null
            ? {}
            : { sha256: plan.expectedSha256 },
        )).bytes;
        if (plan.expectedSha256 === null || sha256(currentBytes) !== plan.expectedSha256) {
          throw new AgentError("STALE_STATE", "File changed before patch commit", { path: plan.path });
        }
        if (plan.backupPath === null) {
          throw new AgentError("INTERNAL_ERROR", "Mutation backup path is missing");
        }
        await this.hooks.beforeCapture?.(plan.path);
        await assertMutationDirectoriesStable(plan);
        const parent = mutationParentIdentity(plan);
        const recaptured = pinnedFileState(runPinnedMutation(
          parent.absolutePath,
          parent,
          {
            kind: "read",
            name: path.basename(plan.absolutePath),
          },
        ));
        if (
          recaptured.sha256 !== plan.expectedSha256 ||
          recaptured.mode !== (plan.oldMode ?? recaptured.mode)
        ) {
          throw new AgentError("STALE_STATE", "File changed before patch commit", {
            path: plan.path,
          });
        }
        // Bind the anticipated backup identity before the no-overwrite hard
        // link and private-quarantine removal so every interruption boundary
        // can be reconciled exactly.
        plan.backupIdentity = fileIdentity(recaptured);
        await this.recordMutationArtifacts(checkpointId, plans);
        try {
          const captured = pinnedFileState(runPinnedMutation(
            parent.absolutePath,
            parent,
            {
              kind: "capture",
              source: path.basename(plan.absolutePath),
              destination: path.basename(plan.backupPath),
              sourceIdentity: plan.backupIdentity,
              expectedSha256: plan.expectedSha256,
              expectedMode: plan.oldMode ?? 0o600,
              quarantine: mutationQuarantine(plan),
            },
          ));
          plan.backupIdentity = fileIdentity(captured);
          plan.backupCreated = true;
        } catch (error) {
          reconcileQuarantinedRemoval(
            parent,
            path.basename(plan.absolutePath),
            plan.backupIdentity,
            plan.expectedSha256,
            plan.oldMode ?? 0o600,
            mutationQuarantine(plan),
          );
          const captured = tryReadExact(
            parent,
            path.basename(plan.backupPath),
            undefined,
            plan.expectedSha256,
            plan.oldMode ?? 0o600,
          );
          if (captured !== null) {
            plan.backupIdentity = fileIdentity(captured);
            plan.backupCreated = true;
          }
          throw error;
        }
        await this.recordMutationArtifacts(checkpointId, plans);
        await this.hooks.afterCapture?.(plan.path);
        await assertMutationDirectoriesStable(plan);
        const verified = pinnedFileState(runPinnedMutation(
          parent.absolutePath,
          parent,
          {
            kind: "read",
            name: path.basename(plan.backupPath),
            identity: plan.backupIdentity,
          },
        ));
        if (
          plan.expectedSha256 === null ||
          verified.sha256 !== plan.expectedSha256 ||
          (plan.oldMode !== null && verified.mode !== plan.oldMode)
        ) {
          throw new AgentError("STALE_STATE", "File changed before patch commit", {
            path: plan.path,
          });
        }
      }
      if (plan.newBytes !== null) {
        if (plan.temporaryPath === null) {
          throw new AgentError("INTERNAL_ERROR", "Mutation temporary path is missing");
        }
        if (plan.temporaryIdentity === null) {
          throw new AgentError("INTERNAL_ERROR", "Mutation temporary identity is missing");
        }
        await assertMutationDirectoriesStable(plan);
        const parent = mutationParentIdentity(plan);
        // Persist uncertainty before the consequential link. If the worker
        // dies after linking and the target is then deleted, recovery must not
        // mistake that absence for proof that installation never happened.
        plan.finalInstallAttempted = true;
        await this.recordMutationArtifacts(checkpointId, plans);
        try {
          const installed = pinnedFileState(runPinnedMutation(
            parent.absolutePath,
            parent,
            {
              kind: "install",
              source: path.basename(plan.temporaryPath),
              destination: path.basename(plan.absolutePath),
              sourceIdentity: plan.temporaryIdentity,
              sourceSha256: sha256(plan.newBytes),
              sourceMode: plan.finalMode,
              ...(this.hooks.failAfterLink?.(plan.path) === true
                ? { failAfterLink: true }
                : {}),
              ...(this.hooks.deleteAfterLinkBeforeResponse?.(plan.path) === true
                ? { testDeleteDestinationAfterLink: true }
                : {}),
            },
          ));
          plan.finalIdentity = fileIdentity(installed);
          plan.finalInstalled = true;
        } catch (error) {
          const installed = tryReadExact(
            parent,
            path.basename(plan.absolutePath),
            plan.temporaryIdentity,
            sha256(plan.newBytes),
            plan.finalMode,
          );
          if (installed !== null) {
            plan.finalIdentity = fileIdentity(installed);
            plan.finalInstalled = true;
          }
          throw error;
        }
        await this.hooks.afterInstall?.(plan.path);
        removeArtifactOrConfirmAbsent(
          parent,
          path.basename(plan.temporaryPath),
          plan.temporaryIdentity,
          sha256(plan.newBytes),
          plan.finalMode,
          mutationQuarantine(plan),
        );
        plan.temporaryCreated = false;
        await this.hooks.afterTemporaryCleanup?.(plan.path);
      }
    }

    for (const plan of plans) {
      if (plan.backupPath !== null) {
        if (plan.backupIdentity === null) {
          throw new AgentError("INTERNAL_ERROR", "Mutation backup identity is missing");
        }
        await assertMutationDirectoriesStable(plan);
        const parent = mutationParentIdentity(plan);
        const captured = pinnedFileState(runPinnedMutation(
          parent.absolutePath,
          parent,
          {
            kind: "read",
            name: path.basename(plan.backupPath),
            identity: plan.backupIdentity,
          },
        ));
        if (plan.expectedSha256 === null || captured.sha256 !== plan.expectedSha256) {
          throw new AgentError("STALE_STATE", "Captured file changed during patch commit", {
            path: plan.path,
          });
        }
        removeArtifactOrConfirmAbsent(
          parent,
          path.basename(plan.backupPath),
          plan.backupIdentity,
          plan.expectedSha256,
          plan.oldMode ?? 0o600,
          mutationQuarantine(plan),
        );
        plan.backupCreated = false;
        plan.backupDeleted = true;
        await this.hooks.afterBackupCleanup?.(plan.path);
      }
    }
  }

  private async preflightHardLinkSupport(
    checkpointId: string,
    plans: readonly MutationPlan[],
  ): Promise<void> {
    for (const plan of plans) {
      if (plan.probePath === null) {
        throw new AgentError("INTERNAL_ERROR", "Mutation hard-link probe path is missing");
      }
      await assertMutationDirectoriesStable(plan);
      const parent = mutationParentIdentity(plan);
      const source =
        plan.newBytes !== null
          ? {
              name: path.basename(plan.temporaryPath ?? ""),
              identity: plan.temporaryIdentity,
              sha256: sha256(plan.newBytes),
              mode: plan.finalMode,
            }
          : {
              name: path.basename(plan.absolutePath),
              identity: null,
              sha256: plan.expectedSha256,
              mode: plan.oldMode,
            };
      if (
        source.name.length === 0 ||
        source.identity === null && plan.newBytes !== null ||
        source.sha256 === null ||
        source.mode === null
      ) {
        throw new AgentError("INTERNAL_ERROR", "Mutation hard-link probe source is incomplete");
      }
      const sourceIdentity =
        source.identity ??
        fileIdentity(pinnedFileState(runPinnedMutation(
          parent.absolutePath,
          parent,
          { kind: "read", name: source.name },
        )));
      plan.probeIdentity = sourceIdentity;
      // Bind the exact anticipated probe inode before link creation so a
      // process-loss recovery can authenticate a target with nlink === 2.
      await this.recordMutationArtifacts(checkpointId, plans);
      try {
        runPinnedMutation(parent.absolutePath, parent, {
          kind: "probe_link",
          source: source.name,
          destination: path.basename(plan.probePath),
          sourceIdentity,
          sourceSha256: source.sha256,
          sourceMode: source.mode,
          quarantine: mutationQuarantine(plan),
          ...(this.hooks.failHardLinkProbe?.(plan.path) === true
            ? { failBeforeLink: true }
            : {}),
        });
      } catch (error) {
        reconcileQuarantinedRemoval(
          parent,
          path.basename(plan.probePath),
          sourceIdentity,
          source.sha256,
          source.mode,
          mutationQuarantine(plan),
        );
        const probe = tryReadExact(
          parent,
          path.basename(plan.probePath),
          sourceIdentity,
          source.sha256,
          source.mode,
        );
        if (probe !== null) {
          removeArtifactOrConfirmAbsent(
            parent,
            path.basename(plan.probePath),
            sourceIdentity,
            source.sha256,
            source.mode,
            mutationQuarantine(plan),
          );
        }
        if (
          tryReadExact(
            parent,
            source.name,
            sourceIdentity,
            source.sha256,
            source.mode,
          ) === null
        ) {
          throw new AgentError(
            "STALE_STATE",
            "Hard-link probe source changed during mutation preflight",
            { path: plan.path },
            { cause: error },
          );
        }
        throw new AgentError(
          "UNSUPPORTED_FILE",
          "Repository filesystem does not support safe no-overwrite hard-link mutation",
          { path: plan.path },
          { cause: error },
        );
      }
    }
  }

  private async restorePlans(plans: readonly MutationPlan[]): Promise<void> {
    const restorationErrors: string[] = [];
    for (const plan of [...plans].reverse()) {
      try {
        const parent = mutationParentIdentity(plan);
        if (plan.temporaryCreated && plan.temporaryPath !== null) {
          await assertMutationDirectoriesStable(plan);
          if (plan.temporaryIdentity === null) {
            throw new Error("Temporary artifact identity is unavailable");
          }
          removeArtifactOrConfirmAbsent(
            parent,
            path.basename(plan.temporaryPath),
            plan.temporaryIdentity,
            plan.newBytes === null ? undefined : sha256(plan.newBytes),
            plan.finalMode,
            mutationQuarantine(plan),
          );
          plan.temporaryCreated = false;
        }
        if (!plan.finalInstalled && !plan.backupCreated && !plan.backupDeleted) {
          removeMutationQuarantine(plan);
          continue;
        }
        if (
          plan.finalInstallAttempted &&
          !plan.finalInstalled &&
          plan.oldBytes !== null
        ) {
          runPinnedMutation(parent.absolutePath, parent, {
            kind: "verify_absent",
            name: path.basename(plan.absolutePath),
          });
          throw new Error(
            "Unacknowledged installation is now absent; preserving the concurrent deletion",
          );
        }
        if (plan.finalInstalled) {
          if (
            plan.newBytes === null ||
            plan.finalIdentity === null ||
            plan.temporaryPath === null
          ) {
            throw new Error("Installed result identity is unavailable");
          }
          const current = pinnedFileState(runPinnedMutation(
            parent.absolutePath,
            parent,
            {
              kind: "read",
              name: path.basename(plan.absolutePath),
              identity: plan.finalIdentity,
            },
          ));
          if (current.sha256 !== sha256(plan.newBytes)) {
            throw new Error("Result path changed again during transaction recovery");
          }
          const parked = pinnedFileState(runPinnedMutation(
            parent.absolutePath,
            parent,
            {
              kind: "capture",
              source: path.basename(plan.absolutePath),
              destination: path.basename(plan.temporaryPath),
              sourceIdentity: plan.finalIdentity,
              expectedSha256: sha256(plan.newBytes),
              expectedMode: plan.finalMode,
              quarantine: mutationQuarantine(plan),
            },
          ));
          plan.temporaryIdentity = fileIdentity(parked);
          plan.temporaryCreated = true;
        }
        if (plan.backupCreated && plan.backupPath !== null) {
          if (plan.backupIdentity === null || plan.oldMode === null) {
            throw new Error("Backup artifact identity is unavailable");
          }
          await assertMutationDirectoriesStable(plan);
          const sourceSha256 =
            plan.expectedSha256 ?? sha256(plan.oldBytes ?? Buffer.alloc(0));
          try {
            runPinnedMutation(parent.absolutePath, parent, {
              kind: "restore",
              source: path.basename(plan.backupPath),
              destination: path.basename(plan.absolutePath),
              sourceIdentity: plan.backupIdentity,
              sourceSha256,
              sourceMode: plan.oldMode,
            });
          } catch (error) {
            if (
              tryReadExact(
                parent,
                path.basename(plan.absolutePath),
                plan.backupIdentity,
                sourceSha256,
                plan.oldMode,
              ) === null
            ) {
              throw error;
            }
          }
          removeArtifactOrConfirmAbsent(
            parent,
            path.basename(plan.backupPath),
            plan.backupIdentity,
            sourceSha256,
            plan.oldMode,
            mutationQuarantine(plan),
          );
          plan.backupCreated = false;
        } else if (plan.oldBytes !== null && (plan.finalInstalled || plan.backupDeleted)) {
          try {
            runPinnedMutation(parent.absolutePath, parent, {
              kind: "write",
              name: path.basename(plan.absolutePath),
              bytes: plan.oldBytes.toString("base64"),
              mode: plan.oldMode ?? 0o600,
            });
          } catch (error) {
            throw new Error("Original content could not be restored", { cause: error });
          }
        }
        if (
          plan.temporaryCreated &&
          plan.temporaryPath !== null &&
          plan.temporaryIdentity !== null
        ) {
          removeArtifactOrConfirmAbsent(
            parent,
            path.basename(plan.temporaryPath),
            plan.temporaryIdentity,
            plan.newBytes === null ? undefined : sha256(plan.newBytes),
            plan.finalMode,
            mutationQuarantine(plan),
          );
          plan.temporaryCreated = false;
        }
        plan.finalInstalled = false;
        removeMutationQuarantine(plan);
      } catch (error) {
        restorationErrors.push(`${plan.path}: ${String(error)}`);
      }
    }
    if (restorationErrors.length > 0) {
      throw new Error(restorationErrors.join("; "));
    }
  }

  private async recordMutationArtifacts(
    checkpointId: string,
    plans: readonly MutationPlan[],
  ): Promise<void> {
    await this.checkpoints.recordMutationArtifacts(
      checkpointId,
      plans.map((plan) => {
        const parent = mutationParentIdentity(plan);
        return {
          path: plan.path,
          directory: fileIdentity(parent),
          ...(plan.newBytes === null
            ? {}
            : {
                temporary: {
                  ...(plan.temporaryIdentity === null ? {} : plan.temporaryIdentity),
                  sha256: sha256(plan.newBytes),
                  mode: plan.finalMode,
                },
              }),
          ...(plan.backupIdentity === null ||
          plan.expectedSha256 === null ||
          plan.oldMode === null
            ? {}
            : {
                backup: {
                  ...plan.backupIdentity,
                  sha256: plan.expectedSha256,
                  mode: plan.oldMode,
                },
              }),
          ...(plan.finalInstallAttempted ? { installAttempted: true } : {}),
          ...(plan.quarantineIdentity === null
            ? {}
            : { quarantine: plan.quarantineIdentity }),
          ...((plan.newBytes ?? plan.oldBytes) === null
            ? {}
            : {
                probe: {
                  ...(plan.probeIdentity ?? {}),
                  sha256: sha256((plan.newBytes ?? plan.oldBytes) as Buffer),
                  mode: plan.newBytes === null ? (plan.oldMode ?? 0o600) : plan.finalMode,
                },
              }),
        };
      }),
    );
  }

  private async assertCheckpointMatchesPlans(
    checkpointId: string,
    plans: readonly MutationPlan[],
  ): Promise<void> {
    const checkpoint = await this.checkpoints.snapshot(checkpointId);
    const entries = new Map(
      checkpoint.entries.map((entry) => [this.boundary.pathKey(entry.path), entry]),
    );
    for (const plan of plans) {
      const entry = entries.get(this.boundary.pathKey(plan.path));
      if (
        entry === undefined ||
        entry.existed !== (plan.oldBytes !== null) ||
        entry.sha256 !== plan.expectedSha256 ||
        entry.mode !== plan.oldMode
      ) {
        throw new AgentError(
          "STALE_STATE",
          "Checkpoint before-image does not match the validated mutation plan",
          { checkpointId, path: plan.path },
        );
      }
    }
  }

}

function validateChangeShape(change: PatchChange): void {
  if (change === null || typeof change !== "object" || typeof change.path !== "string") {
    throw new AgentError("PROTOCOL_INVALID", "Patch change has an invalid shape");
  }
  if (change.kind !== "create" && change.kind !== "update" && change.kind !== "delete") {
    throw new AgentError("PROTOCOL_INVALID", "Patch change kind is unsupported");
  }
  if (change.kind !== "delete" && typeof change.content !== "string") {
    throw new AgentError("PROTOCOL_INVALID", "Patch content must be a string", { path: change.path });
  }
  if (change.kind !== "create" && typeof change.base_sha256 !== "string") {
    throw new AgentError("PROTOCOL_INVALID", "Patch base hash must be a string", {
      path: change.path,
    });
  }
}

function encodeText(content: string, path: string): Buffer {
  if (content.includes("\0")) {
    throw new AgentError("UNSUPPORTED_FILE", "NUL-containing content is not supported", { path });
  }
  return Buffer.from(content, "utf8");
}

function assertSupportedMutationPath(repositoryPath: string): void {
  if (
    /\.(?:exe|dll|com|msi|msix|appx|appxbundle|cmd|bat|ps1|psm1|vbs|vbe|wsf|wsh|scr|zip|7z|rar|tar|gz|bz2|xz|pfx|p12|cer|der|db|sqlite|sqlite3)$/iu.test(
      repositoryPath,
    )
  ) {
    throw new AgentError("UNSUPPORTED_FILE", "Executable, archive, key, and database files cannot be modified", {
      path: repositoryPath,
    });
  }
}

async function captureMutationDirectoryIdentities(
  repositoryRoot: string,
  targetParent: string,
  repositoryPath: string,
): Promise<readonly MutationDirectoryIdentity[]> {
  const relative = path.relative(repositoryRoot, targetParent);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AgentError("PATH_OUTSIDE_REPOSITORY", "Mutation parent escapes the repository", {
      path: repositoryPath,
    });
  }
  const directories = [
    repositoryRoot,
    ...(relative === "" ? [] : relative.split(path.sep).map(
      (_segment, index, segments) =>
        path.join(repositoryRoot, ...segments.slice(0, index + 1)),
    )),
  ];
  const identities: MutationDirectoryIdentity[] = [];
  for (const absolutePath of directories) {
    const linkState = await lstat(absolutePath, { bigint: true });
    const state = await stat(absolutePath, { bigint: true });
    if (
      linkState.isSymbolicLink() ||
      !state.isDirectory() ||
      (await realpath(absolutePath)) !== absolutePath
    ) {
      throw new AgentError("UNSUPPORTED_FILE", "Mutation parent must be a stable directory", {
        path: repositoryPath,
      });
    }
    identities.push({ absolutePath, ...pinnedIdentityFromBigInts(state.dev, state.ino) });
  }
  return identities;
}

function mutationParentIdentity(plan: MutationPlan): MutationDirectoryIdentity {
  const parent = plan.directoryIdentities.at(-1);
  if (parent === undefined || parent.absolutePath !== path.dirname(plan.absolutePath)) {
    throw new AgentError("INTERNAL_ERROR", "Mutation parent identity is unavailable", {
      path: plan.path,
    });
  }
  return parent;
}

function fileIdentity(value: PinnedIdentity): PinnedIdentity {
  return { device: value.device, inode: value.inode };
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
    !Number.isFinite(value.modifiedAtMs)
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Pinned filesystem evidence is invalid");
  }
  return value as PinnedFileState;
}

function tryReadExact(
  parent: MutationDirectoryIdentity,
  name: string,
  identity: PinnedIdentity | undefined,
  expectedSha256: string | null | undefined,
  expectedMode: number | undefined,
): PinnedFileState | null {
  try {
    const current = pinnedFileState(runPinnedMutation(
      parent.absolutePath,
      parent,
      {
        kind: "read",
        name,
        ...(identity === undefined ? {} : { identity }),
      },
    ));
    if (
      (expectedSha256 !== undefined &&
        expectedSha256 !== null &&
        current.sha256 !== expectedSha256) ||
      (expectedMode !== undefined && current.mode !== expectedMode)
    ) {
      return null;
    }
    return current;
  } catch {
    return null;
  }
}

function removeArtifactOrConfirmAbsent(
  parent: MutationDirectoryIdentity,
  name: string,
  identity: PinnedIdentity,
  expectedSha256: string | undefined,
  expectedMode: number,
  quarantine: PinnedQuarantine,
): void {
  try {
    runPinnedMutation(parent.absolutePath, parent, {
      kind: "remove",
      name,
      identity,
      ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
      expectedMode,
      quarantine,
    });
  } catch (error) {
    try {
      reconcileQuarantinedRemoval(
        parent,
        name,
        identity,
        expectedSha256,
        expectedMode,
        quarantine,
      );
      runPinnedMutation(parent.absolutePath, parent, {
        kind: "verify_absent",
        name,
      });
    } catch {
      throw error;
    }
  }
}

function reconcileQuarantinedRemoval(
  parent: MutationDirectoryIdentity,
  name: string,
  identity: PinnedIdentity,
  expectedSha256: string | undefined,
  expectedMode: number,
  quarantine: PinnedQuarantine,
): void {
  runPinnedMutation(parent.absolutePath, parent, {
    kind: "reconcile_quarantine",
    name,
    identity,
    ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
    expectedMode,
    quarantine,
  });
}

function mutationQuarantine(plan: MutationPlan): PinnedQuarantine {
  if (plan.quarantinePath === null || plan.quarantineIdentity === null) {
    throw new AgentError("RECOVERY_REQUIRED", "Mutation quarantine evidence is unavailable", {
      path: plan.path,
    });
  }
  return {
    name: path.basename(plan.quarantinePath),
    identity: plan.quarantineIdentity,
  };
}

function removeMutationQuarantine(plan: MutationPlan): void {
  if (!plan.quarantineCreated) return;
  const parent = mutationParentIdentity(plan);
  runPinnedMutation(parent.absolutePath, parent, {
    kind: "remove_quarantine",
    quarantine: mutationQuarantine(plan),
  });
  plan.quarantineCreated = false;
}

async function assertMutationDirectoriesStable(plan: MutationPlan): Promise<void> {
  for (const expected of plan.directoryIdentities) {
    try {
      const linkState = await lstat(expected.absolutePath, { bigint: true });
      const current = await stat(expected.absolutePath, { bigint: true });
      if (
        linkState.isSymbolicLink() ||
        !current.isDirectory() ||
        current.dev.toString() !== expected.device ||
        current.ino.toString() !== expected.inode ||
        (await realpath(expected.absolutePath)) !== expected.absolutePath
      ) {
        throw new Error("directory identity mismatch");
      }
    } catch (error) {
      throw new AgentError(
        "STALE_STATE",
        "Mutation parent directory changed before a filesystem operation",
        { path: plan.path },
        { cause: error },
      );
    }
  }
}

function assertMutationBudgetReservation(
  maxFiles: number,
  maxChangedLines: number,
): void {
  if (
    !Number.isSafeInteger(maxFiles) ||
    maxFiles < 1 ||
    !Number.isSafeInteger(maxChangedLines) ||
    maxChangedLines < 0
  ) {
    throw new AgentError("INTERNAL_ERROR", "Mutation budget reservation is invalid", {
      maxFiles,
      maxChangedLines,
    });
  }
}
