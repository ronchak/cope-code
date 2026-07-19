import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { stableJson } from "../shared/crypto.js";
import { AgentError } from "../shared/errors.js";

const CONTROL_VERSION = "cba-session-control/1" as const;

export type ControlAction = "pause" | "abort";

interface ControlRequest {
  readonly schema_version: typeof CONTROL_VERSION;
  readonly request_id: string;
  readonly session_id: string;
  readonly action: ControlAction;
  readonly reason: string;
  readonly created_at: string;
}

export interface ActiveRuntimeControl {
  requestPause(reason: string): Promise<void>;
  emergencyStop(reason: string): Promise<void>;
}

export async function writeControlRequest(
  sessionDirectory: string,
  sessionId: string,
  action: ControlAction,
  reason: string,
): Promise<void> {
  const filename = controlFilename(sessionDirectory);
  const existing = await readControlRequest(filename).catch(() => undefined);
  if (existing?.action === "abort" && action === "pause") return;
  const request: ControlRequest = {
    schema_version: CONTROL_VERSION,
    request_id: `control_${randomUUID()}`,
    session_id: sessionId,
    action,
    reason,
    created_at: new Date().toISOString(),
  };
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${stableJson(request)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filename);
}

export class SessionControlMonitor {
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> = Promise.resolve();
  private stopped = false;

  public constructor(
    private readonly sessionDirectory: string,
    private readonly sessionId: string,
    private readonly runtime: ActiveRuntimeControl,
    private readonly intervalMs = 250,
  ) {}

  public start(): void {
    if (this.timer !== undefined) return;
    const poll = (): void => {
      this.polling = this.polling.then(() => this.pollOnce()).catch(async (error) => {
        await this.runtime.emergencyStop(`Invalid session control request: ${String(error)}`);
      });
    };
    poll();
    this.timer = setInterval(poll, this.intervalMs);
    this.timer.unref();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.polling;
  }

  private async pollOnce(): Promise<void> {
    if (this.stopped) return;
    const filename = controlFilename(this.sessionDirectory);
    let request: ControlRequest;
    try {
      request = await readControlRequest(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (request.session_id !== this.sessionId) {
      throw new AgentError("RECOVERY_REQUIRED", "Session control request identity does not match");
    }
    if (request.action === "pause") {
      await this.runtime.requestPause(request.reason);
    } else {
      await this.runtime.emergencyStop(request.reason);
    }
    await unlink(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function controlFilename(sessionDirectory: string): string {
  return path.join(sessionDirectory, "control", "request.json");
}

async function readControlRequest(filename: string): Promise<ControlRequest> {
  const bytes = await readFile(filename);
  if (bytes.length > 16 * 1024) {
    throw new AgentError("RECOVERY_REQUIRED", "Session control request is oversized");
  }
  const value = JSON.parse(bytes.toString("utf8")) as Partial<ControlRequest> & Readonly<Record<string, unknown>>;
  const unknown = Object.keys(value).filter((key) => ![
    "schema_version",
    "request_id",
    "session_id",
    "action",
    "reason",
    "created_at",
  ].includes(key));
  if (
    unknown.length > 0 ||
    value.schema_version !== CONTROL_VERSION ||
    typeof value.request_id !== "string" ||
    typeof value.session_id !== "string" ||
    (value.action !== "pause" && value.action !== "abort") ||
    typeof value.reason !== "string" ||
    typeof value.created_at !== "string"
  ) {
    throw new AgentError("RECOVERY_REQUIRED", "Session control request failed validation", { unknown });
  }
  return value as ControlRequest;
}
