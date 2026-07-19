import { homedir } from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";

import { AgentError } from "../shared/errors.js";
import { defaultProfileHome, selectEnvironment, terminatePosixProcessGroup, uniquePaths } from "./common.js";
import type { HostPlatform } from "./contracts.js";

export class DarwinHostPlatform implements HostPlatform {
  public readonly platform = "darwin" as const;
  public readonly liveBrowserSupported: boolean;
  public readonly supportsDirectoryFsync = true;
  public readonly supportsPosixModes = true;
  public readonly caseInsensitiveByDefault = false;
  public readonly nullDevice = "/dev/null";

  public constructor(
    public readonly architecture: string = process.arch,
    private readonly effectiveUid: () => number | undefined = () => process.getuid?.(),
  ) {
    this.liveBrowserSupported = architecture === "arm64" || architecture === "x64";
  }

  public stateHome(environment: NodeJS.ProcessEnv = process.env): string {
    return path.join(environment.HOME ?? homedir(), "Library", "Application Support", "CopilotBrowserAgent");
  }

  public profileHome(stateHome: string): string { return defaultProfileHome(stateHome); }

  public edgeExecutableCandidates(environment: NodeJS.ProcessEnv = process.env): readonly string[] {
    const home = environment.HOME ?? homedir();
    return uniquePaths([
      environment.COPE_EDGE_EXECUTABLE,
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      path.join(home, "Applications", "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"),
    ]);
  }

  public gitExecutableCandidates(): readonly string[] { return ["git"]; }

  public probeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return selectEnvironment(environment, ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"]);
  }

  public assertNonPrivileged(): void {
    const uid = this.effectiveUid();
    if (uid === undefined) {
      throw new AgentError("ELEVATED_EXECUTION_REFUSED", "Unable to verify the effective macOS user", {
        diagnosticCode: "DARWIN_UID_UNVERIFIED",
      });
    }
    if (uid === 0) {
      throw new AgentError("ELEVATED_EXECUTION_REFUSED", "Cope refuses root execution on macOS; run it from the intended standard user account", {
        diagnosticCode: "DARWIN_ROOT_REFUSED",
      });
    }
  }

  public async verifyEligibility(options: Parameters<HostPlatform["verifyEligibility"]>[0]) {
    this.assertNonPrivileged();
    if (options.liveBrowser && !this.liveBrowserSupported) {
      throw new AgentError("TRANSPORT_UNAVAILABLE", "The experimental macOS Edge preview supports only arm64 and x64", {
        diagnosticCode: "DARWIN_ARCHITECTURE_UNSUPPORTED",
        architecture: this.architecture,
      });
    }
    const version = await options.runProbe(
      "/usr/bin/sw_vers",
      ["-productVersion"],
      options.cwd,
      this.probeEnvironment(process.env),
      false,
    );
    const observedVersion = version.stdout.trim();
    const validVersion = /^\d+(?:\.\d+){1,2}$/u.test(observedVersion);
    const major = validVersion ? Number(observedVersion.split(".")[0]) : 0;
    if (version.exitCode !== 0 || !validVersion || !Number.isSafeInteger(major) || major < 14) {
      throw new AgentError("CONFIG_INVALID", "macOS 14 or newer is required for the experimental Edge preview", {
        diagnosticCode: "DARWIN_VERSION_UNSUPPORTED",
        observed: observedVersion,
      });
    }
    if (!options.liveBrowser) return { standardUserVerified: true, guiSessionVerified: false };
    const uid = this.effectiveUid();
    if (uid === undefined) throw new AgentError("ELEVATED_EXECUTION_REFUSED", "Unable to verify the effective macOS user");
    const console = await options.runProbe(
      "/usr/bin/stat",
      ["-f", "%u", "/dev/console"],
      options.cwd,
      this.probeEnvironment(process.env),
      false,
    );
    const observedConsoleUid = console.stdout.trim();
    const consoleUid = /^\d+$/u.test(observedConsoleUid) ? Number(observedConsoleUid) : Number.NaN;
    const gui = await options.runProbe(
      "/bin/launchctl",
      ["print", `gui/${String(uid)}`],
      options.cwd,
      this.probeEnvironment(process.env),
      false,
    );
    if (console.exitCode !== 0 || consoleUid !== uid || gui.exitCode !== 0) {
      throw new AgentError("TRANSPORT_UNAVAILABLE", "A logged-in Aqua session for the current macOS user is required for visible Edge", {
        diagnosticCode: "DARWIN_GUI_SESSION_UNAVAILABLE",
        consoleUid: Number.isSafeInteger(consoleUid) ? consoleUid : null,
        effectiveUid: uid,
      });
    }
    return { standardUserVerified: true, guiSessionVerified: true };
  }

  public async terminateProcessTree(child: ChildProcess, graceMs: number): Promise<void> {
    await terminatePosixProcessGroup(child, graceMs);
  }
}
