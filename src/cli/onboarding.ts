import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

import { parseBrowserConfig, parseRepositoryConfig } from "../config/loader.js";
import {
  BROWSER_CONFIG_VERSION,
  REPOSITORY_CONFIG_VERSION,
  type BrowserFileConfig,
  type LegacyEdgeBrowserFileConfig,
  type RepositoryAgentConfig,
} from "../config/types.js";
import {
  BROWSER_CONTRACT_VERSION,
  browserProductPresentation,
  discoverInstalledBrowsers,
  launchBrowserCopilotTransport,
  otherDedicatedBrowserProfileRoots,
  resolveSafeBrowserProfileDirectory,
  verifyManualBrowserExecutable,
  type BrowserIdentityVerifier,
  type BrowserLaunchConfig,
  type BrowserProduct,
  type DiscoveredBrowser,
  type BrowserCopilotTransport,
} from "../browser/index.js";
import {
  DEFAULT_ORGANIZATION_POLICY,
  DEFAULT_REPOSITORY_POLICY,
  assertValidPolicyDocument,
  type PolicyDocument,
} from "../policy/index.js";
import { resolveStateHome } from "../session/paths.js";
import { AgentError, errorMessage } from "../shared/errors.js";
import { CURRENT_HOST_PLATFORM, type HostPlatform } from "../platform/index.js";
import { preparePrivateStateHome } from "../platform/private-storage.js";
import type { CommandDefinition } from "../tools/index.js";
import type { CliCommand } from "./arguments.js";
import { runHostEligibilityPreflight } from "../preflight/machine.js";
import { hint, info, keyValue, section, success, warning, type Writable } from "./presentation.js";
import { confirmPrompt, PromptCancelledError, selectPrompt, textPrompt } from "./prompts.js";
import {
  browserSetupPrompt,
  PromptBackError,
  type BrowserSetupAction,
  type BrowserSetupScreen,
} from "./browser-setup-ui.js";
import { commitBrowserSetup, readBrowserConfigBaseline } from "./setup-transaction.js";

const DEFAULT_COPILOT_ENTRY_URL = "https://m365.cloud.microsoft/chat";
const CONFIG_DIRECTORY_NAME = "config";

export interface MachineConfigurationPaths {
  readonly stateHome: string;
  readonly organizationPolicy: string;
  readonly browser: string;
  readonly profileDirectory: string;
  readonly profileDirectories: Readonly<Record<BrowserProduct, string>>;
}

export interface MachineSetupDependencies {
  readonly identityVerifier?: BrowserIdentityVerifier;
  readonly discoverBrowsers?: typeof discoverInstalledBrowsers;
  readonly verifyManualBrowser?: typeof verifyManualBrowserExecutable;
  readonly promptBrowser?: typeof browserSetupPrompt;
  readonly promptText?: typeof textPrompt;
  readonly promptConfirm?: typeof confirmPrompt;
  readonly launchBrowser?: (
    config: BrowserLaunchConfig,
    host: HostPlatform,
    identityVerifier?: BrowserIdentityVerifier,
  ) => Promise<BrowserCopilotTransport>;
}

interface ExistingBrowserSetup {
  readonly file: BrowserFileConfig | LegacyEdgeBrowserFileConfig;
  readonly config: BrowserLaunchConfig;
  readonly browser: DiscoveredBrowser;
  readonly evidenceChanged: boolean;
}

interface MachineSetupSummary {
  readonly stateHome: string;
  readonly organizationPolicy: string;
  readonly browser: string;
  readonly browserProduct: BrowserProduct;
  readonly browserExecutable: string;
  /** Compatibility field retained for managed callers which consumed setup JSON. */
  readonly edgeExecutable?: string;
  readonly entryUrl: string;
}

export interface RepositoryConfigurationResult {
  readonly filename: string;
  readonly created: boolean;
  readonly profile: "standard" | "inspect" | "manual";
  readonly commandCount: number;
}

