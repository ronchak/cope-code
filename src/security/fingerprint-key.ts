import { randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import { AgentError } from "../shared/errors.js";

const KEY_BYTES = 32;

/**
 * Loads a per-session HMAC key used only for stable secret fingerprints. The
 * key is local operational state, never included in prompts, audit events, or
 * exported review metadata.
 */
export async function loadOrCreateFingerprintKey(filename: string): Promise<Uint8Array> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(filename, "wx", 0o600);
    try {
      const key = randomBytes(KEY_BYTES);
      await handle.writeFile(key);
      await handle.sync();
      return key;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const key = await readFile(filename);
  if (key.length !== KEY_BYTES) {
    throw new AgentError("RECOVERY_REQUIRED", "Session secret-fingerprint key is malformed", { filename });
  }
  return key;
}

/** Existing sessions must never silently replace the key that binds their fingerprints. */
export async function loadFingerprintKey(filename: string): Promise<Uint8Array> {
  let key: Buffer;
  try {
    key = await readFile(filename);
  } catch (error) {
    throw new AgentError(
      "RECOVERY_REQUIRED",
      "Session secret-fingerprint key is unavailable",
      { filename },
      { cause: error },
    );
  }
  if (key.length !== KEY_BYTES) {
    throw new AgentError("RECOVERY_REQUIRED", "Session secret-fingerprint key is malformed", { filename });
  }
  return key;
}
