import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { parseBrowserConfig, parseRepositoryConfig } from "../config/loader.js";
import { RepositoryBoundary } from "../repository/index.js";
import { errorMessage } from "../shared/errors.js";
import type { CliCommand } from "./arguments.js";
import {
  probeNpmVersion,
  runDoctorProbe,
  type DoctorProbeDependencies,
} from "./doctor-probe.js";
import { configurationPaths, inspectMachineConfiguration } from "./onboarding.js";
import { hint, keyValue, section, success, warning, type Writable } from "./presentation.js";
import {
  resolveDefaultGitExecutable,
  runHostProbe,
  type HostPlatform,
} from "../platform/index.js";
import { verifyDedicatedProfileRoot, verifyPrivateStateHome } from "../platform/private-storage.js";
import {
  browserProductPresentation,
  otherDedicatedBrowserProfileRoots,
  resolveSafeBrowserProfileDirectory,
  verifyDedicatedProfileMarker,
  verifyManualBrowserExecutable,
  type BrowserIdentityVerifier,
} from "../browser/index.js";

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly summary?: string;
  readonly evidence?: unknown;
  readonly required: boolean;
}

export interface DoctorDependencies extends DoctorProbeDependencies {
  readonly browserIdentityVerifier?: BrowserIdentityVerifier;
}

