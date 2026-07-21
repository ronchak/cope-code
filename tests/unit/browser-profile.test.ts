import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  validateBrowserConfig,
  validateEdgeProfileDirectoryPath,
} from "../../src/browser/config.js";
import {
  ExclusiveProfileLock,
  prepareDedicatedProfile,
  resolveSafeEdgeProfileDirectory,
} from "../../src/browser/profile-lock.js";
import { loadRuntimeConfiguration } from "../../src/config/loader.js";
import { launchDedicatedPersistentContext } from "../../src/browser/edge-launcher.js";
import type { BrowserContext } from "playwright-core";
import {
  DEFAULT_ORGANIZATION_POLICY,
  DEFAULT_REPOSITORY_POLICY,
} from "../../src/policy/index.js";
import { AgentError } from "../../src/shared/errors.js";
import { createFilesystemIdentity } from "../../src/shared/filesystem-identity.js";

test("profile configuration rejects UNC, device, and shared path forms", () => {
  for (const candidate of [
    "\\\\server\\share\\edge-profile",
    "//server/share/edge-profile",
    "\\\\?\\C:\\edge-profile",
    "\\\\.\\C:\\edge-profile",
    "\\??\\C:\\edge-profile",
    "\\Device\\HarddiskVolume1\\edge-profile",
  ]) {
    assert.throws(
      () => validateEdgeProfileDirectoryPath(candidate),
      /UNC, device, and shared paths are not allowed/u,
      candidate,
    );
  }
});

test("shipped browser templates make their product-specific uncertified UI contracts explicit", async () => {
  for (const [filename, product] of [
    ["config/examples/browser.edge149.uncertified-template.json", "edge"],
    ["config/examples/browser.chrome149.preview-template.json", "chrome"],
  ] as const) {
    const template = JSON.parse(await readFile(filename, "utf8")) as {
      product?: string;
      ui_contract?: { version?: string; certifiedSurface?: string } & Record<string, unknown>;
    };
    assert.equal(template.product, product);
    assert.match(template.ui_contract?.version ?? "", new RegExp(`uncertified-${product}149-template`, "u"));
    assert.match(template.ui_contract?.certifiedSurface ?? "", /UNDEPLOYABLE TEMPLATE/u);
    assert.doesNotThrow(() => validateBrowserConfig({
      entryUrl: "https://copilot.example.test/chat",
      approvedHosts: [{ hostname: "copilot.example.test" }],
      uiContract: template.ui_contract as never,
      expectedIdentity: "Synthetic Work Account",
      requireProtectionIndicator: true,
      maxMessageChars: 1_000,
      maxResponseChars: 1_000,
      waits: {
        actionMs: 100,
        submissionConfirmationMs: 100,
        responseMs: 100,
        manualReadinessMs: 100,
        pollMs: 10,
        stableSamples: 2,
        minimumStableMs: 10,
      },
    }));
  }
});

test("profile resolver rejects prospective overlap with repository and state roots", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-browser-profile-boundary-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, "repository");
  const stateContainer = join(root, "state-container");
  const stateHome = join(stateContainer, "state");
  await mkdir(repositoryRoot);
  await mkdir(stateHome, { recursive: true });

  for (const [candidate, boundary] of [
    [join(repositoryRoot, "missing", "edge-profile"), "repository"],
    [join(stateHome, "missing-edge-profile"), "state"],
    [stateContainer, "state"],
    [root, "repository"],
  ] as const) {
    await assert.rejects(
      resolveSafeEdgeProfileDirectory(candidate, { repositoryRoot, stateHome }),
      (error: unknown) =>
        error instanceof AgentError &&
        error.code === "CONFIG_INVALID" &&
        error.details.diagnosticCode === "EDGE_PROFILE_PATH_OVERLAP" &&
        error.details.boundary === boundary,
      candidate,
    );
  }
});

