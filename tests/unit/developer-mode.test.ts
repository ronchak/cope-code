import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createInitialGrant } from "../../src/cli/commands.js";
import { effectiveGrantSummary } from "../../src/cli/runtime-composition.js";
import {
  loadRuntimeConfiguration,
  parseRepositoryConfig,
} from "../../src/config/loader.js";
import {
  LEGACY_REPOSITORY_CONFIG_VERSION,
  REPOSITORY_CONFIG_VERSION,
  type LoadedRuntimeConfiguration,
  type RepositoryAgentConfig,
} from "../../src/config/types.js";
import {
  DEFAULT_DEVELOPER_ORGANIZATION_POLICY,
  DEFAULT_DEVELOPER_REPOSITORY_POLICY,
  DEFAULT_ORGANIZATION_POLICY,
  DEFAULT_REPOSITORY_POLICY,
  type PolicyDocument,
} from "../../src/policy/index.js";
import { sha256, stableJson } from "../../src/shared/crypto.js";

const limits = {
  max_file_bytes: 1_048_576,
  max_read_bytes: 131_072,
  max_search_output_bytes: 131_072,
  max_diff_bytes: 524_288,
  max_checkpoint_bytes: 16_777_216,
  max_patch_bytes: 4_194_304,
} as const;

function rawRepository(
  version: typeof LEGACY_REPOSITORY_CONFIG_VERSION | typeof REPOSITORY_CONFIG_VERSION,
  options: {
    readonly enabled?: boolean;
    readonly policy?: PolicyDocument;
  } = {},
): Readonly<Record<string, unknown>> {
  return {
    schema_version: version,
    ...(version === REPOSITORY_CONFIG_VERSION
      ? { developer_terminal: { enabled: options.enabled ?? false } }
      : {}),
    classification: "internal",
    policy: options.policy ?? (
      version === REPOSITORY_CONFIG_VERSION && options.enabled === true
        ? DEFAULT_DEVELOPER_REPOSITORY_POLICY
        : DEFAULT_REPOSITORY_POLICY
    ),
    grant_defaults: {
      readable_paths: ["**"],
      writable_paths: ["**"],
      disclosure_classifications: ["internal"],
    },
    commands: [],
    completion: {
      required_command_ids: [],
      require_validation_after_last_mutation: false,
    },
    limits,
    retention: { retain_source_artifacts_on_completion: false },
  };
}

function configuration(
  repository: RepositoryAgentConfig,
  organizationPolicy: PolicyDocument = DEFAULT_DEVELOPER_ORGANIZATION_POLICY,
): LoadedRuntimeConfiguration {
  return {
    organizationPolicy,
    repository,
    hashes: {
      organization: "a".repeat(64),
      repository: "b".repeat(64),
    },
    files: {
      organization: "/state/organization-policy.json",
      repository: "/repo/.cba/repository.json",
    },
  };
}

test("repository config v1 stays strict, hash-pinned, and terminal-disabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cope-developer-config-"));
  const repositoryRoot = path.join(root, "repo");
  const stateHome = path.join(root, "state");
  await mkdir(path.join(repositoryRoot, ".cba"), { recursive: true });
  await mkdir(path.join(stateHome, "config"), { recursive: true });
  const raw = rawRepository(LEGACY_REPOSITORY_CONFIG_VERSION);
  await writeFile(
    path.join(repositoryRoot, ".cba", "repository.json"),
    `${JSON.stringify(raw)}\n`,
  );
  await writeFile(
    path.join(stateHome, "config", "organization-policy.json"),
    `${JSON.stringify(DEFAULT_DEVELOPER_ORGANIZATION_POLICY)}\n`,
  );

  const loaded = await loadRuntimeConfiguration({
    repositoryRoot,
    stateHome,
    requireBrowser: false,
  });
  assert.equal(loaded.repository.schema_version, LEGACY_REPOSITORY_CONFIG_VERSION);
  assert.deepEqual(loaded.repository.developer_terminal, { enabled: false });
  assert.equal(loaded.hashes.repository, sha256(stableJson(raw)));
  assert.throws(
    () => parseRepositoryConfig({ ...raw, developer_terminal: { enabled: true } }),
    /repository configuration contains unknown fields/u,
  );
});

