import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  CURRENT_HOST_PLATFORM,
  runHostProbe,
  type HostPlatform,
  type ProbeResult,
  type ProbeRunner,
} from "../platform/index.js";
import { AgentError } from "../shared/errors.js";
import { BROWSER_PRODUCTS, browserProductPresentation, type BrowserProduct } from "./product.js";

export interface BrowserIdentityEvidence {
  readonly platform: "darwin" | "win32";
  readonly productName: string;
  readonly publisher: string;
  readonly identifier: string;
  readonly signatureStatus: "valid";
}

export interface VerifiedBrowserExecutable {
  readonly product: BrowserProduct;
  readonly executablePath: string;
  readonly version: string;
  readonly executableSha256: string;
  readonly size: number;
  readonly modifiedMs: number;
  readonly evidence: BrowserIdentityEvidence;
}

export interface DiscoveredBrowser extends VerifiedBrowserExecutable {
  readonly source: "automatic" | "manual";
  readonly locationLabel: string;
}

export type BrowserIdentityVerifier = (
  product: BrowserProduct,
  executablePath: string,
) => Promise<VerifiedBrowserExecutable>;

/**
 * A verified, vendor-signed browser may replace itself with a newer release.
 * Same-version byte changes and version downgrades remain fail-closed.
 */
export function isCompatibleBrowserExecutableUpgrade(
  configuredVersion: string | undefined,
  configuredExecutableSha256: string | undefined,
  verifiedVersion: string,
  verifiedExecutableSha256: string,
): boolean {
  if (configuredVersion === undefined || configuredExecutableSha256 === undefined) return true;
  const comparison = compareBrowserVersions(verifiedVersion, configuredVersion);
  return comparison > 0 || comparison === 0 &&
    verifiedExecutableSha256 === configuredExecutableSha256;
}

export interface BrowserDiscoveryOptions {
  readonly host?: HostPlatform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runProbe?: ProbeRunner;
  readonly identityVerifier?: BrowserIdentityVerifier;
}

const MAC_IDENTITIES = Object.freeze({
  edge: {
    executable: "Microsoft Edge",
    bundleIdentifier: "com.microsoft.edgemac",
    teamIdentifier: "UBF8T346G9",
    authority: /Microsoft Corporation/iu,
  },
  chrome: {
    executable: "Google Chrome",
    bundleIdentifier: "com.google.Chrome",
    teamIdentifier: "EQHXZ8M8AV",
    authority: /Google LLC/iu,
  },
} satisfies Readonly<Record<BrowserProduct, {
  readonly executable: string;
  readonly bundleIdentifier: string;
  readonly teamIdentifier: string;
  readonly authority: RegExp;
}>>);

const WINDOWS_IDENTITIES = Object.freeze({
  edge: {
    executable: "msedge.exe",
    stableInstallSuffix: "\\microsoft\\edge\\application\\msedge.exe",
    product: /^Microsoft Edge$/iu,
    company: /^Microsoft Corporation$/iu,
    publisher: /CN=Microsoft Corporation(?:,|$)/iu,
  },
  chrome: {
    executable: "chrome.exe",
    stableInstallSuffix: "\\google\\chrome\\application\\chrome.exe",
    product: /^Google Chrome$/iu,
    company: /^Google LLC$/iu,
    publisher: /CN=Google LLC(?:,|$)/iu,
  },
} satisfies Readonly<Record<BrowserProduct, {
  readonly executable: string;
  readonly stableInstallSuffix: string;
  readonly product: RegExp;
  readonly company: RegExp;
  readonly publisher: RegExp;
}>>);

const WINDOWS_SYSTEM_DIRECTORY = "C:\\Windows\\System32";
const WINDOWS_POWERSHELL_EXECUTABLE =
  `${WINDOWS_SYSTEM_DIRECTORY}\\WindowsPowerShell\\v1.0\\powershell.exe`;
const WINDOWS_BROWSER_IDENTITY_PATH_VARIABLE = "COPE_BROWSER_IDENTITY_PATH";

