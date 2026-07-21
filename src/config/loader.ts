import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  BROWSER_CONTRACT_VERSION,
  DEFAULT_BROWSER_WAITS,
  createBaselineCopilotUiContract,
  isBrowserProduct,
  otherDedicatedBrowserProfileRoots,
  resolveSafeBrowserProfileDirectory,
  validateBrowserLaunchConfig,
  verifyBrowserExecutable,
  type BrowserIdentityVerifier,
  type BrowserLaunchConfig,
} from "../browser/index.js";
import { assertValidPolicyDocument, type PolicyDocument } from "../policy/index.js";
import { sha256, stableJson } from "../shared/crypto.js";
import { AgentError, errorMessage } from "../shared/errors.js";
import { CURRENT_HOST_PLATFORM, type HostPlatform } from "../platform/index.js";
import { CommandCatalog } from "../tools/index.js";
import {
  BROWSER_CONFIG_VERSION,
  LEGACY_BROWSER_CONFIG_VERSION,
  REPOSITORY_CONFIG_VERSION,
  type AnyBrowserFileConfig,
  type LoadedRuntimeConfiguration,
  type RepositoryAgentConfig,
} from "./types.js";

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

export interface LoadRuntimeConfigurationOptions {
  readonly repositoryRoot: string;
  readonly stateHome: string;
  readonly requireBrowser: boolean;
  readonly organizationPolicyFile?: string;
  readonly repositoryConfigFile?: string;
  readonly browserConfigFile?: string;
  readonly host?: HostPlatform;
  readonly browserIdentityVerifier?: BrowserIdentityVerifier;
}

export async function loadRuntimeConfiguration(
  options: LoadRuntimeConfigurationOptions,
): Promise<LoadedRuntimeConfiguration> {
  const organizationFile = options.organizationPolicyFile ??
    path.join(options.stateHome, "config", "organization-policy.json");
  const repositoryFile = options.repositoryConfigFile ??
    path.join(options.repositoryRoot, ".cba", "repository.json");
  const browserFile = options.browserConfigFile ?? path.join(options.stateHome, "config", "browser.json");

  const organizationRaw = await readJson(organizationFile, "organization policy");
  assertValidPolicyDocument(organizationRaw);
  if (organizationRaw.layer !== "organization") {
    throw new AgentError("CONFIG_INVALID", "Organization policy file has the wrong layer", { organizationFile });
  }
  const repositoryRaw = await readJson(repositoryFile, "repository configuration");
  const repository = parseRepositoryConfig(repositoryRaw);

  let browser: (BrowserLaunchConfig & { readonly browserExecutable: string }) | undefined;
  let browserHash: string | undefined;
  let browserIdentityHash: string | undefined;
  if (options.requireBrowser) {
    const browserRaw = await readJson(browserFile, "browser configuration");
    const parsed = parseBrowserConfig(browserRaw);
    const host = options.host ?? CURRENT_HOST_PLATFORM;
    const verified = await (options.browserIdentityVerifier ?? ((product, executablePath) =>
      verifyBrowserExecutable(product, executablePath, { host })))(
      parsed.config.product,
      parsed.config.browserExecutable,
    );
    const configuredCanonicalExecutable = await realpath(parsed.config.browserExecutable).catch(() => undefined);
    if (
      verified.product !== parsed.config.product || configuredCanonicalExecutable === undefined ||
      verified.executablePath !== configuredCanonicalExecutable
    ) {
      throw new AgentError("CONFIG_INVALID", "Browser identity verification returned mismatched product or path evidence", {
        diagnosticCode: "BROWSER_IDENTITY_EVIDENCE_MISMATCH",
        product: parsed.config.product,
      });
    }
    if (
      parsed.config.browserVersion !== undefined && parsed.config.browserVersion !== verified.version ||
      parsed.config.browserExecutableSha256 !== undefined &&
        parsed.config.browserExecutableSha256 !== verified.executableSha256
    ) {
      throw new AgentError("CONFIG_INVALID", "The configured browser identity changed after setup", {
        diagnosticCode: "BROWSER_EXECUTABLE_EVIDENCE_CHANGED",
        product: parsed.config.product,
        next: "Run cope setup to verify the updated browser before live use.",
      });
    }
    const ordinaryProfileRoots = (["edge", "chrome"] as const).flatMap((product) =>
      host.ordinaryBrowserProfileRoots(product, process.env));
    browser = {
      ...parsed.config,
      browserExecutable: verified.executablePath,
      browserVersion: verified.version,
      browserExecutableSha256: verified.executableSha256,
      profileDirectory: await resolveSafeBrowserProfileDirectory(parsed.config.profileDirectory, {
        repositoryRoot: options.repositoryRoot,
        stateHome: options.stateHome,
        ordinaryProfileRoots,
        dedicatedProfileRoots: otherDedicatedBrowserProfileRoots(
          host,
          options.stateHome,
          parsed.config.product,
        ),
      }),
    };
    browserHash = sha256(stableJson(browserRaw));
    browserIdentityHash = sha256(stableJson({
      product: verified.product,
      executable_path: verified.executablePath,
      version: verified.version,
      executable_sha256: verified.executableSha256,
    }));
  }

  return {
    organizationPolicy: organizationRaw,
    repository,
    ...(browser === undefined ? {} : { browser }),
    hashes: {
      organization: sha256(stableJson(organizationRaw)),
      repository: sha256(stableJson(repositoryRaw)),
      ...(browserHash === undefined ? {} : { browser: browserHash }),
      ...(browserIdentityHash === undefined ? {} : { browserIdentity: browserIdentityHash }),
    },
    files: {
      organization: await canonicalOrResolved(organizationFile),
      repository: await canonicalOrResolved(repositoryFile),
      ...(options.requireBrowser ? { browser: await canonicalOrResolved(browserFile) } : {}),
    },
  };
}

