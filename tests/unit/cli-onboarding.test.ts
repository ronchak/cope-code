import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  configurationPaths,
  configureMachine,
  executeSetupCommand,
  writeRepositoryConfiguration,
} from "../../src/cli/onboarding.js";
import type {
  BrowserLaunchConfig,
  BrowserProduct,
  DiscoveredBrowser,
  EdgeCopilotTransport,
} from "../../src/browser/index.js";
import { createBaselineCopilotUiContract } from "../../src/browser/index.js";
import { parseBrowserConfig } from "../../src/config/loader.js";
import { AgentError } from "../../src/shared/errors.js";
import { PromptCancelledError } from "../../src/cli/prompts.js";
import { createStandardUserHost } from "../helpers/standard-user-host.js";

test("guided project setup detects useful package scripts and chooses one completion check", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-onboarding-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const fakeNpmCli = path.join(root, "npm-cli.js");
  await writeFile(fakeNpmCli, "// test fixture\n", "utf8");
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    scripts: {
      test: "node --test",
      build: "tsc -p tsconfig.json",
      lint: "eslint .",
    },
  }), "utf8");

  const previous = process.env.npm_execpath;
  process.env.npm_execpath = fakeNpmCli;
  context.after(() => {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
  });

  const result = await writeRepositoryConfiguration({ repositoryRoot: root, profile: "standard", force: true });
  assert.equal(result.profile, "standard");
  assert.equal(result.commandCount, 3);

  const config = JSON.parse(await readFile(result.filename, "utf8")) as {
    grant_defaults: { writable_paths: string[] };
    commands: Array<{ id: string; executable: string; fixedArguments: string[] }>;
    completion: { required_command_ids: string[]; require_validation_after_last_mutation: boolean };
  };
  assert.deepEqual(config.grant_defaults.writable_paths, ["**"]);
  assert.deepEqual(config.commands.map((command) => command.id), ["npm.test", "npm.build", "npm.lint"]);
  assert.ok(config.commands.every((command) => command.executable === process.execPath));
  assert.ok(config.commands.every((command) => command.fixedArguments[0] === fakeNpmCli));
  assert.deepEqual(config.completion.required_command_ids, ["npm.test"]);
  assert.equal(config.completion.require_validation_after_last_mutation, true);
});

test("placeholder npm tests are ignored and inspect setup stays read-only", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-onboarding-inspect-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const fakeNpmCli = path.join(root, "npm-cli.js");
  await writeFile(fakeNpmCli, "// test fixture\n", "utf8");
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    scripts: { test: "echo Error: no test specified && exit 1" },
  }), "utf8");
  const previous = process.env.npm_execpath;
  process.env.npm_execpath = fakeNpmCli;
  context.after(() => {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
  });

  const result = await writeRepositoryConfiguration({ repositoryRoot: root, profile: "inspect", force: true });
  const config = JSON.parse(await readFile(result.filename, "utf8")) as {
    grant_defaults: { writable_paths: string[] };
    commands: unknown[];
    completion: { required_command_ids: string[] };
  };
  assert.deepEqual(config.grant_defaults.writable_paths, []);
  assert.deepEqual(config.commands, []);
  assert.deepEqual(config.completion.required_command_ids, []);
});

const browserDigest = "a".repeat(64);

function discoveredBrowser(product: BrowserProduct, executablePath = `/verified/${product}`): DiscoveredBrowser {
  return {
    product,
    executablePath,
    version: "149.0.1.2",
    executableSha256: browserDigest,
    size: 42,
    modifiedMs: 1,
    evidence: {
      platform: "darwin",
      productName: product === "edge" ? "Microsoft Edge Stable" : "Google Chrome Stable",
      publisher: product === "edge" ? "UBF8T346G9" : "EQHXZ8M8AV",
      identifier: product === "edge" ? "com.microsoft.edgemac" : "com.google.Chrome",
      signatureStatus: "valid",
    },
    source: "automatic",
    locationLabel: "Found in Applications",
  };
}

function readyTransport(observed: BrowserLaunchConfig[]): EdgeCopilotTransport {
  return {
    waitForManualReadiness: async () => ({ classification: { state: "ready" } }),
    inspectState: async () => ({ classification: { state: "ready" } }),
    close: async () => undefined,
  } as unknown as EdgeCopilotTransport;
}

const acceptPromptDefault: NonNullable<import("../../src/cli/onboarding.js").MachineSetupDependencies["promptText"]> =
  async (_label, options) => options?.defaultValue ?? "person@example.com";

