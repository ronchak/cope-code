import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";

import type { HostPlatform } from "../platform/index.js";
import { AgentError } from "../shared/errors.js";

export const COMMAND_CONTAINMENT_PROFILE_VERSION = "command-containment/1" as const;

export interface CommandContainmentProfile {
  readonly version: typeof COMMAND_CONTAINMENT_PROFILE_VERSION;
  readonly filesystem: {
    readonly repository: "read-only" | "read-write";
    readonly system: "read-only";
    readonly temporary: "deny";
  };
  readonly network:
    | { readonly mode: "deny" }
    | { readonly mode: "unrestricted" }
    | { readonly mode: "allow-listed"; readonly hosts: readonly string[] };
  /** Represented now; current backends reject nonempty resource limits. */
  readonly resources?: {
    readonly maxProcesses?: number;
    readonly maxMemoryBytes?: number;
    readonly maxCpuTimeMs?: number;
  };
}

export interface ContainmentLaunchRequest {
  readonly profile: CommandContainmentProfile;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly repositoryRoot: string;
  readonly workingDirectory: string;
}

export interface ContainedLaunch {
  readonly backend: "linux-bubblewrap" | "darwin-seatbelt";
  readonly executable: string;
  readonly arguments: readonly string[];
}

export interface CommandContainmentBackend {
  prepare(request: ContainmentLaunchRequest): Promise<ContainedLaunch>;
}

/**
 * Selects only a concrete backend whose launcher is present. Windows has no
 * backend here: restricted tokens, Job Objects, AppContainer, and network
 * policy require a dedicated native implementation before containment can be
 * claimed.
 */
export function platformContainmentBackend(host: HostPlatform): CommandContainmentBackend {
  if (host.platform === "linux") return new BubblewrapContainmentBackend();
  if (host.platform === "darwin") return new SeatbeltContainmentBackend();
  return new UnavailableContainmentBackend(host.platform);
}

class UnavailableContainmentBackend implements CommandContainmentBackend {
  public constructor(private readonly platform: string) {}

  public async prepare(): Promise<ContainedLaunch> {
    throw new AgentError("POLICY_DENIED", `Required command containment is unavailable on '${this.platform}'`);
  }
}

export class BubblewrapContainmentBackend implements CommandContainmentBackend {
  public constructor(private readonly launcherCandidates: readonly string[] = ["/usr/bin/bwrap", "/bin/bwrap"]) {}

  public async prepare(request: ContainmentLaunchRequest): Promise<ContainedLaunch> {
    assertValidContainmentProfile(request.profile);
    rejectUnsupportedProfileFeatures(request.profile);
    const launcher = await requireLauncher(this.launcherCandidates, "bubblewrap");
    const args = [
      "--die-with-parent",
      "--new-session",
      "--unshare-user-try",
      "--unshare-pid",
      "--ro-bind",
      "/",
      "/",
      "--proc",
      "/proc",
      request.profile.filesystem.repository === "read-write" ? "--bind" : "--ro-bind",
      request.repositoryRoot,
      request.repositoryRoot,
      "--chdir",
      request.workingDirectory,
    ];
    if (request.profile.network.mode === "deny") args.push("--unshare-net");
    args.push("--", request.executable, ...request.arguments);
    return { backend: "linux-bubblewrap", executable: launcher, arguments: args };
  }
}

export class SeatbeltContainmentBackend implements CommandContainmentBackend {
  public constructor(private readonly launcherCandidates: readonly string[] = ["/usr/bin/sandbox-exec"]) {}

  public async prepare(request: ContainmentLaunchRequest): Promise<ContainedLaunch> {
    assertValidContainmentProfile(request.profile);
    rejectUnsupportedProfileFeatures(request.profile);
    const launcher = await requireLauncher(this.launcherCandidates, "sandbox-exec");
    const rules = [
      "(version 1)",
      "(allow default)",
      "(deny file-write*)",
      request.profile.filesystem.repository === "read-write"
        ? `(allow file-write* (subpath ${seatbeltString(request.repositoryRoot)}))`
        : "",
      request.profile.network.mode === "deny" ? "(deny network*)" : "",
    ].filter((rule) => rule !== "");
    return {
      backend: "darwin-seatbelt",
      executable: launcher,
      arguments: ["-p", rules.join("\n"), request.executable, ...request.arguments],
    };
  }
}

export function assertValidContainmentProfile(profile: CommandContainmentProfile): void {
  if (profile.version !== COMMAND_CONTAINMENT_PROFILE_VERSION) {
    throw new AgentError("POLICY_DENIED", "Command containment profile version is unsupported");
  }
  if (profile.filesystem.system !== "read-only" || profile.filesystem.temporary !== "deny") {
    throw new AgentError("POLICY_DENIED", "Command containment profile requests unsupported filesystem authority");
  }
  if (profile.network.mode === "allow-listed") {
    if (profile.network.hosts.length === 0 || profile.network.hosts.some((host) => host.trim() === "")) {
      throw new AgentError("POLICY_DENIED", "Command containment network allow-list is invalid");
    }
  }
  for (const limit of Object.values(profile.resources ?? {})) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new AgentError("POLICY_DENIED", "Command containment resource limits must be positive integers");
    }
  }
}

function rejectUnsupportedProfileFeatures(profile: CommandContainmentProfile): void {
  if (profile.network.mode === "allow-listed") {
    throw new AgentError("POLICY_DENIED", "Host-scoped network containment is not implemented by this backend");
  }
  if (Object.keys(profile.resources ?? {}).length > 0) {
    throw new AgentError("POLICY_DENIED", "Resource-limit containment is not implemented by this backend");
  }
}

async function requireLauncher(candidates: readonly string[], name: string): Promise<string> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const canonical = await realpath(candidate);
      if ((await stat(canonical)).isFile()) return canonical;
    } catch {
      // Continue through the bounded, platform-owned candidate list.
    }
  }
  throw new AgentError("POLICY_DENIED", `Required ${name} command containment backend is unavailable`);
}

function seatbeltString(value: string): string {
  if (value.includes("\u0000") || value.includes("\n") || value.includes("\r")) {
    throw new AgentError("POLICY_DENIED", "Repository path cannot be represented in the Seatbelt profile");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
