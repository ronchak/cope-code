import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverInstalledBrowsers,
  BrowserCopilotTransport,
  isApprovedWindowsStableBrowserPath,
  parseWindowsStableBrowserRoots,
  parseWindowsBrowserIdentityEvidence,
  EdgeCopilotTransport,
  createBaselineCopilotUiContract,
  verifyManualBrowserExecutable,
  verifyBrowserExecutable,
  verifyWindowsIdentity,
  type BrowserIdentityVerifier,
  type VerifiedBrowserExecutable,
} from "../../src/browser/index.js";
import { parseBrowserConfig } from "../../src/config/loader.js";
import { DarwinHostPlatform, WindowsHostPlatform, type ProbeRunner } from "../../src/platform/index.js";
import { AgentError } from "../../src/shared/errors.js";

const digest = "a".repeat(64);

function verified(product: "edge" | "chrome", executablePath: string): VerifiedBrowserExecutable {
  return {
    product,
    executablePath,
    version: "149.0.1.2",
    executableSha256: digest,
    size: 42,
    modifiedMs: 1,
    evidence: {
      platform: "darwin",
      productName: product === "edge" ? "Microsoft Edge Stable" : "Google Chrome Stable",
      publisher: product === "edge" ? "UBF8T346G9" : "EQHXZ8M8AV",
      identifier: product === "edge" ? "com.microsoft.edgemac" : "com.google.Chrome",
      signatureStatus: "valid",
    },
  };
}

test("browser discovery deterministically reports Edge only, Chrome only, both, and neither", async () => {
  const base = new DarwinHostPlatform("arm64", () => 501);
  for (const [available, expected] of [
    [new Set(["edge"]), ["edge"]],
    [new Set(["chrome"]), ["chrome"]],
    [new Set(["edge", "chrome"]), ["edge", "chrome"]],
    [new Set(), []],
  ] as const) {
    const verifier: BrowserIdentityVerifier = async (product, executablePath) => {
      if (!available.has(product)) throw new AgentError("CONFIG_INVALID", "not installed");
      return verified(product, executablePath);
    };
    const discovered = await discoverInstalledBrowsers({
      host: base,
      environment: { HOME: "/Users/tester" },
      identityVerifier: verifier,
    });
    assert.deepEqual(discovered.map((browser) => browser.product), expected);
  }
});