export function parseRepositoryConfig(value: unknown): RepositoryAgentConfig {
  const object = record(value, "repository configuration");
  exactKeys(object, [
    "schema_version",
    "classification",
    "policy",
    "grant_defaults",
    "commands",
    "completion",
    "limits",
    "retention",
  ], "repository configuration");
  if (object.schema_version !== REPOSITORY_CONFIG_VERSION) {
    throw new AgentError("CONFIG_INVALID", `Expected repository schema ${REPOSITORY_CONFIG_VERSION}`);
  }
  const classification = nonEmptyString(object.classification, "classification");
  assertValidPolicyDocument(object.policy);
  if (object.policy.layer !== "repository") {
    throw new AgentError("CONFIG_INVALID", "Embedded repository policy has the wrong layer");
  }
  const grant = record(object.grant_defaults, "grant_defaults");
  exactKeys(grant, ["readable_paths", "writable_paths", "disclosure_classifications"], "grant_defaults");
  const completion = record(object.completion, "completion");
  exactKeys(completion, ["required_command_ids", "require_validation_after_last_mutation"], "completion");
  const limits = record(object.limits, "limits");
  exactKeys(limits, [
    "max_file_bytes",
    "max_read_bytes",
    "max_search_output_bytes",
    "max_diff_bytes",
    "max_checkpoint_bytes",
    "max_patch_bytes",
  ], "limits");
  const retention = record(object.retention, "retention");
  exactKeys(retention, ["retain_source_artifacts_on_completion"], "retention");
  if (!Array.isArray(object.commands)) throw new AgentError("CONFIG_INVALID", "commands must be an array");
  // Constructor performs strict per-definition validation and duplicate checks.
  void new CommandCatalog(object.commands as never);
  const config: RepositoryAgentConfig = {
    schema_version: REPOSITORY_CONFIG_VERSION,
    classification,
    policy: object.policy,
    grant_defaults: {
      readable_paths: stringArray(grant.readable_paths, "readable_paths"),
      writable_paths: stringArray(grant.writable_paths, "writable_paths"),
      disclosure_classifications: stringArray(grant.disclosure_classifications, "disclosure_classifications"),
    },
    commands: object.commands as never,
    completion: {
      required_command_ids: stringArray(completion.required_command_ids, "required_command_ids"),
      require_validation_after_last_mutation: booleanValue(
        completion.require_validation_after_last_mutation,
        "require_validation_after_last_mutation",
      ),
    },
    limits: {
      max_file_bytes: positiveInteger(limits.max_file_bytes, "max_file_bytes"),
      max_read_bytes: positiveInteger(limits.max_read_bytes, "max_read_bytes"),
      max_search_output_bytes: positiveInteger(limits.max_search_output_bytes, "max_search_output_bytes"),
      max_diff_bytes: positiveInteger(limits.max_diff_bytes, "max_diff_bytes"),
      max_checkpoint_bytes: positiveInteger(limits.max_checkpoint_bytes, "max_checkpoint_bytes"),
      max_patch_bytes: positiveInteger(limits.max_patch_bytes, "max_patch_bytes"),
    },
    retention: {
      retain_source_artifacts_on_completion: booleanValue(
        retention.retain_source_artifacts_on_completion,
        "retain_source_artifacts_on_completion",
      ),
    },
  };
  for (const required of config.completion.required_command_ids) {
    if (!config.commands.some((command) => command.id === required)) {
      throw new AgentError("CONFIG_INVALID", `Required completion command '${required}' is absent from the catalog`);
    }
  }
  return config;
}