test("guided machine setup preselects the only detected browser and commits only after readiness", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-machine-one-browser-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const stateHome = path.join(root, "state");
  await mkdir(stateHome, { mode: 0o700 });
  const host = createStandardUserHost();
  const paths = configurationPaths(stateHome, host);
  const chrome = discoveredBrowser("chrome");
  const launched: BrowserLaunchConfig[] = [];
  const result = await configureMachine({
    paths,
    force: false,
    interactive: true,
    output: { write: () => undefined },
    host,
    entryUrl: "https://m365.cloud.microsoft/chat",
  }, {
    discoverBrowsers: async () => [chrome],
    promptBrowser: async (screen) => {
      assert.equal(screen.kind, "single");
      return { action: "continue", browser: chrome };
    },
    promptText: async (label) => label.includes("account") ? "person@example.com" : "",
    promptConfirm: async () => false,
    verifyManualBrowser: async (product, executablePath) => ({
      ...discoveredBrowser(product, executablePath),
      source: "manual",
    }),
    launchBrowser: async (config) => {
      launched.push(config);
      return readyTransport(launched);
    },
  });
  assert.equal(result.browserProduct, "chrome");
  assert.equal(result.edgeExecutable, undefined);
  assert.equal(launched.length, 1);
  assert.equal(launched[0]?.product, "chrome");
  const persisted = JSON.parse(await readFile(paths.browser, "utf8")) as Record<string, unknown>;
  assert.equal(persisted.schema_version, "cba-browser-config/2");
  assert.equal(persisted.product, "chrome");
  assert.equal(persisted.browser_executable, chrome.executablePath);
  assert.equal(path.basename(String(persisted.profile_directory)), "CopilotBrowserAgentChromeProfile");
  assert.ok(await readFile(paths.organizationPolicy, "utf8"));
});

test("two-browser setup defaults to Edge and explicit automation can choose Chrome without UI", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-machine-two-browser-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const host = createStandardUserHost();
  const edge = discoveredBrowser("edge");
  const chrome = discoveredBrowser("chrome");
  const interactiveHome = path.join(root, "interactive");
  await mkdir(interactiveHome, { mode: 0o700 });
  let selectedIndex = -1;
  await configureMachine({
    paths: configurationPaths(interactiveHome, host),
    force: false,
    interactive: true,
    output: { write: () => undefined },
    host,
    identity: "person@example.com",
    entryUrl: "https://m365.cloud.microsoft/chat",
    requireProtectionIndicator: false,
  }, {
    discoverBrowsers: async () => [edge, chrome],
    promptBrowser: async (screen) => {
      assert.equal(screen.kind, "choose");
      if (screen.kind !== "choose") throw new Error("wrong screen");
      selectedIndex = screen.selectedIndex;
      return { action: "continue", browser: screen.browsers[screen.selectedIndex]! };
    },
    promptConfirm: async () => false,
    verifyManualBrowser: async (product, executablePath) => ({ ...discoveredBrowser(product, executablePath), source: "manual" }),
    launchBrowser: async () => readyTransport([]),
  });
  assert.equal(selectedIndex, 0);

  const managedHome = path.join(root, "managed");
  await mkdir(managedHome, { mode: 0o700 });
  let promptCalled = false;
  const result = await configureMachine({
    paths: configurationPaths(managedHome, host),
    force: false,
    interactive: false,
    output: { write: () => undefined },
    host,
    browser: "chrome",
    identity: "person@example.com",
  }, {
    discoverBrowsers: async () => [edge, chrome],
    promptBrowser: async () => { promptCalled = true; throw new Error("unexpected prompt"); },
    verifyManualBrowser: async (product, executablePath) => ({ ...discoveredBrowser(product, executablePath), source: "manual" }),
    launchBrowser: async () => readyTransport([]),
  });
  assert.equal(promptCalled, false);
  assert.equal(result.browserProduct, "chrome");
});

