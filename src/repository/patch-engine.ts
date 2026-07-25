import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { AgentError } from "../shared/errors.js";
import { sha256 } from "../shared/crypto.js";
import type { PathProtectionPolicy } from "../security/protected-paths.js";
import type { RepositoryBoundary } from "./boundary.js";
import { normalizeRepositoryPath } from "./boundary.js";
import { checkpointMutationArtifactPaths, type CheckpointStore } from "./checkpoint.js";
import { countChangedLines, planExactTextEdit } from "./exact-text-edit.js";
import { looksBinary, readTextFile } from "./text-file.js";
import type { FileState } from "./types.js";
import { CURRENT_HOST_PLATFORM } from "../platform/index.js";

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

export interface PatchEngineHooks {
  /** @internal Deterministic checkpoint race injection point. */
  readonly beforeCheckpoint?: () => Promise<void>;
  /** @internal Deterministic checkpoint race injection point. */
  readonly afterCheckpoint?: () => Promise<void>;
  /** @internal Deterministic transaction-directory race injection point. */
  readonly afterTransactionDirectory?: (
    path: string,
    transactionDirectory: string,
  ) => Promise<void>;
  /** @internal Deterministic fault/race injection point used by repository tests. */
  readonly beforeCapture?: (path: string) => Promise<void>;
  /** @internal Deterministic fault/race injection point used by repository tests. */
  readonly afterCapture?: (path: string) => Promise<void>;
  /** @internal Deterministic post-install race injection point. */
  readonly afterInstall?: (path: string) => Promise<void>;
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
  transactionDirectory: string | null;
  transactionDirectoryIdentity: MutationDirectoryIdentity | null;
  temporaryPath: string | null;
  backupPath: string | null;
  temporaryCreated: boolean;
  backupCreated: boolean;
  backupDeleted: boolean;
  finalInstalled: boolean;
}