export async function executeSetupCommand(
  command: Extract<CliCommand, { readonly command: "setup" }>,
  io: { readonly stdout: Writable; readonly stderr: Writable },
  host: HostPlatform = CURRENT_HOST_PLATFORM,
  dependencies: MachineSetupDependencies = {},
): Promise<number> {
  // Setup visibly launches the selected browser, so standard-user and GUI
  // eligibility are prerequisites just as they are for a live task.
  await runHostEligibilityPreflight({ liveBrowser: true, host });
  const paths = configurationPaths(command.stateHome, host);
  await preparePrivateStateHome(paths.stateHome, host);
  // A redirected or low-capability output still gets the plain numbered setup
  // flow when stdin is interactive.
  const interactive = !command.json && process.stdin.isTTY === true;
  let result;
  try {
    result = await configureMachine({
      paths,
      force: command.force,
      interactive,
      output: io.stdout,
      host,
      ...(command.identity === undefined ? {} : { identity: command.identity }),
      ...(command.entryUrl === undefined ? {} : { entryUrl: command.entryUrl }),
      ...(command.requireProtectionIndicator === undefined
        ? {}
        : { requireProtectionIndicator: command.requireProtectionIndicator }),
      ...(command.browser === undefined ? {} : { browser: command.browser }),
      ...(command.browserExecutable === undefined ? {} : { browserExecutable: command.browserExecutable }),
    }, dependencies);
  } catch (error) {
    if (error instanceof PromptBackError) {
      if (!command.json) info("Setup was not changed.", io.stdout);
      return 0;
    }
    throw error;
  }
  if (command.json) io.stdout.write(`${JSON.stringify({ ok: true, configured: true, ...result })}\n`);
  return 0;
}

export async function ensureMachineConfiguration(options: {
  readonly stateHome?: string;
  readonly interactive: boolean;
  readonly output?: Writable;
  readonly host: HostPlatform;
}): Promise<MachineConfigurationPaths> {
  const paths = configurationPaths(options.stateHome, options.host);
  await preparePrivateStateHome(paths.stateHome, options.host);
  const status = await inspectMachineConfiguration(paths);
  if (status.valid) return paths;
  if (!options.interactive) {
    throw new AgentError(
      "CONFIG_INVALID",
      "Cope needs one-time browser setup before it can launch",
      { problems: status.problems, next: "Run cope setup in an interactive terminal.", stateHome: paths.stateHome },
    );
  }
  const output = options.output ?? process.stdout;
  section("One-time setup", output);
  status.problems.forEach((problem) => warning(problem, output));
  hint("This creates local policy and a dedicated browser profile. It never stores your password.", output);
  await configureMachine({ paths, force: true, interactive: true, output, host: options.host });
  return paths;
}

export async function ensureRepositoryConfiguration(options: {
  readonly repositoryRoot: string;
  readonly interactive: boolean;
  readonly output?: Writable;
  readonly preferredProfile?: "standard" | "inspect";
}): Promise<RepositoryConfigurationResult> {
  const output = options.output ?? process.stdout;
  const filename = path.join(options.repositoryRoot, ".cba", "repository.json");
  try {
    const parsed = parseRepositoryConfig(JSON.parse(await readFile(filename, "utf8")) as unknown);
    return {
      filename,
      created: false,
      profile: parsed.grant_defaults.writable_paths.length === 0 ? "inspect" : "standard",
      commandCount: parsed.commands.length,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !options.interactive) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && options.interactive) {
      warning(`The existing project configuration is invalid: ${shortError(error)}`, output);
      if (!await confirmPrompt("Replace it with a guided configuration?", true)) throw error;
    }
  }

  let profile = options.preferredProfile;
  if (profile === undefined && options.interactive) {
    profile = await selectPrompt("How much access should Cope start with?", [
      { value: "standard", label: "Edit this project", description: "Recommended. Read and change project files, with prompts for protected actions" },
      { value: "inspect", label: "Inspect only", description: "Read the project without changing files" },
    ] as const);
  }
  profile ??= "standard";
  const result = await writeRepositoryConfiguration({ repositoryRoot: options.repositoryRoot, profile, force: true });
  section("Project ready", output);
  keyValue("Access", profile === "inspect" ? "inspect only" : "edit", output);
  keyValue("Validation commands", result.commandCount, output);
  if (result.commandCount > 0) info(`Detected ${result.commandCount} package validation command${result.commandCount === 1 ? "" : "s"}.`, output);
  else hint("No package validation scripts were detected. Cope can still work on the files.", output);
  return result;
}

