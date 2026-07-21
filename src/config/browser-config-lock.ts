import { mkdir, open, readFile, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

import { newId } from "../shared/crypto.js";
import { AgentError } from "../shared/errors.js";

const LOCK_DIRECTORY = ".browser-config.lock";
const OWNER_FILENAME = "owner.json";
const RECOVERY_FILENAME = "recovery.claim";

interface BrowserConfigLockMetadata {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
  readonly createdAt: string;
}

/**
 * A directory lock keeps a dead owner's namespace present while exactly one
 * contender claims recovery inside it. The path is removed only after that
 * claim succeeds, so another contender cannot install a new owner between a
 * stale-owner check and cleanup.
 */
export class BrowserConfigTransactionLock {
  readonly #lockDirectory: string;
  readonly #token: string;
  #released = false;

  private constructor(lockDirectory: string, token: string) {
    this.#lockDirectory = lockDirectory;
    this.#token = token;
  }

  public static async acquire(stateHome: string): Promise<BrowserConfigTransactionLock> {
    const configDirectory = path.join(stateHome, "config");
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    const lockDirectory = path.join(configDirectory, LOCK_DIRECTORY);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = newId("browser-config-lock");
      try {
        await mkdir(lockDirectory, { mode: 0o700 });
        const metadata: BrowserConfigLockMetadata = {
          version: 1,
          pid: process.pid,
          token,
          createdAt: new Date().toISOString(),
        };
        try {
          const handle = await open(path.join(lockDirectory, OWNER_FILENAME), "wx", 0o600);
          try {
            await handle.writeFile(JSON.stringify(metadata), "utf8");
            await handle.sync();
          } finally {
            await handle.close();
          }
        } catch (error) {
          await unlink(path.join(lockDirectory, OWNER_FILENAME)).catch(ignoreMissing);
          await rmdir(lockDirectory).catch(ignoreMissing);
          throw error;
        }
        return new BrowserConfigTransactionLock(lockDirectory, token);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      }

      const owner = await readMetadata(path.join(lockDirectory, OWNER_FILENAME));
      if (owner === undefined) {
        throw recoveryError("The browser configuration lock cannot be verified", "BROWSER_CONFIG_LOCK_UNREADABLE");
      }
      if (isProcessAlive(owner.pid)) {
        throw new AgentError("TRANSPORT_UNAVAILABLE", "Browser configuration is being updated by another Cope process", {
          diagnosticCode: "BROWSER_CONFIG_LOCKED",
        });
      }
      await claimAndRemoveDeadLock(lockDirectory, owner.token);
    }
    throw new AgentError("TRANSPORT_UNAVAILABLE", "Could not acquire the browser configuration lock", {
      diagnosticCode: "BROWSER_CONFIG_LOCK_RACE",
    });
  }

  public async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    const ownerFile = path.join(this.#lockDirectory, OWNER_FILENAME);
    const owner = await readMetadata(ownerFile);
    if (owner?.token !== this.#token) return;
    await unlink(ownerFile).catch(ignoreMissing);
    await rmdir(this.#lockDirectory).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }
}

async function claimAndRemoveDeadLock(lockDirectory: string, observedToken: string): Promise<void> {
  const claimFile = path.join(lockDirectory, RECOVERY_FILENAME);
  let claim;
  try {
    claim = await open(claimFile, "wx", 0o600);
  } catch (error) {
    if (isNodeError(error) && (error.code === "EEXIST" || error.code === "ENOENT")) {
      throw recoveryError("Another Cope process is recovering the browser configuration lock", "BROWSER_CONFIG_LOCK_RECOVERY_RACE");
    }
    throw error;
  }
  try {
    await claim.writeFile(observedToken, "utf8");
    await claim.sync();
  } finally {
    await claim.close();
  }

  const ownerFile = path.join(lockDirectory, OWNER_FILENAME);
  const current = await readMetadata(ownerFile);
  if (current?.token !== observedToken || current === undefined || isProcessAlive(current.pid)) {
    await unlink(claimFile).catch(ignoreMissing);
    throw recoveryError("The browser configuration lock changed during recovery", "BROWSER_CONFIG_LOCK_RECOVERY_RACE");
  }
  await unlink(ownerFile);
  await unlink(claimFile);
  await rmdir(lockDirectory);
}

async function readMetadata(filename: string): Promise<BrowserConfigLockMetadata | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filename, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const item = parsed as Readonly<Record<string, unknown>>;
    if (
      Object.keys(item).sort().join("\0") !== ["createdAt", "pid", "token", "version"].join("\0") ||
      item.version !== 1 || !Number.isSafeInteger(item.pid) || typeof item.token !== "string" ||
      item.token.length < 16 || typeof item.createdAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(item.createdAt) ||
      !Number.isFinite(Date.parse(item.createdAt))
    ) return undefined;
    return item as unknown as BrowserConfigLockMetadata;
  } catch {
    return undefined;
  }
}

function recoveryError(message: string, diagnosticCode: string): AgentError {
  return new AgentError("RECOVERY_REQUIRED", message, {
    diagnosticCode,
    next: "Inspect the private config/.browser-config.lock directory; remove it only after confirming no Cope process owns it.",
  });
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function ignoreMissing(error: unknown): void {
  if (!isNodeError(error) || error.code !== "ENOENT") throw error;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
