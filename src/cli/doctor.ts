import { access, lstat, readFile } from "node:fs/promises";
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

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly required: boolean;
}

export async function executeDoctorCommand(
  command: Extract<CliCommand, { readonly command: "doctor" }>,
  io: { readonly stdout: Writable; readonly stderr: Writable },
  host: HostPlatform,
  dependencies: DoctorProbeDependencies = {},
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
    checks.push({ name: "Host session", ok: true, detail: `${host.platform}/${host.architecture}; standard user and GUI verified`, required: true });
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
      : `${machine.problems.join(" ")} Install Microsoft Edge Stable, then run cope setup.`,
    required: true,
  });

  if (machine.valid) {
    try {
      const parsed = parseBrowserConfig(JSON.parse(await readFile(paths.browser, "utf8")) as unknown);
      await access(parsed.config.edgeExecutable);
      checks.push({ name: "Microsoft Edge", ok: true, detail: parsed.config.edgeExecutable, required: true });
      try {
        await lstat(parsed.config.profileDirectory);
        await verifyDedicatedProfileRoot(parsed.config.profileDirectory, host);
        checks.push({ name: "Edge profile privacy", ok: true, detail: parsed.config.profileDirectory, required: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          checks.push({ name: "Edge profile privacy", ok: true, detail: `${parsed.config.profileDirectory} (created privately on first launch)`, required: true });
        } else {
          checks.push({ name: "Edge profile privacy", ok: false, detail: errorMessage(error), required: true });
        }
      }
    } catch (error) {
      checks.push({ name: "Microsoft Edge", ok: false, detail: errorMessage(error), required: true });
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
      if (check.ok) success(`${check.name}: ${check.detail}`, io.stdout);
      else warning(`${check.name}: ${check.detail}`, io.stdout);
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
