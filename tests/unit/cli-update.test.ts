import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  executeUpdateCommand,
  localUpdateInstallerInvocation,
  resolveLocalUpdateCheckout,
} from "../../src/cli/update.js";
import { DarwinHostPlatform, WindowsHostPlatform, type HostPlatform } from "../../src/platform/index.js";
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
    createStandardUserHost(new DarwinHostPlatform("arm64", () => 501)),
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

test("local update validates a Windows checkout and runs its PowerShell installer", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-windows-local-update-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@local/copilot-browser-agent" }), "utf8");
  await writeFile(path.join(root, "scripts", "install-windows.ps1"), "exit 0\n", "utf8");
  const canonicalRoot = await realpath(root);

  const output = new MemoryOutput();
  let observed: { installer: string; source: string; platform: string } | undefined;
  const exitCode = await executeUpdateCommand(
    { command: "update", json: false },
    { stdout: output, stderr: output },
    createStandardUserHost(new WindowsHostPlatform("x64")),
    {
      environment: { COPE_SOURCE_DIR: root },
      runInstaller: async (installer, source, _environment, platform) => {
        observed = { installer, source, platform };
        return { stdout: "installer complete\n", stderr: "" };
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(observed, {
    installer: path.join(canonicalRoot, "scripts", "install-windows.ps1"),
    source: canonicalRoot,
    platform: "win32",
  });
  assert.match(output.value, /up to date with your local checkout/u);
});

test("Windows update guidance points to the Windows installer", async () => {
  await assert.rejects(resolveLocalUpdateCheckout({}, "win32"), (error: unknown) =>
    error instanceof AgentError && /COPE_SOURCE_DIR is not set/u.test(error.message) &&
    typeof error.details.next === "string" && /install\.cmd/u.test(error.details.next) &&
    /PowerShell/u.test(error.details.next));
});

test("Windows update passes a spaced installer path as one PowerShell argument", () => {
  assert.deepEqual(localUpdateInstallerInvocation("C:\\Cope Source\\scripts\\install-windows.ps1", "win32"), {
    executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    arguments: [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\Cope Source\\scripts\\install-windows.ps1",
      "-SkipSetup",
    ],
  });
});

test("Windows update resolves system PowerShell from a case-insensitive non-default system root", () => {
  const invocation = localUpdateInstallerInvocation(
    "D:\\Cope Source\\scripts\\install-windows.ps1",
    "win32",
    { systemroot: "D:\\WINNT" },
  );
  assert.equal(invocation.executable, "D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(invocation.arguments[5], "D:\\Cope Source\\scripts\\install-windows.ps1");
});

test("Windows update rejects a non-local SystemRoot before choosing PowerShell", () => {
  const invocation = localUpdateInstallerInvocation("C:\\Cope\\scripts\\install-windows.ps1", "win32", {
    SYSTEMROOT: "\\\\server\\Windows",
  });
  assert.equal(invocation.executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
});

test("local update rejects unsupported host platforms before reading source configuration", async () => {
  const output = new MemoryOutput();
  await assert.rejects(
    executeUpdateCommand(
      { command: "update", json: false },
      { stdout: output, stderr: output },
      { platform: "linux" } as HostPlatform,
      { environment: {} },
    ),
    (error: unknown) => error instanceof AgentError && /Windows and macOS installs only/u.test(error.message),
  );
  assert.equal(output.value, "");
});
