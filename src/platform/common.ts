import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import type { ProbeResult, ProbeRunner } from "./contracts.js";

export const runHostProbe: ProbeRunner = async (
  executable,
  args,
  cwd,
  environment,
  windowsHide,
): Promise<ProbeResult> => await new Promise((resolve, reject) => {
  const child = spawn(executable, [...args], {
    cwd,
    shell: false,
    windowsHide,
    stdio: ["ignore", "pipe", "pipe"],
    env: environment,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { if (stdout.length < 32_768) stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { if (stderr.length < 32_768) stderr += chunk; });
  child.once("error", reject);
  child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
});

export async function terminatePosixProcessGroup(child: ChildProcess, graceMs: number): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { return; }
  }
  await new Promise<void>((resolve) => {
    const deadline = setTimeout(resolve, graceMs);
    deadline.unref();
    child.once("close", () => { clearTimeout(deadline); resolve(); });
  });
  // The group leader may exit on SIGTERM while a descendant deliberately
  // ignores it. Probe the process group itself and always escalate survivors.
  try {
    process.kill(-pid, 0);
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }
}

export function uniquePaths(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined && value.length > 0))];
}

export function defaultProfileHome(stateHome: string): string {
  return path.join(path.dirname(stateHome), "CopilotBrowserAgentEdgeProfile");
}

export function selectEnvironment(
  environment: NodeJS.ProcessEnv,
  keys: readonly string[],
): NodeJS.ProcessEnv {
  return Object.fromEntries(keys.flatMap((key) =>
    environment[key] === undefined ? [] : [[key, environment[key]]],
  ));
}
