import type { CliCommand } from "./arguments.js";

export interface TerminalState {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
}

/**
 * An explicit interactive `cope setup` invocation means the operator wants to
 * revisit setup. Keep redirected and JSON invocations idempotent for scripts.
 */
export function enableInteractiveSetupRerun(
  command: CliCommand,
  terminal: TerminalState = {
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
  },
): CliCommand {
  if (
    command.command !== "setup" ||
    command.force ||
    command.json ||
    !terminal.stdinIsTTY ||
    !terminal.stdoutIsTTY
  ) {
    return command;
  }
  return { ...command, force: true };
}
