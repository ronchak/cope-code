import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_TRANSPORT_V2_CONTRACT_VERSION,
  isModelTransportV2,
  negotiateCapabilities,
  toStringSubmission,
  type ModelTransport,
  type ModelTransportCapabilities,
} from "../../src/transport/index.js";

const capabilities: ModelTransportCapabilities = {
  contractVersion: MODEL_TRANSPORT_V2_CONTRACT_VERSION,
  transportKind: "structured-fixture",
  inputKinds: ["text"],
  outputModes: ["complete", "stream"],
  signals: ["model", "usage", "stop", "context"],
  models: [{ id: "model-a", contextWindowTokens: 200_000 }],
  maxInputBytes: 1_048_576,
};

test("v2 capability negotiation selects only advertised modes, models, and signals", () => {
  assert.deepEqual(
    negotiateCapabilities(capabilities, {
      outputMode: "stream",
      modelId: "model-a",
      requiredSignals: ["usage", "context", "usage"],
    }),
    {
      contractVersion: MODEL_TRANSPORT_V2_CONTRACT_VERSION,
      transportKind: "structured-fixture",
      outputMode: "stream",
      modelId: "model-a",
      signals: ["usage", "context"],
      maxInputBytes: 1_048_576,
    },
  );
  assert.throws(() => negotiateCapabilities(capabilities, { modelId: "unknown" }), /does not advertise model/u);
  assert.throws(
    () => negotiateCapabilities({ ...capabilities, outputModes: ["complete"] }, { outputMode: "stream" }),
    /does not support 'stream'/u,
  );
  assert.throws(
    () => negotiateCapabilities({ ...capabilities, signals: ["stop"] }, { requiredSignals: ["context"] }),
    /required signal/u,
  );
  assert.throws(
    () => negotiateCapabilities({ ...capabilities, models: [{ id: "model-a" }, { id: "model-a" }] }, {}),
    /bounded and unique/u,
  );
  assert.throws(
    () => negotiateCapabilities({ ...capabilities, maxInputBytes: 0 }, {}),
    /positive safe integers/u,
  );
});

test("typed text submissions preserve v1 correlation and idempotency fields", () => {
  assert.deepEqual(
    toStringSubmission({
      taskId: "task_1",
      turnId: "turn_1",
      submissionId: "submission_1",
      expectedConversationId: "conversation_1",
      modelId: "model-a",
      input: { kind: "text", content: "typed payload" },
    }),
    {
      taskId: "task_1",
      turnId: "turn_1",
      submissionId: "submission_1",
      expectedConversationId: "conversation_1",
      content: "typed payload",
    },
  );
});

test("v1 transports remain valid and are not mistaken for v2", () => {
  const v1 = {
    transportKind: "cba-browser",
    submit: async () => { throw new Error("not called"); },
    resolveSubmission: async () => { throw new Error("not called"); },
    receive: async () => { throw new Error("not called"); },
    emergencyStop: async () => undefined,
    close: async () => undefined,
  } satisfies ModelTransport;
  assert.equal(isModelTransportV2(v1), false);
});