test("automatic discovery does not accept a product mismatch or Chromium derivative", async () => {
  const host = new Proxy(new DarwinHostPlatform("arm64", () => 501), {
    get(target, property, receiver) {
      if (property === "browserExecutableCandidates") {
        return (product: "edge" | "chrome") => product === "chrome"
          ? ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"]
          : [];
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const discovered = await discoverInstalledBrowsers({
    host,
    identityVerifier: async () => {
      throw new AgentError("CONFIG_INVALID", "product mismatch", {
        diagnosticCode: "BROWSER_EXECUTABLE_PRODUCT_MISMATCH",
      });
    },
  });
  assert.deepEqual(discovered, []);
});

test("manual browser selection verifies identity and missing executables fail closed", async () => {
  const selected = await verifyManualBrowserExecutable(
    "chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    { identityVerifier: async (product, executablePath) => verified(product, executablePath) },
  );
  assert.equal(selected.source, "manual");
  assert.equal(selected.product, "chrome");
  await assert.rejects(
    verifyManualBrowserExecutable("chrome", "/definitely/missing/Google Chrome"),
    (error: unknown) =>
      error instanceof AgentError && error.details.diagnosticCode === "BROWSER_EXECUTABLE_UNAVAILABLE",
  );
});

test("macOS identity verification binds exact bundle, team, signature, version, and bytes", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-browser-identity-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const app = path.join(root, "Google Chrome.app");
  const executable = path.join(app, "Contents", "MacOS", "Google Chrome");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "verified chrome bytes\n", "utf8");
  await chmod(executable, 0o700);
  await writeFile(path.join(app, "Contents", "Info.plist"), "fixture", "utf8");
  const host = new DarwinHostPlatform("arm64", () => 501);
  const identity = await verifyBrowserExecutable("chrome", executable, {
    host,
    runProbe: async (command, args) => {
      if (command.endsWith("PlistBuddy")) {
        return args[1]?.includes("CFBundleIdentifier")
          ? { exitCode: 0, stdout: "com.google.Chrome\n", stderr: "" }
          : { exitCode: 0, stdout: "149.0.1.2\n", stderr: "" };
      }
      if (args.includes("--verify")) return { exitCode: 0, stdout: "", stderr: "valid on disk" };
      return {
        exitCode: 0,
        stdout: "",
        stderr: "Identifier=com.google.Chrome\nTeamIdentifier=EQHXZ8M8AV\nAuthority=Developer ID Application: Google LLC (EQHXZ8M8AV)\n",
      };
    },
  });
  assert.equal(identity.product, "chrome");
  assert.equal(identity.version, "149.0.1.2");
  assert.match(identity.executableSha256, /^[a-f0-9]{64}$/u);
  assert.equal(identity.evidence.identifier, "com.google.Chrome");

  await assert.rejects(
    verifyBrowserExecutable("edge", executable, { host, runProbe: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }),
    (error: unknown) =>
      error instanceof AgentError && error.details.diagnosticCode === "BROWSER_EXECUTABLE_PRODUCT_MISMATCH",
  );
});

test("production macOS verification rejects an unsupported Chromium derivative before metadata probes", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-browser-derivative-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "Brave Browser.app", "Contents", "MacOS", "Brave Browser");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "brave fixture\n", "utf8");
  await chmod(executable, 0o700);
  let probes = 0;
  await assert.rejects(
    verifyBrowserExecutable("chrome", executable, {
      host: new DarwinHostPlatform("arm64", () => 501),
      runProbe: async () => { probes += 1; return { exitCode: 0, stdout: "", stderr: "" }; },
    }),
    (error: unknown) =>
      error instanceof AgentError && error.details.diagnosticCode === "BROWSER_EXECUTABLE_PRODUCT_MISMATCH",
  );
  assert.equal(probes, 0);
});

test("production Windows metadata parser requires exact product, company, filename, version, and signer", () => {
  const valid = parseWindowsBrowserIdentityEvidence("chrome", {
    exitCode: 0,
    stdout: [
      "Google Chrome",
      "Google LLC",
      "chrome.exe",
      "149.0.1.2",
      "Valid",
      "CN=Google LLC, O=Google LLC, L=Mountain View, S=California, C=US",
    ].join("\r\n"),
    stderr: "",
  });
  assert.equal(valid.version, "149.0.1.2");
  assert.equal(valid.identity.signatureStatus, "valid");
  assert.throws(() => parseWindowsBrowserIdentityEvidence("chrome", {
    exitCode: 0,
    stdout: ["Chromium", "The Chromium Authors", "chrome.exe", "149.0.1.2", "Valid", "CN=Unknown"].join("\r\n"),
    stderr: "",
  }), (error: unknown) =>
    error instanceof AgentError && error.details.diagnosticCode === "BROWSER_EXECUTABLE_PRODUCT_MISMATCH");
});

test("Windows Stable identity requires the vendor Stable installation layout", () => {
  const trustedRoots = [
    "C:\\Program Files (x86)",
    "C:\\Program Files",
    "C:\\Users\\user\\AppData\\Local",
  ];
  assert.equal(isApprovedWindowsStableBrowserPath(
    "edge",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    trustedRoots,
  ), true);
  assert.equal(isApprovedWindowsStableBrowserPath(
    "chrome",
    "C:\\Users\\user\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    trustedRoots,
  ), true);
  for (const [product, executable] of [
    ["edge", "C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe"],
    ["edge", "C:\\Program Files (x86)\\Microsoft\\Edge Dev\\Application\\msedge.exe"],
    ["chrome", "C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe"],
    ["chrome", "C:\\Users\\user\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe"],
    ["chrome", "C:\\portable\\chrome.exe"],
    ["chrome", "C:\\portable\\Google\\Chrome\\Application\\chrome.exe"],
    ["chrome", "D:\\Apps\\Google\\Chrome\\Application\\chrome.exe"],
    ["chrome", "\\\\server\\share\\Google\\Chrome\\Application\\chrome.exe"],
  ] as const) {
    assert.equal(isApprovedWindowsStableBrowserPath(product, executable, trustedRoots), false, executable);
  }
  assert.equal(isApprovedWindowsStableBrowserPath(
    "chrome",
    "D:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ["D:\\Program Files", "C:\\Users\\user\\AppData\\Local"],
  ), true);
  assert.equal(isApprovedWindowsStableBrowserPath(
    "chrome",
    "C:\\portable\\Google\\Chrome\\Application\\chrome.exe",
    ["C:\\Program Files", "C:\\Users\\user\\AppData\\Local"],
  ), false);
});

