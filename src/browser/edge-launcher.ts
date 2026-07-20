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
      (sliceMs, activeSignal) => this.#adapter.waitForManualReadiness(sliceMs, activeSignal),
      this.#readinessWaits,
      maxWaitMs ?? this.#readinessWaits.manualReadinessMs,
      signal,
      {
        isTerminalInspection: (inspection) => {
          const state = inspection.classification.state;
          if (!isTerminalManualReadinessState(state)) return false;
          return state !== "unapproved-host" || !this.#semanticPage.isManualAuthenticationRedirect();
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
