import path from "node:path";

import type { HostPlatform } from "./contracts.js";

export interface TerminalLaunch {
  readonly executable: string;
  readonly arguments: readonly string[];
}

export class TerminalLaunchError extends Error {
  public constructor(
    message: string,
    public readonly reason: "invalid_request" | "windows_batch_argv_unsupported",
  ) {
    super(message);
    this.name = "TerminalLaunchError";
  }
}

export function resolveTerminalLaunch(
  host: HostPlatform,
  request:
    | { readonly mode: "shell"; readonly command: string }
    | {
        readonly mode: "argv";
        readonly executable: string;
        readonly arguments: readonly string[];
      },
  environment: NodeJS.ProcessEnv,
): TerminalLaunch {
  if (request.mode === "argv") {
    assertLaunchString(request.executable, "Terminal executable");
    for (const argument of request.arguments) assertArgumentString(argument);
    if (
      host.platform === "win32" &&
      [".bat", ".cmd"].includes(path.win32.extname(request.executable).toLowerCase())
    ) {
      throw new TerminalLaunchError(
        "Windows .bat and .cmd files require terminal shell mode; direct argv execution is not supported",
        "windows_batch_argv_unsupported",
      );
    }
    return { executable: request.executable, arguments: [...request.arguments] };
  }

  assertLaunchString(request.command, "Terminal shell command");
  if (host.platform === "win32") {
    return {
      executable: validShell(environment.COMSPEC) ?? "cmd.exe",
      arguments: ["/d", "/s", "/c", request.command],
    };
  }
  return {
    executable: validShell(environment.SHELL) ?? "/bin/sh",
    arguments: ["-c", request.command],
  };
}

function validShell(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 && !value.includes("\0") ? value : undefined;
}

function assertLaunchString(value: string, description: string): void {
  if (value.length === 0 || value.includes("\0")) {
    throw new TerminalLaunchError(`${description} must be nonempty and NUL-free`, "invalid_request");
  }
}

function assertArgumentString(value: string): void {
  if (value.includes("\0")) {
    throw new TerminalLaunchError("Terminal arguments must be NUL-free", "invalid_request");
  }
}
