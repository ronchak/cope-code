import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

import {
  runHostProbe,
  type HostPlatform,
  type ProbeResult,
  type ProbeRunner,
} from "../platform/index.js";
import { errorMessage } from "../shared/errors.js";

export interface DoctorProbeDependencies {
  readonly runProbe?: ProbeRunner;
  readonly resolveNpmCli?: () => Promise<string | undefined>;
}

export interface NpmDoctorProbeResult extends ProbeResult {
  readonly npmCli?: string;
}

/**
 * Doctor is diagnostic code. A failed process launch must become a failed check,
 * not abort the command before the remaining checks can run.
 */
export async function runDoctorProbe(
  runner: ProbeRunner,
  executable: string,
  args: readonly string[],
  cwd: string,
  host: HostPlatform,
): Promise<ProbeResult> {
  try {
    return await runner(
      executable,
      args,
      cwd,
      host.probeEnvironment(process.env),
      host.platform === "win32",
    );
  } catch (error) {
    return { exitCode: null, stdout: "", stderr: errorMessage(error) };
  }
}

/**
 * npm.cmd is a Windows shell script and cannot be safely spawned with
 * shell=false. Resolve npm's JavaScript entrypoint and run it through the
 * current Node executable instead.
 */
export async function probeNpmVersion(
  host: HostPlatform,
  cwd: string,
  dependencies: DoctorProbeDependencies = {},
): Promise<NpmDoctorProbeResult> {
  let npmCli: string | undefined;
  try {
    npmCli = await (dependencies.resolveNpmCli ?? resolveNpmCliForCurrentRuntime)();
  } catch (error) {
    return { exitCode: null, stdout: "", stderr: errorMessage(error) };
  }
  if (npmCli === undefined) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "npm CLI could not be located in the active Node.js installation",
    };
  }
  const result = await runDoctorProbe(
    dependencies.runProbe ?? runHostProbe,
    process.execPath,
    [npmCli, "--version"],
    cwd,
    host,
  );
  return { ...result, npmCli };
}

export async function resolveNpmCliForCurrentRuntime(): Promise<string | undefined> {
  const executableDirectory = path.dirname(process.execPath);
  const candidates = unique([
    process.env.npm_execpath,
    path.join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    process.env.ProgramFiles === undefined
      ? undefined
      : path.join(process.env.ProgramFiles, "nodejs", "node_modules", "npm", "bin", "npm-cli.js"),
    process.env["ProgramFiles(x86)"] === undefined
      ? undefined
      : path.join(process.env["ProgramFiles(x86)"], "nodejs", "node_modules", "npm", "bin", "npm-cli.js"),
    process.env.APPDATA === undefined
      ? undefined
      : path.join(process.env.APPDATA, "npm", "node_modules", "npm", "bin", "npm-cli.js"),
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/share/nodejs/npm/bin/npm-cli.js",
  ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0));

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.F_OK);
      return path.resolve(candidate);
    } catch {
      // Continue through the bounded, deterministic candidate list.
    }
  }
  return undefined;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
