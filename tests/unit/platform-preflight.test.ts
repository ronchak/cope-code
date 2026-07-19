import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  offlineTransportWarnings,
  runHostEligibilityPreflight,
  runMachinePreflight,
} from "../../src/preflight/machine.js";
import { DEFAULT_GIT_EXECUTABLE } from "../../src/repository/boundary.js";
import { AgentError } from "../../src/shared/errors.js";
import { DarwinHostPlatform, WindowsHostPlatform } from "../../src/platform/index.js";

test("Windows machine preflight preserves probe order and emits no offline warning", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-preflight-windows-order-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  initializeGitRepository(root);
  const calls: string[] = [];
  const host = new WindowsHostPlatform("x64");
  const result = await runMachinePreflight({
    repositoryRoot: root,
    liveBrowser: false,
    host,
    gitExecutable: DEFAULT_GIT_EXECUTABLE,
    runProbe: async (executable, args) => {
      calls.push(`${executable} ${args.join(" ")}`);
      if (executable === "whoami.exe") {
        return { exitCode: 0, stdout: '"Medium","S-1-16-8192"', stderr: "" };
      }
      if (args.length === 1 && args[0] === "--version") {
        return { exitCode: 0, stdout: "git version 2.50.0\n", stderr: "" };
      }
      return { exitCode: 0, stdout: `${root}\n`, stderr: "" };
    },
  });
  assert.equal(calls.filter((call) => call.startsWith("whoami.exe ")).length, 1);
  assert.equal(calls[0]?.startsWith("whoami.exe "), true);
  assert.equal(calls.length, 3);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(offlineTransportWarnings(host), []);
});

test("Darwin GUI eligibility is revalidated at machine preflight after an earlier guided check", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cba-preflight-darwin-recheck-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  let checks = 0;
  const base = new DarwinHostPlatform("arm64", () => 501);
  const host = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "verifyEligibility") return async () => {
        checks += 1;
        if (checks > 1) {
          throw new AgentError("TRANSPORT_UNAVAILABLE", "Aqua session changed", {
            diagnosticCode: "DARWIN_GUI_SESSION_UNAVAILABLE",
          });
        }
        return { standardUserVerified: true, guiSessionVerified: true };
      };
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  await runHostEligibilityPreflight({ liveBrowser: true, cwd: root, host });
  await assert.rejects(
    runMachinePreflight({ repositoryRoot: root, liveBrowser: true, host }),
    (error: unknown) =>
      error instanceof AgentError && error.details.diagnosticCode === "DARWIN_GUI_SESSION_UNAVAILABLE",
  );
  assert.equal(checks, 2);
});

function initializeGitRepository(root: string): void {
  const initialized = spawnSync(DEFAULT_GIT_EXECUTABLE, ["init", "-q", root], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(initialized.status, 0, initialized.stderr);
}