test("profile overlap uses the volume's case and Unicode identity", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-browser-profile-alias-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, "CAFÉ");
  const stateHome = join(root, "state");
  await mkdir(repositoryRoot);
  await mkdir(stateHome);
  const identity = createFilesystemIdentity({
    device: 99,
    caseSensitive: false,
    unicodeNormalizationAliases: true,
  });

  await assert.rejects(
    resolveSafeEdgeProfileDirectory(
      join(root, "cafe\u0301", "profile"),
      { repositoryRoot, stateHome },
      async () => identity,
    ),
    (error: unknown) =>
      error instanceof AgentError &&
      error.details.diagnosticCode === "EDGE_PROFILE_PATH_OVERLAP" &&
      error.details.boundary === "repository",
  );
});

test("profile resolver refuses the ordinary Microsoft Edge profile tree", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-browser-ordinary-profile-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, "repository");
  const stateHome = join(root, "state");
  const ordinaryProfile = join(root, "Microsoft Edge");
  await mkdir(repositoryRoot);
  await mkdir(stateHome);
  await assert.rejects(
    resolveSafeEdgeProfileDirectory(
      join(ordinaryProfile, "User Data", "Default"),
      { repositoryRoot, stateHome, ordinaryProfileRoots: [ordinaryProfile] },
    ),
    (error: unknown) =>
      error instanceof AgentError &&
      error.details.diagnosticCode === "EDGE_PROFILE_PATH_OVERLAP" &&
      error.details.boundary === "ordinary-browser-profile",
  );
});

test("profile resolver refuses the ordinary Google Chrome profile tree", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-browser-ordinary-chrome-profile-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, "repository");
  const stateHome = join(root, "state");
  const ordinaryChrome = join(root, "Google", "Chrome");
  await mkdir(repositoryRoot);
  await mkdir(stateHome);
  await assert.rejects(
    resolveSafeEdgeProfileDirectory(
      join(ordinaryChrome, "Default"),
      { repositoryRoot, stateHome, ordinaryProfileRoots: [ordinaryChrome] },
    ),
    (error: unknown) =>
      error instanceof AgentError &&
      error.details.diagnosticCode === "EDGE_PROFILE_PATH_OVERLAP" &&
      error.details.boundary === "ordinary-browser-profile",
  );
});

test("profile resolver refuses overlap with the other product's dedicated profile", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-browser-sibling-profile-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const stateHome = join(root, "state");
  const profilesRoot = join(root, "profiles");
  const siblingProfile = join(profilesRoot, "CopilotBrowserAgentEdgeProfile");
  await mkdir(stateHome);

  for (const candidate of [
    siblingProfile,
    join(siblingProfile, "nested-chrome-profile"),
    profilesRoot,
  ]) {
    await assert.rejects(
      resolveSafeEdgeProfileDirectory(candidate, {
        stateHome,
        dedicatedProfileRoots: [siblingProfile],
      }),
      (error: unknown) =>
        error instanceof AgentError &&
        error.details.diagnosticCode === "EDGE_PROFILE_PATH_OVERLAP" &&
        error.details.boundary === "dedicated-browser-profile",
      candidate,
    );
  }

  const selectedProductProfile = join(profilesRoot, "CopilotBrowserAgentChromeProfile");
  assert.equal(
    await resolveSafeEdgeProfileDirectory(selectedProductProfile, {
      stateHome,
      dedicatedProfileRoots: [siblingProfile],
    }),
    join(await realpath(root), "profiles", "CopilotBrowserAgentChromeProfile"),
  );
});

test("profile resolver follows parent links before containment and returns a canonical prospective path", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-browser-profile-link-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, "repository");
  const stateHome = join(root, "state");
  const safeTarget = join(root, "profile-storage");
  await mkdir(repositoryRoot);
  await mkdir(stateHome);
  await mkdir(safeTarget);

  const repositoryAlias = join(root, "repository-alias");
  const safeAlias = join(root, "profile-alias");
  try {
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(repositoryRoot, repositoryAlias, linkType);
    await symlink(safeTarget, safeAlias, linkType);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      context.skip("The Windows test account cannot create a junction");
      return;
    }
    throw error;
  }

  await assert.rejects(
    resolveSafeEdgeProfileDirectory(join(repositoryAlias, "future-profile"), {
      repositoryRoot,
      stateHome,
    }),
    (error: unknown) =>
      error instanceof AgentError &&
      error.details.diagnosticCode === "EDGE_PROFILE_PATH_OVERLAP" &&
      error.details.boundary === "repository",
  );

  const accepted = await resolveSafeEdgeProfileDirectory(join(safeAlias, "future-profile"), {
    repositoryRoot,
    stateHome,
  });
  assert.equal(accepted, join(await realpath(safeTarget), "future-profile"));
});

