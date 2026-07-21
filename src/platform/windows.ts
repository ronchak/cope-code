import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { AgentError } from "../shared/errors.js";
import { selectEnvironment, uniquePaths } from "./common.js";
import type { HostPlatform } from "./contracts.js";
import type { BrowserProduct } from "../browser/product.js";

export class WindowsHostPlatform implements HostPlatform {
  public readonly platform = "win32" as const;
  public readonly liveBrowserSupported = true;
  public readonly supportsDirectoryFsync = false;
  public readonly supportsPosixModes = false;
  public readonly caseInsensitiveByDefault = true;
  public readonly nullDevice = "NUL";

  public constructor(
    public readonly architecture: string = process.arch,
    private readonly spawnProcess: typeof spawn = spawn,
  ) {}

  public stateHome(environment: NodeJS.ProcessEnv = process.env): string {
    if (!environment.LOCALAPPDATA) throw new Error("LOCALAPPDATA is required on Windows");
    return path.win32.join(environment.LOCALAPPDATA, "CopilotBrowserAgent");
  }

  public profileHome(stateHome: string, product: BrowserProduct = "edge"): string {
    return path.win32.join(
      path.win32.dirname(stateHome),
      product === "edge" ? "CopilotBrowserAgentEdgeProfile" : "CopilotBrowserAgentChromeProfile",
    );
  }

  public browserExecutableCandidates(
    product: BrowserProduct,
    environment: NodeJS.ProcessEnv = process.env,
  ): readonly string[] {
    if (product === "edge") {
      return uniquePaths([environment.COPE_BROWSER_EXECUTABLE, ...this.edgeExecutableCandidates(environment)]);
    }
    return uniquePaths([
      environment.COPE_BROWSER_EXECUTABLE,
      environment["ProgramFiles(x86)"] === undefined ? undefined : path.win32.join(environment["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
      environment.ProgramFiles === undefined ? undefined : path.win32.join(environment.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
      environment.LOCALAPPDATA === undefined ? undefined : path.win32.join(environment.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ]);
  }

  public ordinaryBrowserProfileRoots(
    product: BrowserProduct,
    environment: NodeJS.ProcessEnv = process.env,
  ): readonly string[] {
    if (environment.LOCALAPPDATA === undefined) return [];
    return [product === "edge"
      ? path.win32.join(environment.LOCALAPPDATA, "Microsoft", "Edge", "User Data")
      : path.win32.join(environment.LOCALAPPDATA, "Google", "Chrome", "User Data")];
  }

  public edgeExecutableCandidates(environment: NodeJS.ProcessEnv = process.env): readonly string[] {
    return uniquePaths([
      environment.COPE_EDGE_EXECUTABLE,
      environment["ProgramFiles(x86)"] === undefined ? undefined : path.win32.join(environment["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
      environment.ProgramFiles === undefined ? undefined : path.win32.join(environment.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      environment.LOCALAPPDATA === undefined ? undefined : path.win32.join(environment.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ]);
  }

  public gitExecutableCandidates(environment: NodeJS.ProcessEnv = process.env): readonly string[] {
    return uniquePaths([
      environment.LOCALAPPDATA === undefined ? undefined : path.win32.join(environment.LOCALAPPDATA, "Programs", "Git", "cmd", "git.exe"),
      path.win32.join(environment.ProgramFiles ?? "C:\\Program Files", "Git", "cmd", "git.exe"),
      environment["ProgramFiles(x86)"] === undefined ? undefined : path.win32.join(environment["ProgramFiles(x86)"], "Git", "cmd", "git.exe"),
      "git",
    ]);
  }

  public probeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return selectEnvironment(environment, ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP"]);
  }

  public assertNonPrivileged(): void { /* verified through the integrity label probe */ }

  public async verifyEligibility(options: Parameters<HostPlatform["verifyEligibility"]>[0]) {
    const result = await options.runProbe(
      "whoami.exe",
      ["/groups", "/fo", "csv", "/nh"],
      options.cwd,
      this.probeEnvironment(process.env),
      true,
    );
    if (result.exitCode !== 0) {
      throw new AgentError("CONFIG_INVALID", "Unable to verify Windows process integrity level", {
        output: bounded(result.stderr || result.stdout),
      });
    }
    if (/S-1-16-(12288|16384)/u.test(result.stdout)) {
      throw new AgentError("POLICY_DENIED", "The agent refuses to run from an elevated Windows process");
    }
    return { standardUserVerified: true, guiSessionVerified: options.liveBrowser };
  }

  public async terminateProcessTree(child: ChildProcess): Promise<void> {
    const pid = child.pid;
    if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const killer = this.spawnProcess("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
        env: this.probeEnvironment(process.env),
      });
      killer.once("error", () => { try { child.kill("SIGKILL"); } catch { /* exited */ } resolve(); });
      killer.once("close", (code) => {
        if (code !== 0 && child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL"); } catch { /* exited */ }
        }
        resolve();
      });
    });
  }
}

function bounded(value: string): string {
  return value.slice(0, 2_048).replace(/[\r\n]+/gu, " ");
}
