import path from "node:path";

import type { OperationRecord, RegisterOperationResult } from "../../src/session/operation-journal.js";
import { OperationJournal } from "../../src/session/operation-journal.js";
import { SessionStore } from "../../src/session/store.js";
import type { SessionState } from "../../src/session/types.js";
import {
  OPERATION_ID,
  PersistentToolExecutor,
  PersistentTransport,
  SESSION_ID,
  crashNow,
  createReliabilityRuntime,
  createReliabilityState,
} from "../helpers/runtime-reliability.js";

type Boundary =
  | "state-prepared"
  | "transport-submitted"
  | "state-submitted"
  | "state-answered"
  | "journal-accepted"
  | "state-operation-accepted"
  | "journal-executing"
  | "state-operation-executing"
  | "tool-side-effect"
  | "journal-completed"
  | "state-operation-completed";

const root = path.resolve(process.argv[2] ?? "");
const boundary = process.argv[3] as Boundary | undefined;
if (root === "" || boundary === undefined) throw new Error("root and boundary are required");

class CrashSessionStore extends SessionStore {
  public constructor(stateHome: string) {
    super(stateHome);
  }

  public override async write(state: SessionState): Promise<void> {
    await super.write(state);
    if (
      (boundary === "state-prepared" && state.submission?.state === "prepared") ||
      (boundary === "state-submitted" && state.submission?.state === "submitted") ||
      (boundary === "state-answered" && state.submission?.state === "answered") ||
      (boundary === "state-operation-accepted" &&
        state.pendingOperations.some((operation) =>
          operation.operationId === OPERATION_ID && operation.status === "accepted")) ||
      (boundary === "state-operation-executing" &&
        state.pendingOperations.some((operation) =>
          operation.operationId === OPERATION_ID && operation.status === "executing")) ||
      (boundary === "state-operation-completed" &&
        state.completedOperationIds.includes(OPERATION_ID) &&
        state.mutations.some((mutation) => mutation.operationId === OPERATION_ID))
    ) {
      crashNow();
    }
  }
}

class CrashOperationJournal extends OperationJournal {
  public override async register(
    operationId: string,
    tool: string,
    mutating: boolean,
    request: unknown,
    now: string,
  ): Promise<RegisterOperationResult> {
    const result = await super.register(operationId, tool, mutating, request, now);
    if (boundary === "journal-accepted" && operationId === OPERATION_ID && result.record.status === "accepted") {
      crashNow();
    }
    return result;
  }

  public override async markExecuting(record: OperationRecord, now: string): Promise<OperationRecord> {
    const result = await super.markExecuting(record, now);
    if (boundary === "journal-executing" && record.operationId === OPERATION_ID) crashNow();
    return result;
  }

  public override async markCompleted(
    record: OperationRecord,
    now: string,
    outcome: string,
    safeResult: Readonly<Record<string, unknown>>,
  ): Promise<OperationRecord> {
    const result = await super.markCompleted(record, now, outcome, safeResult);
    if (boundary === "journal-completed" && record.operationId === OPERATION_ID) crashNow();
    return result;
  }
}

const state = createReliabilityState(path.join(root, "repository"));
const store = new CrashSessionStore(path.join(root, "state"));
await store.create(state);
const journal = new CrashOperationJournal(path.join(root, "operations"), SESSION_ID);
const transport = new PersistentTransport(
  root,
  boundary === "transport-submitted" ? crashNow : undefined,
);
const tools = new PersistentToolExecutor(
  root,
  boundary === "tool-side-effect" ? crashNow : undefined,
);
const result = await createReliabilityRuntime({ root, state, store, journal, transport, tools }).run();
throw new Error(`runtime did not crash at ${boundary}; ended ${result.status}`);
