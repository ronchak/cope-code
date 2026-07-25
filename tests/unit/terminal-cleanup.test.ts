import assert from "node:assert/strict";
import test from "node:test";

import { cleanupTerminalRecoveryArtifacts } from "../../src/session/terminal-cleanup.js";

test("terminal cleanup attempts handoff removal when artifact clearing fails", async () => {
  let handoffRemovalCalls = 0;
  await assert.rejects(cleanupTerminalRecoveryArtifacts({
    status: "failed",
    retainSourceArtifacts: false,
    artifacts: {
      clear: async () => {
        throw new Error("artifact cleanup failed");
      },
    },
    completionHandoffs: {
      remove: async () => {
        handoffRemovalCalls += 1;
      },
    },
  }), /artifact cleanup failed/u);
  assert.equal(handoffRemovalCalls, 1);
});

test("terminal cleanup retains approved source artifacts but removes a non-completed handoff", async () => {
  let artifactClearCalls = 0;
  let handoffRemovalCalls = 0;
  await cleanupTerminalRecoveryArtifacts({
    status: "aborted",
    retainSourceArtifacts: true,
    artifacts: {
      clear: async () => {
        artifactClearCalls += 1;
      },
    },
    completionHandoffs: {
      remove: async () => {
        handoffRemovalCalls += 1;
      },
    },
  });
  assert.equal(artifactClearCalls, 0);
  assert.equal(handoffRemovalCalls, 1);
});
