import type { BrowserLaunchConfig, BrowserProduct, CopilotUiContract } from "../browser/index.js";
import type { PolicyDocument } from "../policy/index.js";
import type { CommandDefinition } from "../tools/index.js";
import type { ManagedPolicyProvenance } from "./managed-policy.js";

export const REPOSITORY_CONFIG_VERSION = "cba-repository-config/1" as const;
export const LEGACY_BROWSER_CONFIG_VERSION = "cba-browser-config/1" as const;
export const BROWSER_CONFIG_VERSION = "cba-browser-config/2" as const;

export interface RepositoryAgentConfig {
  readonly schema_version: typeof REPOSITORY_CONFIG_VERSION;
  readonly classification: string;
  readonly policy: PolicyDocument;
  readonly grant_defaults: {
    readonly readable_paths: readonly string[];
    readonly writable_paths: readonly string[];
    readonly disclosure_classifications: readonly string[];
  };
  readonly commands: readonly CommandDefinition[];
  readonly completion: {
    readonly required_command_ids: readonly string[];
    readonly require_validation_after_last_mutation: boolean;
  };
  readonly limits: {
    readonly max_file_bytes: number;
    readonly max_read_bytes: number;
    readonly max_search_output_bytes: number;
    readonly max_diff_bytes: number;
    readonly max_checkpoint_bytes: number;
    readonly max_patch_bytes: number;
  };
  readonly retention: {
    readonly retain_source_artifacts_on_completion: boolean;
  };
}

interface SharedBrowserFileConfig {
  readonly entry_url: string;
  readonly approved_hosts: readonly { readonly hostname: string; readonly allow_subdomains?: boolean }[];
  readonly manual_authentication_hosts?: readonly { readonly hostname: string; readonly allow_subdomains?: boolean }[];
  readonly expected_identity: string;
  readonly require_protection_indicator: boolean;
  readonly profile_directory: string;
  readonly max_message_chars?: number;
  readonly max_response_chars?: number;
  readonly waits?: Partial<BrowserLaunchConfig["waits"]>;
  readonly ui_contract?: CopilotUiContract;
}

export interface LegacyEdgeBrowserFileConfig extends SharedBrowserFileConfig {
  readonly schema_version: typeof LEGACY_BROWSER_CONFIG_VERSION;
  readonly edge_executable: string;
}

export interface BrowserFileConfig extends SharedBrowserFileConfig {
  readonly schema_version: typeof BROWSER_CONFIG_VERSION;
  readonly product: BrowserProduct;
  readonly browser_contract_version: BrowserLaunchConfig["browserContractVersion"];
  readonly browser_executable: string;
  readonly browser_version: string;
  readonly browser_executable_sha256: string;
}

export type AnyBrowserFileConfig = BrowserFileConfig | LegacyEdgeBrowserFileConfig;

export interface LoadedRuntimeConfiguration {
  readonly organizationPolicy: PolicyDocument;
  readonly repository: RepositoryAgentConfig;
  readonly browser?: BrowserLaunchConfig & { readonly browserExecutable: string };
  readonly managedPolicy?: {
    readonly provenance: ManagedPolicyProvenance;
    readonly killSwitch: { readonly enabled: boolean; readonly diagnosticCode?: string };
  };
  readonly hashes: {
    readonly organization: string;
    readonly repository: string;
    readonly browser?: string;
    readonly browserIdentity?: string;
    readonly managedPolicy?: string;
  };
  readonly files: {
    readonly organization: string;
    readonly repository: string;
    readonly browser?: string;
    readonly managedPolicyBundle?: string;
    readonly managedPolicyTrust?: string;
  };
}
