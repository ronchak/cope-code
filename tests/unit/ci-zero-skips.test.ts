import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("zero-skip runner accepts passing tests and rejects a skipped safety test", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cope-zero-skips-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const passing = path.join(temporary, "passing.test.mjs");
  const noisy = path.join(temporary, "noisy.test.mjs");
  const skipped = path.join(temporary, "skipped.test.mjs");
  await writeFile(passing, "import test from 'node:test'; test('runs', () => {});\n");
  await writeFile(
    noisy,
    "import test from 'node:test'; test('diagnostic output is not a skip', () => console.log('# SKIP in output'));\n",
  );
  await writeFile(skipped, "import test from 'node:test'; test('must run', { skip: true }, () => {});\n");
  const runner = path.resolve("scripts/run-tests-without-skips.mjs");
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;

  const usageResult = spawnSync(process.execPath, [runner], { encoding: "utf8", env: environment });
  assert.equal(usageResult.status, 2, usageResult.stderr);
  assert.match(usageResult.stderr, /Usage:/u);
  const passResult = spawnSync(process.execPath, [runner, passing], { encoding: "utf8", env: environment });
  assert.equal(passResult.status, 0, passResult.stderr);
  const noisyResult = spawnSync(process.execPath, [runner, noisy], { encoding: "utf8", env: environment });
  assert.equal(noisyResult.status, 0, noisyResult.stderr);
  const skipResult = spawnSync(process.execPath, [runner, skipped], { encoding: "utf8", env: environment });
  assert.equal(skipResult.status, 1, skipResult.stderr);
  assert.match(skipResult.stderr, /Safety test contract violated/u);
});

test("Chromium safety command covers the current 15-test inventory", async () => {
  const manifest = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const command = manifest.scripts?.["test:chromium-safety"];
  assert.equal(
    command,
    "npm run build && node scripts/run-tests-without-skips.mjs --manifest tests/chromium-safety-manifest.json",
  );
  const safetyManifest = JSON.parse(
    await readFile(path.resolve("tests/chromium-safety-manifest.json"), "utf8"),
  ) as {
    sourceFiles: string[];
    expectedTestCount: number;
  };
  assert.deepEqual(safetyManifest.sourceFiles, [
    "tests/unit/playwright-identity-ambiguity.test.ts",
    "tests/unit/playwright-native-dialog-race.test.ts",
  ]);
  assert.equal(safetyManifest.expectedTestCount, 15);

  const validator = path.resolve("scripts/validate-chromium-safety-inventory.mjs");
  const validation = spawnSync(
    process.execPath,
    [validator, path.resolve("tests/chromium-safety-manifest.json"), path.resolve(".")],
    { encoding: "utf8" },
  );
  assert.equal(validation.status, 0, validation.stderr);

  const missingBrowser = path.resolve("dist/tests/missing-chromium");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    COPE_TEST_CHROMIUM_EXECUTABLE: missingBrowser,
  };
  delete environment.NODE_TEST_CONTEXT;
  const inventory = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=tap",
      ...safetyManifest.sourceFiles.map((source) =>
        path.resolve("dist", source.replace(/\.ts$/u, ".js"))),
    ],
    { encoding: "utf8", env: environment },
  );
  assert.equal(inventory.status, 0, inventory.stderr);
  assert.match(inventory.stdout, new RegExp(`^# tests ${safetyManifest.expectedTestCount}$`, "mu"));
  assert.match(inventory.stdout, new RegExp(`^# skipped ${safetyManifest.expectedTestCount}$`, "mu"));
});

test("Chromium inventory validation rejects an omitted runtime test file", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cope-chromium-inventory-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const unitDirectory = path.join(temporary, "tests", "unit");
  await mkdir(unitDirectory, { recursive: true });
  const runtimeImport = [
    'import test from "node:test"',
    "import {",
    "  chromium as testChromium,",
    '} from "playwright-core"',
    "const browserUnavailable = true",
    "void testChromium",
    'test("must run with Chromium", { skip: browserUnavailable }, () => {})',
    "",
  ].join("\n");
  await writeFile(path.join(unitDirectory, "listed.test.ts"), runtimeImport);
  await writeFile(path.join(unitDirectory, "omitted.test.ts"), runtimeImport);
  await writeFile(
    path.join(temporary, "manifest.json"),
    `${JSON.stringify({
      sourceFiles: ["tests/unit/listed.test.ts"],
      expectedTestCount: 1,
    })}\n`,
  );

  const validator = path.resolve("scripts/validate-chromium-safety-inventory.mjs");
  const validation = spawnSync(
    process.execPath,
    [validator, path.join(temporary, "manifest.json"), temporary],
    { encoding: "utf8" },
  );
  assert.equal(validation.status, 1);
  assert.match(validation.stderr, /manifest omits runtime Chromium test files: tests\/unit\/omitted\.test\.ts/u);
});

test("manifested zero-skip runner rejects fewer tests than declared", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cope-chromium-count-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const sourceDirectory = path.join(temporary, "tests", "unit");
  const buildDirectory = path.join(temporary, "dist", "tests", "unit");
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(buildDirectory, { recursive: true });
  await writeFile(
    path.join(sourceDirectory, "counted.test.ts"),
    'import { chromium } from "playwright-core"\nvoid chromium\n',
  );
  await writeFile(
    path.join(buildDirectory, "counted.test.js"),
    'import test from "node:test";\ntest("only one", () => {});\n',
  );
  await writeFile(
    path.join(temporary, "manifest.json"),
    `${JSON.stringify({
      sourceFiles: ["tests/unit/counted.test.ts"],
      expectedTestCount: 2,
    })}\n`,
  );

  const runner = path.resolve("scripts/run-tests-without-skips.mjs");
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [runner, "--manifest", path.join(temporary, "manifest.json")],
    { cwd: temporary, encoding: "utf8", env: environment },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected 2 tests, but TAP reported 1/u);
});

test("offline matrix provisions the pinned browser once on every hosted tuple", async () => {
  const workflow = await readFile(path.resolve(".github/workflows/offline-matrix.yml"), "utf8");
  const tuples = [...workflow.matchAll(/^\s+- tuple: (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(tuples, ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"]);
  assert.equal(
    (workflow.match(/^\s{10}PLAYWRIGHT_BROWSERS_PATH: \$\{\{ runner\.temp \}\}\/playwright-browsers$/gmu) ?? [])
      .length,
    3,
  );
  assert.doesNotMatch(workflow, /^\s{6}PLAYWRIGHT_BROWSERS_PATH:/mu);
  assert.match(workflow, /npx --no-install playwright-core install --no-shell chromium/u);
  assert.equal((workflow.match(/npm run test:chromium-safety/gu) ?? []).length, 1);

  const checkIndex = workflow.indexOf("npm run check");
  const installIndex = workflow.indexOf("npx --no-install playwright-core install --no-shell chromium");
  const safetyIndex = workflow.indexOf("npm run test:chromium-safety");
  assert.ok(checkIndex > 0);
  assert.ok(installIndex > checkIndex);
  assert.ok(safetyIndex > installIndex);
  assert.match(workflow, /push:\n\s+branches: \[main\]\n\s+pull_request:/u);
  assert.match(workflow, /cancel-in-progress: true/u);
  assert.match(workflow, /timeout-minutes: 20/u);
});
