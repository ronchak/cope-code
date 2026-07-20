import { chromium, type BrowserContext } from "playwright-core";

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
import { ContextSemanticPage, openTrackedCopilotPage } from "./context-semantic-page.js";
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

export type PersistentContextLauncher = typeof chromium.launchPersistentContext;

export interface EdgeLauncherDependencies {
  readonly killSwitch?: BrowserKillSwitch;
  readonly host?: HostPlatform;
  readonly launchPersistentContext?: PersistentContextLauncher;
}

export interface EdgeReadinessInspector {
  inspectState(): Promise<BrowserStateInspection>;
}

/** Owns the visible Edge lifecycle while delegating model operations to the adapter. */
export class EdgeCopilotTransport implements ModelTransport {
  public readonly transportKind = "visible-edge-m365-copilot/v1";

  readonly #context: BrowserContext;
  readonly #semanticPage: ContextSemanticPage;
  readonly #adapter: CopilotBrowserAdapter;
  readonly #lock: ExclusiveProfileLock;
  readonly #killSwitch: BrowserKillSwitch;
  readonly #readinessWaits: BrowserWaitConfig;
  #closed = false;

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
    assertKillSwitchEnabled(killSwitch);
    const lock = await ExclusiveProfileLock.acquire(config.profileDirectory, host);
    let context: BrowserContext | undefined;
    try {
      await prepareDedicatedProfile(config.profileDirectory);
      await verifyDedicatedProfileRoot(config.profileDirectory, host);
      assertKillSwitchEnabled(killSwitch);
      context = await launchDedicatedPersistentContext(
        config.profileDirectory,
        {
          ...(config.edgeExecutable === undefined
            ? { channel: "msedge" as const }
            : { executablePath: config.edgeExecutable }),
          headless: false,
          acceptDownloads: false,
          timeout: config.waits.actionMs,
        },
        dependencies.launchPersistentContext,
      );
      const semanticPage = await openTrackedCopilotPage(context, config);
      const {
        profileDirectory: _profileDirectory,
        edgeExecutable: _edgeExecutable,
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
      if (context !== undefined) await context.close().catch(() => undefined);
      await lock.release();
      if (error instanceof AgentError) throw error;
      throw new AgentError(
        "TRANSPORT_UNAVAILABLE",
        "Could not launch the visible Microsoft Edge transport",
        {
          diagnosticCode: "EDGE_LAUNCH_FAILED",
          next: "Close the dedicated Edge window, run cope setup --force, and retry.",
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
    return waitForStableManualReadiness(
      (_sliceMs, activeSignal) => inspectEdgeReadinessOnce(this.#adapter, activeSignal),
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
  return await launcher(profileDirectory, options);
}

export async function launchEdgeCopilotTransport(
  config: EdgeLaunchConfig,
  dependencies: EdgeLauncherDependencies = {},
): Promise<EdgeCopilotTransport> {
  return EdgeCopilotTransport.launch(config, dependencies);
}
