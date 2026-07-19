import { AgentError } from "../shared/errors.js";

export interface KillSwitchStatus {
  readonly enabled: boolean;
  readonly diagnosticCode?: string;
}

export interface BrowserKillSwitch {
  status(): KillSwitchStatus;
}

/** Process-local switch; a deployment can wrap a centrally managed source. */
export class MutableBrowserKillSwitch implements BrowserKillSwitch {
  #status: KillSwitchStatus = { enabled: true };

  public status(): KillSwitchStatus {
    return this.#status;
  }

  public disable(diagnosticCode = "OPERATOR_KILL_SWITCH"): void {
    this.#status = { enabled: false, diagnosticCode: sanitizeDiagnosticCode(diagnosticCode) };
  }
}

export function assertKillSwitchEnabled(killSwitch: BrowserKillSwitch): void {
  const status = killSwitch.status();
  if (!status.enabled) {
    throw new AgentError("TRANSPORT_UNAVAILABLE", "Browser transport is disabled", {
      diagnosticCode: status.diagnosticCode ?? "KILL_SWITCH",
    });
  }
}

function sanitizeDiagnosticCode(value: string): string {
  const code = value.toUpperCase().replace(/[^A-Z0-9_-]/gu, "_").slice(0, 64);
  return code.length === 0 ? "KILL_SWITCH" : code;
}