test("live configuration canonicalizes the profile and exposes a separate verified browser identity hash", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-browser-profile-config-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, "repository");
  const stateHome = join(root, "state");
  const safeTarget = join(root, "profile-storage");
  await mkdir(join(repositoryRoot, ".cba"), { recursive: true });
  await mkdir(join(stateHome, "config"), { recursive: true });
  await mkdir(safeTarget);

  await writeFile(
    join(stateHome, "config", "organization-policy.json"),
    JSON.stringify(DEFAULT_ORGANIZATION_POLICY),
  );
  await writeFile(join(repositoryRoot, ".cba", "repository.json"), JSON.stringify({
    schema_version: "cba-repository-config/1",
    classification: "internal",
    policy: DEFAULT_REPOSITORY_POLICY,
    grant_defaults: {
      readable_paths: ["**"],
      writable_paths: [],
      disclosure_classifications: ["internal"],
    },
    commands: [],
    completion: {
      required_command_ids: [],
      require_validation_after_last_mutation: true,
    },
    limits: {
      max_file_bytes: 1_048_576,
      max_read_bytes: 131_072,
      max_search_output_bytes: 131_072,
      max_diff_bytes: 524_288,
      max_checkpoint_bytes: 16_777_216,
      max_patch_bytes: 4_194_304,
    },
    retention: { retain_source_artifacts_on_completion: false },
  }));
  await writeFile(join(stateHome, "config", "browser.json"), JSON.stringify({
    schema_version: "cba-browser-config/1",
    entry_url: "https://m365.cloud.microsoft/chat",
    approved_hosts: [{ hostname: "m365.cloud.microsoft", allow_subdomains: false }],
    expected_identity: "approved@example.invalid",
    require_protection_indicator: false,
    profile_directory: join(safeTarget, "future-profile"),
    edge_executable: process.execPath,
  }));

  const browserIdentityVerifier = async (product: "edge" | "chrome", executablePath: string) => ({
    product,
    executablePath,
    version: "149.0.1.2",
    executableSha256: "a".repeat(64),
    size: 1,
    modifiedMs: 1,
    evidence: {
      platform: process.platform === "win32" ? "win32" as const : "darwin" as const,
      productName: "Microsoft Edge Stable",
      publisher: "fixture",
      identifier: "fixture",
      signatureStatus: "valid" as const,
    },
  });
  const loaded = await loadRuntimeConfiguration({
    repositoryRoot,
    stateHome,
    requireBrowser: true,
    browserIdentityVerifier,
  });
  assert.equal(
    loaded.browser?.profileDirectory,
    join(await realpath(safeTarget), "future-profile"),
  );
  const afterUpdate = await loadRuntimeConfiguration({
    repositoryRoot,
    stateHome,
    requireBrowser: true,
    browserIdentityVerifier: async (product, executablePath) => ({
      ...await browserIdentityVerifier(product, executablePath),
      version: "150.0.2.3",
      executableSha256: "b".repeat(64),
    }),
  });
  assert.equal(afterUpdate.hashes.browser, loaded.hashes.browser);
  assert.notEqual(afterUpdate.hashes.browserIdentity, loaded.hashes.browserIdentity);
});