test("Windows Stable roots require bounded absolute OS folder results", () => {
  assert.deepEqual(parseWindowsStableBrowserRoots("edge", {
    exitCode: 0,
    stdout: [
      "C:\\Program Files (x86)",
      "D:\\Program Files",
      "C:\\Users\\user\\AppData\\Local",
    ].join("\r\n"),
    stderr: "",
  }), ["C:\\Program Files (x86)", "D:\\Program Files", "C:\\Users\\user\\AppData\\Local"]);
  for (const stdout of [
    "C:\\portable",
    "C:\\Program Files\r\n\\\\server\\share",
    "C:\\Program Files\r\nrelative\\AppData",
  ]) {
    assert.throws(() => parseWindowsStableBrowserRoots("edge", {
      exitCode: 0,
      stdout,
      stderr: "",
    }), (error: unknown) => error instanceof AgentError &&
      error.details.diagnosticCode === "BROWSER_EXECUTABLE_CHANNEL_UNVERIFIED");
  }
});

test("Windows identity probes use an absolute system PowerShell outside poisoned search paths", async () => {
  class PoisonedWindowsHost extends WindowsHostPlatform {
    public override probeEnvironment(): NodeJS.ProcessEnv {
      return { PATH: "C:\\portable", Path: "C:\\portable" };
    }
  }
  const probes: Array<{
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
  }> = [];
  const runProbe: ProbeRunner = async (executable, args, cwd, environment) => {
    probes.push({ executable, args, cwd, environment });
    return probes.length === 1 ? {
      exitCode: 0,
      stdout: [
        "C:\\Program Files (x86)",
        "D:\\Program Files",
        "C:\\Users\\josé\\AppData\\Local",
      ].join("\r\n"),
      stderr: "",
    } : {
      exitCode: 0,
      stdout: [
        "Google Chrome",
        "Google LLC",
        "chrome.exe",
        "149.0.1.2",
        "Valid",
        "CN=Google LLC, O=Google LLC, C=US",
      ].join("\r\n"),
      stderr: "",
    };
  };

  const result = await verifyWindowsIdentity(
    "chrome",
    "D:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    new PoisonedWindowsHost(),
    runProbe,
  );
  assert.equal(result.version, "149.0.1.2");
  assert.equal(probes.length, 2);
  for (const observed of probes) {
    assert.equal(observed.executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.equal(observed.cwd, "C:\\Windows\\System32");
    assert.equal(observed.environment.Path, "C:\\portable");
    assert.match(observed.args.join(" "), /OutputEncoding/iu);
  }
});

test("browser config v1 maps strictly to Edge while v2 records explicit product evidence", () => {
  const shared = {
    entry_url: "https://m365.cloud.microsoft/chat",
    approved_hosts: [{ hostname: "m365.cloud.microsoft", allow_subdomains: false }],
    expected_identity: "user@example.invalid",
    require_protection_indicator: false,
    profile_directory: "/private/cope-browser-profile",
  } as const;
  const legacy = parseBrowserConfig({
    schema_version: "cba-browser-config/1",
    ...shared,
    edge_executable: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  });
  assert.equal(legacy.config.product, "edge");
  assert.equal(legacy.config.browserVersion, undefined);

  const current = parseBrowserConfig({
    schema_version: "cba-browser-config/2",
    ...shared,
    product: "chrome",
    browser_contract_version: "cope-visible-browser/v1",
    browser_executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    browser_version: "149.0.1.2",
    browser_executable_sha256: digest,
  });
  assert.equal(current.config.product, "chrome");
  assert.equal(current.config.browserExecutableSha256, digest);
  assert.throws(() => parseBrowserConfig({
    ...current.file,
    edge_executable: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  }), /unknown fields/u);
});

test("the live launcher cannot bypass executable verification through a Playwright channel", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-browser-launch-verification-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "Microsoft Edge");
  await writeFile(executable, "edge fixture\n", "utf8");
  await chmod(executable, 0o700);
  let launchCalls = 0;
  await assert.rejects(EdgeCopilotTransport.launch({
    product: "edge",
    browserContractVersion: "cope-visible-browser/v1",
    browserExecutable: executable,
    profileDirectory: path.join(root, "profile"),
    entryUrl: "https://m365.cloud.microsoft/chat",
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    uiContract: createBaselineCopilotUiContract("user@example.invalid"),
    expectedIdentity: "user@example.invalid",
    requireProtectionIndicator: false,
    maxMessageChars: 10_000,
    maxResponseChars: 10_000,
    waits: {
      actionMs: 100,
      submissionConfirmationMs: 100,
      responseMs: 100,
      manualReadinessMs: 100,
      pollMs: 10,
      stableSamples: 2,
      minimumStableMs: 10,
    },
  }, {
    browserIdentityVerifier: async () => {
      throw new AgentError("CONFIG_INVALID", "identity refused", {
        diagnosticCode: "BROWSER_EXECUTABLE_PRODUCT_MISMATCH",
      });
    },
    launchPersistentContext: async () => {
      launchCalls += 1;
      throw new Error("must not launch");
    },
  }), /identity refused/u);
  assert.equal(launchCalls, 0);
});

