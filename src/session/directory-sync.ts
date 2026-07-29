import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { CURRENT_HOST_PLATFORM } from "../platform/index.js";

export interface DirectorySyncOptions {
  readonly supported?: boolean;
  readonly openDirectory?: typeof open;
}

/**
 * Best-effort host capability wrapper for durability-sensitive directory
 * publication. Callers must not treat this as proof against power loss.
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