export async function executeDoctorCommand(
  command: Extract<CliCommand, { readonly command: "doctor" }>,
  io: { readonly stdout: Writable; readonly stderr: Writable },
  host: HostPlatform,
  dependencies: DoctorDependencies = {},
): Promise<number> {
  const checks: Check[] = [];
  const probeRunner = dependencies.runProbe ?? runHostProbe;
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const nodeOk = nodeMajor >= 24;
  checks.push({
    name: "Node.js",
    ok: nodeOk,
    detail: runtimeFloorDetail("Node.js", `v${process.versions.node}`, 24, nodeOk),
    required: true,
  });

  const npm = await probeNpmVersion(host, process.cwd(), dependencies);
  const npmMajor = Number.parseInt(npm.stdout.trim().split(".")[0] ?? "0", 10);
  const npmOk = npm.exitCode === 0 && Number.isSafeInteger(npmMajor) && npmMajor >= 11;
  checks.push({
    name: "npm",
    ok: npmOk,
    detail: runtimeFloorDetail(
      "npm",
      npm.exitCode === 0 ? `v${npm.stdout.trim()}` : npm.stderr.trim() || npm.npmCli || "npm unavailable",
      11,
      npmOk,
    ),
    required: true,
  });

  try {
    if (host.liveBrowserSupported) {
      await host.verifyEligibility({ liveBrowser: true, cwd: process.cwd(), runProbe: probeRunner });
    } else {
      host.assertNonPrivileged();
    }
    checks.push({
      name: "Host session",
      ok: true,
      detail: host.liveBrowserSupported
        ? `${host.platform}/${host.architecture}; standard user and GUI verified`
        : `${host.platform}/${host.architecture}; standard user verified; live browser unsupported`,
      required: true,
    });
  } catch (error) {
    const remediation = host.platform === "darwin"
      ? " Log in to Aqua as the intended console user and run Cope without sudo."
      : "";
    checks.push({ name: "Host session", ok: false, detail: `${errorMessage(error)}${remediation}`, required: true });
  }

  const gitExecutable = resolveDefaultGitExecutable(host);
  const git = await runDoctorProbe(probeRunner, gitExecutable, ["--version"], process.cwd(), host);
  checks.push({
    name: "Git",
    ok: git.exitCode === 0 && /^git version /u.test(git.stdout),
    detail: git.exitCode === 0 ? git.stdout.trim() : git.stderr.trim() || gitExecutable,
    required: true,
  });

  const paths = configurationPaths(command.stateHome, host);
  try {
    await verifyPrivateStateHome(paths.stateHome, host);
    checks.push({ name: "State privacy", ok: true, detail: `${paths.stateHome} (private ownership and modes verified)`, required: true });
  } catch (error) {
    checks.push({ name: "State privacy", ok: false, detail: errorMessage(error), required: true });
  }
  const machine = await inspectMachineConfiguration(paths);
  checks.push({
    name: "Browser setup",
    ok: machine.valid,
    detail: machine.valid
      ? paths.browser
      : `${machine.problems.join(" ")} Install Microsoft Edge Stable or Google Chrome Stable, then run cope setup.`,
    summary: machine.valid ? "configured" : "missing or invalid; run cope setup",
    required: true,
  });

  if (machine.valid) {
    try {
      const parsed = parseBrowserConfig(JSON.parse(await readFile(paths.browser, "utf8")) as unknown);
      const verified = await verifyManualBrowserExecutable(
        parsed.config.product,
        parsed.config.browserExecutable,
        {
          host,
          ...(dependencies.browserIdentityVerifier === undefined
            ? {}
            : { identityVerifier: dependencies.browserIdentityVerifier }),
        },
      );
      if (
        parsed.config.browserVersion !== undefined && parsed.config.browserVersion !== verified.version ||
        parsed.config.browserExecutableSha256 !== undefined &&
          parsed.config.browserExecutableSha256 !== verified.executableSha256
      ) {
        throw new Error("Configured browser version or executable digest changed after setup; run cope setup to verify the update");
      }
      const presentation = browserProductPresentation(parsed.config.product);
      const support = parsed.config.product === "chrome"
        ? "Chrome preview candidate / offline evidence only"
        : "Established compatibility target / live evidence pending";
      checks.push({
        name: "Selected browser",
        ok: true,
        detail: `${presentation.productName} ${verified.version}; ${support}; ${verified.executablePath}`,
        summary: `${presentation.productName} ${verified.version.split(".")[0] ?? verified.version} — ${support}`,
        evidence: {
          product: verified.product,
          version: verified.version,
          executable_path: verified.executablePath,
          executable_sha256: verified.executableSha256,
          identity: verified.evidence,
          support_track: presentation.supportTrack,
          certification_status: presentation.certificationStatus,
        },
        required: true,
      });
      try {
        const profileDirectory = await resolveSafeBrowserProfileDirectory(parsed.config.profileDirectory, {
          stateHome: paths.stateHome,
          ordinaryProfileRoots: (["edge", "chrome"] as const).flatMap((product) =>
            host.ordinaryBrowserProfileRoots(product, process.env)),
          dedicatedProfileRoots: otherDedicatedBrowserProfileRoots(
            host,
            paths.stateHome,
            parsed.config.product,
          ),
        });
        await lstat(profileDirectory);
        await verifyDedicatedProfileRoot(profileDirectory, host);
        await verifyDedicatedProfileMarker(profileDirectory, parsed.config.product);
        checks.push({
          name: "Browser profile privacy",
          ok: true,
          detail: `${profileDirectory}; private ownership and ${parsed.config.product} product marker verified`,
          summary: `private, dedicated, and ${parsed.config.product}-bound`,
          evidence: { profile_path: profileDirectory, product: parsed.config.product, privacy_status: "verified" },
          required: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          checks.push({
            name: "Browser profile privacy",
            ok: true,
            detail: `${parsed.config.profileDirectory} (will be created privately on first launch)`,
            summary: "dedicated profile not created yet",
            required: true,
          });
        } else {
          checks.push({ name: "Browser profile privacy", ok: false, detail: errorMessage(error), required: true });
        }
      }
    } catch (error) {
      checks.push({ name: "Selected browser", ok: false, detail: errorMessage(error), required: true });
    }
  }

  try {
    const boundary = await RepositoryBoundary.discover(command.repository, gitExecutable);
    checks.push({ name: "Project", ok: true, detail: boundary.root, required: true });
    checks.push({
      name: "Project volume",
      ok: true,
      detail: `device ${String(boundary.rootDevice)}; ${boundary.filesystemIdentity.caseSensitive ? "case-sensitive" : "case-insensitive"}; Unicode ${boundary.filesystemIdentity.unicodeNormalizationAliases ? "aliases normalized" : "forms distinct"}`,
      required: true,
    });
    try {
      const configFile = path.join(boundary.root, ".cba", "repository.json");
      parseRepositoryConfig(JSON.parse(await readFile(configFile, "utf8")) as unknown);
      checks.push({ name: "Project setup", ok: true, detail: configFile, required: true });
    } catch (error) {
      checks.push({ name: "Project setup", ok: false, detail: `Run cope in the project to create it. ${errorMessage(error)}`, required: true });
    }
  } catch (error) {
    checks.push({ name: "Project", ok: false, detail: `Open a Git project or standalone file. ${errorMessage(error)}`, required: true });
  }

  const ok = checks.every((check) => !check.required || check.ok);
  if (command.json) {
    io.stdout.write(`${JSON.stringify({ ok, checks })}\n`);
  } else {
    section("Cope doctor", io.stdout);
    for (const check of checks) {
      const detail = check.summary ?? check.detail;
      if (check.ok) success(`${check.name}: ${detail}`, io.stdout);
      else warning(`${check.name}: ${detail}`, io.stdout);
    }
    io.stdout.write("\n");
    if (ok) success("Cope is ready to launch.", io.stdout);
    else hint("Fix the items above, then run cope doctor again.", io.stdout);
    keyValue("State", paths.stateHome, io.stdout);
  }
  return ok ? 0 : 1;
}

export function runtimeFloorDetail(product: "Node.js" | "npm", observed: string, minimumMajor: number, ok: boolean): string {
  return ok ? observed : `${observed}; requires ${product} ${String(minimumMajor)}+`;
}