export async function discoverInstalledBrowsers(
  options: BrowserDiscoveryOptions = {},
): Promise<readonly DiscoveredBrowser[]> {
  const host = options.host ?? CURRENT_HOST_PLATFORM;
  const environment = options.environment ?? process.env;
  const verifier = options.identityVerifier ?? ((product, executablePath) =>
    verifyBrowserExecutable(product, executablePath, {
      host,
      ...(options.runProbe === undefined ? {} : { runProbe: options.runProbe }),
    }));
  const discovered: DiscoveredBrowser[] = [];
  const seen = new Set<string>();
  for (const product of BROWSER_PRODUCTS) {
    for (const candidate of host.browserExecutableCandidates(product, environment)) {
      try {
        const identity = await verifier(product, candidate);
        const key = `${identity.product}\0${identity.executablePath}`;
        if (seen.has(key)) break;
        seen.add(key);
        discovered.push({
          ...identity,
          source: "automatic",
          locationLabel: browserLocationLabel(identity.executablePath, host),
        });
        break;
      } catch {
        // Discovery treats an inaccessible or mismatched bounded candidate as
        // absent. Explicit/manual selection returns the concrete failure.
      }
    }
  }
  return discovered;
}

export async function verifyManualBrowserExecutable(
  product: BrowserProduct,
  executablePath: string,
  options: BrowserDiscoveryOptions = {},
): Promise<DiscoveredBrowser> {
  const host = options.host ?? CURRENT_HOST_PLATFORM;
  const verifier = options.identityVerifier ?? ((selectedProduct, selectedPath) =>
    verifyBrowserExecutable(selectedProduct, selectedPath, {
      host,
      ...(options.runProbe === undefined ? {} : { runProbe: options.runProbe }),
    }));
  const identity = await verifier(product, executablePath);
  return {
    ...identity,
    source: "manual",
    locationLabel: browserLocationLabel(identity.executablePath, host),
  };
}

export async function verifyBrowserExecutable(
  product: BrowserProduct,
  executablePath: string,
  options: { readonly host?: HostPlatform; readonly runProbe?: ProbeRunner } = {},
): Promise<VerifiedBrowserExecutable> {
  const host = options.host ?? CURRENT_HOST_PLATFORM;
  if (host.platform !== "darwin" && host.platform !== "win32") {
    throw identityError(product, "Browser identity verification is unavailable on this host", {
      diagnosticCode: "BROWSER_IDENTITY_HOST_UNSUPPORTED",
      platform: host.platform,
    });
  }
  if (!path.isAbsolute(executablePath) || executablePath.includes("\0")) {
    throw identityError(product, "The selected browser executable path must be absolute", {
      diagnosticCode: "BROWSER_EXECUTABLE_PATH_INVALID",
    });
  }
  await access(executablePath, constants.R_OK | constants.X_OK).catch((error: unknown) => {
    throw identityError(product, "The selected browser executable is missing or inaccessible", {
      diagnosticCode: "BROWSER_EXECUTABLE_UNAVAILABLE",
    }, error);
  });
  const lexical = await lstat(executablePath);
  if (!lexical.isFile() || lexical.isSymbolicLink()) {
    throw identityError(product, "The selected browser executable must be a regular non-link file", {
      diagnosticCode: "BROWSER_EXECUTABLE_PATH_UNSAFE",
    });
  }
  const canonical = await realpath(executablePath);
  const before = await stat(canonical);
  const probe = options.runProbe ?? runHostProbe;
  const evidence = host.platform === "darwin"
    ? await verifyDarwinIdentity(product, canonical, host, probe)
    : await verifyWindowsIdentity(product, canonical, host, probe);
  const executableSha256 = await sha256File(canonical);
  const after = await stat(canonical);
  if (
    before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw identityError(product, "The selected browser executable changed during verification", {
      diagnosticCode: "BROWSER_EXECUTABLE_CHANGED_DURING_VERIFICATION",
    });
  }
  return {
    product,
    executablePath: canonical,
    version: evidence.version,
    executableSha256,
    size: after.size,
    modifiedMs: after.mtimeMs,
    evidence: evidence.identity,
  };
}