test("Retry redetects browsers and changing Edge to Chrome requires confirmation and a separate profile", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-machine-retry-change-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const host = createStandardUserHost();
  const edge = discoveredBrowser("edge");
  const chrome = discoveredBrowser("chrome");

  const retryHome = path.join(root, "retry");
  await mkdir(retryHome, { mode: 0o700 });
  let discoveryCount = 0;
  const retryScreens: string[] = [];
  const retryResult = await configureMachine({
    paths: configurationPaths(retryHome, host),
    force: false,
    interactive: true,
    output: { write: () => undefined },
    host,
    identity: "person@example.com",
    entryUrl: "https://m365.cloud.microsoft/chat",
    requireProtectionIndicator: false,
  }, {
    discoverBrowsers: async () => ++discoveryCount === 1 ? [] : [chrome],
    promptBrowser: async (screen) => {
      retryScreens.push(screen.kind);
      if (screen.kind === "none") return { action: "retry" };
      if (screen.kind === "single") return { action: "continue", browser: screen.browser };
      throw new Error(`unexpected screen ${screen.kind}`);
    },
    verifyManualBrowser: async (product, executablePath) => ({ ...discoveredBrowser(product, executablePath), source: "manual" }),
    launchBrowser: async () => readyTransport([]),
  });
  assert.equal(retryResult.browserProduct, "chrome");
  assert.deepEqual(retryScreens, ["none", "single"]);

  const changeHome = path.join(root, "change");
  await mkdir(changeHome, { mode: 0o700 });
  const changePaths = configurationPaths(changeHome, host);
  const common = {
    verifyManualBrowser: async (product: BrowserProduct, executablePath: string) => ({
      ...discoveredBrowser(product, executablePath),
      source: "manual" as const,
    }),
    launchBrowser: async () => readyTransport([]),
    promptText: acceptPromptDefault,
  };
  await configureMachine({
    paths: changePaths,
    force: false,
    interactive: false,
    output: { write: () => undefined },
    host,
    browser: "edge",
    identity: "person@example.com",
  }, { ...common, discoverBrowsers: async () => [edge] });
  const changeScreens: string[] = [];
  const changed = await configureMachine({
    paths: changePaths,
    force: false,
    interactive: true,
    output: { write: () => undefined },
    host,
  }, {
    ...common,
    discoverBrowsers: async () => [edge, chrome],
    promptBrowser: async (screen) => {
      changeScreens.push(screen.kind);
      if (screen.kind === "current") return { action: "change" };
      if (screen.kind === "choose") return { action: "continue", browser: chrome };
      if (screen.kind === "confirm-change") return { action: "confirm-change", browser: chrome };
      throw new Error(`unexpected screen ${screen.kind}`);
    },
  });
  assert.equal(changed.browserProduct, "chrome");
  assert.deepEqual(changeScreens, ["current", "choose", "confirm-change"]);
  const persisted = JSON.parse(await readFile(changePaths.browser, "utf8")) as Record<string, unknown>;
  assert.equal(persisted.product, "chrome");
  assert.notEqual(persisted.profile_directory, changePaths.profileDirectories.edge);
  assert.equal(path.basename(String(persisted.profile_directory)), "CopilotBrowserAgentChromeProfile");
});

test("existing browser setup remains selected and is not silently rewritten", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-machine-existing-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const stateHome = path.join(root, "state");
  await mkdir(stateHome, { mode: 0o700 });
  const host = createStandardUserHost();
  const paths = configurationPaths(stateHome, host);
  const edge = discoveredBrowser("edge");
  const launched: BrowserLaunchConfig[] = [];
  const dependencies = {
    discoverBrowsers: async () => [] as readonly DiscoveredBrowser[],
    promptBrowser: async (screen: Parameters<NonNullable<import("../../src/cli/onboarding.js").MachineSetupDependencies["promptBrowser"]>>[0]) => {
      assert.equal(screen.kind, "current");
      return { action: "continue", browser: edge } as const;
    },
    verifyManualBrowser: async (product: BrowserProduct, executablePath: string) => ({
      ...discoveredBrowser(product, executablePath),
      source: "manual" as const,
    }),
    launchBrowser: async (config: BrowserLaunchConfig) => {
      launched.push(config);
      return readyTransport(launched);
    },
    promptText: acceptPromptDefault,
  };
  await configureMachine({
    paths,
    force: false,
    interactive: false,
    output: { write: () => undefined },
    host,
    browser: "edge",
    identity: "person@example.com",
  }, {
    ...dependencies,
    discoverBrowsers: async () => [edge],
  });
  const managed = JSON.parse(await readFile(paths.browser, "utf8")) as {
    approved_hosts: Array<{ hostname: string; allow_subdomains: boolean }>;
    manual_authentication_hosts: Array<{ hostname: string; allow_subdomains: boolean }>;
  } & Record<string, unknown>;
  managed.approved_hosts = [
    { hostname: "m365.cloud.microsoft", allow_subdomains: false },
    { hostname: "tenant.example", allow_subdomains: false },
  ];
  managed.manual_authentication_hosts = [
    { hostname: "login.microsoftonline.com", allow_subdomains: false },
  ];
  await writeFile(paths.browser, `${JSON.stringify(managed)}\n`, "utf8");
  const before = await readFile(paths.browser);
  const result = await configureMachine({
    paths,
    force: false,
    interactive: true,
    output: { write: () => undefined },
    host,
  }, dependencies);
  assert.equal(result.browserProduct, "edge");
  assert.deepEqual(await readFile(paths.browser), before);
  assert.deepEqual(launched.at(-1)?.approvedHosts, [
    { hostname: "m365.cloud.microsoft", allowSubdomains: false },
    { hostname: "tenant.example", allowSubdomains: false },
  ]);
  assert.deepEqual(launched.at(-1)?.manualAuthenticationHosts, [
    { hostname: "login.microsoftonline.com", allowSubdomains: false },
  ]);
});