test("Chrome launch uses exactly the verified executable and Chrome-dedicated persistent profile", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-chrome-launch-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "Google Chrome");
  const profile = path.join(root, "chrome-profile");
  await writeFile(executable, "chrome fixture\n", "utf8");
  await chmod(executable, 0o700);
  const observed: Array<{ profile: string; options: Record<string, unknown> }> = [];
  const page = {
    url: () => "https://m365.cloud.microsoft/chat",
    on: () => page,
    setDefaultTimeout: () => undefined,
    setDefaultNavigationTimeout: () => undefined,
  };
  const browserContext = {
    pages: () => [page],
    close: async () => undefined,
  };
  const transport = await BrowserCopilotTransport.launch({
    product: "chrome",
    browserContractVersion: "cope-visible-browser/v1",
    browserExecutable: executable,
    browserVersion: "149.0.1.2",
    browserExecutableSha256: digest,
    profileDirectory: profile,
    entryUrl: "https://m365.cloud.microsoft/chat",
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    uiContract: createBaselineCopilotUiContract("user@example.invalid"),
    expectedIdentity: "user@example.invalid",
    requireProtectionIndicator: false,
    maxMessageChars: 10_000,
    maxResponseChars: 10_000,
    waits: {
      actionMs: 100,
      submissionConfirmationMs: 100,
      responseMs: 100,
      manualReadinessMs: 100,
      pollMs: 10,
      stableSamples: 2,
      minimumStableMs: 10,
    },
  }, {
    browserIdentityVerifier: async (product, executablePath) => verified(product, await realpath(executablePath)),
    launchPersistentContext: async (userDataDirectory, options) => {
      observed.push({ profile: userDataDirectory, options: options as Record<string, unknown> });
      return browserContext as never;
    },
  });
  try {
    assert.equal(observed.length, 1);
    assert.equal(observed[0]?.profile, await realpath(profile));
    assert.equal(observed[0]?.options.executablePath, await realpath(executable));
    assert.equal(observed[0]?.options.headless, false);
    assert.equal(observed[0]?.options.acceptDownloads, false);
    assert.equal("channel" in (observed[0]?.options ?? {}), false);
  } finally {
    await transport.close();
  }
});
