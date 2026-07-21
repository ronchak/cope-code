import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const workflowDirectory = path.resolve(".github", "workflows");

test("release branches contain no temporary one-shot GitHub workflows", async () => {
  const entries = await readdir(workflowDirectory);
  const temporary = entries.filter((entry) => /^one-shot-.*\.ya?ml$/u.test(entry));
  assert.deepEqual(temporary, []);
});
