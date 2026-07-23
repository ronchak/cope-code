import { chromium, type BrowserContext } from "playwright-core";
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
  validateEdgeLaunchConfig,
  type BrowserWaitConfig,
  type EdgeLaunchConfig,
} from "./config.js";
import {
  browserContextTermination,
  ContextSemanticPage,
  openTrackedCopilotPage,
  terminateBrowserContext,
} from "./context-semantic-page.js";
import {
  assertKillSwitchEnabled,
  MutableBrowserKillSwitch,
  type BrowserKillSwitch,
} from "./kill-switch.js";
import {
  isTerminalManualReadinessState,
  waitForStableManualReadiness,
} from "./manual-readiness.js";
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

export interface EdgeReadinessInspector {
  inspectState(): Promise<BrowserStateInspection>;
}

/** Browser-neutral name for new integrations. */
export type BrowserLauncherDependencies = EdgeLauncherDependencies;

/** Owns the selected visible browser lifecycle while delegating model operations to the shared adapter. */
export class EdgeCopilotTransport implements ModelTransport {
  public readonly transportKind = "visible-browser-m365-copilot/v1";

  readonly #context: BrowserContext;
  readonly #semanticPage: ContextSemanticPage;
  readonly #adapter: CopilotBrowserAdapter;
  readonly #lock: ExclusiveProfileLock;
  readonly #killSwitch: BrowserKillSwitch;
  readonly #readinessWaits: BrowserWaitConfig;
  #closePromise: Promise<void> | undefined;

