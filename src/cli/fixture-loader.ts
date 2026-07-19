import { readFile } from "node:fs/promises";

import { AgentError, errorMessage } from "../shared/errors.js";
import {
  ScriptedFixtureTransport,
  type ScriptedFixtureResponse,
  type ScriptedFixtureTurn,
} from "../transport/index.js";

export const CLI_FIXTURE_SCHEMA_VERSION = "cba-scripted-fixture/1" as const;

export interface LoadCliFixtureOptions {
  readonly taskId: string;
  readonly startTurnNumber?: number;
  /** Present when AgentRuntime will recover this submission without asking idFactory for it. */
  readonly recoveringSubmission?: {
    readonly turnId: string;
    readonly submissionId: string;
  };
}

export interface LoadedCliFixture {
  readonly transport: ScriptedFixtureTransport;
  readonly idFactory: (prefix: string) => string;
  readonly turnCount: number;
}

/**
 * Loads a reusable, text-only model fixture. Correlation fields are generated
 * by the harness; response text may use {{TASK_ID}}, {{TURN_ID}}, and
 * {{SUBMISSION_ID}} placeholders.
 */
export async function loadCliFixture(
  filename: string,
  options: LoadCliFixtureOptions,
): Promise<LoadedCliFixture> {
  const raw = await readBoundedJson(filename);
  const document = record(raw, "fixture");
  exactKeys(document, ["schema_version", "turns"], "fixture");
  if (document.schema_version !== CLI_FIXTURE_SCHEMA_VERSION) {
    throw new AgentError("CONFIG_INVALID", `Expected fixture schema ${CLI_FIXTURE_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(document.turns) || document.turns.length === 0) {
    throw new AgentError("CONFIG_INVALID", "Fixture turns must be a non-empty array");
  }

  const startTurnNumber = options.startTurnNumber ?? 1;
  if (!Number.isSafeInteger(startTurnNumber) || startTurnNumber < 1) {
    throw new AgentError("CONFIG_INVALID", "Fixture start turn is invalid");
  }
  const sourceTurns = document.turns.slice(startTurnNumber - 1);
  if (sourceTurns.length === 0) {
    throw new AgentError("TRANSPORT_UNAVAILABLE", "Fixture has no turns remaining for this session", {
      startTurnNumber,
      configuredTurns: document.turns.length,
    });
  }

  const turns = sourceTurns.map((value, offset) => {
    const turnNumber = startTurnNumber + offset;
    const turnId = `turn_${String(turnNumber).padStart(4, "0")}`;
    const recovering = options.recoveringSubmission?.turnId === turnId
      ? options.recoveringSubmission
      : undefined;
    const submissionId = recovering?.submissionId ?? `submission_fixture_${String(turnNumber).padStart(4, "0")}`;
    return parseTurn(value, {
      taskId: options.taskId,
      turnId,
      submissionId,
    });
  });

  const ids = turns
    .filter((turn) => turn.submissionId !== options.recoveringSubmission?.submissionId)
    .map((turn) => turn.submissionId);
  let cursor = 0;
  return {
    transport: new ScriptedFixtureTransport(turns),
    idFactory: (prefix) => {
      if (prefix !== "submission") {
        throw new AgentError("INTERNAL_ERROR", `Fixture cannot allocate '${prefix}' identifiers`);
      }
      const id = ids[cursor];
      if (id === undefined) {
        throw new AgentError("TRANSPORT_UNAVAILABLE", "Fixture submission identifiers are exhausted");
      }
      cursor += 1;
      return id;
    },
    turnCount: turns.length,
  };
}

function parseTurn(
  value: unknown,
  correlation: Pick<ScriptedFixtureTurn, "taskId" | "turnId" | "submissionId">,
): ScriptedFixtureTurn {
  const turn = record(value, "fixture turn");
  exactKeys(turn, [
    "expected_content_contains",
    "conversation_id",
    "submission_status",
    "submission_diagnostic_code",
    "response",
  ], "fixture turn");
  const substitutions = {
    TASK_ID: correlation.taskId,
    TURN_ID: correlation.turnId,
    SUBMISSION_ID: correlation.submissionId,
  } as const;
  const expected = optionalString(turn.expected_content_contains, "expected_content_contains");
  const conversationId = optionalString(turn.conversation_id, "conversation_id");
  const status = turn.submission_status;
  if (status !== undefined && status !== "submitted" && status !== "not-submitted" && status !== "indeterminate") {
    throw new AgentError("CONFIG_INVALID", "Fixture submission_status is invalid");
  }
  const diagnostic = optionalString(turn.submission_diagnostic_code, "submission_diagnostic_code");
  return {
    ...correlation,
    ...(expected === undefined
      ? {}
      : { expectedContent: new RegExp(escapeRegExp(template(expected, substitutions)), "u") }),
    ...(conversationId === undefined ? {} : { conversationId: template(conversationId, substitutions) }),
    ...(status === undefined ? {} : { submissionStatus: status }),
    ...(diagnostic === undefined ? {} : { submissionDiagnosticCode: diagnostic }),
    response: parseResponse(turn.response, substitutions),
  };
}

function parseResponse(
  value: unknown,
  substitutions: Readonly<Record<"TASK_ID" | "TURN_ID" | "SUBMISSION_ID", string>>,
): ScriptedFixtureResponse {
  const response = record(value, "fixture response");
  const status = response.status;
  if (status === "completed") {
    exactKeys(response, ["status", "response_id", "content"], "completed fixture response");
    const responseId = optionalString(response.response_id, "response_id");
    return {
      status,
      ...(responseId === undefined ? {} : { responseId: template(responseId, substitutions) }),
      content: template(requiredString(response.content, "content"), substitutions),
    };
  }
  if (status === "blocked") {
    exactKeys(response, ["status", "reason", "retryable", "diagnostic_code"], "blocked fixture response");
    const reasons = [
      "authentication-required",
      "identity-unverified",
      "protection-unverified",
      "throttled",
      "service-error",
      "unapproved-host",
      "blocking-modal",
      "transport-incompatible",
      "transport-disabled",
      "conversation-mismatch",
      "submission-unresolved",
      "unknown",
    ] as const;
    if (!reasons.includes(response.reason as never)) {
      throw new AgentError("CONFIG_INVALID", "Fixture blocked reason is invalid");
    }
    const retryable = optionalBoolean(response.retryable, "retryable");
    const diagnosticCode = optionalString(response.diagnostic_code, "diagnostic_code");
    return {
      status,
      reason: response.reason as (typeof reasons)[number],
      ...(retryable === undefined ? {} : { retryable }),
      ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
    };
  }
  if (status === "timed-out") {
    exactKeys(response, ["status", "incomplete"], "timed-out fixture response");
    const incomplete = optionalBoolean(response.incomplete, "incomplete");
    return { status, ...(incomplete === undefined ? {} : { incomplete }) };
  }
  if (status === "indeterminate") {
    exactKeys(response, ["status", "diagnostic_code"], "indeterminate fixture response");
    const diagnosticCode = optionalString(response.diagnostic_code, "diagnostic_code");
    return { status, ...(diagnosticCode === undefined ? {} : { diagnosticCode }) };
  }
  throw new AgentError("CONFIG_INVALID", "Fixture response status is invalid");
}

function template(
  value: string,
  substitutions: Readonly<Record<"TASK_ID" | "TURN_ID" | "SUBMISSION_ID", string>>,
): string {
  return value.replace(/\{\{(TASK_ID|TURN_ID|SUBMISSION_ID)\}\}/gu, (_match, key: keyof typeof substitutions) =>
    substitutions[key]);
}

async function readBoundedJson(filename: string): Promise<unknown> {
  try {
    const content = await readFile(filename);
    if (content.length > 16 * 1024 * 1024) {
      throw new AgentError("CONFIG_INVALID", "Fixture file exceeds 16 MiB");
    }
    return JSON.parse(content.toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError("CONFIG_INVALID", `Unable to load fixture: ${errorMessage(error)}`, { filename }, { cause: error });
  }
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentError("CONFIG_INVALID", `${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new AgentError("CONFIG_INVALID", `${label} contains unknown fields`, { fields: unknown });
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new AgentError("CONFIG_INVALID", `${label} must be a string`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentError("CONFIG_INVALID", `${label} must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new AgentError("CONFIG_INVALID", `${label} must be boolean`);
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
