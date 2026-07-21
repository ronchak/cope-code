import { chromium, type BrowserContext, type Page } from "playwright-core";
import { realpath } from "node:fs/promises";

import { AgentError } from "../shared/errors.js";
import type {
  ModelTransport,
  ReceiveRequest,
  ReceiveResult,
  SubmissionReceipt,
  SubmissionRequest,
  SubmissionResolutionRequest,
  TransportCallOptions,
} from "../transport/model-transport.js";
import { CopilotBrowserAdapter, type BrowserStateInspection } from "./copilot-browser-adapter.js";
import {
  isApprovedUrl,
  validateEdgeLaunchConfig,
  type BrowserWaitConfig,
  type EdgeLaunchConfig,
} from "./config.js";
import {
  assertKillSwitchEnabled,
  MutableBrowserKillSwitch,
  type BrowserKillSwitch,
} from "./kill-switch.js";
import {
  isTerminalManualReadinessState,
  waitForStableManualReadiness,
} from "./manual-readiness.js";
import { PlaywrightSemanticPage } from "./playwright-semantic-page.js";
import { ExclusiveProfileLock, prepareDedicatedProfile } from "./profile-lock.js";
import { CURRENT_HOST_PLATFORM, type HostPlatform } from "../platform/index.js";
import { verifyDedicatedProfileRoot } from "../platform/private-storage.js";
import { verifyBrowserExecutable, type BrowserIdentityVerifier } from "./discovery.js";

export type PersistentContextLauncher = typeof chromium.launchPersistentContext;

export interface EdgeLauncherDependencies {
  readonly killSwitch?: BrowserKillSwitch;
  readonly host?: HostPlatform;
  readonly launchPersistentContext?: PersistentContextLauncher;
  readonly browserIdentityVerifier?: BrowserIdentityVerifier;
}

/** Browser-neutral name for new integrations. */
export type BrowserLauncherDependencies = EdgeLauncherDependencies;

/** Owns the selected visible browser lifecycle while delegating model operations to the shared adapter. */
export class EdgeCopilotTransport implements ModelTransport {
  public readonly transportKind = "visible-browser-m365-copilot/v1";

  readonly #context: BrowserContext;
  readonly #adapter: CopilotBrowserAdapter;
  readonly #lock: ExclusiveProfileLock;
  readonly #killSwitch: BrowserKillSwitch;
  readonly #readinessWaits: BrowserWaitConfig;
  readonly #isManualAuthenticationRedirect: () => boolean;
  #closed = false;

  private constructor(
    context: BrowserContext,
    adapter: CopilotBrowserAdapter,
    lock: ExclusiveProfileLock,
    killSwitch: BrowserKillSwitch,
    readinessWaits: BrowserWaitConfig,
    isManualAuthenticationRedirect: () => boolean,
  ) {
    this.#context = context;
    this.#adapter = adapter;
    this.#lock = lock;
    this.#killSwitch = killSwitch;
    this.#readinessWaits = readinessWaits;
    this.#isManualAuthenticationRedirect = isManualAuthenticationRedirect;
  }

  public static async launch(
    config: EdgeLaunchConfig,
    dependencies: EdgeLauncherDependencies = {},
  ): Promise<EdgeCopilotTransport> {
    validateEdgeLaunchConfig(config);
    const killSwitch = dependencies.killSwitch ?? new MutableBrowserKillSwitch();
    const host = dependencies.host ?? CURRENT_HOST_PLATFORM;
    const verified = await (dependencies.browserIdentityVerifier ?? ((product, executablePath) =>
      verifyBrowserExecutable(product, executablePath, { host })))(config.product, config.browserExecutable);
    const configuredCanonical = await realpath(config.browserExecutable).catch(() => undefined);
    if (
      verified.product !== config.product || configuredCanonical === undefined ||
      verified.executablePath !== configuredCanonical ||
      config.browserVersion !== undefined && verified.version !== config.browserVersion ||
      config.browserExecutableSha256 !== undefined &&
        verified.executableSha256 !== config.browserExecutableSha256
    ) {
      throw new AgentError("CONFIG_INVALID", "The selected browser identity changed before launch", {
        diagnosticCode: "BROWSER_EXECUTABLE_EVIDENCE_CHANGED",
        product: config.product,
      });
    }
    config = {
      ...config,
      browserExecutable: verified.executablePath,
      browserVersion: verified.version,
      browserExecutableSha256: verified.executableSha256,
    };
    assertKillSwitchEnabled(killSwitch);
    const lock = await ExclusiveProfileLock.acquire(config.profileDirectory, host);
    config = { ...config, profileDirectory: lock.profileDirectory };
    let context: BrowserContext | undefined;
    try {
      await prepareDedicatedProfile(config.profileDirectory, config.product);
      await verifyDedicatedProfileRoot(config.profileDirectory, host);
      assertKillSwitchEnabled(killSwitch);
      context = await launchDedicatedPersistentContext(
        config.profileDirectory,
        {
          executablePath: config.browserExecutable,
          headless: false,
          acceptDownloads: false,
          timeout: config.waits.actionMs,
        },
        dependencies.launchPersistentContext,
      );
      const page = await selectOrOpenApprovedPage(context, config);
      page.setDefaultTimeout(config.waits.actionMs);
      page.setDefaultNavigationTimeout(config.waits.actionMs);
      const {
        profileDirectory: _profileDirectory,
        product: _product,
        browserContractVersion: _browserContractVersion,
        browserExecutable: _browserExecutable,
        browserVersion: _browserVersion,
        browserExecutableSha256: _browserExecutableSha256,
        ...adapterConfig
      } = config;
      const adapter = new CopilotBrowserAdapter(new PlaywrightSemanticPage(page), adapterConfig, {
        killSwitch,
      });
      const isManualAuthenticationRedirect = (): boolean =>
        isApprovedUrl(page.url(), config.manualAuthenticationHosts ?? []);
      return new EdgeCopilotTransport(
        context,
        adapter,
        lock,
        killSwitch,
        config.waits,
        isManualAuthenticationRedirect,
      );
    } catch (error) {
      if (context !== undefined) await context.close().catch(() => undefined);
      await lock.release();
      if (error instanceof AgentError) throw error;
      throw new AgentError(
        "TRANSPORT_UNAVAILABLE",
        "Could not launch the selected visible browser transport",
        { diagnosticCode: "EDGE_LAUNCH_FAILED" },
      );
    }
  }