test("forced setup replaces only a stale pinned UI contract", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-machine-stale-contract-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const stateHome = path.join(root, "state");
  await mkdir(stateHome, { mode: 0o700 });
  const host = createStandardUserHost();
  const paths = configurationPaths(stateHome, host);
  const edge = discoveredBrowser("edge");
  const launched: BrowserLaunchConfig[] = [];
  const dependencies = {
    discoverBrowsers: async () => [edge],
    verifyManualBrowser: async (product: BrowserProduct, executablePath: string) => ({
      ...discoveredBrowser(product, executablePath),
      source: "manual" as const,
    }),
    launchBrowser: async (config: BrowserLaunchConfig) => {
      launched.push(config);
      return readyTransport(launched);
    },
    promptText: acceptPromptDefault,
  };

  await configureMachine({
    paths,
    force: false,
    interactive: false,
    output: { write: () => undefined },
    host,
    browser: "edge",
    identity: "person@example.com",
  }, dependencies);

  const stale = JSON.parse(await readFile(paths.browser, "utf8")) as Record<string, unknown>;
  const unsafeContract = structuredClone(
    createBaselineCopilotUiContract("person@example.com"),
  ) as unknown as {
    groups: Record<string, { candidates: Array<Record<string, unknown>> }>;
  };
  const protection = unsafeContract.groups.protection;
  assert.ok(protection);
  protection.candidates = [{
    kind: "text",
    text: { source: "enterprise data protection|protected", flags: "iu" },
  }];
  stale.ui_contract = unsafeContract;
  const staleBytes = `${JSON.stringify(stale)}\n`;
  await writeFile(paths.browser, staleBytes, "utf8");

  assert.throws(() => parseBrowserConfig(stale), /protection/iu);
  await assert.rejects(
    configureMachine({
      paths,
      force: false,
      interactive: false,
      output: { write: () => undefined },
      host,
    }, dependencies),
    /was not replaced/u,
  );
  assert.equal(await readFile(paths.browser, "utf8"), staleBytes);

  const invalidBeyondContract = { ...stale, unexpected_top_level: true };
  const invalidBytes = `${JSON.stringify(invalidBeyondContract)}\n`;
  await writeFile(paths.browser, invalidBytes, "utf8");
  await assert.rejects(
    configureMachine({
      paths,
      force: true,
      interactive: false,
      output: { write: () => undefined },
      host,
    }, dependencies),
    /was not replaced/u,
  );
  assert.equal(await readFile(paths.browser, "utf8"), invalidBytes);

  for (const unrecoverable of [
    "null\n",
    "[]\n",
    "{broken json\n",
    `${JSON.stringify({ unexpected_top_level: true })}\n`,
  ]) {
    await writeFile(paths.browser, unrecoverable, "utf8");
    await assert.rejects(
      configureMachine({
        paths,
        force: true,
        interactive: false,
        output: { write: () => undefined },
        host,
      }, dependencies),
      /was not replaced/u,
    );
    assert.equal(await readFile(paths.browser, "utf8"), unrecoverable);
  }

  await writeFile(paths.browser, staleBytes, "utf8");
  launched.length = 0;
  await configureMachine({
    paths,
    force: true,
    interactive: false,
    output: { write: () => undefined },
    host,
  }, dependencies);

  assert.equal(launched.length, 1);
  assert.ok(launched[0]?.uiContract.groups.protection.candidates.every(
    (candidate) => candidate.kind === "role" &&
      (candidate.role === "status" || candidate.role === "img"),
  ));
  const recovered = JSON.parse(await readFile(paths.browser, "utf8")) as Record<string, unknown>;
  assert.equal(Object.hasOwn(recovered, "ui_contract"), false);
  assert.doesNotThrow(() => parseBrowserConfig(recovered));

  const validButStaleContract = structuredClone(
    createBaselineCopilotUiContract("person@example.com"),
  ) as unknown as Record<string, unknown>;
  validButStaleContract.version = `${String(validButStaleContract.version)}:synthetically-stale`;
  const validPinned = { ...recovered, ui_contract: validButStaleContract };
  assert.doesNotThrow(() => parseBrowserConfig(validPinned));
  const validPinnedBytes = `${JSON.stringify(validPinned)}\n`;
  await writeFile(paths.browser, validPinnedBytes, "utf8");
  await configureMachine({
    paths,
    force: false,
    interactive: false,
    output: { write: () => undefined },
    host,
  }, dependencies);
  assert.equal(await readFile(paths.browser, "utf8"), validPinnedBytes);

  await assert.rejects(
    configureMachine({
      paths,
      force: true,
      interactive: false,
      output: { write: () => undefined },
      host,
    }, {
      ...dependencies,
      launchBrowser: async (config) => {
        assert.notEqual(config.uiContract.version, validButStaleContract.version);
        return {
          waitForManualReadiness: async () => ({
            classification: {
              state: "changed-selector" as const,
              diagnosticCode: "UI_CONTRACT_QUORUM_FAILED",
            },
          }),
          inspectState: async () => ({
            classification: {
              state: "changed-selector" as const,
              diagnosticCode: "UI_CONTRACT_QUORUM_FAILED",
            },
          }),
          close: async () => undefined,
        } as unknown as EdgeCopilotTransport;
      },
    }),
    (error: unknown) =>
      error instanceof AgentError &&
      error.code === "TRANSPORT_UNAVAILABLE",
  );
  assert.equal(await readFile(paths.browser, "utf8"), validPinnedBytes);

  launched.length = 0;
  await configureMachine({
    paths,
    force: true,
    interactive: false,
    output: { write: () => undefined },
    host,
  }, dependencies);
  assert.equal(launched.length, 1);
  assert.notEqual(
    launched[0]?.uiContract.version,
    validButStaleContract.version,
  );
  const resetValidPinned = JSON.parse(
    await readFile(paths.browser, "utf8"),
  ) as Record<string, unknown>;
  assert.equal(Object.hasOwn(resetValidPinned, "ui_contract"), false);

  await writeFile(paths.browser, staleBytes, "utf8");
  const externalChange = "external browser config change\n";
  await assert.rejects(
    configureMachine({
      paths,
      force: true,
      interactive: false,
      output: { write: () => undefined },
      host,
    }, {
      ...dependencies,
      launchBrowser: async (config) => {
        assert.ok(config.uiContract.groups.protection.candidates.every(
          (candidate) => candidate.kind === "role",
        ));
        await writeFile(paths.browser, externalChange, "utf8");
        return readyTransport([]);
      },
    }),
    (error: unknown) =>
      error instanceof AgentError &&
      error.details.diagnosticCode === "BROWSER_CONFIG_COMPARE_AND_SWAP_FAILED",
  );
  assert.equal(await readFile(paths.browser, "utf8"), externalChange);
});