export async function writeRepositoryConfiguration(options: {
  readonly repositoryRoot: string;
  readonly profile: "standard" | "inspect" | "manual";
  readonly force: boolean;
}): Promise<RepositoryConfigurationResult> {
  const filename = path.join(options.repositoryRoot, ".cba", "repository.json");
  if (!options.force) {
    try {
      await access(filename, constants.F_OK);
      throw new AgentError("CONFIG_INVALID", "Repository configuration already exists; use --force to replace it", { filename });
    } catch (error) {
      if (error instanceof AgentError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const config = options.profile === "manual"
    ? createManualRepositoryConfig()
    : await createQuickRepositoryConfig(options.repositoryRoot, options.profile);
  parseRepositoryConfig(config);
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await atomicWriteJson(filename, config);
  return { filename, created: true, profile: options.profile, commandCount: config.commands.length };
}

export function configurationPaths(
  stateHome?: string,
  host: HostPlatform = CURRENT_HOST_PLATFORM,
): MachineConfigurationPaths {
  const resolvedStateHome = path.resolve(stateHome ?? resolveStateHome(process.env, host));
  return {
    stateHome: resolvedStateHome,
    organizationPolicy: path.join(resolvedStateHome, CONFIG_DIRECTORY_NAME, "organization-policy.json"),
    browser: path.join(resolvedStateHome, CONFIG_DIRECTORY_NAME, "browser.json"),
    profileDirectory: host.profileHome(resolvedStateHome),
    profileDirectories: {
      edge: host.profileHome(resolvedStateHome, "edge"),
      chrome: host.profileHome(resolvedStateHome, "chrome"),
    },
  };
}

export async function inspectMachineConfiguration(paths: MachineConfigurationPaths): Promise<{
  readonly valid: boolean;
  readonly problems: readonly string[];
}> {
  const problems: string[] = [];
  try {
    const raw = JSON.parse(await readFile(paths.organizationPolicy, "utf8")) as unknown;
    assertValidPolicyDocument(raw);
    if ((raw as PolicyDocument).layer !== "organization") problems.push("The machine policy has the wrong layer.");
  } catch (error) {
    problems.push(`Machine policy is missing or invalid: ${shortError(error)}`);
  }
  try {
    const raw = JSON.parse(await readFile(paths.browser, "utf8")) as unknown;
    parseBrowserConfig(raw);
    if (/REPLACE_|\.invalid(?:\/|$)/iu.test(JSON.stringify(raw))) problems.push("Browser configuration still contains template placeholders.");
  } catch (error) {
    problems.push(`Browser configuration is missing or invalid: ${shortError(error)}`);
  }
  return { valid: problems.length === 0, problems };
}

export async function configureMachine(options: {
  readonly paths: MachineConfigurationPaths;
  readonly force: boolean;
  readonly interactive: boolean;
  readonly output: Writable;
  readonly identity?: string;
  readonly entryUrl?: string;
  readonly requireProtectionIndicator?: boolean;
  readonly browser?: BrowserProduct;
  readonly browserExecutable?: string;
  readonly host: HostPlatform;
}, dependencies: MachineSetupDependencies = {}): Promise<MachineSetupSummary> {
  if (options.browserExecutable !== undefined && options.browser === undefined) {
    throw new AgentError("CONFIG_INVALID", "--browser-executable requires --browser edge or --browser chrome");
  }
  const promptBrowser = dependencies.promptBrowser ?? browserSetupPrompt;
  const promptText = dependencies.promptText ?? textPrompt;
  const promptConfirm = dependencies.promptConfirm ?? confirmPrompt;
  const discover = dependencies.discoverBrowsers ?? discoverInstalledBrowsers;
  const verifyManual = dependencies.verifyManualBrowser ?? verifyManualBrowserExecutable;
  const browserBaseline = await readBrowserConfigBaseline(options.paths.browser);
  const organizationPolicyToCreate = await policyForSetup(options.paths.organizationPolicy);
  const current = await readExistingBrowserSetup(options, browserBaseline, verifyManual, dependencies.identityVerifier);

  // Managed and automation callers can treat an already-valid setup as an
  // idempotent check. Interactive setup always shows the current selection.
  if (
    !options.interactive && current !== undefined && organizationPolicyToCreate === undefined &&
    !current.evidenceChanged &&
    !options.force && options.browser === undefined && options.browserExecutable === undefined &&
    options.identity === undefined && options.entryUrl === undefined &&
    options.requireProtectionIndicator === undefined
  ) {
    return setupSummary(options.paths, current.config);
  }

  const selected = await selectBrowserForSetup({
    options,
    ...(current === undefined ? {} : { current }),
    discover,
    verifyManual,
    promptBrowser,
    promptText,
    ...(dependencies.identityVerifier === undefined ? {} : { identityVerifier: dependencies.identityVerifier }),
  });
  const materialBrowserChange = current === undefined ||
    current.browser.product !== selected.product ||
    current.browser.executablePath !== selected.executablePath;
  if (current !== undefined && materialBrowserChange && options.interactive) {
    const action = await promptBrowser({ kind: "confirm-change", from: current.browser, to: selected }, options.output);
    if (action.action !== "confirm-change") throw new PromptBackError();
  }

  const currentIdentity = typeof current?.config.expectedIdentity === "string"
    ? current.config.expectedIdentity
    : undefined;
  const identity = options.identity ?? currentIdentity ?? (options.interactive
    ? await promptText("Work account name or email shown in Copilot")
    : undefined);
  if (identity === undefined || identity.trim().length === 0) {
    throw new AgentError("CONFIG_INVALID", "Setup requires the visible work-account name or email", { next: "Use cope setup --identity you@example.com" });
  }
  const entryText = options.entryUrl ?? current?.config.entryUrl ?? (options.interactive
    ? await promptText("Microsoft 365 Copilot Chat URL", { defaultValue: DEFAULT_COPILOT_ENTRY_URL })
    : DEFAULT_COPILOT_ENTRY_URL);
  const parsedUrl = parseSetupEntryUrl(entryText);
  const requireProtectionIndicator = options.requireProtectionIndicator ??
    current?.config.requireProtectionIndicator ?? (options.interactive
      ? await promptConfirm("Require a visible enterprise-data-protection indicator before sending prompts?", false)
      : false);
  const profileDirectory = await resolveSafeBrowserProfileDirectory(
    current?.config.product === selected.product
      ? current.config.profileDirectory
      : options.paths.profileDirectories[selected.product],
    {
      stateHome: options.paths.stateHome,
      ordinaryProfileRoots: (["edge", "chrome"] as const).flatMap((product) =>
        options.host.ordinaryBrowserProfileRoots(product, process.env)),
      dedicatedProfileRoots: otherDedicatedBrowserProfileRoots(
        options.host,
        options.paths.stateHome,
        selected.product,
      ),
    },
  );
  const currentFile = current?.file;
  const entryUrlChanged = current === undefined || parsedUrl.toString() !== current.config.entryUrl;
  const browserConfig: BrowserFileConfig = {
    schema_version: BROWSER_CONFIG_VERSION,
    product: selected.product,
    browser_contract_version: BROWSER_CONTRACT_VERSION,
    entry_url: parsedUrl.toString(),
    approved_hosts: !entryUrlChanged && currentFile !== undefined
      ? currentFile.approved_hosts
      : [{ hostname: parsedUrl.hostname, allow_subdomains: false }],
    ...(!entryUrlChanged && currentFile !== undefined
      ? currentFile.manual_authentication_hosts === undefined
        ? {}
        : { manual_authentication_hosts: currentFile.manual_authentication_hosts }
      : { manual_authentication_hosts: authenticationHosts(parsedUrl.hostname) }),
    expected_identity: identity.trim(),
    require_protection_indicator: requireProtectionIndicator,
    profile_directory: profileDirectory,
    browser_executable: selected.executablePath,
    browser_version: selected.version,
    browser_executable_sha256: selected.executableSha256,
    ...(currentFile === undefined
      ? { max_message_chars: 200_000 }
      : currentFile.max_message_chars === undefined
        ? {}
        : { max_message_chars: currentFile.max_message_chars }),
    ...(currentFile === undefined
      ? { max_response_chars: 1_000_000 }
      : currentFile.max_response_chars === undefined
        ? {}
        : { max_response_chars: currentFile.max_response_chars }),
    ...(currentFile?.waits === undefined ? {} : { waits: currentFile.waits }),
    ...(currentFile?.ui_contract === undefined ? {} : { ui_contract: currentFile.ui_contract }),
  };
  const shouldWriteBrowser = current === undefined || current.evidenceChanged || options.force || materialBrowserChange ||
    options.identity !== undefined || options.entryUrl !== undefined ||
    options.requireProtectionIndicator !== undefined;
  // When nothing is being persisted, validate exactly what will remain on
  // disk. This matters for managed host lists and pinned UI contracts.
  const candidate = shouldWriteBrowser
    ? parseBrowserConfig(browserConfig).config
    : current!.config;

  section("Browser sign-in", options.output);
  keyValue("Browser", browserProductPresentation(selected.product).productName, options.output);
  info("Cope is opening a visible browser with its separate profile.", options.output);
  hint("Complete sign-in, MFA, consent, or tenant prompts yourself. Cope never imports your everyday profile.", options.output);
  const launch = dependencies.launchBrowser ?? ((config, host, identityVerifier) =>
    launchBrowserCopilotTransport(config, {
      host,
      ...(identityVerifier === undefined ? {} : { browserIdentityVerifier: identityVerifier }),
    }));
  const setupAbort = new AbortController();
  let cancellationPhase: "cancellable" | "committing" | "done" = "cancellable";
  const requestCancellation = (): void => {
    if (cancellationPhase === "cancellable") setupAbort.abort();
    // Once the atomic commit begins, treat the bounded save as completing;
    // never terminate inside the critical section and leave partial state.
  };
  process.on("SIGINT", requestCancellation);
  process.on("SIGTERM", requestCancellation);
  let transport: BrowserCopilotTransport | undefined;
  try {
    transport = await launch(candidate, options.host, dependencies.identityVerifier);
    if (setupAbort.signal.aborted) throw new PromptCancelledError();
    const readiness = await transport.waitForManualReadiness(
      candidate.waits.manualReadinessMs,
      setupAbort.signal,
    );
    if (setupAbort.signal.aborted) throw new PromptCancelledError();
    if (readiness.classification.state !== "ready") {
      throw new AgentError("TRANSPORT_UNAVAILABLE", "The selected browser did not reach a verified Copilot-ready state", {
        product: selected.product,
        browserState: readiness.classification.state,
        next: "Finish sign-in in the visible browser, confirm the approved account and protection state, then retry setup.",
      });
    }
    cancellationPhase = "committing";
    await commitBrowserSetup({
      stateHome: options.paths.stateHome,
      browserFile: options.paths.browser,
      browserBaseline,
      organizationPolicyFile: options.paths.organizationPolicy,
      ...(organizationPolicyToCreate === undefined ? {} : { organizationPolicyToCreate }),
      ...(shouldWriteBrowser ? { browserConfig } : {}),
      host: options.host,
      revalidate: async () => {
        const verifiedAgain = await verifyManual(
          selected.product,
          selected.executablePath,
          { host: options.host, ...(dependencies.identityVerifier === undefined ? {} : { identityVerifier: dependencies.identityVerifier }) },
        );
        if (
          verifiedAgain.executablePath !== selected.executablePath ||
          verifiedAgain.version !== selected.version ||
          verifiedAgain.executableSha256 !== selected.executableSha256
        ) {
          throw new AgentError("CONFIG_INVALID", "The selected browser changed before setup could be saved", {
            diagnosticCode: "BROWSER_EXECUTABLE_EVIDENCE_CHANGED",
          });
        }
        const finalReadiness = await transport!.inspectState();
        if (finalReadiness.classification.state !== "ready") {
          throw new AgentError("TRANSPORT_UNAVAILABLE", "The Copilot page stopped being ready before setup could be saved", {
            browserState: finalReadiness.classification.state,
          });
        }
      },
    });
    cancellationPhase = "done";
  } catch (error) {
    if (setupAbort.signal.aborted && !(error instanceof PromptCancelledError)) {
      throw new PromptCancelledError();
    }
    throw error;
  } finally {
    process.off("SIGINT", requestCancellation);
    process.off("SIGTERM", requestCancellation);
    if (transport !== undefined) await transport.close();
  }

  success("Cope setup is ready.", options.output);
  keyValue("Browser", browserProductPresentation(selected.product).productName, options.output);
  keyValue("Copilot URL", parsedUrl.toString(), options.output);
  keyValue("Account check", identity.trim(), options.output);
  info("Next: run cope from a project folder.", options.output);
  return setupSummary(options.paths, candidate);
}

function setupSummary(paths: MachineConfigurationPaths, config: BrowserLaunchConfig): MachineSetupSummary {
  return {
    stateHome: paths.stateHome,
    organizationPolicy: paths.organizationPolicy,
    browser: paths.browser,
    browserProduct: config.product,
    browserExecutable: config.browserExecutable,
    ...(config.product === "edge" ? { edgeExecutable: config.browserExecutable } : {}),
    entryUrl: config.entryUrl,
  };
}

async function policyForSetup(filename: string): Promise<PolicyDocument | undefined> {
  try {
    const value = JSON.parse(await readFile(filename, "utf8")) as unknown;
    assertValidPolicyDocument(value);
    if ((value as PolicyDocument).layer !== "organization") {
      throw new AgentError("CONFIG_INVALID", "The existing machine policy has the wrong layer", { filename });
    }
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new AgentError("CONFIG_INVALID", "The existing machine policy is invalid and was not replaced", {
        filename,
        next: "Repair or deliberately remove the invalid policy, then run cope setup again.",
      }, { cause: error });
    }
  }
  const policy: PolicyDocument = {
    ...DEFAULT_ORGANIZATION_POLICY,
    policy_id: "cope-local-user",
    revision: "1",
  };
  assertValidPolicyDocument(policy);
  return policy;
}

async function readExistingBrowserSetup(
  options: { readonly paths: MachineConfigurationPaths; readonly host: HostPlatform },
  baseline: Awaited<ReturnType<typeof readBrowserConfigBaseline>>,
  verifyManual: typeof verifyManualBrowserExecutable,
  identityVerifier?: BrowserIdentityVerifier,
): Promise<ExistingBrowserSetup | undefined> {
  if (!baseline.exists) return undefined;
  try {
    const parsed = parseBrowserConfig(JSON.parse(baseline.bytes!.toString("utf8")) as unknown);
    const browser = await verifyManual(parsed.config.product, parsed.config.browserExecutable, {
      host: options.host,
      ...(identityVerifier === undefined ? {} : { identityVerifier }),
    });
    const evidenceChanged =
      parsed.config.browserVersion !== undefined && parsed.config.browserVersion !== browser.version ||
      parsed.config.browserExecutableSha256 !== undefined &&
        parsed.config.browserExecutableSha256 !== browser.executableSha256;
    const profileDirectory = await resolveSafeBrowserProfileDirectory(parsed.config.profileDirectory, {
      stateHome: options.paths.stateHome,
      ordinaryProfileRoots: (["edge", "chrome"] as const).flatMap((product) =>
        options.host.ordinaryBrowserProfileRoots(product, process.env)),
      dedicatedProfileRoots: otherDedicatedBrowserProfileRoots(
        options.host,
        options.paths.stateHome,
        parsed.config.product,
      ),
    });
    return {
      file: parsed.file,
      config: {
        ...parsed.config,
        profileDirectory,
        browserExecutable: browser.executablePath,
        browserVersion: browser.version,
        browserExecutableSha256: browser.executableSha256,
      },
      browser,
      evidenceChanged,
    };
  } catch (error) {
    if (
      error instanceof AgentError &&
      error.details.next !== undefined
    ) throw error;
    throw new AgentError("CONFIG_INVALID", "The existing browser configuration is invalid or mismatched and was not replaced", {
      filename: options.paths.browser,
      next: "Repair or deliberately remove the invalid browser configuration, then run cope setup again.",
    }, { cause: error });
  }
}

async function selectBrowserForSetup(input: {
  readonly options: {
    readonly browser?: BrowserProduct;
    readonly browserExecutable?: string;
    readonly interactive: boolean;
    readonly output: Writable;
    readonly host: HostPlatform;
  };
  readonly current?: ExistingBrowserSetup;
  readonly discover: typeof discoverInstalledBrowsers;
  readonly verifyManual: typeof verifyManualBrowserExecutable;
  readonly promptBrowser: typeof browserSetupPrompt;
  readonly promptText: typeof textPrompt;
  readonly identityVerifier?: BrowserIdentityVerifier;
}): Promise<DiscoveredBrowser> {
  const verificationOptions = {
    host: input.options.host,
    ...(input.identityVerifier === undefined ? {} : { identityVerifier: input.identityVerifier }),
  };
  if (input.options.browserExecutable !== undefined) {
    return input.verifyManual(input.options.browser!, input.options.browserExecutable, verificationOptions);
  }
  if (input.options.browser !== undefined) {
    if (input.current?.browser.product === input.options.browser) return input.current.browser;
  }
  let discovered = await input.discover(verificationOptions);
  if (input.options.browser !== undefined) {
    const match = discovered.find((browser) => browser.product === input.options.browser);
    if (match !== undefined) return match;
    if (!input.options.interactive) {
      throw new AgentError("CONFIG_INVALID", `${browserProductPresentation(input.options.browser).productName} was not found`, {
        next: "Install it or provide --browser-executable with the matching stable-browser path.",
      });
    }
    return promptForManualBrowser(input.options.browser, input);
  }
  if (!input.options.interactive) {
    if (input.current !== undefined) return input.current.browser;
    if (discovered.length === 1) return discovered[0]!;
    throw new AgentError("CONFIG_INVALID", discovered.length === 0
      ? "No supported stable browser was found"
      : "Both Edge and Chrome were found; automation must choose one", {
      next: "Use cope setup --browser edge or cope setup --browser chrome.",
    });
  }
  if (input.current !== undefined) {
    const action = await input.promptBrowser({ kind: "current", browser: input.current.browser }, input.options.output);
    if (action.action === "continue") return action.browser;
  }
  for (;;) {
    if (discovered.length === 0) {
      const action = await input.promptBrowser({
        kind: "none",
        searched: ["Microsoft Edge Stable", "Google Chrome Stable"],
        guidance: input.options.host.platform === "darwin"
          ? "Install a stable browser in Applications, then return here."
          : input.options.host.platform === "win32"
            ? "Install a stable browser for this Windows user or for all users, then return here."
            : "Install a supported stable browser using your platform's normal installer, then return here.",
      }, input.options.output);
      if (action.action === "retry") {
        discovered = await input.discover(verificationOptions);
        continue;
      }
      if (action.action === "advanced") return promptForManualBrowser(undefined, input);
    }
    if (discovered.length === 1) {
      const action = await input.promptBrowser({ kind: "single", browser: discovered[0]! }, input.options.output);
      if (action.action === "continue") return action.browser;
      if (action.action === "advanced") return promptForManualBrowser(undefined, input);
    }
    const browsers = discovered as readonly [DiscoveredBrowser, ...DiscoveredBrowser[]];
    const selectedIndex = Math.max(0, input.current === undefined
      ? browsers.findIndex((browser) => browser.product === "edge")
      : browsers.findIndex((browser) => browser.product === input.current!.browser.product));
    const action = await input.promptBrowser({ kind: "choose", browsers, selectedIndex }, input.options.output);
    if (action.action === "continue") return action.browser;
  }
}

async function promptForManualBrowser(
  product: BrowserProduct | undefined,
  input: {
    readonly options: { readonly output: Writable; readonly host: HostPlatform };
    readonly promptBrowser: typeof browserSetupPrompt;
    readonly promptText: typeof textPrompt;
    readonly verifyManual: typeof verifyManualBrowserExecutable;
    readonly identityVerifier?: BrowserIdentityVerifier;
  },
): Promise<DiscoveredBrowser> {
  let selectedProduct = product;
  if (selectedProduct === undefined) {
    const action = await input.promptBrowser({ kind: "manual-product", selectedIndex: 0 }, input.options.output);
    if (action.action !== "manual-product") throw new PromptBackError();
    selectedProduct = action.product;
  }
  const name = browserProductPresentation(selectedProduct).productName;
  const executablePath = await input.promptText(`Path to ${name}`);
  return input.verifyManual(selectedProduct, executablePath, {
    host: input.options.host,
    ...(input.identityVerifier === undefined ? {} : { identityVerifier: input.identityVerifier }),
  });
}

function parseSetupEntryUrl(entryText: string): URL {
  let parsedUrl: URL;
  try { parsedUrl = new URL(entryText); } catch (error) {
    throw new AgentError("CONFIG_INVALID", "The Copilot URL is invalid", { entryUrl: entryText }, { cause: error });
  }
  if (
    parsedUrl.protocol !== "https:" || parsedUrl.username !== "" || parsedUrl.password !== "" ||
    (parsedUrl.port !== "" && parsedUrl.port !== "443")
  ) {
    throw new AgentError("CONFIG_INVALID", "The Copilot URL must be a credential-free HTTPS URL");
  }
  return parsedUrl;
}

async function createQuickRepositoryConfig(
  repositoryRoot: string,
  profile: "standard" | "inspect",
): Promise<RepositoryAgentConfig> {
  const commands = await detectValidationCommands(repositoryRoot);
  const preferred = preferredRequiredCommand(commands);
  return {
    schema_version: REPOSITORY_CONFIG_VERSION,
    classification: "internal",
    policy: {
      ...DEFAULT_REPOSITORY_POLICY,
      policy_id: "cope-project",
      revision: "1",
    },
    grant_defaults: {
      readable_paths: ["**"],
      writable_paths: profile === "standard" ? ["**"] : [],
      disclosure_classifications: ["internal"],
    },
    commands,
    completion: {
      required_command_ids: preferred === undefined ? [] : [preferred],
      require_validation_after_last_mutation: preferred !== undefined,
    },
    limits: defaultLimits(),
    retention: { retain_source_artifacts_on_completion: false },
  };
}

function createManualRepositoryConfig(): RepositoryAgentConfig {
  return {
    schema_version: REPOSITORY_CONFIG_VERSION,
    classification: "internal",
    policy: { ...DEFAULT_REPOSITORY_POLICY, policy_id: "cope-project", revision: "1" },
    grant_defaults: {
      readable_paths: ["**"],
      writable_paths: [],
      disclosure_classifications: ["internal"],
    },
    commands: [],
    completion: { required_command_ids: [], require_validation_after_last_mutation: false },
    limits: defaultLimits(),
    retention: { retain_source_artifacts_on_completion: false },
  };
}

function defaultLimits(): RepositoryAgentConfig["limits"] {
  return {
    max_file_bytes: 1_048_576,
    max_read_bytes: 131_072,
    max_search_output_bytes: 131_072,
    max_diff_bytes: 524_288,
    max_checkpoint_bytes: 16_777_216,
    max_patch_bytes: 4_194_304,
  };
}

async function detectValidationCommands(repositoryRoot: string): Promise<readonly CommandDefinition[]> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8")) as unknown; }
  catch { return []; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const scripts = (parsed as { readonly scripts?: unknown }).scripts;
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) return [];
  const npmCli = await resolveNpmCli();
  if (npmCli === undefined) return [];
  const candidates = [
    { script: "test", category: "test", timeoutMs: 300_000 },
    { script: "check", category: "analysis", timeoutMs: 600_000 },
    { script: "build", category: "build", timeoutMs: 300_000 },
    { script: "typecheck", category: "typecheck", timeoutMs: 300_000 },
    { script: "lint", category: "lint", timeoutMs: 300_000 },
  ] as const;
  return candidates.flatMap((candidate): CommandDefinition[] => {
    const value = (scripts as Readonly<Record<string, unknown>>)[candidate.script];
    if (typeof value !== "string" || value.trim().length === 0 || /no test specified/iu.test(value)) return [];
    return [{
      id: `npm.${candidate.script}`,
      description: `Run npm ${candidate.script} using the repository package script.`,
      category: candidate.category,
      risk: "low",
      sideEffects: true,
      networkRequired: false,
      executable: process.execPath,
      fixedArguments: [npmCli, "run", candidate.script],
      workingDirectory: ".",
      timeoutMs: candidate.timeoutMs,
      maxTimeoutMs: 900_000,
      maxOutputBytes: 1_048_576,
      successExitCodes: [0],
    }];
  });
}

async function resolveNpmCli(): Promise<string | undefined> {
  const candidates = unique([
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    process.env.ProgramFiles === undefined ? undefined : path.join(process.env.ProgramFiles, "nodejs", "node_modules", "npm", "bin", "npm-cli.js"),
    process.env.APPDATA === undefined ? undefined : path.join(process.env.APPDATA, "npm", "node_modules", "npm", "bin", "npm-cli.js"),
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/share/nodejs/npm/bin/npm-cli.js",
  ].filter((entry): entry is string => entry !== undefined && entry.length > 0));
  for (const candidate of candidates) {
    try { await access(candidate, constants.F_OK); return path.resolve(candidate); } catch { /* continue */ }
  }
  return undefined;
}

function preferredRequiredCommand(commands: readonly CommandDefinition[]): string | undefined {
  for (const id of ["npm.test", "npm.check", "npm.build", "npm.typecheck", "npm.lint"]) {
    if (commands.some((command) => command.id === id)) return id;
  }
  return undefined;
}

export async function resolveEdgeExecutable(
  interactive: boolean,
  host: HostPlatform = CURRENT_HOST_PLATFORM,
): Promise<string> {
  const candidates = host.edgeExecutableCandidates(process.env);
  for (const candidate of candidates) {
    try { await access(candidate, constants.F_OK); return candidate; } catch { /* continue */ }
  }
  if (interactive) {
    const manual = await textPrompt(host.platform === "darwin" ? "Path to Microsoft Edge" : "Path to msedge.exe");
    try { await access(manual, constants.F_OK); return path.resolve(manual); }
    catch (error) { throw new AgentError("CONFIG_INVALID", "Microsoft Edge was not found at that path", { path: manual }, { cause: error }); }
  }
  throw new AgentError("CONFIG_INVALID", "Microsoft Edge was not found", { next: "Install Edge or set COPE_EDGE_EXECUTABLE." });
}

function authenticationHosts(entryHostname: string): readonly { readonly hostname: string; readonly allow_subdomains: boolean }[] {
  return unique([
    entryHostname,
    "m365.cloud.microsoft",
    "m365copilot.com",
    "login.microsoftonline.com",
    "login.live.com",
    "login.microsoft.com",
    "office.com",
    "www.office.com",
  ]).map((hostname) => ({ hostname, allow_subdomains: false }));
}

async function atomicWriteJson(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, filename);
  if (CURRENT_HOST_PLATFORM.supportsDirectoryFsync) {
    const directory = await open(path.dirname(filename), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function shortError(error: unknown): string {
  return errorMessage(error).replace(/[\r\n]+/gu, " ").slice(0, 240);
}
