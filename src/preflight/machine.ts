import { access } from "node:fs/promises";
import { AgentError } from "../shared/errors.js";
import { DEFAULT_GIT_EXECUTABLE, RepositoryBoundary } from "../repository/boundary.js";
import {
  CURRENT_HOST_PLATFORM,
  resolveDefaultGitExecutable,
  runHostProbe,
  type HostPlatform,
  type ProbeRunner,
} from "../platform/index.js";

export interface MachinePreflightOptions {
  readonly repositoryRoot: string;
  readonly liveBrowser: boolean;
  readonly edgeExecutable?: string;
  readonly gitExecutable?: string;
  readonly minimumNodeMajor?: number;
  readonly host?: HostPlatform;
  readonly runProbe?: ProbeRunner;
}

export interface MachinePreflightResult {
  readonly platform: NodeJS.Platform;
  readonly nodeVersion: string;
  readonly gitVersion: string;
  readonly repositoryTopLevel: string;
  readonly edgeExecutable?: string;
  readonly standardUserVerified: boolean;
  readonly guiSessionVerified: boolean;
  readonly warnings: readonly string[];
}

export async function runHostEligibilityPreflight(options: {
  readonly liveBrowser: boolean;
  readonly cwd?: string;
  readonly minimumNodeMajor?: number;
  readonly host?: HostPlatform;
  readonly runProbe?: ProbeRunner;
}): Promise<{ readonly host: HostPlatform; readonly eligibility: Awaited<ReturnType<HostPlatform["verifyEligibility"]>> }> {
  const host = options.host ?? CURRENT_HOST_PLATFORM;
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const minimum = options.minimumNodeMajor ?? 24;
  if (!Number.isSafeInteger(major) || major < minimum) {
    throw new AgentError("CONFIG_INVALID", `Node.js ${minimum} or newer is required`, {
      actual: process.versions.node,
    });
  }
  const eligibility = await host.verifyEligibility({
    liveBrowser: options.liveBrowser,
    cwd: options.cwd ?? process.cwd(),
    runProbe: options.runProbe ?? runHostProbe,
  });
  return { host, eligibility };
}

export async function runMachinePreflight(options: MachinePreflightOptions): Promise<MachinePreflightResult> {
  const early = await runHostEligibilityPreflight(options);
  const host = early.host;
  const probe = options.runProbe ?? runHostProbe;
  const warnings: string[] = [];

  const gitExecutable = options.gitExecutable ?? resolveDefaultGitExecutable(host);
  const version = await probe(gitExecutable, ["--version"], options.repositoryRoot, host.probeEnvironment(process.env), host.platform === "win32");
  if (version.exitCode !== 0 || !version.stdout.startsWith("git version ")) {
    throw new AgentError("CONFIG_INVALID", "Git is required and was not detected", {
      executable: gitExecutable,
      output: bounded(version.stderr || version.stdout),
    });
  }
  const topLevel = await probe(
    gitExecutable,
    ["-C", options.repositoryRoot, "rev-parse", "--show-toplevel"],
    options.repositoryRoot,
    host.probeEnvironment(process.env),
    host.platform === "win32",
  );
  if (topLevel.exitCode !== 0 || topLevel.stdout.trim().length === 0) {
    throw new AgentError("CONFIG_INVALID", "The selected directory is not a Git working tree", {
      repositoryRoot: options.repositoryRoot,
    });
  }
  const boundary = await RepositoryBoundary.create(topLevel.stdout.trim());
  await boundary.assertNoNestedGitBoundaries({ gitExecutable });

  if (options.liveBrowser) {
    if (!options.edgeExecutable) {
      throw new AgentError("CONFIG_INVALID", "Live Edge transport requires an explicit Edge executable path");
    }
    await access(options.edgeExecutable).catch(() => {
      throw new AgentError("CONFIG_INVALID", "Configured Microsoft Edge executable is unavailable", {
        edgeExecutable: options.edgeExecutable,
      });
    });
  } else {
    warnings.push(...offlineTransportWarnings(host));
  }

  return {
    platform: host.platform,
    nodeVersion: process.versions.node,
    gitVersion: version.stdout.trim(),
    repositoryTopLevel: topLevel.stdout.trim(),
    ...(options.edgeExecutable === undefined ? {} : { edgeExecutable: options.edgeExecutable }),
    standardUserVerified: early.eligibility.standardUserVerified,
    guiSessionVerified: early.eligibility.guiSessionVerified,
    warnings,
  };
}

export function offlineTransportWarnings(host: HostPlatform): readonly string[] {
  return host.platform === "win32"
    ? []
    : ["Live Edge checks were skipped because an offline transport was selected."];
}

function bounded(value: string): string {
  return value.slice(0, 2_048).replace(/[\r\n]+/gu, " ");
}