test("repository config v2 requires one strict developer_terminal enable bit", async () => {
  const raw = rawRepository(REPOSITORY_CONFIG_VERSION, { enabled: true });
  const parsed = parseRepositoryConfig(raw);
  assert.equal(parsed.schema_version, REPOSITORY_CONFIG_VERSION);
  assert.deepEqual(parsed.developer_terminal, { enabled: true });
  assert.throws(
    () => parseRepositoryConfig({ ...raw, developer_terminal: { enabled: true, timeout: 1 } }),
    /developer_terminal contains unknown fields/u,
  );
  const { developer_terminal: _developerTerminal, ...missing } = raw;
  assert.throws(
    () => parseRepositoryConfig(missing),
    /developer_terminal/u,
  );
});

test("only a new auto v2 grant allowed by every layer includes terminal_exec", () => {
  const cases = [
    {
      name: "developer",
      repository: parseRepositoryConfig(
        rawRepository(REPOSITORY_CONFIG_VERSION, {
          enabled: true,
          policy: DEFAULT_DEVELOPER_REPOSITORY_POLICY,
        }),
      ),
      organization: DEFAULT_DEVELOPER_ORGANIZATION_POLICY,
      mode: "auto" as const,
      expected: true,
    },
    {
      name: "legacy-auto",
      repository: parseRepositoryConfig(
        rawRepository(LEGACY_REPOSITORY_CONFIG_VERSION, {
          policy: DEFAULT_DEVELOPER_REPOSITORY_POLICY,
        }),
      ),
      organization: DEFAULT_DEVELOPER_ORGANIZATION_POLICY,
      mode: "auto" as const,
      expected: false,
    },
    {
      name: "v2-disabled",
      repository: parseRepositoryConfig(
        rawRepository(REPOSITORY_CONFIG_VERSION, {
          enabled: false,
          policy: DEFAULT_DEVELOPER_REPOSITORY_POLICY,
        }),
      ),
      organization: DEFAULT_DEVELOPER_ORGANIZATION_POLICY,
      mode: "auto" as const,
      expected: false,
    },
    {
      name: "inspect",
      repository: parseRepositoryConfig(
        rawRepository(REPOSITORY_CONFIG_VERSION, {
          enabled: true,
          policy: DEFAULT_DEVELOPER_REPOSITORY_POLICY,
        }),
      ),
      organization: DEFAULT_DEVELOPER_ORGANIZATION_POLICY,
      mode: "inspect" as const,
      expected: false,
    },
    {
      name: "edit",
      repository: parseRepositoryConfig(
        rawRepository(REPOSITORY_CONFIG_VERSION, {
          enabled: true,
          policy: DEFAULT_DEVELOPER_REPOSITORY_POLICY,
        }),
      ),
      organization: DEFAULT_DEVELOPER_ORGANIZATION_POLICY,
      mode: "edit" as const,
      expected: false,
    },
    {
      name: "managed-organization-deny",
      repository: parseRepositoryConfig(
        rawRepository(REPOSITORY_CONFIG_VERSION, {
          enabled: true,
          policy: DEFAULT_DEVELOPER_REPOSITORY_POLICY,
        }),
      ),
      organization: DEFAULT_ORGANIZATION_POLICY,
      mode: "auto" as const,
      expected: false,
    },
    {
      name: "managed-repository-deny",
      repository: parseRepositoryConfig(
        rawRepository(REPOSITORY_CONFIG_VERSION, {
          enabled: true,
          policy: DEFAULT_REPOSITORY_POLICY,
        }),
      ),
      organization: DEFAULT_DEVELOPER_ORGANIZATION_POLICY,
      mode: "auto" as const,
      expected: false,
    },
  ];

  for (const item of cases) {
    const grant = createInitialGrant(
      configuration(item.repository, item.organization),
      {
        taskId: `task-${item.name}`,
        repositoryRoot: "/repo",
        branch: "main",
        mode: item.mode,
      },
      (value) => value,
    );
    const terminalTools = (grant.capabilities.tools?.allow ?? [])
      .filter((tool) => tool === "terminal_exec");
    assert.equal(
      terminalTools.length,
      item.expected ? 1 : 0,
      item.name,
    );
    assert.equal(
      grant.capabilities.tools?.deny?.includes("terminal_exec") ?? false,
      !item.expected,
      item.name,
    );

    const summary = JSON.parse(
      effectiveGrantSummary(configuration(item.repository, item.organization), grant),
    ) as Readonly<Record<string, unknown>>;
    assert.equal("terminal" in summary, item.expected, item.name);
    assert.equal(summary.effective_mode, item.expected ? "developer" : (
      item.mode === "inspect" ? "inspect-only" : item.mode === "auto" ? "policy-auto" : "edit-capable"
    ), item.name);
  }
});
