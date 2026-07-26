import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("soak wrapper invokes npm's JavaScript CLI through Node on every platform", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cope-reliability-runner-"));
  try {
    const capture = path.join(root, "capture.json");
    const fakeNpm = path.join(root, "npm-cli.mjs");
    await writeFile(
      fakeNpm,
      "import { writeFileSync } from 'node:fs';" +
        "writeFileSync(process.env.COPE_CAPTURE, JSON.stringify({" +
        "argv:process.argv.slice(2),iterations:process.env.COPE_RELIABILITY_ITERATIONS}));\n",
    );
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      npm_execpath: fakeNpm,
      COPE_CAPTURE: capture,
    };
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/run-reliability.mjs"), "--iterations", "7"],
      { encoding: "utf8", env: environment },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), {
      argv: ["run", "test:reliability"],
      iterations: "7",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
