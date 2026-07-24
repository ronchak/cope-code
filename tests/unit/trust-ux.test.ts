import assert from "node:assert/strict";
import test from "node:test";

import { renderHumanResult } from "../../src/cli/friendly-output.js";
import { stripAnsi } from "../../src/cli/terminal-layout.js";

test("completed output separates agent, pre-existing, validation, and disclosure evidence", () => {
  const rendered = stripAnsi(renderHumanResult({
    status: "completed",
    sessionId: "session_12345678",
    modelSummary: "Fixed it",
    handoff: {
      status: "completed",
      sessionId: "session_12345678",
      repository: { agentChangedPaths: ["src/a.ts"], preExistingChanges: ["notes.txt"], current: { entries: [] } },
      validation: [{ commandId: "test", outcome: "success" }],
      disclosures: { disclosedBytes: 42, redactionCount: 1 },
    },
  }));
  assert.match(rendered, /Completion evidence/);
  assert.match(rendered, /Agent changes: 1 file/);
  assert.match(rendered, /Pre-existing changes.*: 1/);
  assert.match(rendered, /Validation records: 1/);
  assert.match(rendered, /Disclosed bytes: 42; redactions: 1/);
  assert.match(rendered, /cope export-review session_12345678/);
  assert.match(rendered, /git diff --stat && git diff/);
});

test("paused output provides contextual resume, inspection, audit, and guarded rollback commands", () => {
  const rendered = stripAnsi(renderHumanResult({
    status: "paused", sessionId: "session_12345678", checkpointId: "checkpoint_12345678",
  }));
  assert.match(rendered, /cope resume session_12345678/);
  assert.match(rendered, /cope status session_12345678/);
  assert.match(rendered, /cope verify-audit session_12345678/);
  assert.match(rendered, /cope rollback session_12345678 --checkpoint checkpoint_12345678/);
  assert.doesNotMatch(rendered, /--force/);
});