test("live configuration binds launch to the canonical verified executable and rejects verifier mismatch", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-browser-executable-binding-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, "repository");
  const stateHome = join(root, "state");
  const profile = join(root, "profile");
  const executableDirectory = join(root, "browser-real");
  const executableAlias = join(root, "browser-alias");
  const executable = join(executableDirectory, "Microsoft Edge");
  await mkdir(join(repositoryRoot, ".cba"), { recursive: true });
  await mkdir(join(stateHome, "config"), { recursive: true });
  await mkdir(executableDirectory);
  await writeFile(executable, "edge fixture\n", "utf8");
  await chmod(executable, 0o700);
  await symlink(executableDirectory, executableAlias, process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(stateHome, "config", "organization-policy.json"), JSON.stringify(DEFAULT_ORGANIZATION_POLICY));
  await writeFile(join(repositoryRoot, ".cba", "repository.json"), JSON.stringify({
    schema_version: "cba-repository-config/1",
    classification: "internal",
    policy: DEFAULT_REPOSITORY_POLICY,
    grant_defaults: { readable_paths: ["**"], writable_paths: [], disclosure_classifications: ["internal"] },
    commands: [],
    completion: { required_command_ids: [], require_validation_after_last_mutation: false },
    limits: {
      max_file_bytes: 1_048_576, max_read_bytes: 131_072, max_search_output_bytes: 131_072,
      max_diff_bytes: 524_288, max_checkpoint_bytes: 16_777_216, max_patch_bytes: 4_194_304,
    },
    retention: { retain_source_artifacts_on_completion: false },
  }));
  await writeFile(join(stateHome, "config", "browser.json"), JSON.stringify({
    schema_version: "cba-browser-config/1",
    entry_url: "https://m365.cloud.microsoft/chat",
    approved_hosts: [{ hostname: "m365.cloud.microsoft" }],
    expected_identity: "approved@example.invalid",
    require_protection_indicator: false,
    profile_directory: profile,
    edge_executable: join(executableAlias, "Microsoft Edge"),
  }));
  const canonicalExecutable = await realpath(executable);
  const evidence = {
    product: "edge" as const,
    executablePath: canonicalExecutable,
    version: "149.0.1.2",
    executableSha256: "a".repeat(64),
    size: 1,
    modifiedMs: 1,
    evidence: {
      platform: "darwin" as const,
      productName: "Microsoft Edge Stable",
      publisher: "fixture",
      identifier: "fixture",
      signatureStatus: "valid" as const,
    },
  };
  const loaded = await loadRuntimeConfiguration({
    repositoryRoot,
    stateHome,
    requireBrowser: true,
    browserIdentityVerifier: async () => evidence,
  });
  assert.equal(loaded.browser?.browserExecutable, canonicalExecutable);
  await assert.rejects(loadRuntimeConfiguration({
    repositoryRoot,
    stateHome,
    requireBrowser: true,
    browserIdentityVerifier: async () => ({ ...evidence, product: "chrome" }),
  }), (error: unknown) =>
    error instanceof AgentError && error.details.diagnosticCode === "BROWSER_IDENTITY_EVIDENCE_MISMATCH");

  await writeFile(join(stateHome, "config", "browser.json"), JSON.stringify({
    schema_version: "cba-browser-config/2",
    entry_url: "https://m365.cloud.microsoft/chat",
    approved_hosts: [{ hostname: "m365.cloud.microsoft" }],
    expected_identity: "approved@example.invalid",
    require_protection_indicator: false,
    profile_directory: profile,
    product: "edge",
    browser_contract_version: "cope-visible-browser/v1",
    browser_executable: join(executableAlias, "Microsoft Edge"),
    browser_version: "149.0.1.2",
    browser_executable_sha256: "b".repeat(64),
  }));
  await assert.rejects(loadRuntimeConfiguration({
    repositoryRoot,
    stateHome,
    requireBrowser: true,
    browserIdentityVerifier: async () => evidence,
  }), (error: unknown) =>
    error instanceof AgentError && error.details.diagnosticCode === "BROWSER_EXECUTABLE_EVIDENCE_CHANGED");
});

test("persistent Edge launch receives only the dedicated profile as its user-data directory", async () => {
  const dedicated = "/private/dedicated-cope-edge-profile";
  const calls: Array<{ readonly userDataDirectory: string; readonly options: Readonly<Record<string, unknown>> }> = [];
  const returnedContext = {
    browser: () => ({ close: async () => undefined }),
  } as unknown as BrowserContext;
  const observed = await launchDedicatedPersistentContext(
    dedicated,
    { headless: false, acceptDownloads: false },
    async (userDataDirectory, options) => {
      calls.push({ userDataDirectory, options: options as Readonly<Record<string, unknown>> });
      return returnedContext;
    },
  );
  assert.equal(observed, returnedContext);
  assert.deepEqual(calls.map((call) => call.userDataDirectory), [dedicated]);
  assert.equal("userDataDir" in (calls[0]?.options ?? {}), false);
});