test("noninteractive idempotent setup does not require a live GUI session", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-machine-idempotent-headless-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const stateHome = path.join(root, "state");
  const host = createStandardUserHost();
  const edge = discoveredBrowser("edge");
  const dependencies = {
    discoverBrowsers: async () => [edge],
    verifyManualBrowser: async (product: BrowserProduct, executablePath: string) => ({
      ...discoveredBrowser(product, executablePath),
      source: "manual" as const,
    }),
    launchBrowser: async () => readyTransport([]),
  };
  const output = { write: () => undefined };

  await executeSetupCommand({
    command: "setup",
    force: false,
    json: true,
    stateHome,
    browser: "edge",
    identity: "person@example.com",
  }, { stdout: output, stderr: output }, host, dependencies);

  const eligibilityChecks: boolean[] = [];
  const headlessHost = new Proxy(host, {
    get(target, property) {
      if (property === "verifyEligibility") {
        return async (options: { readonly liveBrowser: boolean }) => {
          eligibilityChecks.push(options.liveBrowser);
          if (options.liveBrowser) throw new Error("live GUI preflight must be deferred");
          return { standardUserVerified: true, guiSessionVerified: false };
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await executeSetupCommand({
    command: "setup",
    force: false,
    json: true,
    stateHome,
  }, { stdout: output, stderr: output }, headlessHost, {
    ...dependencies,
    discoverBrowsers: async () => { throw new Error("idempotent setup must not discover"); },
    launchBrowser: async () => { throw new Error("idempotent setup must not launch"); },
  });
  assert.deepEqual(eligibilityChecks, [false]);
});

test("first-time setup refuses a missing live GUI before creating state", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-machine-first-setup-headless-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const stateHome = path.join(root, "state");
  const host = createStandardUserHost();
  const eligibilityChecks: boolean[] = [];
  const headlessHost = new Proxy(host, {
    get(target, property) {
      if (property === "verifyEligibility") {
        return async (options: { readonly liveBrowser: boolean }) => {
          eligibilityChecks.push(options.liveBrowser);
          if (options.liveBrowser) throw new Error("Aqua GUI session unavailable");
          return { standardUserVerified: true, guiSessionVerified: false };
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const output = { write: () => undefined };

  await assert.rejects(executeSetupCommand({
    command: "setup",
    force: false,
    json: true,
    stateHome,
    browser: "edge",
    identity: "person@example.com",
  }, { stdout: output, stderr: output }, headlessHost), /Aqua GUI session unavailable/u);

  assert.deepEqual(eligibilityChecks, [false, true]);
  await assert.rejects(lstat(stateHome), { code: "ENOENT" });
});

test("idempotent setup re-verifies private state after reading browser evidence", async (context) => {
  if (process.platform !== "darwin") {
    context.skip("Private state mode enforcement is macOS-specific");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "cope-machine-idempotent-state-race-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const stateHome = path.join(root, "state");
  const host = createStandardUserHost();
  const edge = discoveredBrowser("edge");
  const output = { write: () => undefined };
  const dependencies = {
    discoverBrowsers: async () => [edge],
    verifyManualBrowser: async (product: BrowserProduct, executablePath: string) => ({
      ...discoveredBrowser(product, executablePath),
      source: "manual" as const,
    }),
    launchBrowser: async () => readyTransport([]),
  };

  await executeSetupCommand({
    command: "setup",
    force: false,
    json: true,
    stateHome,
    browser: "edge",
    identity: "person@example.com",
  }, { stdout: output, stderr: output }, host, dependencies);

  await assert.rejects(executeSetupCommand({
    command: "setup",
    force: false,
    json: true,
    stateHome,
  }, { stdout: output, stderr: output }, host, {
    ...dependencies,
    verifyManualBrowser: async (product, executablePath) => {
      await chmod(stateHome, 0o755);
      return {
        ...discoveredBrowser(product, executablePath),
        source: "manual" as const,
      };
    },
    launchBrowser: async () => { throw new Error("unsafe idempotent setup must not launch"); },
  }), (error: unknown) =>
    error instanceof AgentError && error.details.diagnosticCode === "DARWIN_PRIVATE_STATE_UNSAFE");
});

test("interactive setup prompts with the current identity and persists a correction", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-machine-identity-correction-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const stateHome = path.join(root, "state");
  await mkdir(stateHome, { mode: 0o700 });
  const host = createStandardUserHost();
  const paths = configurationPaths(stateHome, host);
  const edge = discoveredBrowser("edge");
  const launched: BrowserLaunchConfig[] = [];
  const common = {
    discoverBrowsers: async () => [edge],
    verifyManualBrowser: async (product: BrowserProduct, executablePath: string) => ({
      ...discoveredBrowser(product, executablePath),
      source: "manual" as const,
    }),
    launchBrowser: async (config: BrowserLaunchConfig) => {
      launched.push(config);
      return readyTransport(launched);
    },
  };
  await configureMachine({
    paths,
    force: false,
    interactive: false,
    output: { write: () => undefined },
    host,
    browser: "edge",
    identity: "old-account@example.com",
  }, common);

  let defaultIdentity: string | undefined;
  await configureMachine({
    paths,
    force: false,
    interactive: true,
    output: { write: () => undefined },
    host,
  }, {
    ...common,
    promptBrowser: async (screen) => {
      assert.equal(screen.kind, "current");
      if (screen.kind !== "current") throw new Error("wrong screen");
      return { action: "continue", browser: screen.browser };
    },
    promptText: async (label, options) => {
      assert.match(label, /account/iu);
      defaultIdentity = options?.defaultValue;
      return "new-account@example.com";
    },
  });

  const persisted = JSON.parse(await readFile(paths.browser, "utf8")) as Record<string, unknown>;
  assert.equal(defaultIdentity, "old-account@example.com");
  assert.equal(persisted.expected_identity, "new-account@example.com");
  assert.equal(launched.at(-1)?.expectedIdentity, "new-account@example.com");
});

test("guided setup verifies and persists a stable browser update before live use resumes", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-machine-browser-update-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const stateHome = path.join(root, "state");
  await mkdir(stateHome, { mode: 0o700 });
  const host = createStandardUserHost();
  const paths = configurationPaths(stateHome, host);
  let observed = discoveredBrowser("edge");
  const launched: BrowserLaunchConfig[] = [];
  const dependencies = {
    discoverBrowsers: async () => [observed],
    verifyManualBrowser: async () => ({ ...observed, source: "manual" as const }),
    promptBrowser: async (screen: Parameters<NonNullable<import("../../src/cli/onboarding.js").MachineSetupDependencies["promptBrowser"]>>[0]) => {
      assert.equal(screen.kind, "current");
      assert.equal(screen.kind === "current" ? screen.browser.version : undefined, "150.0.2.3");
      return { action: "continue", browser: observed } as const;
    },
    launchBrowser: async (config: BrowserLaunchConfig) => {
      launched.push(config);
      return readyTransport(launched);
    },
    promptText: acceptPromptDefault,
  };

  await configureMachine({
    paths,
    force: false,
    interactive: false,
    output: { write: () => undefined },
    host,
    browser: "edge",
    identity: "person@example.com",
  }, dependencies);
  const original = JSON.parse(await readFile(paths.browser, "utf8")) as Record<string, unknown>;

  observed = {
    ...observed,
    version: "150.0.2.3",
    executableSha256: "b".repeat(64),
  };
  await configureMachine({
    paths,
    force: false,
    interactive: true,
    output: { write: () => undefined },
    host,
  }, dependencies);

  const updated = JSON.parse(await readFile(paths.browser, "utf8")) as Record<string, unknown>;
  assert.equal(updated.browser_version, "150.0.2.3");
  assert.equal(updated.browser_executable_sha256, "b".repeat(64));
  assert.equal(updated.profile_directory, original.profile_directory);
  assert.equal(launched.at(-1)?.browserVersion, "150.0.2.3");
  assert.equal(launched.at(-1)?.browserExecutableSha256, "b".repeat(64));
});

test("same-product setup preserves a verified manual executable without discovery", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-machine-manual-browser-rerun-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const stateHome = path.join(root, "state");
  await mkdir(stateHome, { mode: 0o700 });
  const host = createStandardUserHost();
  const paths = configurationPaths(stateHome, host);
  const manualExecutable = "/managed/Google Chrome";
  const launched: BrowserLaunchConfig[] = [];
  const verifyManualBrowser = async (product: BrowserProduct, executablePath: string) => ({
    ...discoveredBrowser(product, executablePath),
    source: "manual" as const,
  });
  const launchBrowser = async (config: BrowserLaunchConfig) => {
    launched.push(config);
    return readyTransport(launched);
  };

  await configureMachine({
    paths,
    force: false,
    interactive: false,
    output: { write: () => undefined },
    host,
    browser: "chrome",
    browserExecutable: manualExecutable,
    identity: "person@example.com",
  }, { verifyManualBrowser, launchBrowser });
  const before = await readFile(paths.browser);

  await configureMachine({
    paths,
    force: false,
    interactive: false,
    output: { write: () => undefined },
    host,
    browser: "chrome",
  }, {
    discoverBrowsers: async () => { throw new Error("same-product setup must not rediscover"); },
    verifyManualBrowser,
    launchBrowser,
  });

  assert.deepEqual(await readFile(paths.browser), before);
  assert.equal(launched.at(-1)?.browserExecutable, manualExecutable);
});

test("existing Chrome and strict legacy Edge remain selected without silent migration", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-machine-existing-products-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const host = createStandardUserHost();
  for (const product of ["chrome", "edge"] as const) {
    const stateHome = path.join(root, product);
    await mkdir(stateHome, { mode: 0o700 });
    const paths = configurationPaths(stateHome, host);
    const selected = discoveredBrowser(product);
    const common = {
      discoverBrowsers: async () => [selected],
      verifyManualBrowser: async (verifiedProduct: BrowserProduct, executablePath: string) => ({
        ...discoveredBrowser(verifiedProduct, executablePath),
        source: "manual" as const,
      }),
      launchBrowser: async () => readyTransport([]),
      promptText: acceptPromptDefault,
    };
    await configureMachine({
      paths,
      force: false,
      interactive: false,
      output: { write: () => undefined },
      host,
      browser: product,
      identity: "person@example.com",
    }, common);
    if (product === "edge") {
      const current = JSON.parse(await readFile(paths.browser, "utf8")) as Record<string, unknown>;
      const executable = current.browser_executable;
      delete current.product;
      delete current.browser_contract_version;
      delete current.browser_executable;
      delete current.browser_version;
      delete current.browser_executable_sha256;
      current.schema_version = "cba-browser-config/1";
      current.edge_executable = executable;
      await writeFile(paths.browser, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    }
    const before = await readFile(paths.browser);
    let currentProduct: BrowserProduct | undefined;
    const result = await configureMachine({
      paths,
      force: false,
      interactive: true,
      output: { write: () => undefined },
      host,
    }, {
      ...common,
      promptBrowser: async (screen) => {
        assert.equal(screen.kind, "current");
        if (screen.kind !== "current") throw new Error("wrong screen");
        currentProduct = screen.browser.product;
        return { action: "continue", browser: screen.browser };
      },
    });
    assert.equal(result.browserProduct, product);
    assert.equal(currentProduct, product);
    assert.deepEqual(await readFile(paths.browser), before);
    const persisted = JSON.parse(before.toString("utf8")) as Record<string, unknown>;
    assert.equal(persisted.schema_version, product === "edge" ? "cba-browser-config/1" : "cba-browser-config/2");
  }
});

test("no-browser setup offers manual installation selection and never saves before readiness", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-machine-manual-browser-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const stateHome = path.join(root, "state");
  await mkdir(stateHome, { mode: 0o700 });
  const host = createStandardUserHost();
  const paths = configurationPaths(stateHome, host);
  const screens: string[] = [];
  let closed = false;
  await assert.rejects(configureMachine({
    paths,
    force: false,
    interactive: true,
    output: { write: () => undefined },
    host,
    identity: "person@example.com",
    entryUrl: "https://m365.cloud.microsoft/chat",
    requireProtectionIndicator: false,
  }, {
    discoverBrowsers: async () => [],
    promptBrowser: async (screen) => {
      screens.push(screen.kind);
      if (screen.kind === "none") return { action: "advanced" };
      if (screen.kind === "manual-product") return { action: "manual-product", product: "chrome" };
      throw new Error(`unexpected screen ${screen.kind}`);
    },
    promptText: async () => "/managed/Google Chrome",
    verifyManualBrowser: async (product, executablePath) => ({
      ...discoveredBrowser(product, executablePath),
      source: "manual",
    }),
    launchBrowser: async () => ({
      waitForManualReadiness: async () => ({ classification: { state: "signed-out" } }),
      close: async () => { closed = true; },
    } as unknown as EdgeCopilotTransport),
  }), (error: unknown) => error instanceof Error && /did not reach/iu.test(error.message));
  assert.deepEqual(screens, ["none", "manual-product"]);
  assert.equal(closed, true);
  await assert.rejects(readFile(paths.browser), { code: "ENOENT" });
  await assert.rejects(readFile(paths.organizationPolicy), { code: "ENOENT" });
});

test("corrupt policy and mismatched existing browser configuration fail with recovery actions", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-machine-corrupt-recovery-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const host = createStandardUserHost();
  const policyHome = path.join(root, "policy");
  await mkdir(path.join(policyHome, "config"), { recursive: true, mode: 0o700 });
  const policyPaths = configurationPaths(policyHome, host);
  await writeFile(policyPaths.organizationPolicy, "{not-json\n", "utf8");
  await assert.rejects(configureMachine({
    paths: policyPaths,
    force: true,
    interactive: false,
    output: { write: () => undefined },
    host,
    browser: "edge",
    identity: "person@example.com",
  }), (error: unknown) => error instanceof AgentError &&
    typeof error.details.next === "string" && /policy/iu.test(error.details.next));

  const browserHome = path.join(root, "browser");
  await mkdir(browserHome, { mode: 0o700 });
  const browserPaths = configurationPaths(browserHome, host);
  const edge = discoveredBrowser("edge");
  await configureMachine({
    paths: browserPaths,
    force: false,
    interactive: false,
    output: { write: () => undefined },
    host,
    browser: "edge",
    identity: "person@example.com",
  }, {
    discoverBrowsers: async () => [edge],
    verifyManualBrowser: async (product, executablePath) => ({ ...discoveredBrowser(product, executablePath), source: "manual" }),
    launchBrowser: async () => readyTransport([]),
  });
  await assert.rejects(configureMachine({
    paths: browserPaths,
    force: false,
    interactive: false,
    output: { write: () => undefined },
    host,
  }, {
    verifyManualBrowser: async () => {
      throw new AgentError("CONFIG_INVALID", "product mismatch", {
        diagnosticCode: "BROWSER_EXECUTABLE_PRODUCT_MISMATCH",
      });
    },
  }), (error: unknown) => error instanceof AgentError &&
    typeof error.details.next === "string" && /browser configuration/iu.test(error.details.next));
});

test("explicit browser replacement recovers from a broken configured executable", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-machine-browser-replacement-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const stateHome = path.join(root, "state");
  await mkdir(stateHome, { mode: 0o700 });
  const host = createStandardUserHost();
  const paths = configurationPaths(stateHome, host);
  const originalExecutable = "/verified/edge";
  const replacementExecutable = "/replacement/edge";
  const launchBrowser = async () => readyTransport([]);

  await configureMachine({
    paths,
    force: false,
    interactive: false,
    output: { write: () => undefined },
    host,
    browser: "edge",
    browserExecutable: originalExecutable,
    identity: "person@example.com",
  }, {
    verifyManualBrowser: async (product, executablePath) => ({
      ...discoveredBrowser(product, executablePath),
      source: "manual",
    }),
    launchBrowser,
  });
  const original = JSON.parse(await readFile(paths.browser, "utf8")) as Record<string, unknown>;

  await configureMachine({
    paths,
    force: true,
    interactive: false,
    output: { write: () => undefined },
    host,
    browser: "edge",
    browserExecutable: replacementExecutable,
  }, {
    verifyManualBrowser: async (product, executablePath) => {
      if (executablePath === originalExecutable) {
        throw new AgentError("CONFIG_INVALID", "configured executable is no longer valid", {
          diagnosticCode: "BROWSER_EXECUTABLE_PRODUCT_MISMATCH",
        });
      }
      return {
        ...discoveredBrowser(product, executablePath),
        source: "manual",
      };
    },
    launchBrowser,
  });

  const replaced = JSON.parse(await readFile(paths.browser, "utf8")) as Record<string, unknown>;
  assert.equal(replaced.browser_executable, replacementExecutable);
  assert.equal(replaced.profile_directory, original.profile_directory);
  assert.equal(replaced.expected_identity, original.expected_identity);
  assert.deepEqual(replaced.approved_hosts, original.approved_hosts);
});

test("Ctrl+C during manual browser readiness cancels cleanly before persistence", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-machine-readiness-cancel-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const stateHome = path.join(root, "state");
  await mkdir(stateHome, { mode: 0o700 });
  const host = createStandardUserHost();
  const paths = configurationPaths(stateHome, host);
  const chrome = discoveredBrowser("chrome");
  const priorSigintListeners = process.listenerCount("SIGINT");
  let closed = false;
  await assert.rejects(configureMachine({
    paths,
    force: false,
    interactive: false,
    output: { write: () => undefined },
    host,
    browser: "chrome",
    identity: "person@example.com",
  }, {
    discoverBrowsers: async () => [chrome],
    verifyManualBrowser: async (product, executablePath) => ({ ...discoveredBrowser(product, executablePath), source: "manual" }),
    launchBrowser: async () => ({
      waitForManualReadiness: async (_maxWaitMs?: number, signal?: AbortSignal) => {
        process.emit("SIGINT", "SIGINT");
        assert.equal(signal?.aborted, true);
        return { classification: { state: "signed-out" } };
      },
      close: async () => { closed = true; },
    } as unknown as EdgeCopilotTransport),
  }), PromptCancelledError);
  assert.equal(closed, true);
  assert.equal(process.listenerCount("SIGINT"), priorSigintListeners);
  await assert.rejects(readFile(paths.browser), { code: "ENOENT" });
  await assert.rejects(readFile(paths.organizationPolicy), { code: "ENOENT" });
});
