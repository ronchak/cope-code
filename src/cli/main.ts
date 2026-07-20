#!/usr/bin/env node

import { stderr, stdout } from "node:process";

import { AgentError, errorMessage } from "../shared/errors.js";
import { parseCliArguments } from "./arguments.js";
import { executeCommand } from "./commands.js";
import { renderHumanError } from "./friendly-output.js";
import { PromptCancelledError } from "./prompts.js";
import { enableInteractiveSetupRerun } from "./setup-invocation.js";
import { beginTerminalTakeover, commandUsesTerminalTakeover } from "./terminal-layout.js";
import { WorkspaceExitRequestedError } from "./workspace.js";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const json = argv.includes("--json");
  let endTerminalTakeover = (): void => undefined;
  try {
    const command = enableInteractiveSetupRerun(parseCliArguments(argv));
    if (commandUsesTerminalTakeover(command.command, command.json)) {
      endTerminalTakeover = beginTerminalTakeover(stdout);
    }
    return await executeCommand(command, { stdout, stderr });
  } catch (error) {
    if (error instanceof WorkspaceExitRequestedError) {
      if (!json) stdout.write("\nClosed.\n");
      return 0;
    }
    if (error instanceof PromptCancelledError) {
      if (json) {
        stdout.write(`${JSON.stringify({ ok: false, code: "CANCELLED", message: "Cancelled by user" })}\n`);
      } else {
        stderr.write("\nCancelled.\n");
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
      stdout.write(`${JSON.stringify(body)}\n`);
    } else {
      stderr.write(renderHumanError(error));
      if (process.env.COPE_DEBUG === "1" && error instanceof Error && error.stack !== undefined) {
        stderr.write(`\n${error.stack}\n`);
      }
    }
    return 1;
  } finally {
    endTerminalTakeover();
  }
}

process.exitCode = await main();
