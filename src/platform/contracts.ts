import type { ChildProcess } from "node:child_process";

export interface ProbeResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type ProbeRunner = (
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  windowsHide: boolean,
) => Promise<ProbeResult>;

export interface HostEligibility {
  readonly standardUserVerified: boolean;
  readonly guiSessionVerified: boolean;
}

export interface HostPlatform {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly liveBrowserSupported: boolean;
  readonly supportsDirectoryFsync: boolean;
  readonly supportsPosixModes: boolean;
  readonly caseInsensitiveByDefault: boolean;
  readonly nullDevice: string;

  stateHome(environment?: NodeJS.ProcessEnv): string;
  profileHome(stateHome: string): string;
  edgeExecutableCandidates(environment?: NodeJS.ProcessEnv): readonly string[];
  gitExecutableCandidates(environment?: NodeJS.ProcessEnv): readonly string[];
  probeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  assertNonPrivileged(): void;
  verifyEligibility(options: {
    readonly liveBrowser: boolean;
    readonly cwd: string;
    readonly runProbe: ProbeRunner;
  }): Promise<HostEligibility>;
  terminateProcessTree(child: ChildProcess, graceMs: number): Promise<void>;
}
