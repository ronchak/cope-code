import { AgentError } from "../shared/errors.js";
import type { SessionState, SessionStatus, TerminalSessionStatus } from "./types.js";

const terminal = new Set<SessionStatus>(["completed", "rolled_back", "blocked", "aborted", "failed"]);

const transitions: Readonly<Record<SessionStatus, ReadonlySet<SessionStatus>>> = {
  created: new Set(["preflight", "aborted", "failed"]),
  preflight: new Set(["grant_pending", "aborted", "failed"]),
  grant_pending: new Set(["transport_starting", "aborted", "failed"]),
  transport_starting: new Set(["initializing_model", "paused", "blocked", "aborted", "failed"]),
  initializing_model: new Set(["awaiting_model", "paused", "blocked", "aborted", "failed"]),
  awaiting_model: new Set([
    "executing_tools",
    "awaiting_user",
    "validating_completion",
    "paused",
    "blocked",
    "aborted",
    "failed",
    "recovering",
  ]),
  executing_tools: new Set([
    "returning_results",
    "awaiting_user",
    "paused",
    "blocked",
    "aborted",
    "failed",
    "recovering",
  ]),
  returning_results: new Set(["awaiting_model", "paused", "blocked", "aborted", "failed", "recovering"]),
  awaiting_user: new Set([
    "executing_tools",
    "returning_results",
    "transport_starting",
    "recovering",
    "paused",
    "blocked",
    "aborted",
    "failed",
  ]),
  paused: new Set(["recovering", "transport_starting", "aborted", "failed"]),
  validating_completion: new Set(["completed", "returning_results", "recovering", "paused", "blocked", "aborted", "failed"]),
  recovering: new Set([
    "transport_starting",
    "awaiting_model",
    "returning_results",
    "paused",
    "blocked",
    "aborted",
    "failed",
  ]),
  completed: new Set(["rolled_back"]),
  rolled_back: new Set(),
  blocked: new Set(["rolled_back"]),
  aborted: new Set(["rolled_back"]),
  failed: new Set(["rolled_back"]),
};

export function transitionSession(
  state: SessionState,
  next: SessionStatus,
  now: string,
  details: { readonly reason?: string; readonly failure?: { readonly code: string; readonly message: string } } = {},
): void {
  if (state.status === next) {
    throw new AgentError("INTERNAL_ERROR", `Redundant session transition ${next} -> ${next}`);
  }
  // A verified explicit checkpoint rollback invalidates any prior lifecycle
  // status, including a formerly completed session.
  if (!transitions[state.status].has(next) && next !== "rolled_back") {
    throw new AgentError("INTERNAL_ERROR", `Invalid session transition ${state.status} -> ${next}`, {
      from: state.status,
      to: next,
    });
  }

  state.status = next;
  state.updatedAt = now;
  if (next === "paused" || next === "blocked") {
    state.pauseReason = details.reason ?? "No reason supplied";
  } else {
    delete state.pauseReason;
  }
  if (next === "failed") {
    state.failure = details.failure ?? { code: "INTERNAL_ERROR", message: details.reason ?? "Session failed" };
  }
  if (terminal.has(next)) {
    state.completedAt = now;
  }
}

export function isTerminal(status: SessionStatus): status is TerminalSessionStatus {
  return terminal.has(status);
}

export function allowedTransitions(status: SessionStatus): readonly SessionStatus[] {
  return [...transitions[status]];
}
