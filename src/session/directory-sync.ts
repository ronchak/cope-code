import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { CURRENT_HOST_PLATFORM } from "../platform/index.js";

export interface DirectorySyncOptions {
  readonly supported?: boolean;
  readonly openDirectory?: typeof open;
}

/**
 * Host-capability wrapper for durability-sensitive directory publication.
 * A supported-host failure is propagated so callers can refuse launch.
 * Successful sync is hardening, not proof against power or storage loss.
 */
export async function syncDirectory(
  directory: string,
  options: DirectorySyncOptions = {},
): Promise<void> {
  if (!(options.supported ?? CURRENT_HOST_PLATFORM.supportsDirectoryFsync)) return;
  const handle = await (options.openDirectory ?? open)(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
