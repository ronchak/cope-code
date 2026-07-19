import assert from "node:assert/strict";
import { test } from "node:test";

import { sha256 } from "../../src/shared/crypto.js";
import type { Clock } from "../../src/shared/time.js";
import {
  MODEL_TRANSPORT_CONTRACT_VERSION,
  ScriptedFixtureTransport,
  TRANSCRIPT_SCHEMA_VERSION,
  TranscriptReplayTransport,
  type SubmissionReceipt,
  type TransportTranscriptV1,
} from "../../src/transport/index.js";

const fixedClock: Clock = { now: () => new Date("2026-07-17T12:00:00.000Z") };

test("scripted fixture executes correlated offline turns deterministically", async () => {
  const transport = new ScriptedFixtureTransport(
    [
      {
        taskId: "task-1",
        turnId: "turn-1",
        submissionId: "submission-1",
        expectedContent: "bootstrap",
        conversationId: "fixture-conversation",
        response: { status: "completed", responseId: "response-1", content: "tool request" },
      },
      {
        taskId: "task-1",
        turnId: "turn-2",
        submissionId: "submission-2",
        expectedContent: /tool result/u,
        response: { status: "blocked", reason: "throttled", retryable: true },
      },
    ],
    fixedClock,
  );

  const firstRequest = {
    taskId: "task-1",
    turnId: "turn-1",
    submissionId: "submission-1",
    content: "bootstrap",
  } as const;
  const receipt = await transport.submit(firstRequest);
  assert.equal(receipt.status, "submitted");
  assert.equal(receipt.observedAt, "2026-07-17T12:00:00.000Z");
  assert.equal((await transport.submit(firstRequest)).transportMarker, receipt.transportMarker);

  const response = await transport.receive(firstRequest);
  assert.deepEqual(response, {
    contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
    taskId: "task-1",
    turnId: "turn-1",
    submissionId: "submission-1",
    observedAt: "2026-07-17T12:00:00.000Z",
    conversationId: "fixture-conversation",
    status: "completed",
    responseId: "response-1",
    content: "tool request",
  });
  assert.equal(transport.remainingTurns, 1);

  await transport.submit({
    taskId: "task-1",
    turnId: "turn-2",
    submissionId: "submission-2",
    content: "structured tool result",
  });
  const blocked = await transport.receive({
    taskId: "task-1",
    turnId: "turn-2",
    submissionId: "submission-2",
  });
  assert.equal(blocked.status, "blocked");
  if (blocked.status === "blocked") assert.equal(blocked.reason, "throttled");
  assert.equal(transport.remainingTurns, 0);
});

test("scripted fixture rejects task/turn mismatch without consuming the script", async () => {
  const transport = new ScriptedFixtureTransport([
    {
      taskId: "task-a",
      turnId: "turn-a",
      submissionId: "submission-a",
      response: { status: "completed", content: "done" },
    },
  ]);
  await assert.rejects(
    transport.submit({
      taskId: "task-b",
      turnId: "turn-a",
      submissionId: "submission-a",
      content: "wrong task",
    }),
    /correlation mismatch/u,
  );
  assert.equal(transport.remainingTurns, 1);
});

test("scripted fixture rejects content changes under an existing submission id", async () => {
  const transport = new ScriptedFixtureTransport([
    {
      taskId: "task-a",
      turnId: "turn-a",
      submissionId: "submission-a",
      response: { status: "completed", content: "done" },
    },
  ]);
  await transport.submit({
    taskId: "task-a",
    turnId: "turn-a",
    submissionId: "submission-a",
    content: "original",
  });
  await assert.rejects(
    transport.submit({
      taskId: "task-a",
      turnId: "turn-a",
      submissionId: "submission-a",
      content: "changed",
    }),
    /different content/u,
  );
});

