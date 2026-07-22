import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { HostPlatform } from "../platform/index.js";
import { AgentError, errorMessage } from "../shared/errors.js";
import type { CliCommand } from "./arguments.js";
import { info, success, type Writable } from "./presentation.js";

const execFileAsync = promisify(execFile);
const SOURCE_ENVIRONMENT_VARIABLE = "COPE_SOURCE_DIR";
const DEFAULT_WINDOWS_ROOT = "C:\\Windows";

type LocalUpdatePlatform = "darwin" | "win32";

export interface LocalUpdateDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly runInstaller?: (
    installer: string,
    sourceDirectory: string,
    environment: NodeJS.ProcessEnv,
    platform: LocalUpdatePlatform,
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
}

export async function executeUpdateCommand(
  command: Extract<CliCommand, { readonly command: "update" }>,
  io: { readonly stdout: Writable; readonly stderr: Writable },
  host: HostPlatform,
  dependencies: LocalUpdateDependencies = {},
): Promise<number> {
  if (host.platform !== "darwin" && host.platform !== "win32") {
    throw new AgentError("CONFIG_INVALID", "cope update supports local Windows and macOS installs only");
  }

  const environment = dependencies.environment ?? process.env;
  const { sourceDirectory, installer } = await resolveLocalUpdateCheckout(environment, host.platform);
  if (!command.json) info(`Updating Cope from ${sourceDirectory}`, io.stdout);

  const runInstaller = dependencies.runInstaller ?? defaultRunInstaller;
  try {
    const result = await runInstaller(installer, sourceDirectory, {
      ...environment,
      [SOURCE_ENVIRONMENT_VARIABLE]: sourceDirectory,
    }, host.platform);
    if (!command.json) {
      if (result.stdout.length > 0) io.stdout.write(result.stdout);
      if (result.stderr.length > 0) io.stderr.write(result.stderr);
      success("Cope is up to date with your local checkout.", io.stdout);
    } else {
      io.stdout.write(`${JSON.stringify({ ok: true, updated: true, sourceDirectory })}\n`);
    }
    return 0;
  } catch (error) {
    throw new AgentError("INTERNAL_ERROR", "Cope could not update from the local checkout", {
      sourceDirectory,
      next: "Fix the installer error, then run cope update again.",
    }, { cause: new Error(errorMessage(error)) });
  }
}

export async function resolveLocalUpdateCheckout(
  environment: NodeJS.ProcessEnv,
  platform: LocalUpdatePlatform = "darwin",
): Promise<{ readonly sourceDirectory: string; readonly installer: string }> {
  const configured = environment[SOURCE_ENVIRONMENT_VARIABLE]?.trim();
  if (configured === undefined || configured.length === 0) {
    throw new AgentError(
      "CONFIG_INVALID",
      `${SOURCE_ENVIRONMENT_VARIABLE} is not set`,
      { next: platform === "win32"
        ? "Rerun .\\install.cmd from your Cope checkout, then open a new PowerShell window."
        : "Rerun ./scripts/install-macos.sh --skip-setup from your Cope checkout, then open a new Terminal." },
    );
  }

  let sourceDirectory: string;
  try {
    sourceDirectory = await realpath(path.resolve(configured));
  } catch (error) {
    throw new AgentError("CONFIG_INVALID", "The configured Cope source folder no longer exists", {
      sourceDirectory: path.resolve(configured),
      next: "Rerun the installer from the checkout's new location.",
    }, { cause: error });
  }

  try {
    const packageDocument = JSON.parse(await readFile(path.join(sourceDirectory, "package.json"), "utf8")) as {
      readonly name?: unknown;
    };
    if (packageDocument.name !== "@local/copilot-browser-agent") throw new Error("unexpected package name");
  } catch (error) {
    throw new AgentError("CONFIG_INVALID", "COPE_SOURCE_DIR does not point to a Cope source checkout", {
      sourceDirectory,
    }, { cause: error });
  }

  const installerName = platform === "win32" ? "install-windows.ps1" : "install-macos.sh";
  const installer = path.join(sourceDirectory, "scripts", installerName);
  try {
    await access(installer, platform === "darwin" ? constants.X_OK : constants.F_OK);
  } catch (error) {
    throw new AgentError("CONFIG_INVALID", platform === "darwin"
      ? "The Cope macOS installer is missing or not executable"
      : "The Cope Windows installer is missing", {
      installer,
    }, { cause: error });
  }
  return { sourceDirectory, installer };
}

async function defaultRunInstaller(
  installer: string,
  sourceDirectory: string,
  environment: NodeJS.ProcessEnv,
  platform: LocalUpdatePlatform,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const invocation = localUpdateInstallerInvocation(installer, platform, environment);
  const result = await execFileAsync(invocation.executable, invocation.arguments, {
    cwd: sourceDirectory,
    env: environment,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: platform === "win32",
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export function localUpdateInstallerInvocation(
  installer: string,
  platform: LocalUpdatePlatform,
  environment: NodeJS.ProcessEnv = {},
): { readonly executable: string; readonly arguments: readonly string[] } {
  if (platform === "win32") {
    return {
      executable: windowsPowerShellExecutable(environment),
      arguments: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer, "-SkipSetup"],
    };
  }
  return { executable: installer, arguments: ["--skip-setup"] };
}

function windowsPowerShellExecutable(environment: NodeJS.ProcessEnv): string {
  const configuredRoot = environmentValue(environment, "SystemRoot")?.trim();
  const normalizedRoot = configuredRoot === undefined ? undefined : path.win32.normalize(configuredRoot);
  const parsedRoot = normalizedRoot === undefined ? undefined : path.win32.parse(normalizedRoot).root;
  const windowsRoot = normalizedRoot !== undefined && parsedRoot !== undefined &&
      /^[A-Z]:\\$/iu.test(parsedRoot) && normalizedRoot.length > parsedRoot.length
    ? normalizedRoot
    : DEFAULT_WINDOWS_ROOT;
  return path.win32.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const expected = name.toLowerCase();
  return Object.entries(environment).find(([key]) => key.toLowerCase() === expected)?.[1];
}
