import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { validateEdgeProfileDirectoryPath } from "../../src/browser/config.js";
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
      error.details.boundary === "ordinary-edge-profile",
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

test("live configuration hands the canonical prospective profile path to the browser launcher", async (context) => {
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

  const loaded = await loadRuntimeConfiguration({ repositoryRoot, stateHome, requireBrowser: true });
  assert.equal(
    loaded.browser?.profileDirectory,
    join(await realpath(safeTarget), "future-profile"),
  );
});

test("persistent Edge launch receives only the dedicated profile as its user-data directory", async () => {
  const dedicated = "/private/dedicated-cope-edge-profile";
  const calls: Array<{ readonly userDataDirectory: string; readonly options: Readonly<Record<string, unknown>> }> = [];
  const returnedContext = {} as BrowserContext;
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
