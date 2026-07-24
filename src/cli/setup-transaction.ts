import { constants } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

import { BrowserConfigTransactionLock } from "../config/browser-config-lock.js";
import type { BrowserFileConfig } from "../config/types.js";
import type { PolicyDocument } from "../policy/index.js";
import { AgentError } from "../shared/errors.js";
import { CURRENT_HOST_PLATFORM, type HostPlatform } from "../platform/index.js";
import {
  browserSetupBlockedErrorDetails,
  liveBrowserSetupBlockers,
  scanSessionRecovery,
} from "./session-recovery.js";

export interface BrowserConfigBaseline {
  readonly exists: boolean;
  readonly bytes?: Buffer;
}

export async function readBrowserConfigBaseline(filename: string): Promise<BrowserConfigBaseline> {
  try {
    return { exists: true, bytes: await readFile(filename) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
}

export async function commitBrowserSetup(options: {
  readonly stateHome: string;
  readonly browserFile: string;
  readonly browserBaseline: BrowserConfigBaseline;
  readonly organizationPolicyFile: string;
  readonly organizationPolicyToCreate?: PolicyDocument;
  readonly browserConfig?: BrowserFileConfig;
  readonly host: HostPlatform;
  readonly revalidate: () => Promise<void>;
}): Promise<void> {
  const lock = await BrowserConfigTransactionLock.acquire(options.stateHome);
  try {
    await assertBaselineUnchanged(options.browserFile, options.browserBaseline);
    await assertBrowserSetupRecoveryReady(options.stateHome, options.host);
    await options.revalidate();
    await assertBaselineUnchanged(options.browserFile, options.browserBaseline);
    await assertBrowserSetupRecoveryReady(options.stateHome, options.host);
    if (options.organizationPolicyToCreate !== undefined) {
      const existing = await readBrowserConfigBaseline(options.organizationPolicyFile);
      if (existing.exists) {
        throw new AgentError("CONFIG_INVALID", "Machine policy appeared while setup was running; setup was not changed", {
          diagnosticCode: "SETUP_POLICY_COMPARE_AND_SWAP_FAILED",
        });
      }
      await atomicWriteJson(options.organizationPolicyFile, options.organizationPolicyToCreate, options.host);
    }
    if (options.browserConfig !== undefined) {
      await atomicWriteJson(options.browserFile, options.browserConfig, options.host);
    }
  } finally {
    await lock.release();
  }
}

export async function pinBrowserConfigurationForSession<T>(options: {
  readonly stateHome: string;
  readonly expectedBrowserHash: string;
  readonly loadCurrent: () => Promise<T & { readonly hashes: { readonly browser?: string } }>;
  readonly writeManifest: (configuration: T) => Promise<void>;
}): Promise<void> {
  const lock = await BrowserConfigTransactionLock.acquire(options.stateHome);
  try {
    const current = await options.loadCurrent();
    if (current.hashes.browser !== options.expectedBrowserHash) {
      throw new AgentError("RECOVERY_REQUIRED", "Browser configuration changed while the session was starting", {
        diagnosticCode: "BROWSER_CONFIG_START_RACE",
      });
    }
    await options.writeManifest(current);
  } finally {
    await lock.release();
  }
}

async function assertBaselineUnchanged(filename: string, baseline: BrowserConfigBaseline): Promise<void> {
  const current = await readBrowserConfigBaseline(filename);
  const matches = current.exists === baseline.exists && (
    !current.exists || current.bytes?.equals(baseline.bytes ?? Buffer.alloc(0)) === true
  );
  if (!matches) {
    throw new AgentError("CONFIG_INVALID", "Browser configuration changed while setup was running; no setup changes were saved", {
      diagnosticCode: "BROWSER_CONFIG_COMPARE_AND_SWAP_FAILED",
    });
  }
}

export async function assertBrowserSetupRecoveryReady(
  stateHome: string,
  host: HostPlatform = CURRENT_HOST_PLATFORM,
): Promise<void> {
  const blockers = liveBrowserSetupBlockers(await scanSessionRecovery(stateHome, host));
  if (blockers.length === 0) return;
  throw new AgentError(
    "RECOVERY_REQUIRED",
    blockers.length === 1
      ? "Browser setup is blocked by an unfinished live-browser session"
      : `Browser setup is blocked by ${String(blockers.length)} unfinished live-browser sessions`,
    browserSetupBlockedErrorDetails(blockers),
  );
}

async function atomicWriteJson(filename: string, value: unknown, host: HostPlatform): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filename);
  if (host.supportsDirectoryFsync) {
    const directory = await open(path.dirname(filename), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
