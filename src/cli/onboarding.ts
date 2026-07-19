import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

import { parseBrowserConfig, parseRepositoryConfig } from "../config/loader.js";
import {
  BROWSER_CONFIG_VERSION,
  REPOSITORY_CONFIG_VERSION,
  type BrowserFileConfig,
  type RepositoryAgentConfig,
} from "../config/types.js";
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
import { confirmPrompt, selectPrompt, textPrompt } from "./prompts.js";

const DEFAULT_COPILOT_ENTRY_URL = "https://m365.cloud.microsoft/chat";
const CONFIG_DIRECTORY_NAME = "config";

export interface MachineConfigurationPaths {
  readonly stateHome: string;
  readonly organizationPolicy: string;
  readonly browser: string;
  readonly profileDirectory: string;
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
): Promise<number> {
  if (host.platform === "darwin") {
    await runHostEligibilityPreflight({ liveBrowser: false, host });
  }
  const paths = configurationPaths(command.stateHome, host);
  await preparePrivateStateHome(paths.stateHome, host);
  const interactive = !command.json && process.stdin.isTTY === true && process.stdout.isTTY === true;
  const result = await configureMachine({
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
  });
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
  hint("This creates local policy and a dedicated Edge profile. It never stores your password.", output);
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

async function configureMachine(options: {
  readonly paths: MachineConfigurationPaths;
  readonly force: boolean;
  readonly interactive: boolean;
  readonly output: Writable;
  readonly identity?: string;
  readonly entryUrl?: string;
  readonly requireProtectionIndicator?: boolean;
  readonly host: HostPlatform;
}): Promise<{
  readonly stateHome: string;
  readonly organizationPolicy: string;
  readonly browser: string;
  readonly edgeExecutable: string;
  readonly entryUrl: string;
}> {
  const current = await inspectMachineConfiguration(options.paths);
  if (current.valid && !options.force) {
    info("Machine setup is already complete.", options.output);
    return existingSetupSummary(options.paths);
  }

  const identity = options.identity ?? (options.interactive
    ? await textPrompt("Work account name or email shown in Copilot")
    : undefined);
  if (identity === undefined || identity.trim().length === 0) {
    throw new AgentError("CONFIG_INVALID", "Setup requires the visible work-account name or email", { next: "Use cope setup --identity you@example.com" });
  }
  const entryText = options.entryUrl ?? (options.interactive
    ? await textPrompt("Microsoft 365 Copilot Chat URL", { defaultValue: DEFAULT_COPILOT_ENTRY_URL })
    : DEFAULT_COPILOT_ENTRY_URL);
  let parsedUrl: URL;
  try { parsedUrl = new URL(entryText); } catch (error) {
    throw new AgentError("CONFIG_INVALID", "The Copilot URL is invalid", { entryUrl: entryText }, { cause: error });
  }
  if (parsedUrl.protocol !== "https:" || parsedUrl.username !== "" || parsedUrl.password !== "") {
    throw new AgentError("CONFIG_INVALID", "The Copilot URL must be a credential-free HTTPS URL");
  }
  const requireProtectionIndicator = options.requireProtectionIndicator ?? (options.interactive
    ? await confirmPrompt("Require a visible enterprise-data-protection indicator before sending prompts?", false)
    : false);
  const edgeExecutable = await resolveEdgeExecutable(options.interactive, options.host);

  const organizationPolicy: PolicyDocument = {
    ...DEFAULT_ORGANIZATION_POLICY,
    policy_id: "cope-local-user",
    revision: "1",
  };
  const browserConfig: BrowserFileConfig = {
    schema_version: BROWSER_CONFIG_VERSION,
    entry_url: parsedUrl.toString(),
    approved_hosts: [{ hostname: parsedUrl.hostname, allow_subdomains: false }],
    manual_authentication_hosts: authenticationHosts(parsedUrl.hostname),
    expected_identity: identity.trim(),
    require_protection_indicator: requireProtectionIndicator,
    profile_directory: options.paths.profileDirectory,
    edge_executable: edgeExecutable,
    max_message_chars: 200_000,
    max_response_chars: 1_000_000,
    waits: {
      actionMs: 15_000,
      submissionConfirmationMs: 12_000,
      responseMs: 180_000,
      manualReadinessMs: 600_000,
      pollMs: 250,
      stableSamples: 3,
      minimumStableMs: 750,
    },
  };
  assertValidPolicyDocument(organizationPolicy);
  parseBrowserConfig(browserConfig);
  await mkdir(path.dirname(options.paths.organizationPolicy), { recursive: true, mode: 0o700 });
  await atomicWriteJson(options.paths.organizationPolicy, organizationPolicy);
  await atomicWriteJson(options.paths.browser, browserConfig);

  success("Cope machine setup is ready.", options.output);
  keyValue("Copilot URL", parsedUrl.toString(), options.output);
  keyValue("Account check", identity.trim(), options.output);
  keyValue("Edge profile", options.paths.profileDirectory, options.output);
  hint("Sign-in and MFA remain manual in the visible Edge window.", options.output);
  return {
    stateHome: options.paths.stateHome,
    organizationPolicy: options.paths.organizationPolicy,
    browser: options.paths.browser,
    edgeExecutable,
    entryUrl: parsedUrl.toString(),
  };
}

async function existingSetupSummary(paths: MachineConfigurationPaths): Promise<{
  readonly stateHome: string;
  readonly organizationPolicy: string;
  readonly browser: string;
  readonly edgeExecutable: string;
  readonly entryUrl: string;
}> {
  const parsed = parseBrowserConfig(JSON.parse(await readFile(paths.browser, "utf8")) as unknown);
  return {
    stateHome: paths.stateHome,
    organizationPolicy: paths.organizationPolicy,
    browser: paths.browser,
    edgeExecutable: parsed.config.edgeExecutable,
    entryUrl: parsed.config.entryUrl,
  };
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
