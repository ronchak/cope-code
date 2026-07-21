#!/usr/bin/env node

import { stderr, stdout } from "node:process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentError, errorMessage } from "../shared/errors.js";
import { parseCliArguments } from "./arguments.js";
import { executeCommand } from "./commands.js";
import { renderHumanError } from "./friendly-output.js";
import { PromptCancelledError } from "./prompts.js";
import { beginTerminalTakeover, commandUsesTerminalTakeover } from "./terminal-layout.js";
import { WorkspaceExitRequestedError } from "./workspace.js";

export interface MainDependencies {
  readonly stdout?: typeof stdout;
  readonly stderr?: typeof stderr;
  readonly executeCommand?: typeof executeCommand;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: MainDependencies = {},
): Promise<number> {
  const output = dependencies.stdout ?? stdout;
  const errorOutput = dependencies.stderr ?? stderr;
  const execute = dependencies.executeCommand ?? executeCommand;
  const json = argv.includes("--json");
  let endTerminalTakeover = (): void => undefined;
  try {
    const command = parseCliArguments(argv);
    if (commandUsesTerminalTakeover(command.command, command.json)) {
      endTerminalTakeover = beginTerminalTakeover(output);
    }
    return await execute(command, { stdout: output, stderr: errorOutput });
  } catch (error) {
    if (error instanceof WorkspaceExitRequestedError) {
      if (!json) output.write("\nClosed.\n");
      return 0;
    }
    if (error instanceof PromptCancelledError) {
      if (json) {
        output.write(`${JSON.stringify({ ok: false, code: "CANCELLED", message: "Cancelled by user" })}\n`);
      } else {
        errorOutput.write("\nCancelled.\n");
      }
      return 130;
    }

    const body = {
      ok: false,
      code: error instanceof AgentError ? error.code : "INTERNAL_ERROR",
      message: errorMessage(error),
      ...(error instanceof AgentError && Object.keys(error.details).length > 0
        ? { details: error.details }
        : {}),
    };

    if (json) {
      output.write(`${JSON.stringify(body)}\n`);
    } else {
      errorOutput.write(renderHumanError(error));
      if (process.env.COPE_DEBUG === "1" && error instanceof Error && error.stack !== undefined) {
        errorOutput.write(`\n${error.stack}\n`);
      }
    }
    return 1;
  } finally {
    endTerminalTakeover();
  }
}

if (isDirectInvocation()) process.exitCode = await main();

function isDirectInvocation(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(invoked) === realpathSync(modulePath);
  } catch {
    return path.resolve(invoked) === path.resolve(modulePath);
  }
}