export function parseBrowserConfig(value: unknown): {
  readonly file: AnyBrowserFileConfig;
  readonly config: BrowserLaunchConfig & { readonly browserExecutable: string };
} {
  const object = record(value, "browser configuration");
  const sharedKeys = [
    "schema_version",
    "entry_url",
    "approved_hosts",
    "manual_authentication_hosts",
    "expected_identity",
    "require_protection_indicator",
    "profile_directory",
    "max_message_chars",
    "max_response_chars",
    "waits",
    "ui_contract",
  ] as const;
  const legacy = object.schema_version === LEGACY_BROWSER_CONFIG_VERSION;
  const current = object.schema_version === BROWSER_CONFIG_VERSION;
  if (!legacy && !current) {
    throw new AgentError(
      "CONFIG_INVALID",
      `Expected browser schema ${LEGACY_BROWSER_CONFIG_VERSION} or ${BROWSER_CONFIG_VERSION}`,
    );
  }
  exactKeys(object, legacy
    ? [...sharedKeys, "edge_executable"]
    : [
        ...sharedKeys,
        "product",
        "browser_contract_version",
        "browser_executable",
        "browser_version",
        "browser_executable_sha256",
      ], "browser configuration");
  const expectedIdentity = nonEmptyString(object.expected_identity, "expected_identity");
  const approvedHosts = hostArray(object.approved_hosts, "approved_hosts");
  const manualAuthenticationHosts = object.manual_authentication_hosts === undefined
    ? []
    : hostArray(object.manual_authentication_hosts, "manual_authentication_hosts");
  if (object.waits !== undefined) {
    exactKeys(record(object.waits, "waits"), [
      "actionMs",
      "submissionConfirmationMs",
      "responseMs",
      "manualReadinessMs",
      "pollMs",
      "stableSamples",
      "minimumStableMs",
    ], "waits");
  }
  const waits = { ...DEFAULT_BROWSER_WAITS, ...(object.waits === undefined ? {} : integerRecord(object.waits, "waits")) };
  const product = legacy ? "edge" : object.product;
  if (!isBrowserProduct(product)) {
    throw new AgentError("CONFIG_INVALID", "Browser product must be edge or chrome");
  }
  const browserContractVersionValue = legacy
    ? BROWSER_CONTRACT_VERSION
    : nonEmptyString(object.browser_contract_version, "browser_contract_version");
  if (browserContractVersionValue !== BROWSER_CONTRACT_VERSION) {
    throw new AgentError("CONFIG_INVALID", `Unsupported browser contract version: ${browserContractVersionValue}`);
  }
  const browserContractVersion = BROWSER_CONTRACT_VERSION;
  const browserExecutable = nonEmptyString(
    legacy ? object.edge_executable : object.browser_executable,
    legacy ? "edge_executable" : "browser_executable",
  );
  const file = object as unknown as AnyBrowserFileConfig;
  const config = {
    entryUrl: nonEmptyString(object.entry_url, "entry_url"),
    approvedHosts,
    manualAuthenticationHosts,
    expectedIdentity,
    requireProtectionIndicator: booleanValue(object.require_protection_indicator, "require_protection_indicator"),
    maxMessageChars: optionalPositiveInteger(object.max_message_chars, "max_message_chars") ?? 200_000,
    maxResponseChars: optionalPositiveInteger(object.max_response_chars, "max_response_chars") ?? 1_000_000,
    waits,
    product,
    browserContractVersion,
    profileDirectory: nonEmptyString(object.profile_directory, "profile_directory"),
    uiContract: object.ui_contract === undefined
      ? createBaselineCopilotUiContract(expectedIdentity)
      : object.ui_contract as never,
    browserExecutable,
    ...(legacy ? {} : {
      browserVersion: nonEmptyString(object.browser_version, "browser_version"),
      browserExecutableSha256: browserExecutableHash(object.browser_executable_sha256),
    }),
  } satisfies BrowserLaunchConfig & { readonly browserExecutable: string };
  try {
    validateBrowserLaunchConfig(config);
  } catch (error) {
    throw new AgentError("CONFIG_INVALID", `Browser configuration is invalid: ${errorMessage(error)}`);
  }
  return { file, config };
}