async function verifyDarwinIdentity(
  product: BrowserProduct,
  executablePath: string,
  host: HostPlatform,
  probe: ProbeRunner,
): Promise<{ readonly version: string; readonly identity: BrowserIdentityEvidence }> {
  const expected = MAC_IDENTITIES[product];
  const suffix = `${path.sep}Contents${path.sep}MacOS${path.sep}${expected.executable}`;
  if (!executablePath.endsWith(suffix)) {
    throw identityError(product, "The selected executable is not the expected stable macOS application", {
      diagnosticCode: "BROWSER_EXECUTABLE_PRODUCT_MISMATCH",
    });
  }
  const appRoot = executablePath.slice(0, -suffix.length);
  if (!appRoot.endsWith(".app")) {
    throw identityError(product, "The selected browser executable is not inside an application bundle", {
      diagnosticCode: "BROWSER_EXECUTABLE_PRODUCT_MISMATCH",
    });
  }
  const environment = host.probeEnvironment(process.env);
  const infoPlist = path.join(appRoot, "Contents", "Info.plist");
  const [identifier, version, signature, details] = await Promise.all([
    probe("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", infoPlist], appRoot, environment, false),
    probe("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", infoPlist], appRoot, environment, false),
    probe("/usr/bin/codesign", ["--verify", "--verbose=1", appRoot], appRoot, environment, false),
    probe("/usr/bin/codesign", ["-dv", "--verbose=4", appRoot], appRoot, environment, false),
  ]);
  const signatureText = `${details.stdout}\n${details.stderr}`;
  const observedIdentifier = identifier.stdout.trim();
  const observedVersion = version.stdout.trim();
  const team = /^TeamIdentifier=(.+)$/mu.exec(signatureText)?.[1]?.trim();
  const signedIdentifier = /^Identifier=(.+)$/mu.exec(signatureText)?.[1]?.trim();
  if (
    identifier.exitCode !== 0 || version.exitCode !== 0 || signature.exitCode !== 0 || details.exitCode !== 0 ||
    observedIdentifier !== expected.bundleIdentifier || signedIdentifier !== expected.bundleIdentifier ||
    team !== expected.teamIdentifier || !expected.authority.test(signatureText) || !validVersion(observedVersion)
  ) {
    throw identityError(product, "The selected application identity does not match the requested browser product", {
      diagnosticCode: "BROWSER_EXECUTABLE_PRODUCT_MISMATCH",
    });
  }
  return {
    version: observedVersion,
    identity: {
      platform: "darwin",
      productName: browserProductPresentation(product).productName,
      publisher: team,
      identifier: observedIdentifier,
      signatureStatus: "valid",
    },
  };
}

export async function verifyWindowsIdentity(
  product: BrowserProduct,
  executablePath: string,
  host: HostPlatform,
  probe: ProbeRunner,
): Promise<{ readonly version: string; readonly identity: BrowserIdentityEvidence }> {
  const expected = WINDOWS_IDENTITIES[product];
  if (path.win32.basename(executablePath).toLowerCase() !== expected.executable) {
    throw identityError(product, "The selected executable name does not match the requested browser product", {
      diagnosticCode: "BROWSER_EXECUTABLE_PRODUCT_MISMATCH",
    });
  }
  const environment = host.probeEnvironment(process.env);
  const rootsScript = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "[Console]::Out.WriteLine([System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ProgramFilesX86))",
    "[Console]::Out.WriteLine([System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ProgramFiles))",
    "[Console]::Out.WriteLine([System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::LocalApplicationData))",
  ].join("; ");
  const rootsResult = await probe(
    WINDOWS_POWERSHELL_EXECUTABLE,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", rootsScript],
    WINDOWS_SYSTEM_DIRECTORY,
    environment,
    true,
  );
  const stableRoots = parseWindowsStableBrowserRoots(product, rootsResult);
  if (!isApprovedWindowsStableBrowserPath(product, executablePath, stableRoots)) {
    throw identityError(product, "The selected executable is not in the expected stable browser installation layout", {
      diagnosticCode: "BROWSER_EXECUTABLE_CHANNEL_UNVERIFIED",
    });
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    `$p=[System.Environment]::GetEnvironmentVariable('${WINDOWS_BROWSER_IDENTITY_PATH_VARIABLE}', 'Process')`,
    "if ([string]::IsNullOrWhiteSpace($p)) { throw 'Browser identity path is unavailable' }",
    "$v=[System.Diagnostics.FileVersionInfo]::GetVersionInfo($p)",
    "$s=Get-AuthenticodeSignature -LiteralPath $p",
    "[Console]::Out.WriteLine($v.ProductName)",
    "[Console]::Out.WriteLine($v.CompanyName)",
    "[Console]::Out.WriteLine($v.OriginalFilename)",
    "[Console]::Out.WriteLine($v.ProductVersion)",
    "[Console]::Out.WriteLine([string]$s.Status)",
    "[Console]::Out.WriteLine([string]$s.SignerCertificate.Subject)",
  ].join("; ");
  const result = await probe(
    WINDOWS_POWERSHELL_EXECUTABLE,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    WINDOWS_SYSTEM_DIRECTORY,
    { ...environment, [WINDOWS_BROWSER_IDENTITY_PATH_VARIABLE]: executablePath },
    true,
  );
  return parseWindowsBrowserIdentityEvidence(product, result);
}