interface MutationDirectoryIdentity {
  readonly absolutePath: string;
  readonly device: number;
  readonly inode: number;
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
  }

  /**
   * Builds a targeted update from an exact, hash-guarded before-image, then
   * delegates commit/checkpoint/rollback/post-state verification to applyPatch.
   */
  public async editText(request: EditTextRequest): Promise<ApplyPatchResult> {
    const normalizedPath = normalizeRepositoryPath(request.path);
    assertSupportedMutationPath(normalizedPath);
    this.protectedPaths.assertAllowed(normalizedPath, "update");
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
    return this.applyPatch({
      changes: [{
        kind: "update",
        path: normalizedPath,
        base_sha256: snapshot.state.sha256,
        content: edit.content,
      }],
      ...(request.operationId === undefined ? {} : { operationId: request.operationId }),
    });
  }

  public async applyPatch(request: ApplyPatchRequest): Promise<ApplyPatchResult> {
    if (!Array.isArray(request.changes) || request.changes.length === 0) {
      throw new AgentError("PROTOCOL_INVALID", "Patch transaction must contain at least one change");
    }
    if (request.changes.length > this.maxFiles) {
      throw new AgentError("BUDGET_EXCEEDED", "Patch exceeds the changed-file budget", {
        fileCount: request.changes.length,
        maxFiles: this.maxFiles,
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
        oldBytes = await readFile(existing.absolutePath);
        oldMode = existingStat.mode & 0o777;
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
        transactionDirectory: null,
        transactionDirectoryIdentity: null,
        temporaryPath: null,
        backupPath: null,
        temporaryCreated: false,
        backupCreated: false,
        backupDeleted: false,
        finalInstalled: false,
      });
    }

    if (totalBytes > this.maxTotalBytes || changedLines > this.maxChangedLines) {
      throw new AgentError("BUDGET_EXCEEDED", "Patch exceeds the configured change budget", {
        totalBytes,
        maxTotalBytes: this.maxTotalBytes,
        changedLines,
        maxChangedLines: this.maxChangedLines,
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
      plan.transactionDirectory = artifacts.transactionDirectory;
      plan.temporaryPath = plan.newBytes === null ? null : artifacts.temporaryPath;
      plan.backupPath = plan.oldBytes === null ? null : artifacts.backupPath;
    }
    try {
      await this.commit(plans);

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
          changedPaths.push({ path: plan.path, kind: plan.kind, state: null });
        } else {
          const current = await readFile(resolved.absolutePath);
          if (sha256(current) !== sha256(plan.newBytes)) {
            throw new AgentError("RECOVERY_REQUIRED", "Resulting file inventory failed verification", {
              path: plan.path,
              checkpointId: checkpoint.id,
            });
          }
          const currentStat = await stat(resolved.absolutePath);
          changedPaths.push({
            path: plan.path,
            kind: plan.kind,
            state: {
              sha256: sha256(current),
              sizeBytes: current.length,
              modifiedAtMs: currentStat.mtimeMs,
            },
          });
        }
      }

      await this.checkpoints.seal(
        checkpoint.id,
        changedPaths.map((entry) => ({
          path: entry.path,
          sha256: entry.state?.sha256 ?? null,
        })),
      );

      return {
        checkpointId: checkpoint.id,
        changedPaths,
        changedLines,
        totalBytes,
        warnings: [],
      };
    } catch (error) {
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

  private async commit(plans: readonly MutationPlan[]): Promise<void> {
    for (const plan of plans) {
      if (plan.transactionDirectory === null) {
        throw new AgentError("INTERNAL_ERROR", "Mutation transaction directory is missing");
      }
      await assertMutationDirectoriesStable(plan);
      await mkdir(plan.transactionDirectory, { mode: 0o700 });
      await assertMutationDirectoriesStable(plan);
      const transactionStat = await lstat(plan.transactionDirectory);
      if (
        transactionStat.isSymbolicLink() ||
        !transactionStat.isDirectory() ||
        (await realpath(plan.transactionDirectory)) !== plan.transactionDirectory
      ) {
        throw new AgentError("STALE_STATE", "Mutation transaction directory changed", {
          path: plan.path,
        });
      }
      plan.transactionDirectoryIdentity = {
        absolutePath: plan.transactionDirectory,
        device: transactionStat.dev,
        inode: transactionStat.ino,
      };
      await this.hooks.afterTransactionDirectory?.(plan.path, plan.transactionDirectory);
      await assertMutationDirectoriesStable(plan);
    }

    for (const plan of plans) {
      if (plan.newBytes !== null && plan.temporaryPath !== null) {
        await assertMutationDirectoriesStable(plan);
        await writeFile(plan.temporaryPath, plan.newBytes, {
          flag: "wx",
          mode: 0o600,
          flush: true,
        });
        plan.temporaryCreated = true;
      }
    }

    for (const plan of plans) {
      const current = await this.boundary.resolve(plan.path, { allowMissingLeaf: true });
      if ((plan.oldBytes === null) === current.exists) {
        throw new AgentError("STALE_STATE", "Path existence changed before patch commit", {
          path: plan.path,
        });
      }
      if (current.exists) {
        const currentFile = await this.boundary.resolveExistingFile(plan.path);
        const currentBytes = await readFile(currentFile.absolutePath);
        if (plan.expectedSha256 === null || sha256(currentBytes) !== plan.expectedSha256) {
          throw new AgentError("STALE_STATE", "File changed before patch commit", { path: plan.path });
        }
        if (plan.backupPath === null) {
          throw new AgentError("INTERNAL_ERROR", "Mutation backup path is missing");
        }
        await this.hooks.beforeCapture?.(plan.path);
        await assertMutationDirectoriesStable(plan);
        await rename(plan.absolutePath, plan.backupPath);
        plan.backupCreated = true;
        await this.hooks.afterCapture?.(plan.path);
        await assertMutationDirectoriesStable(plan);
        const captured = await readFile(plan.backupPath);
        const capturedStat = await stat(plan.backupPath);
        if (
          plan.expectedSha256 === null ||
          sha256(captured) !== plan.expectedSha256 ||
          (plan.oldMode !== null && (capturedStat.mode & 0o777) !== plan.oldMode)
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
        await assertMutationDirectoriesStable(plan);
        await link(plan.temporaryPath, plan.absolutePath);
        await rm(plan.temporaryPath, { force: false });
        plan.temporaryCreated = false;
        plan.finalInstalled = true;
        if (plan.oldMode !== null && CURRENT_HOST_PLATFORM.supportsPosixModes) {
          await chmod(plan.absolutePath, plan.oldMode);
        }
        await this.hooks.afterInstall?.(plan.path);
      }
    }

    for (const plan of plans) {
      if (plan.backupPath !== null) {
        await assertMutationDirectoriesStable(plan);
        const captured = await readFile(plan.backupPath);
        if (plan.expectedSha256 === null || sha256(captured) !== plan.expectedSha256) {
          throw new AgentError("STALE_STATE", "Captured file changed during patch commit", {
            path: plan.path,
          });
        }
        await rm(plan.backupPath, { force: false });
        plan.backupCreated = false;
        plan.backupDeleted = true;
      }
      await this.removeTransactionDirectory(plan);
    }
  }

  private async restorePlans(plans: readonly MutationPlan[]): Promise<void> {
    const restorationErrors: string[] = [];
    for (const plan of [...plans].reverse()) {
      try {
        if (plan.temporaryCreated && plan.temporaryPath !== null) {
          await assertMutationDirectoriesStable(plan);
          await rm(plan.temporaryPath, { force: true });
          plan.temporaryCreated = false;
        }
        if (!plan.finalInstalled && !plan.backupCreated && !plan.backupDeleted) {
          await this.removeTransactionDirectory(plan);
          continue;
        }
        const current = await this.boundary.resolve(plan.path, { allowMissingLeaf: true });
        if (plan.finalInstalled && plan.newBytes !== null && !current.exists) {
          throw new Error("Installed result was removed during transaction recovery");
        }
        if (plan.finalInstalled && current.exists) {
          const currentBytes = await readFile(current.absolutePath);
          if (plan.newBytes === null || sha256(currentBytes) !== sha256(plan.newBytes)) {
            throw new Error("Result path changed again during transaction recovery");
          }
          await rm(current.absolutePath, { force: false });
        }
        if (plan.backupCreated && plan.backupPath !== null) {
          await assertMutationDirectoriesStable(plan);
          await link(plan.backupPath, plan.absolutePath);
          await rm(plan.backupPath, { force: false });
          plan.backupCreated = false;
        } else if (plan.oldBytes !== null && (plan.finalInstalled || plan.backupDeleted)) {
          try {
            await writeFile(plan.absolutePath, plan.oldBytes, {
              flag: "wx",
              mode: 0o600,
              flush: true,
            });
            if (plan.oldMode !== null && CURRENT_HOST_PLATFORM.supportsPosixModes) {
              await chmod(plan.absolutePath, plan.oldMode);
            }
          } catch (error) {
            throw new Error("Original content could not be restored", { cause: error });
          }
        }
        plan.finalInstalled = false;
        await this.removeTransactionDirectory(plan);
      } catch (error) {
        restorationErrors.push(`${plan.path}: ${String(error)}`);
      }
    }
    if (restorationErrors.length > 0) {
      throw new Error(restorationErrors.join("; "));
    }
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

  private async removeTransactionDirectory(plan: MutationPlan): Promise<void> {
    if (plan.transactionDirectory === null) return;
    await assertMutationDirectoriesStable(plan);
    await rmdir(plan.transactionDirectory);
    plan.transactionDirectory = null;
    plan.transactionDirectoryIdentity = null;
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
    const linkState = await lstat(absolutePath);
    const state = await stat(absolutePath);
    if (
      linkState.isSymbolicLink() ||
      !state.isDirectory() ||
      (await realpath(absolutePath)) !== absolutePath
    ) {
      throw new AgentError("UNSUPPORTED_FILE", "Mutation parent must be a stable directory", {
        path: repositoryPath,
      });
    }
    identities.push({
      absolutePath,
      device: state.dev,
      inode: state.ino,
    });
  }
  return identities;
}

async function assertMutationDirectoriesStable(plan: MutationPlan): Promise<void> {
  const identities = [
    ...plan.directoryIdentities,
    ...(plan.transactionDirectoryIdentity === null ? [] : [plan.transactionDirectoryIdentity]),
  ];
  for (const expected of identities) {
    try {
      const linkState = await lstat(expected.absolutePath);
      const current = await stat(expected.absolutePath);
      if (
        linkState.isSymbolicLink() ||
        !current.isDirectory() ||
        current.dev !== expected.device ||
        current.ino !== expected.inode ||
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
