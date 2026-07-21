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

export interface LocalUpdateDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly runInstaller?: (
    installer: string,
    sourceDirectory: string,
    environment: NodeJS.ProcessEnv,
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
}

export async function executeUpdateCommand(
  command: Extract<CliCommand, { readonly command: "update" }>,
  io: { readonly stdout: Writable; readonly stderr: Writable },
  host: HostPlatform,
  dependencies: LocalUpdateDependencies = {},
): Promise<number> {
  if (host.platform !== "darwin") {
    throw new AgentError("CONFIG_INVALID", "cope update currently supports the local macOS install only");
  }

  const environment = dependencies.environment ?? process.env;
  const { sourceDirectory, installer } = await resolveLocalUpdateCheckout(environment);
  if (!command.json) info(`Updating Cope from ${sourceDirectory}`, io.stdout);

  const runInstaller = dependencies.runInstaller ?? defaultRunInstaller;
  try {
    const result = await runInstaller(installer, sourceDirectory, {
      ...environment,
      [SOURCE_ENVIRONMENT_VARIABLE]: sourceDirectory,
    });
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
): Promise<{ readonly sourceDirectory: string; readonly installer: string }> {
  const configured = environment[SOURCE_ENVIRONMENT_VARIABLE]?.trim();
  if (configured === undefined || configured.length === 0) {
    throw new AgentError(
      "CONFIG_INVALID",
      `${SOURCE_ENVIRONMENT_VARIABLE} is not set`,
      { next: "Rerun ./scripts/install-macos.sh --skip-setup from your Cope checkout, then open a new Terminal." },
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

  const installer = path.join(sourceDirectory, "scripts", "install-macos.sh");
  try {
    await access(installer, constants.X_OK);
  } catch (error) {
    throw new AgentError("CONFIG_INVALID", "The Cope macOS installer is missing or not executable", {
      installer,
    }, { cause: error });
  }
  return { sourceDirectory, installer };
}

async function defaultRunInstaller(
  installer: string,
  sourceDirectory: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await execFileAsync(installer, ["--skip-setup"], {
    cwd: sourceDirectory,
    env: environment,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}
