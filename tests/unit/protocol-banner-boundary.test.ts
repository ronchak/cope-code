import assert from "node:assert/strict";
import test from "node:test";

import { responseProtocolLabels } from "../../src/browser/playwright-semantic-page.js";

test("protocol banner labels use exact Unicode-aware non-consuming boundaries", () => {
  assert.deepEqual(responseProtocolLabels("cba-agent/1"), ["cba-agent/1"]);
  assert.deepEqual(responseProtocolLabels("cba-agent/10"), ["cba-agent/10"]);
  assert.deepEqual(responseProtocolLabels("cba-agent/1.0"), ["cba-agent/1.0"]);
  assert.deepEqual(responseProtocolLabels("xcba-agent/1"), []);
  assert.deepEqual(responseProtocolLabels("cba_agent/1"), []);

  // Non-consuming assertions let two punctuation-separated labels be counted;
  // a glued pair cannot manufacture a supported first token.
  assert.deepEqual(
    responseProtocolLabels("cba-agent/1,cba/1"),
    ["cba-agent/1", "cba/1"],
  );
  assert.deepEqual(responseProtocolLabels("cba-agent/1cba/1"), []);

  // Unicode punctuation is a separator. Unicode letters, numbers, and marks
  // are identifier adjacency and therefore fail closed like ASCII letters.
  assert.deepEqual(responseProtocolLabels("“cba-agent/1”—"), ["cba-agent/1"]);
  assert.deepEqual(responseProtocolLabels("écba-agent/1"), []);
  assert.deepEqual(responseProtocolLabels("cba-agent/1界"), []);
  assert.deepEqual(responseProtocolLabels("cba-agent/1\u0301"), []);
  assert.deepEqual(responseProtocolLabels("９cba-agent/1"), []);
});