test("not-submitted fixture result prevents receive from pretending a response exists", async () => {
  const transport = new ScriptedFixtureTransport([
    {
      taskId: "task",
      turnId: "turn",
      submissionId: "submission",
      submissionStatus: "not-submitted",
      response: { status: "completed", content: "must not be returned" },
    },
  ]);
  const request = { taskId: "task", turnId: "turn", submissionId: "submission", content: "x" };
  assert.equal((await transport.submit(request)).status, "not-submitted");
  const response = await transport.receive(request);
  assert.equal(response.status, "blocked");
  if (response.status === "blocked") {
    assert.equal(response.reason, "submission-unresolved");
    assert.equal(response.retryable, true);
  }
});

test("transcript replay verifies strict event order, digest, and correlation", async () => {
  const request = {
    taskId: "task-replay",
    turnId: "turn-replay",
    submissionId: "submission-replay",
    content: "approved replay prompt",
  } as const;
  const receipt: SubmissionReceipt = {
    contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
    taskId: request.taskId,
    turnId: request.turnId,
    submissionId: request.submissionId,
    status: "submitted",
    observedAt: "2026-07-17T12:00:00.000Z",
    conversationId: "replay-conversation",
  };
  const transcript: TransportTranscriptV1 = {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    events: [
      { type: "submit", ...request, contentSha256: sha256(request.content), receipt },
      {
        type: "resolve-submission",
        taskId: request.taskId,
        turnId: request.turnId,
        submissionId: request.submissionId,
        receipt,
      },
      {
        type: "receive",
        taskId: request.taskId,
        turnId: request.turnId,
        submissionId: request.submissionId,
        result: {
          contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
          taskId: request.taskId,
          turnId: request.turnId,
          submissionId: request.submissionId,
          observedAt: "2026-07-17T12:00:01.000Z",
          status: "completed",
          responseId: "response-replay",
          content: "recorded response",
        },
      },
    ],
  };
  const replay = new TranscriptReplayTransport(transcript);
  assert.equal((await replay.submit(request)).status, "submitted");
  assert.equal((await replay.resolveSubmission(request)).status, "submitted");
  const result = await replay.receive(request);
  assert.equal(result.status, "completed");
  assert.equal(replay.remainingEvents, 0);
});

test("transcript replay never repairs a mismatched prompt or skips an event", async () => {
  const request = { taskId: "task", turnId: "turn", submissionId: "submission" } as const;
  const receipt: SubmissionReceipt = {
    contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
    ...request,
    status: "submitted",
    observedAt: "2026-07-17T12:00:00.000Z",
  };
  const replay = new TranscriptReplayTransport({
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    events: [{ type: "submit", ...request, contentSha256: sha256("expected"), receipt }],
  });
  await assert.rejects(replay.submit({ ...request, content: "different" }), /digest mismatch/u);

  const wrongOrder = new TranscriptReplayTransport({
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    events: [
      {
        type: "receive",
        ...request,
        result: {
          contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
          ...request,
          observedAt: "2026-07-17T12:00:00.000Z",
          status: "timed-out",
          diagnosticCode: "NO_RESPONSE",
        },
      },
    ],
  });
  await assert.rejects(
    wrongOrder.submit({ ...request, content: "expected" }),
    /event order mismatch/u,
  );
});

test("transcript replay rejects mismatched nested result correlation", async () => {
  const request = { taskId: "task", turnId: "turn", submissionId: "submission" } as const;
  const replay = new TranscriptReplayTransport({
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    events: [
      {
        type: "receive",
        ...request,
        result: {
          contractVersion: MODEL_TRANSPORT_CONTRACT_VERSION,
          taskId: "another-task",
          turnId: request.turnId,
          submissionId: request.submissionId,
          observedAt: "2026-07-17T12:00:00.000Z",
          status: "timed-out",
          diagnosticCode: "NO_RESPONSE",
        },
      },
    ],
  });
  await assert.rejects(replay.receive(request), /result correlation mismatch/u);
});