test("persistent browser launch rejects a missing process owner", async () => {
  let closed = false;
  const returnedContext = {
    browser: () => null,
    close: async () => { closed = true; },
  } as unknown as BrowserContext;

  await assert.rejects(
    launchDedicatedPersistentContext(
      "/private/dedicated-cope-edge-profile",
      { headless: false },
      async () => returnedContext,
    ),
    (error: unknown) =>
      error instanceof AgentError &&
      error.details.diagnosticCode === "BROWSER_PROCESS_OWNER_UNAVAILABLE",
  );
  assert.equal(closed, true);
});

test("dedicated profile lock is exclusive and recoverable after release", async () => {
  const root = await mkdtemp(join(tmpdir(), "copilot-browser-profile-test-"));
  const profile = join(root, "profile");
  try {
    const first = await ExclusiveProfileLock.acquire(profile);
    await prepareDedicatedProfile(profile);
    await assert.rejects(ExclusiveProfileLock.acquire(profile), /already in use/u);
    await first.release();

    const second = await ExclusiveProfileLock.acquire(profile);
    await prepareDedicatedProfile(profile);
    await second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile preparation refuses an existing unmarked browser profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "copilot-browser-profile-test-"));
  const profile = join(root, "ordinary-profile");
  try {
    await mkdir(profile);
    await writeFile(join(profile, "Preferences"), "{}", "utf8");
    await assert.rejects(prepareDedicatedProfile(profile), /non-empty, unmarked/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dedicated profile markers bind the profile to one browser product", async () => {
  const root = await mkdtemp(join(tmpdir(), "copilot-browser-profile-product-test-"));
  const chromeProfile = join(root, "chrome");
  try {
    await mkdir(chromeProfile);
    await prepareDedicatedProfile(chromeProfile, "chrome");
    await prepareDedicatedProfile(chromeProfile, "chrome");
    await assert.rejects(
      prepareDedicatedProfile(chromeProfile, "edge"),
      /belongs to another product/u,
    );
    await writeFile(join(chromeProfile, ".copilot-agent-profile-v1.json"), JSON.stringify({
      kind: "copilot-agent-dedicated-browser-profile/v1",
      product: "edge",
    }));
    await assert.rejects(
      prepareDedicatedProfile(chromeProfile, "chrome"),
      /belongs to another product/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy Edge markers are strict and marker links fail closed", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-browser-legacy-profile-marker-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const profile = join(root, "profile");
  const marker = join(profile, ".copilot-agent-profile-v1.json");
  await mkdir(profile);
  const createdAt = new Date().toISOString();
  await writeFile(marker, JSON.stringify({
    kind: "copilot-agent-dedicated-edge-profile/v1",
    createdAt,
  }));
  await prepareDedicatedProfile(profile, "edge");
  await writeFile(marker, JSON.stringify({
    kind: "copilot-agent-dedicated-edge-profile/v1",
    product: "chrome",
    injected: true,
    createdAt,
  }));
  await assert.rejects(prepareDedicatedProfile(profile, "edge"), /marker is invalid/u);
  await rm(marker);
  const target = join(root, "foreign-marker.json");
  await writeFile(target, JSON.stringify({
    kind: "copilot-agent-dedicated-edge-profile/v1",
    createdAt,
  }));
  try {
    await symlink(target, marker, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      context.skip("The Windows test account cannot create a marker symlink");
      return;
    }
    throw error;
  }
  await assert.rejects(prepareDedicatedProfile(profile, "edge"), /marker is invalid/u);
});

test("an unreadable existing lock fails closed instead of being deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "copilot-browser-profile-test-"));
  const profile = join(root, "profile");
  try {
    await mkdir(profile, { mode: 0o700 });
    await writeFile(join(profile, ".copilot-agent-profile.lock"), "partial", { encoding: "utf8", mode: 0o600 });
    await assert.rejects(ExclusiveProfileLock.acquire(profile), /cannot be verified/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