function browserExecutableHash(value: unknown): string {
  const hash = nonEmptyString(value, "browser_executable_sha256");
  if (!/^[a-f0-9]{64}$/u.test(hash)) {
    throw new AgentError("CONFIG_INVALID", "browser_executable_sha256 must be a lowercase SHA-256 digest");
  }
  return hash;
}

async function readJson(filename: string, label: string): Promise<unknown> {
  try {
    const bytes = await readFile(filename);
    if (bytes.length > MAX_CONFIG_BYTES) throw new AgentError("CONFIG_INVALID", `${label} is oversized`);
    const text = bytes.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) throw new AgentError("CONFIG_INVALID", `${label} must not contain a BOM`);
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError("CONFIG_INVALID", `Unable to load ${label}: ${errorMessage(error)}`, { filename }, { cause: error });
  }
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentError("CONFIG_INVALID", `${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new AgentError("CONFIG_INVALID", `${label} contains unknown fields`, { fields: unknown });
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new AgentError("CONFIG_INVALID", `${label} must be a non-empty-string array`);
  }
  if (new Set(value.map((entry) => entry.toLowerCase())).size !== value.length) {
    throw new AgentError("CONFIG_INVALID", `${label} contains duplicates`);
  }
  return value;
}

function hostArray(value: unknown, label: string): readonly { readonly hostname: string; readonly allowSubdomains?: boolean }[] {
  if (!Array.isArray(value) || value.length === 0) throw new AgentError("CONFIG_INVALID", `${label} must be a non-empty array`);
  return value.map((entry) => {
    const item = record(entry, label);
    exactKeys(item, ["hostname", "allow_subdomains"], label);
    const hostname = nonEmptyString(item.hostname, `${label}.hostname`);
    return item.allow_subdomains === undefined
      ? { hostname }
      : { hostname, allowSubdomains: booleanValue(item.allow_subdomains, `${label}.allow_subdomains`) };
  });
}

function integerRecord(value: unknown, label: string): Readonly<Record<string, number>> {
  const object = record(value, label);
  return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, positiveInteger(entry, `${label}.${key}`)]));
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new AgentError("CONFIG_INVALID", `${label} is required`);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new AgentError("CONFIG_INVALID", `${label} must be boolean`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AgentError("CONFIG_INVALID", `${label} must be a positive integer`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, label);
}

async function canonicalOrResolved(filename: string): Promise<string> {
  return realpath(filename).catch(() => path.resolve(filename));
}
