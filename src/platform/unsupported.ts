import { homedir } from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";

import { AgentError } from "../shared/errors.js";
import { defaultProfileHome, selectEnvironment, terminatePosixProcessGroup, uniquePaths } from "./common.js";
import type { HostPlatform } from "./contracts.js";

export class UnsupportedHostPlatform implements HostPlatform {
  public readonly liveBrowserSupported = false;
  public readonly supportsDirectoryFsync = true;
  public readonly supportsPosixModes = true;
  public readonly caseInsensitiveByDefault = false;
  public readonly nullDevice = "/dev/null";

  public constructor(
    public readonly platform: NodeJS.Platform,
    public readonly architecture: string = process.arch,
  ) {}

  public stateHome(environment: NodeJS.ProcessEnv = process.env): string {
    return path.join(environment.XDG_STATE_HOME ?? path.join(environment.HOME ?? homedir(), ".local", "state"), "copilot-browser-agent");
  }
  public profileHome(stateHome: string): string { return defaultProfileHome(stateHome); }
  public edgeExecutableCandidates(environment: NodeJS.ProcessEnv = process.env): readonly string[] {
    return uniquePaths([environment.COPE_EDGE_EXECUTABLE]);
  }
  public gitExecutableCandidates(): readonly string[] { return ["git"]; }
  public probeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return selectEnvironment(environment, ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"]);
  }
  public assertNonPrivileged(): void { /* unsupported hosts retain offline behavior */ }
  public async verifyEligibility(options: Parameters<HostPlatform["verifyEligibility"]>[0]) {
    if (options.liveBrowser) {
      throw new AgentError("TRANSPORT_UNAVAILABLE", `The live Edge transport is unavailable on ${this.platform}`, {
        diagnosticCode: "LIVE_BROWSER_HOST_UNSUPPORTED",
      });
    }
    return { standardUserVerified: true, guiSessionVerified: false };
  }
  public async terminateProcessTree(child: ChildProcess, graceMs: number): Promise<void> {
    await terminatePosixProcessGroup(child, graceMs);
  }
}
