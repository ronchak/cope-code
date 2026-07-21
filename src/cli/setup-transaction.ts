import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";

import { BrowserConfigTransactionLock } from "../config/browser-config-lock.js";
import type { BrowserFileConfig } from "../config/types.js";
import type { PolicyDocument } from "../policy/index.js";
import { readRuntimeManifest } from "./session-files.js";
import { SessionStore } from "../session/store.js";
import { isTerminal } from "../session/state-machine.js";
import { AgentError } from "../shared/errors.js";
import type { HostPlatform } from "../platform/index.js";

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
    await assertNoResumableLiveSessions(options.stateHome);
    await options.revalidate();
    await assertBaselineUnchanged(options.browserFile, options.browserBaseline);
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

async function assertNoResumableLiveSessions(stateHome: string): Promise<void> {
  const sessionsDirectory = path.join(stateHome, "sessions");
  let entries;
  try {
    entries = await readdir(sessionsDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const store = new SessionStore(stateHome);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    try {
      const state = await store.read(entry.name);
      if (isTerminal(state.status)) continue;
      const manifest = await readRuntimeManifest(store.sessionDirectory(state.sessionId));
      if (manifest.transport === "edge") {
        throw new AgentError("RECOVERY_REQUIRED", "Browser setup cannot change while a live-browser session is resumable", {
          diagnosticCode: "BROWSER_CONFIG_RESUMABLE_SESSION",
          sessionId: state.sessionId,
          next: "Resume, abort, or reconcile the session before changing browser setup.",
        });
      }
    } catch (error) {
      if (error instanceof AgentError && error.details.diagnosticCode === "BROWSER_CONFIG_RESUMABLE_SESSION") {
        throw error;
      }
      throw new AgentError("RECOVERY_REQUIRED", "Browser setup found unreadable session state and made no changes", {
        diagnosticCode: "BROWSER_CONFIG_SESSION_SCAN_FAILED",
        sessionDirectory: entry.name,
      }, { cause: error });
    }
  }
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
