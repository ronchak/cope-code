import assert from "node:assert/strict";
import test from "node:test";

import { createBaselineCopilotUiContract } from "../../src/browser/config.js";

test("manual authentication evidence is tied to controls or containers, never free page text", () => {
  const contract = createBaselineCopilotUiContract("Synthetic Work Account");

  for (const signal of ["signed-out", "mfa", "consent"] as const) {
    assert.equal(
      contract.groups[signal].candidates.some((candidate) => candidate.kind === "text"),
      false,
      `${signal} must not be satisfied by conversation text`,
    );
  }

  assert.equal(
    contract.groups.mfa.candidates.some((candidate) =>
      candidate.kind === "role" &&
      ["textbox", "status", "alert"].includes(candidate.role)),
    true,
  );
  assert.equal(
    contract.groups.consent.candidates.some((candidate) =>
      candidate.kind === "role" &&
      ["dialog", "alertdialog"].includes(candidate.role)),
    true,
  );
});
