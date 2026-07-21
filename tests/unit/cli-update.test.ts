import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executeUpdateCommand, resolveLocalUpdateCheckout } from "../../src/cli/update.js";
import { AgentError } from "../../src/shared/errors.js";
import { createStandardUserHost } from "../helpers/standard-user-host.js";

class MemoryOutput {
  public value = "";
  public write(value: string): void { this.value += value; }
}

test("local update validates the configured checkout and runs its installer", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-local-update-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@local/copilot-browser-agent" }), "utf8");
  const installer = path.join(root, "scripts", "install-macos.sh");
  await writeFile(installer, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(installer, 0o700);
  const canonicalRoot = await realpath(root);

  const output = new MemoryOutput();
  let observed: { installer: string; source: string; environment: NodeJS.ProcessEnv } | undefined;
  const exitCode = await executeUpdateCommand(
    { command: "update", json: false },
    { stdout: output, stderr: output },
    createStandardUserHost(),
    {
      environment: { COPE_SOURCE_DIR: root },
      runInstaller: async (installerPath, source, environment) => {
        observed = { installer: installerPath, source, environment };
        return { stdout: "installer complete\n", stderr: "" };
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(observed?.installer, path.join(canonicalRoot, "scripts", "install-macos.sh"));
  assert.equal(observed?.source, canonicalRoot);
  assert.equal(observed?.environment.COPE_SOURCE_DIR, canonicalRoot);
  assert.match(output.value, /Updating Cope/u);
  assert.match(output.value, /up to date with your local checkout/u);
});

test("local update explains how to recover when its source environment is missing", async () => {
  await assert.rejects(resolveLocalUpdateCheckout({}), (error: unknown) =>
    error instanceof AgentError && /COPE_SOURCE_DIR is not set/u.test(error.message) &&
    typeof error.details.next === "string" && /install-macos\.sh/u.test(error.details.next));
});
