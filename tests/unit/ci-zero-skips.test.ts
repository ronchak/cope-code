import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("zero-skip runner accepts passing tests and rejects a skipped safety test", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cope-zero-skips-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const passing = path.join(temporary, "passing.test.mjs");
  const skipped = path.join(temporary, "skipped.test.mjs");
  await writeFile(passing, "import test from 'node:test'; test('runs', () => {});\n");
  await writeFile(skipped, "import test from 'node:test'; test('must run', { skip: true }, () => {});\n");
  const runner = path.resolve("scripts/run-tests-without-skips.mjs");
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;

  const passResult = spawnSync(process.execPath, [runner, passing], { encoding: "utf8", env: environment });
  assert.equal(passResult.status, 0, passResult.stderr);
  const skipResult = spawnSync(process.execPath, [runner, skipped], { encoding: "utf8", env: environment });
  assert.equal(skipResult.status, 1, skipResult.stderr);
  assert.match(skipResult.stderr, /Safety test contract violated/u);
});

test("offline matrix installs pinned Chromium and runs the zero-skip safety lane", async () => {
  const workflow = await readFile(path.resolve(".github/workflows/offline-matrix.yml"), "utf8");
  assert.match(workflow, /npx --no-install playwright-core install chromium/u);
  assert.match(workflow, /npm run test:chromium-safety/u);
});
