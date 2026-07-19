import { readFile } from "node:fs/promises";

import type { SessionState } from "../session/types.js";
import { AgentError, errorMessage } from "../shared/errors.js";
import {
  TRANSCRIPT_SCHEMA_VERSION,
  TranscriptReplayTransport,
  type TranscriptEvent,
  type TransportTranscriptV1,
} from "../transport/index.js";

export interface ReplayIdentity {
  readonly taskId: string;
  readonly submissionIds: readonly string[];
}

export async function inspectReplayIdentity(filename: string): Promise<ReplayIdentity> {
  const transcript = await readTranscript(filename);
  const submissions = transcript.events.filter((event) => event.type === "submit");
  const first = submissions[0];
  if (first === undefined) {
    throw new AgentError("CONFIG_INVALID", "Replay transcript contains no submit event");
  }
  const taskIds = new Set(transcript.events.map((event) => event.taskId));
  if (taskIds.size !== 1) {
    throw new AgentError("CONFIG_INVALID", "Replay transcript spans multiple task identifiers");
  }
  return { taskId: first.taskId, submissionIds: submissions.map((event) => event.submissionId) };
}

export async function loadReplayTransport(
  filename: string,
  state: SessionState,
): Promise<{ readonly transport: TranscriptReplayTransport; readonly idFactory: (prefix: string) => string }> {
  const transcript = await readTranscript(filename);
  const firstIndex = replayStartIndex(transcript.events, state);
  const events = transcript.events.slice(firstIndex);
  if (events.some((event) => event.taskId !== state.taskId)) {
    throw new AgentError("PROTOCOL_INVALID", "Replay transcript task does not match the session task");
  }
  const recoveringSubmission =
    state.submission !== undefined && state.submission.state !== "answered"
      ? state.submission.submissionId
      : undefined;
  const submissionIds = events
    .filter((event) => event.type === "submit" && event.submissionId !== recoveringSubmission)
    .map((event) => event.submissionId);
  let cursor = 0;
  return {
    transport: new TranscriptReplayTransport({ schemaVersion: TRANSCRIPT_SCHEMA_VERSION, events }),
    idFactory: (prefix) => {
      if (prefix !== "submission") {
        throw new AgentError("INTERNAL_ERROR", `Replay cannot allocate '${prefix}' identifiers`);
      }
      const id = submissionIds[cursor];
      if (id === undefined) {
        throw new AgentError("TRANSPORT_UNAVAILABLE", "Replay submission identifiers are exhausted");
      }
      cursor += 1;
      return id;
    },
  };
}

function replayStartIndex(events: readonly TranscriptEvent[], state: SessionState): number {
  if (state.submission !== undefined && state.submission.state !== "answered") {
    const index = events.findIndex((event) =>
      event.type === "resolve-submission" && event.submissionId === state.submission?.submissionId);
    if (index === -1) {
      throw new AgentError("RECOVERY_REQUIRED", "Replay transcript lacks the required submission-resolution event", {
        submissionId: state.submission.submissionId,
      });
    }
    return index;
  }
  const nextTurnId = state.queuedOutbound?.turnId ??
    `turn_${String(state.turnSequence + 1).padStart(4, "0")}`;
  const index = events.findIndex((event) => event.type === "submit" && event.turnId === nextTurnId);
  if (index === -1) {
    // An answered response may complete locally without another transport call.
    if (state.submission?.state === "answered") return events.length;
    throw new AgentError("RECOVERY_REQUIRED", "Replay transcript has no submit event for the next turn", {
      turnId: nextTurnId,
    });
  }
  return index;
}

async function readTranscript(filename: string): Promise<TransportTranscriptV1> {
  try {
    const bytes = await readFile(filename);
    if (bytes.length > 32 * 1024 * 1024) {
      throw new AgentError("CONFIG_INVALID", "Replay transcript exceeds 32 MiB");
    }
    const value = JSON.parse(bytes.toString("utf8")) as Partial<TransportTranscriptV1>;
    if (value.schemaVersion !== TRANSCRIPT_SCHEMA_VERSION || !Array.isArray(value.events)) {
      throw new AgentError("CONFIG_INVALID", `Expected transcript schema ${TRANSCRIPT_SCHEMA_VERSION}`);
    }
    for (const [index, event] of value.events.entries()) {
      if (
        event === null ||
        typeof event !== "object" ||
        !["submit", "receive", "resolve-submission"].includes((event as { type?: string }).type ?? "") ||
        typeof (event as { taskId?: unknown }).taskId !== "string" ||
        typeof (event as { turnId?: unknown }).turnId !== "string" ||
        typeof (event as { submissionId?: unknown }).submissionId !== "string"
      ) {
        throw new AgentError("CONFIG_INVALID", "Replay transcript event is malformed", { index });
      }
    }
    return value as TransportTranscriptV1;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError("CONFIG_INVALID", `Unable to load replay transcript: ${errorMessage(error)}`, {
      filename,
    }, { cause: error });
  }
}
