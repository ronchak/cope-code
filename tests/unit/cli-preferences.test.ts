import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadPreferences, preferencesPath, updatePreferences } from "../../src/cli/preferences.js";

test("Cope preferences default safely and persist project and mode", async (context) => {
  const stateHome = await mkdtemp(path.join(tmpdir(), "cope-preferences-"));
  context.after(async () => rm(stateHome, { recursive: true, force: true }));

  assert.deepEqual(await loadPreferences(stateHome), {
    schema_version: "cope-preferences/1",
    mode: "edit",
  });

  const repository = path.join(stateHome, "project");
  const updated = await updatePreferences(stateHome, { mode: "inspect", lastRepository: repository });
  assert.equal(updated.mode, "inspect");
  assert.equal(updated.last_repository, path.resolve(repository));
  assert.deepEqual(await loadPreferences(stateHome), updated);

  const stored = JSON.parse(await readFile(preferencesPath(stateHome), "utf8")) as Record<string, unknown>;
  assert.equal(stored.schema_version, "cope-preferences/1");
});

test("corrupt or incompatible preferences fall back instead of blocking startup", async (context) => {
  const stateHome = await mkdtemp(path.join(tmpdir(), "cope-preferences-corrupt-"));
  context.after(async () => rm(stateHome, { recursive: true, force: true }));
  await writeFile(preferencesPath(stateHome), "{not json", "utf8");
  assert.equal((await loadPreferences(stateHome)).mode, "edit");
});
