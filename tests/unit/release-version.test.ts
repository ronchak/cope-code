import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { CLI_VERSION } from "../../src/cli/commands.js";

const execFileAsync = promisify(execFile);
const verifier = path.resolve("scripts/verify-release-version.mjs");

test("release version is derived from synchronized package metadata", async () => {
  const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as { version: string };
  assert.equal(CLI_VERSION, packageJson.version);
  const result = await execFileAsync(process.execPath, [verifier], { cwd: process.cwd() });
  assert.match(result.stdout, new RegExp(`Release version ${escapeRegExp(packageJson.version)} is synchronized\\.`, "u"));
});

test("release verifier rejects package-lock drift", async (context) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "cope-release-version-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  await copyReleaseSurfaces(temporary);

  const lockFile = path.join(temporary, "package-lock.json");
  const packageLock = JSON.parse(await readFile(lockFile, "utf8")) as {
    version: string;
    packages: { "": { version: string } };
  };
  packageLock.packages[""].version = "9.9.9";
  await writeFile(lockFile, `${JSON.stringify(packageLock, null, 2)}\n`, "utf8");

  await assert.rejects(
    execFileAsync(process.execPath, [verifier], { cwd: temporary }),
    (error: unknown) => processError(error).includes('package-lock.json packages[""] version must match package.json'),
  );
});

test("release verifier rejects a manually duplicated active version", async (context) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "cope-release-literal-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  await copyReleaseSurfaces(temporary);

  const installer = path.join(temporary, "scripts/install-windows.ps1");
  await writeFile(installer, `${await readFile(installer, "utf8")}\n# See RELEASE-NOTES-9.9.9.md.\n`, "utf8");
  await assert.rejects(
    execFileAsync(process.execPath, [verifier], { cwd: temporary }),
    (error: unknown) => processError(error).includes("scripts/install-windows.ps1 contains release-like version literal(s): 9.9.9"),
  );
});

test("release verifier limits non-release inventory exceptions to their recorded occurrence", async (context) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "cope-release-allowance-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  await copyReleaseSurfaces(temporary);

  const windowsTarget = path.join(temporary, "docs/WINDOWS-TARGET.md");
  await writeFile(windowsTarget, `${await readFile(windowsTarget, "utf8")}\nCurrent release is 24.17.0.\n`, "utf8");
  await assert.rejects(
    execFileAsync(process.execPath, [verifier], { cwd: temporary }),
    (error: unknown) => processError(error).includes("docs/WINDOWS-TARGET.md contains release-like version literal(s): 24.17.0"),
  );
});

test("Windows installer binds packed and installed versions to package.json", async () => {
  const installer = await readFile(path.resolve("scripts/install-windows.ps1"), "utf8");
  assert.match(installer, /Read-PackageVersion \(Join-Path \$ProjectRoot "package\.json"\)/u);
  assert.match(installer, /\$packedRelease\.version -ne \$ExpectedVersion/u);
  assert.match(installer, /\$installedVersion -ne \$ExpectedVersion/u);
});

async function copyReleaseSurfaces(target: string): Promise<void> {
  for (const filename of [
    "package.json",
    "package-lock.json",
    "src/cli/commands.ts",
    "scripts/install-windows.ps1",
    "scripts/install-macos.sh",
    "START-HERE.txt",
    "docs/WINDOWS-TARGET.md",
    "tests/unit/cli-user-experience.test.ts",
  ]) {
    const destination = path.join(target, filename);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.resolve(filename), destination);
  }
}

function processError(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const stderr = "stderr" in error ? String(error.stderr) : "";
  const message = "message" in error ? String(error.message) : "";
  return `${message}\n${stderr}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
