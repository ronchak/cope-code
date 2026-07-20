import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeDoctorCommand } from "../../src/cli/doctor.js";
import {
  isNpmCliEntryPoint,
  probeNpmVersion,
  runDoctorProbe,
} from "../../src/cli/doctor-probe.js";
import {
  CURRENT_HOST_PLATFORM,
  WindowsHostPlatform,
} from "../../src/platform/index.js";

const host = new WindowsHostPlatform("x64");

test("doctor resolves and executes the real npm CLI on the current target runner", async () => {
  const result = await probeNpmVersion(CURRENT_HOST_PLATFORM, process.cwd());

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+(?:[-+].*)?$/u);
  assert.equal(result.npmCli === undefined ? false : isNpmCliEntryPoint(result.npmCli), true);
});

test("doctor runs npm's JavaScript CLI through Node instead of spawning npm.cmd", async () => {
  const npmCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  let observedExecutable: string | undefined;
  let observedArguments: readonly string[] | undefined;
  let observedWindowsHide: boolean | undefined;

  const result = await probeNpmVersion(host, "C:\\repo", {
    resolveNpmCli: async () => npmCli,
    runProbe: async (executable, args, _cwd, _environment, windowsHide) => {
      observedExecutable = executable;
      observedArguments = args;
      observedWindowsHide = windowsHide;
      return { exitCode: 0, stdout: "11.13.0\n", stderr: "" };
    },
  });

  assert.equal(observedExecutable, process.execPath);
  assert.deepEqual(observedArguments, [npmCli, "--version"]);
  assert.equal(observedWindowsHide, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "11.13.0\n");
});

test("doctor never mistakes pnpm, Yarn, or a generic Corepack shim for npm", async () => {
  assert.equal(isNpmCliEntryPoint("C:\\corepack\\pnpm.cjs"), false);
  assert.equal(isNpmCliEntryPoint("C:\\corepack\\yarn.js"), false);
  assert.equal(isNpmCliEntryPoint("C:\\tools\\npm-cli.js"), false);
  assert.equal(isNpmCliEntryPoint("C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"), true);

  let invoked = false;
  const result = await probeNpmVersion(host, "C:\\repo", {
    resolveNpmCli: async () => "C:\\corepack\\pnpm.cjs",
    runProbe: async () => {
      invoked = true;
      return { exitCode: 0, stdout: "10.0.0\n", stderr: "" };
    },
  });

  assert.equal(invoked, false);
  assert.equal(result.exitCode, null);
  assert.match(result.stderr, /not npm\/bin\/npm-cli\.js/u);
});

test("doctor converts spawn failures into failed probe results", async () => {
  const result = await runDoctorProbe(
    async () => {
      throw Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });
    },
    "C:\\invalid.exe",
    [],
    "C:\\repo",
    host,
  );

  assert.equal(result.exitCode, null);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /spawn EINVAL/u);
});

test("doctor completes its report instead of crashing when Windows probes cannot spawn", async (context) => {
  const stateHome = await mkdtemp(path.join(os.tmpdir(), "cope-doctor-spawn-"));
  context.after(async () => rm(stateHome, { recursive: true, force: true }));
  let output = "";

  const exitCode = await executeDoctorCommand(
    { command: "doctor", repository: process.cwd(), stateHome, json: true },
    {
      stdout: { write: (value) => { output += value; } },
      stderr: { write: () => undefined },
    },
    host,
    {
      resolveNpmCli: async () => "C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      runProbe: async () => {
        throw Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });
      },
    },
  );

  assert.equal(exitCode, 1);
  const report = JSON.parse(output) as {
    readonly ok?: boolean;
    readonly checks?: readonly { readonly name?: string; readonly detail?: string }[];
  };
  assert.equal(report.ok, false);
  assert.equal(report.checks?.some((check) => check.name === "npm" && /spawn EINVAL/u.test(check.detail ?? "")), true);
  assert.equal(report.checks?.some((check) => check.name === "Git"), true);
  assert.equal(report.checks?.some((check) => check.name === "Project"), true);
});
