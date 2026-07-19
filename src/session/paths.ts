import { createHash } from "node:crypto";
import { hostname } from "node:os";

import { CURRENT_HOST_PLATFORM, type HostPlatform } from "../platform/index.js";

export function resolveStateHome(
  env: NodeJS.ProcessEnv = process.env,
  host: HostPlatform = CURRENT_HOST_PLATFORM,
): string {
  return host.stateHome(env);
}

export function workspaceKey(canonicalRepositoryRoot: string): string {
  return createHash("sha256").update(canonicalRepositoryRoot).digest("hex");
}

export function currentHost(): string {
  return hostname();
}