  public async inspectState(): Promise<BrowserStateInspection> {
    return this.#adapter.inspectState();
  }

  public async waitForManualReadiness(
    maxWaitMs?: number,
    signal?: AbortSignal,
  ): Promise<BrowserStateInspection> {
    return waitForStableManualReadiness(
      (sliceMs, activeSignal) => this.#adapter.waitForManualReadiness(sliceMs, activeSignal),
      this.#readinessWaits,
      maxWaitMs ?? this.#readinessWaits.manualReadinessMs,
      signal,
      {
        isTerminalInspection: (inspection) => {
          const state = inspection.classification.state;
          if (!isTerminalManualReadinessState(state)) return false;
          return state !== "unapproved-host" || !this.#isManualAuthenticationRedirect();
        },
      },
    );
  }

  public async submit(
    request: SubmissionRequest,
    options?: TransportCallOptions,
  ): Promise<SubmissionReceipt> {
    return this.#adapter.submit(request, options);
  }

  public async resolveSubmission(
    request: SubmissionResolutionRequest,
    options?: TransportCallOptions,
  ): Promise<SubmissionReceipt> {
    return this.#adapter.resolveSubmission(request, options);
  }

  public async receive(
    request: ReceiveRequest,
    options?: TransportCallOptions,
  ): Promise<ReceiveResult> {
    return this.#adapter.receive(request, options);
  }

  public async emergencyStop(reason: string): Promise<void> {
    if (this.#killSwitch instanceof MutableBrowserKillSwitch) {
      this.#killSwitch.disable("OPERATOR_KILL_SWITCH");
    }
    await this.#adapter.emergencyStop(reason);
    await this.close();
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#adapter.close();
    try {
      await this.#context.close();
    } finally {
      await this.#lock.release();
    }
  }
}

export async function launchDedicatedPersistentContext(
  profileDirectory: string,
  options: Parameters<PersistentContextLauncher>[1],
  launcher: PersistentContextLauncher = chromium.launchPersistentContext.bind(chromium),
): Promise<BrowserContext> {
  return await launcher(profileDirectory, options);
}

export async function launchEdgeCopilotTransport(
  config: EdgeLaunchConfig,
  dependencies: EdgeLauncherDependencies = {},
): Promise<EdgeCopilotTransport> {
  return EdgeCopilotTransport.launch(config, dependencies);
}

/** Browser-neutral names; Edge exports remain as compatibility aliases. */
export type BrowserCopilotTransport = EdgeCopilotTransport;
export const BrowserCopilotTransport = EdgeCopilotTransport;

export async function launchBrowserCopilotTransport(
  config: EdgeLaunchConfig,
  dependencies: BrowserLauncherDependencies = {},
): Promise<BrowserCopilotTransport> {
  return EdgeCopilotTransport.launch(config, dependencies);
}

async function selectOrOpenApprovedPage(
  context: BrowserContext,
  config: EdgeLaunchConfig,
): Promise<Page> {
  const approvedPages = context.pages().filter((page) =>
    isApprovedUrl(page.url(), config.approvedHosts),
  );
  if (approvedPages.length > 1) {
    throw new AgentError("TRANSPORT_INDETERMINATE", "Multiple approved Copilot pages are open", {
      diagnosticCode: "AMBIGUOUS_COPILOT_PAGE",
      pageCount: approvedPages.length,
    });
  }
  const existing = approvedPages[0];
  if (existing !== undefined) return existing;
  const blank = context.pages().find((page) => page.url() === "about:blank");
  const page = blank ?? (await context.newPage());
  // Navigation is restricted to the explicitly approved entry URL. Redirects
  // for manual authentication remain visible and are never automated.
  await page.goto(config.entryUrl, {
    waitUntil: "domcontentloaded",
    timeout: config.waits.actionMs,
  });
  return page;
}
