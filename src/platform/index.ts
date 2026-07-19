import { arch, platform } from "node:os";
import { existsSync } from "node:fs";

import type { HostPlatform } from "./contracts.js";
import { DarwinHostPlatform } from "./darwin.js";
import { UnsupportedHostPlatform } from "./unsupported.js";
import { WindowsHostPlatform } from "./windows.js";

export * from "./contracts.js";
export { runHostProbe } from "./common.js";
export { DarwinHostPlatform } from "./darwin.js";
export { UnsupportedHostPlatform } from "./unsupported.js";
export { WindowsHostPlatform } from "./windows.js";

export function selectHostPlatform(
  currentPlatform: NodeJS.Platform = platform(),
  currentArchitecture: string = arch(),
): HostPlatform {
  if (currentPlatform === "win32") return new WindowsHostPlatform(currentArchitecture);
  if (currentPlatform === "darwin") return new DarwinHostPlatform(currentArchitecture);
  return new UnsupportedHostPlatform(currentPlatform, currentArchitecture);
}

/** Selected exactly once for the process; callers inject this object onward. */
export const CURRENT_HOST_PLATFORM: HostPlatform = selectHostPlatform();

export function resolveDefaultGitExecutable(
  host: HostPlatform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return host.gitExecutableCandidates(environment)
    .find((candidate) => candidate === "git" || existsSync(candidate)) ?? "git";
}