/**
 * Windows version resources and publisher signatures identify the vendor and
 * product, but Chrome/Edge prerelease channels may use the same values. Bind
 * that evidence to the vendor's distinct Stable installation directory and
 * fail closed for Beta, Dev, Canary/SxS, portable, UNC, or device paths.
 */
export function isApprovedWindowsStableBrowserPath(
  product: BrowserProduct,
  executablePath: string,
  trustedRoots: readonly string[],
): boolean {
  const suffix = WINDOWS_IDENTITIES[product].stableInstallSuffix;
  const approved = new Set(trustedRoots.map((root) =>
    path.win32.normalize(`${root}${suffix}`).toLowerCase()));
  return approved.has(path.win32.normalize(executablePath).toLowerCase());
}

export function parseWindowsStableBrowserRoots(
  product: BrowserProduct,
  result: ProbeResult,
): readonly string[] {
  const roots = [...new Set(result.stdout.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0))];
  if (
    result.exitCode !== 0 || roots.length < 2 || roots.length > 3 ||
    roots.some((root) => !/^[a-z]:[\\/]/iu.test(root))
  ) {
    throw identityError(product, "Windows did not return trusted browser installation roots", {
      diagnosticCode: "BROWSER_EXECUTABLE_CHANNEL_UNVERIFIED",
    });
  }
  return roots;
}

export function parseWindowsBrowserIdentityEvidence(
  product: BrowserProduct,
  result: ProbeResult,
): { readonly version: string; readonly identity: BrowserIdentityEvidence } {
  const expected = WINDOWS_IDENTITIES[product];
  const lines = result.stdout.split(/\r?\n/u).map((line) => line.trim());
  const [productName = "", company = "", originalFilename = "", version = "", status = "", publisher = ""] = lines;
  if (
    result.exitCode !== 0 || !expected.product.test(productName) || !expected.company.test(company) ||
    originalFilename.toLowerCase() !== expected.executable || !validVersion(version) || status !== "Valid" ||
    !expected.publisher.test(publisher)
  ) {
    throw identityError(product, "The selected executable identity does not match the requested browser product", {
      diagnosticCode: "BROWSER_EXECUTABLE_PRODUCT_MISMATCH",
    });
  }
  return {
    version,
    identity: {
      platform: "win32",
      productName,
      publisher,
      identifier: originalFilename,
      signatureStatus: "valid",
    },
  };
}

function validVersion(value: string): boolean {
  return /^\d+(?:\.\d+){1,3}$/u.test(value);
}

function compareBrowserVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

async function sha256File(filename: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filename);
    stream.once("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

function browserLocationLabel(executablePath: string, host: HostPlatform): string {
  if (host.platform === "darwin" && executablePath.includes(`${path.sep}Applications${path.sep}`)) {
    return "Found in Applications";
  }
  if (host.platform === "win32") return "Found in Windows applications";
  return "Verified installation";
}

function identityError(
  product: BrowserProduct,
  message: string,
  details: Readonly<Record<string, unknown>>,
  cause?: unknown,
): AgentError {
  return new AgentError("CONFIG_INVALID", message, {
    product,
    ...details,
  }, cause === undefined ? undefined : { cause });
}
