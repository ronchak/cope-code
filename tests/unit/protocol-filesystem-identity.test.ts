import assert from "node:assert/strict";
import test from "node:test";

import { parseProtocolEnvelope, ProtocolParseError } from "../../src/protocol/index.js";
import { createFilesystemIdentity } from "../../src/shared/filesystem-identity.js";
import { CbaProtocolAdapter } from "../../src/orchestrator/cba-protocol-adapter.js";

function wire(first: string, second: string): string {
  return [
    "```cba/1",
    JSON.stringify({
      protocol: "cba/1",
      message_type: "tool_request",
      message_id: "message_identity",
      task_id: "task_identity",
      turn_id: 1,
      operations: [{
        operation_id: "operation_identity",
        tool: "apply_patch",
        arguments: {
          changes: [
            { kind: "create", path: first, content: "first\n" },
            { kind: "create", path: second, content: "second\n" },
          ],
        },
      }],
    }),
    "```",
  ].join("\n");
}

function parse(first: string, second: string, facts: { caseSensitive: boolean; unicodeNormalizationAliases: boolean }): void {
  const identity = createFilesystemIdentity({ device: 3, ...facts });
  parseProtocolEnvelope(wire(first, second), {
    expected_task_id: "task_identity",
    expected_turn_id: 1,
    path_key: identity.pathKey,
  });
}

test("protocol mutation dedupe uses actual case and Unicode volume identity", () => {
  assert.doesNotThrow(() => parse("src/A.ts", "src/a.ts", {
    caseSensitive: true,
    unicodeNormalizationAliases: false,
  }));
  assert.throws(
    () => parse("src/A.ts", "src/a.ts", { caseSensitive: false, unicodeNormalizationAliases: false }),
    (error: unknown) => error instanceof ProtocolParseError && error.protocolCode === "SCHEMA_INVALID",
  );
  assert.throws(
    () => parse("src/caf\u00e9.ts", "src/cafe\u0301.ts", { caseSensitive: true, unicodeNormalizationAliases: true }),
    (error: unknown) => error instanceof ProtocolParseError && error.protocolCode === "SCHEMA_INVALID",
  );
  assert.doesNotThrow(() => parse("src/caf\u00e9.ts", "src/cafe\u0301.ts", {
    caseSensitive: true,
    unicodeNormalizationAliases: false,
  }));

  const sensitive = createFilesystemIdentity({ device: 4, caseSensitive: true, unicodeNormalizationAliases: false });
  assert.doesNotThrow(() => new CbaProtocolAdapter({ pathKey: sensitive.pathKey }).parseModelTurn(
    wire("src/A.ts", "src/a.ts"),
    { taskId: "task_identity", turnId: "turn_1" },
  ));
});
