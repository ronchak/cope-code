import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DarwinHostPlatform,
  UnsupportedHostPlatform,
  WindowsHostPlatform,
  selectHostPlatform,
  type ProbeRunner,
} from "../../src/platform/index.js";
import { AgentError } from "../../src/shared/errors.js";
import { executeCommand } from "../../src/cli/commands.js";

test("Windows host preserves state, Edge, Git, and probe-environment order", () => {
  const host = new WindowsHostPlatform("x64");
  const environment = {
    LOCALAPPDATA: "C:\\Users\\preview\\AppData\\Local",
    ProgramFiles: "D:\\Program Files",
    "ProgramFiles(x86)": "D:\\Program Files (x86)",
    COPE_EDGE_EXECUTABLE: "E:\\Edge\\msedge.exe",
    PATH: "controlled-path",
    Path: "controlled-Path",
    PATHEXT: ".EXE;.CMD",
    SYSTEMROOT: "C:\\Windows",
    WINDIR: "C:\\Windows",
    TEMP: "C:\\Temp",
    SECRET: "must-not-pass",
  } satisfies NodeJS.ProcessEnv;
  assert.equal(host.stateHome(environment), "C:\\Users\\preview\\AppData\\Local\\CopilotBrowserAgent");
  assert.deepEqual(host.edgeExecutableCandidates(environment), [
    "E:\\Edge\\msedge.exe",
    "D:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "D:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Users\\preview\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ]);
  assert.deepEqual(host.gitExecutableCandidates(environment), [
    "C:\\Users\\preview\\AppData\\Local\\Programs\\Git\\cmd\\git.exe",
    "D:\\Program Files\\Git\\cmd\\git.exe",
    "D:\\Program Files (x86)\\Git\\cmd\\git.exe",
    "git",
  ]);
  const probeEnvironment = host.probeEnvironment(environment);
  assert.equal(probeEnvironment.PATH, "controlled-path");
  assert.equal(probeEnvironment.Path, "controlled-Path");
  assert.equal(probeEnvironment.SECRET, undefined);
  assert.equal(host.supportsDirectoryFsync, false);
  assert.equal(host.caseInsensitiveByDefault, true);
  assert.equal(host.nullDevice, "NUL");
});

test("Windows host refuses high integrity and accepts a medium token", async () => {
  const host = new WindowsHostPlatform();
  let observedWindowsHide = false;
  let observedExecutable = "";
  const highProbe: ProbeRunner = async (executable, _args, _cwd, _env, windowsHide) => {
    observedExecutable = executable;
    observedWindowsHide = windowsHide;
    return { exitCode: 0, stdout: '"High Mandatory Level","S-1-16-12288"', stderr: "" };
  };
  await assert.rejects(
    host.verifyEligibility({ liveBrowser: true, cwd: "C:\\repo", runProbe: highProbe }),
    (error: unknown) =>
      error instanceof AgentError &&
      error.code === "POLICY_DENIED" &&
      error.message === "The agent refuses to run from an elevated Windows process",
  );
  assert.equal(observedExecutable, "whoami.exe");
  assert.equal(observedWindowsHide, true);
  const mediumProbe: ProbeRunner = async () => ({ exitCode: 0, stdout: '"Medium","S-1-16-8192"', stderr: "" });
  assert.deepEqual(
    await host.verifyEligibility({ liveBrowser: false, cwd: "C:\\repo", runProbe: mediumProbe }),
    { standardUserVerified: true, guiSessionVerified: false },
  );
});

test("Darwin host uses tuple-scoped paths, rejects root, and verifies Aqua ownership", async () => {
  const rootHost = new DarwinHostPlatform("arm64", () => 0);
  assert.throws(
    () => rootHost.assertNonPrivileged(),
    (error: unknown) =>
      error instanceof AgentError &&
      error.code === "ELEVATED_EXECUTION_REFUSED" &&
      error.details.diagnosticCode === "DARWIN_ROOT_REFUSED",
  );
  const host = new DarwinHostPlatform("x64", () => 501);
  assert.equal(
    host.stateHome({ HOME: "/Users/preview" }),
    "/Users/preview/Library/Application Support/CopilotBrowserAgent",
  );
  assert.deepEqual(host.edgeExecutableCandidates({ HOME: "/Users/preview" }), [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Users/preview/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ]);
  assert.equal(host.nullDevice, "/dev/null");
  const calls: string[] = [];
  const probe: ProbeRunner = async (executable) => {
    calls.push(executable);
    if (executable.endsWith("sw_vers")) return { exitCode: 0, stdout: "15.7.7\n", stderr: "" };
    if (executable.endsWith("stat")) return { exitCode: 0, stdout: "501\n", stderr: "" };
    return { exitCode: 0, stdout: "gui domain", stderr: "" };
  };
  assert.deepEqual(
    await host.verifyEligibility({ liveBrowser: true, cwd: "/repo", runProbe: probe }),
    { standardUserVerified: true, guiSessionVerified: true },
  );
  assert.deepEqual(calls, ["/usr/bin/sw_vers", "/usr/bin/stat", "/bin/launchctl"]);
});

