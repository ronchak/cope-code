import type { PathProtectionPolicy } from "../security/protected-paths.js";
import { ProtectedPathPolicy } from "../security/protected-paths.js";
import { RepositoryBoundary } from "./boundary.js";
import { CheckpointStore, type CheckpointStoreOptions } from "./checkpoint.js";
import { GitInspector, type GitInspectorOptions } from "./git.js";
import { PatchEngine, type PatchBudgets } from "./patch-engine.js";
import { RepositoryTools, type RepositoryToolsOptions } from "./repository-tools.js";
import { SnapshotDiffInspector } from "./snapshot-diff.js";
import type { FilesystemIdentity } from "../shared/filesystem-identity.js";

export interface RepositoryContextConfig {
  /** An exact repository root, canonicalized before use. */
  readonly repositoryRoot: string;
  /** Recovery storage is normally placed outside the working tree. */
  readonly checkpointDirectory: string;
  readonly repositoryTools?: RepositoryToolsOptions;
  readonly git?: GitInspectorOptions;
  readonly checkpoints?: CheckpointStoreOptions;
  readonly patchBudgets?: PatchBudgets;
  readonly protectedPaths?: PathProtectionPolicy;
  readonly filesystemIdentity?: FilesystemIdentity;
}

/** Coherent deterministic repository control plane; contains no browser or model logic. */
export class RepositoryContext {
  private constructor(
    public readonly boundary: RepositoryBoundary,
    public readonly tools: RepositoryTools,
    public readonly git: GitInspector,
    public readonly checkpoints: CheckpointStore,
    public readonly patchEngine: PatchEngine,
    public readonly snapshotDiff: SnapshotDiffInspector,
  ) {}

  public static async create(config: RepositoryContextConfig): Promise<RepositoryContext> {
    const boundary = await RepositoryBoundary.create(config.repositoryRoot, config.filesystemIdentity);
    return RepositoryContext.createForBoundary(boundary, config);
  }

  public static async discover(
    config: Omit<RepositoryContextConfig, "repositoryRoot"> & {
      readonly startPath: string;
      readonly gitExecutable?: string;
    },
  ): Promise<RepositoryContext> {
    const boundary = await RepositoryBoundary.discover(config.startPath, config.gitExecutable);
    const { startPath: _startPath, gitExecutable, ...contextConfig } = config;
    return RepositoryContext.createForBoundary(boundary, {
      ...contextConfig,
      repositoryRoot: boundary.root,
      git: {
        ...config.git,
        ...(gitExecutable === undefined ? {} : { gitExecutable }),
      },
    });
  }

  private static async createForBoundary(
    boundary: RepositoryBoundary,
    config: RepositoryContextConfig,
  ): Promise<RepositoryContext> {
    await boundary.assertNoNestedGitBoundaries({
      ...(config.git?.gitExecutable === undefined
        ? {}
        : { gitExecutable: config.git.gitExecutable }),
    });
    const tools = await RepositoryTools.create(boundary, config.repositoryTools);
    const git = new GitInspector(boundary, {
      ...config.git,
      isPathAllowed: (candidate, operation) =>
        tools.isPathAllowed(candidate, operation) &&
        (config.git?.isPathAllowed?.(candidate, operation) ?? true),
    });
    const checkpoints = await CheckpointStore.create(
      boundary,
      config.checkpointDirectory,
      config.checkpoints,
    );
    const configuredProtection = config.protectedPaths ?? new ProtectedPathPolicy();
    const protectedPaths = configuredProtection instanceof ProtectedPathPolicy
      ? configuredProtection.withFilesystemIdentity(boundary.filesystemIdentity)
      : configuredProtection;
    const patchEngine = new PatchEngine(
      boundary,
      checkpoints,
      protectedPaths,
      config.patchBudgets,
    );
    const snapshotDiff = new SnapshotDiffInspector(boundary, checkpoints, {
      ...(config.git?.maxDiffBytes === undefined ? {} : { maxDiffBytes: config.git.maxDiffBytes }),
      ...(config.patchBudgets?.maxFileBytes === undefined
        ? {}
        : { maxFileBytes: config.patchBudgets.maxFileBytes }),
      ...(config.checkpoints?.maxFiles === undefined ? {} : { maxFiles: config.checkpoints.maxFiles }),
      isPathAllowed: (candidate) => tools.isPathAllowed(candidate, "git_diff"),
    });
    return new RepositoryContext(boundary, tools, git, checkpoints, patchEngine, snapshotDiff);
  }
}