  private constructor(
    context: BrowserContext,
    semanticPage: ContextSemanticPage,
    adapter: CopilotBrowserAdapter,
    lock: ExclusiveProfileLock,
    killSwitch: BrowserKillSwitch,
    readinessWaits: BrowserWaitConfig,
  ) {
    this.#context = context;
    this.#semanticPage = semanticPage;
    this.#adapter = adapter;
    this.#lock = lock;
    this.#killSwitch = killSwitch;
    this.#readinessWaits = readinessWaits;
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
      context = await launchPersistentContext(
        config.profileDirectory,
        {
          executablePath: config.browserExecutable,
          headless: false,
          acceptDownloads: false,
          timeout: config.waits.actionMs,
        },
        dependencies.launchPersistentContext,
      );
      const semanticPage = await openTrackedCopilotPage(context, config);
      const {
        profileDirectory: _profileDirectory,
        product: _product,
        browserContractVersion: _browserContractVersion,
        browserExecutable: _browserExecutable,
        browserVersion: _browserVersion,
        browserExecutableSha256: _browserExecutableSha256,
        ...adapterConfig
      } = config;
      const adapter = new CopilotBrowserAdapter(semanticPage, adapterConfig, {
        killSwitch,
      });
      return new EdgeCopilotTransport(
        context,
        semanticPage,
        adapter,
        lock,
        killSwitch,
        config.waits,
      );
    } catch (error) {
      if (context !== undefined) {
        const termination = browserContextTermination(context) ??
          terminateBrowserContext(context);
        // Never recreate an action-timeout hang by awaiting cleanup here. Keep
        // the exclusive profile lock until owner shutdown positively succeeds;
        // a rejected or stalled close leaves the profile fail-closed.
        void termination.then(
          async () => lock.release(),
          () => undefined,
        ).catch(() => undefined);
      } else {
        await lock.release();
      }
      if (error instanceof AgentError) throw error;
      throw new AgentError(
        "TRANSPORT_UNAVAILABLE",
        "Could not launch the selected visible browser transport",
        {
          diagnosticCode: "EDGE_LAUNCH_FAILED",
          next: "Close the dedicated browser window, run cope setup --force, and retry.",
        },
        { cause: error },
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
    return this.#waitForReadiness(maxWaitMs, signal, false);
  }

  /**
   * Setup may prove that the configured Copilot page is ready while a
   * provenance-bound SSO popup lingers. Runtime submission deliberately does
   * not use this exception and remains blocked until the popup closes.
   */
  public async waitForSetupReadiness(
    maxWaitMs?: number,
    signal?: AbortSignal,
  ): Promise<BrowserStateInspection> {
    return this.#waitForReadiness(maxWaitMs, signal, true);
  }

  public async inspectSetupReadiness(signal?: AbortSignal): Promise<BrowserStateInspection> {
    return this.#waitForReadiness(this.#readinessWaits.actionMs, signal, true);
  }

  async #waitForReadiness(
    maxWaitMs: number | undefined,
    signal: AbortSignal | undefined,
    allowConfiguredPageProbe: boolean,
  ): Promise<BrowserStateInspection> {
    return waitForStableManualReadiness(
      (_sliceMs, activeSignal) => inspectEdgeReadinessOnce(
        {
          inspectState: () => this.#inspectReadinessOnce(
            allowConfiguredPageProbe,
            activeSignal,
          ),
        },
        activeSignal,
      ),
      this.#readinessWaits,
      maxWaitMs ?? this.#readinessWaits.manualReadinessMs,
      signal,
      {
        isTerminalInspection: (inspection) => isTerminalEdgeReadinessInspection(
          inspection,
          this.#semanticPage.isManualAuthenticationRedirect(),
        ),
      },
    );
  }

  async #inspectReadinessOnce(
    allowConfiguredPageProbe: boolean,
    signal?: AbortSignal,
  ): Promise<BrowserStateInspection> {
    const inspect = () => this.#adapter.inspectManualReadinessState(
      () => this.#semanticPage.holdForManualAuthenticationHandoff(
        false,
        allowConfiguredPageProbe,
      ),
      allowConfiguredPageProbe
        ? () => this.#semanticPage.isManualAuthenticationRedirect()
        : undefined,
      signal,
    );
    return this.#semanticPage.withManualReadinessProbe(inspect);
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

  public close(): Promise<void> {
    this.#closePromise ??= this.#closeOnce();
    return this.#closePromise;
  }

  async #closeOnce(): Promise<void> {
    await this.#adapter.close();
    const existingTermination = browserContextTermination(this.#context);
    if (existingTermination !== undefined) {
      // A renderer timeout or native dialog may leave owner teardown pending
      // indefinitely. Do not turn a bounded operation diagnostic into a hang in
      // runtime/CLI finally cleanup; retain the profile lock until success.
      void existingTermination.then(
        async () => this.#lock.release(),
        () => undefined,
      ).catch(() => undefined);
      return;
    }
    const termination = terminateBrowserContext(this.#context);
    if (await browserTerminationSettlesWithin(termination, this.#readinessWaits.actionMs)) {
      await this.#lock.release();
      return;
    }
    // Browser.close() can stall on Windows while a renderer or profile process
    // exits. Let CLI cleanup return after the configured action bound, but keep
    // the profile unavailable until the real process owner confirms shutdown.
    void termination.then(
      async () => this.#lock.release(),
      () => undefined,
    ).catch(() => undefined);
  }
}

/** Exported for a no-extra-handles process-liveness regression. */
export async function browserTerminationSettlesWithin(
  promise: Promise<void>,
  milliseconds: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Perform exactly one page inspection for the outer readiness state machine.
 * This avoids nesting the adapter's broad host-level manual-wait loop inside the
 * stricter Edge redirect classifier. The outer loop owns all retries and waits.
 */
export async function inspectEdgeReadinessOnce(
  inspector: EdgeReadinessInspector,
  signal?: AbortSignal,
): Promise<BrowserStateInspection> {
  signal?.throwIfAborted();
  const inspection = await inspector.inspectState();
  signal?.throwIfAborted();
  return inspection;
}

/**
 * Only a host-level rejection on an explicitly allowlisted Microsoft
 * authentication redirect may retain the long manual window. A page on the
 * approved M365 host but outside the configured chat surface has a different
 * diagnostic and remains a bounded failure even though that host also appears
 * in the manual-authentication allowlist.
 */
export function isTerminalEdgeReadinessInspection(
  inspection: BrowserStateInspection,
  isManualAuthenticationRedirect: boolean,
): boolean {
  const state = inspection.classification.state;
  // DOM dialogs on the configured Copilot page can be closed by the
  // operator. Native JavaScript dialogs are sticky by design and cannot
  // recover inside this session, so return their diagnostic promptly.
  if (
    state === "blocking-modal" &&
    inspection.classification.diagnosticCode === "NATIVE_BROWSER_DIALOG_DETECTED"
  ) {
    return true;
  }
  if (!isTerminalManualReadinessState(state)) return false;
  if (state !== "unapproved-host") return true;
  return inspection.classification.diagnosticCode !== "HOST_NOT_APPROVED" ||
    !isManualAuthenticationRedirect;
}

export async function launchDedicatedPersistentContext(
  profileDirectory: string,
  options: Parameters<PersistentContextLauncher>[1],
  launcher: PersistentContextLauncher = chromium.launchPersistentContext.bind(chromium),
): Promise<BrowserContext> {
  return launchPersistentContext(profileDirectory, options, launcher);
}

async function launchPersistentContext(
  profileDirectory: string,
  options: Parameters<PersistentContextLauncher>[1],
  launcher: PersistentContextLauncher = chromium.launchPersistentContext.bind(chromium),
): Promise<BrowserContext> {
  return launcher(profileDirectory, options);
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