test("unsupported hosts remain offline-only", async () => {
  const host = new UnsupportedHostPlatform("linux", "x64");
  await assert.rejects(
    host.verifyEligibility({ liveBrowser: true, cwd: "/repo", runProbe: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }),
    (error: unknown) => error instanceof AgentError && error.code === "TRANSPORT_UNAVAILABLE",
  );
  assert.equal(selectHostPlatform("linux", "x64").liveBrowserSupported, false);
});

test("Darwin live eligibility rejects malformed probes and unsupported architectures", async () => {
  const malformedVersion = new DarwinHostPlatform("arm64", () => 501);
  await assert.rejects(
    malformedVersion.verifyEligibility({
      liveBrowser: false,
      cwd: "/repo",
      runProbe: async () => ({ exitCode: 0, stdout: "14garbage\n", stderr: "" }),
    }),
    (error: unknown) =>
      error instanceof AgentError && error.details.diagnosticCode === "DARWIN_VERSION_UNSUPPORTED",
  );
  const unsupported = new DarwinHostPlatform("ppc64", () => 501);
  await assert.rejects(
    unsupported.verifyEligibility({
      liveBrowser: true,
      cwd: "/repo",
      runProbe: async () => ({ exitCode: 0, stdout: "15.7.7\n", stderr: "" }),
    }),
    (error: unknown) =>
      error instanceof AgentError && error.details.diagnosticCode === "DARWIN_ARCHITECTURE_UNSUPPORTED",
  );
  const malformedConsole = new DarwinHostPlatform("x64", () => 501);
  await assert.rejects(
    malformedConsole.verifyEligibility({
      liveBrowser: true,
      cwd: "/repo",
      runProbe: async (executable) => executable.endsWith("sw_vers")
        ? { exitCode: 0, stdout: "15.7.7\n", stderr: "" }
        : executable.endsWith("stat")
          ? { exitCode: 0, stdout: "501garbage\n", stderr: "" }
          : { exitCode: 0, stdout: "gui domain", stderr: "" },
    }),
    (error: unknown) =>
      error instanceof AgentError && error.details.diagnosticCode === "DARWIN_GUI_SESSION_UNAVAILABLE",
  );
});

test("interactive Darwin GUI refusal occurs before workspace or preference writes", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cope-interactive-host-refusal-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const stateHome = path.join(root, "state");
  const repository = path.join(root, "workspace");
  const host = new DarwinHostPlatform("arm64", () => 501);
  const originalPath = process.env.PATH;
  process.env.PATH = originalPath;
  await assert.rejects(
    executeCommand({
      command: "interactive",
      repository,
      repositoryExplicit: true,
      mode: "edit",
      modeExplicit: true,
      transport: "edge",
      continueRecent: false,
      initialObjective: "synthetic task",
      acceptanceCriteria: [],
      approveGrant: false,
      stateHome,
      json: true,
    }, { stdout: { write: () => undefined }, stderr: { write: () => undefined } }, { host: new Proxy(host, {
      get(target, property, receiver) {
        if (property === "verifyEligibility") {
          return async () => { throw new AgentError("TRANSPORT_UNAVAILABLE", "No Aqua session", { diagnosticCode: "DARWIN_GUI_SESSION_UNAVAILABLE" }); };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) }),
    (error: unknown) =>
      error instanceof AgentError && error.details.diagnosticCode === "DARWIN_GUI_SESSION_UNAVAILABLE",
  );
  await assert.rejects(stat(stateHome), { code: "ENOENT" });
  await assert.rejects(stat(repository), { code: "ENOENT" });
});

test("sessions command resolves its default state only through the injected host", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cope-injected-state-root-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const injectedState = path.join(root, "injected-state");
  const sessionDirectory = path.join(injectedState, "sessions", "session_injected_1234");
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(path.join(sessionDirectory, "session.json"), JSON.stringify({
    sessionId: "session_injected_1234",
    objective: "injected host session",
    repositoryRoot: root,
    updatedAt: "2026-07-18T00:00:00.000Z",
    status: "paused",
    mode: "edit",
  }));
  const base = new UnsupportedHostPlatform("linux", "x64");
  const host = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "stateHome") return () => injectedState;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  let output = "";
  assert.equal(await executeCommand(
    { command: "sessions", all: true, json: true },
    { stdout: { write: (value) => { output += value; } }, stderr: { write: () => undefined } },
    { host },
  ), 0);
  assert.match(output, /injected host session/u);
});
