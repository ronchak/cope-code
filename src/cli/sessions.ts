import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { resolveStateHome } from "../session/paths.js";
import type { SessionState, SessionStatus } from "../session/types.js";
import type { CliCommand } from "./arguments.js";
import { CURRENT_HOST_PLATFORM, type HostPlatform } from "../platform/index.js";
import { verifyPrivateStateHome } from "../platform/private-storage.js";
import { hint, keyValue, section, warning, type Writable } from "./presentation.js";

export interface SessionSummary {
  readonly sessionId: string;
  readonly objective: string;
  readonly repositoryRoot: string;
  readonly status: SessionStatus;
  readonly mode: SessionState["mode"];
  readonly updatedAt: string;
  readonly resumable: boolean;
}

export async function listSessions(options: {
  readonly repositoryRoot?: string;
  readonly stateHome?: string;
  readonly limit?: number;
  readonly host?: HostPlatform;
}): Promise<readonly SessionSummary[]> {
  const host = options.host ?? CURRENT_HOST_PLATFORM;
  const stateHome = path.resolve(options.stateHome ?? resolveStateHome(process.env, host));
  await verifyPrivateStateHome(stateHome, host);
  const directory = path.join(stateHome, "sessions");
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return []; }
  const requestedRepository = options.repositoryRoot;
  const canonicalRepository = requestedRepository === undefined
    ? undefined
    : await realpath(requestedRepository).catch(() => path.resolve(requestedRepository));
  const summaries: SessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = JSON.parse(await readFile(path.join(directory, entry.name, "session.json"), "utf8")) as Partial<SessionState>;
      if (
        typeof raw.sessionId !== "string" || typeof raw.objective !== "string" ||
        typeof raw.repositoryRoot !== "string" || typeof raw.updatedAt !== "string" ||
        !isStatus(raw.status) || (raw.mode !== "inspect" && raw.mode !== "edit" && raw.mode !== "auto")
      ) continue;
      if (canonicalRepository !== undefined) {
        const canonical = await realpath(raw.repositoryRoot).catch(() => path.resolve(raw.repositoryRoot!));
        if (canonical !== canonicalRepository) continue;
      }
      summaries.push({
        sessionId: raw.sessionId,
        objective: raw.objective,
        repositoryRoot: raw.repositoryRoot,
        status: raw.status,
        mode: raw.mode,
        updatedAt: raw.updatedAt,
        resumable: !["completed", "rolled_back", "blocked", "aborted", "failed"].includes(raw.status),
      });
    } catch {
      // Ignore corrupt entries here; status/verify-audit remain the recovery tools.
    }
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, options.limit ?? 20);
}

export async function mostRecentResumableSession(options: {
  readonly repositoryRoot: string;
  readonly stateHome?: string;
  readonly host?: HostPlatform;
}): Promise<SessionSummary | undefined> {
  return (await listSessions({ ...options, limit: 50 })).find((session) => session.resumable);
}

export async function executeSessionsCommand(
  command: Extract<CliCommand, { readonly command: "sessions" }>,
  io: { readonly stdout: Writable; readonly stderr: Writable },
  host: HostPlatform = CURRENT_HOST_PLATFORM,
): Promise<number> {
  const sessions = await listSessions({
    ...(command.repository === undefined || command.all ? {} : { repositoryRoot: command.repository }),
    ...(command.stateHome === undefined ? {} : { stateHome: command.stateHome }),
    limit: command.all ? 100 : 20,
    host,
  });
  if (command.json) {
    io.stdout.write(`${JSON.stringify({ ok: true, sessions })}\n`);
    return 0;
  }
  section(command.all || command.repository === undefined ? "Recent Cope sessions" : "Project sessions", io.stdout);
  if (sessions.length === 0) {
    warning("No sessions found.", io.stdout);
    hint("Run cope and describe a task to start one.", io.stdout);
    return 0;
  }
  for (const session of sessions) {
    io.stdout.write(`\n${session.resumable ? "*" : " "} ${session.objective}\n`);
    keyValue("Status", session.status, io.stdout);
    keyValue("Updated", session.updatedAt.replace("T", " ").slice(0, 19), io.stdout);
    keyValue("ID", session.sessionId, io.stdout);
  }
  hint("A * marks a resumable session. Use cope -c or /resume.", io.stdout);
  return 0;
}

function isStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && [
    "created", "preflight", "grant_pending", "transport_starting", "initializing_model",
    "awaiting_model", "executing_tools", "returning_results", "awaiting_user", "paused",
    "validating_completion", "recovering", "completed", "rolled_back", "blocked", "aborted", "failed",
  ].includes(value);
}
