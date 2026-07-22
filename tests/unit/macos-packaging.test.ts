import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const installPath = path.resolve("scripts/install-macos.sh");
const uninstallPath = path.resolve("scripts/uninstall-macos.sh");
const validatorPath = path.resolve("scripts/validate-macos-user-path.mjs");

test("macOS packaging wrappers are syntactically valid and preserve the user-level contract", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX wrapper validation runs on macOS/Linux lanes");
    return;
  }

  await execFileAsync("/bin/sh", ["-n", installPath]);
  await execFileAsync("/bin/sh", ["-n", uninstallPath]);
  assert.equal((await lstat(installPath)).mode & 0o111, 0o111);
  assert.equal((await lstat(uninstallPath)).mode & 0o111, 0o111);

  const installer = await readFile(installPath, "utf8");
  assert.match(installer, /Node\.js 24\+/u);
  assert.match(installer, /npm 11\+/u);
  assert.match(installer, /npm ci --no-audit --no-fund/u);
  assert.match(installer, /npm pack --json --ignore-scripts --pack-destination/u);
  assert.match(installer, /npm install --global --prefix "\$prefix"/u);
  assert.match(installer, /"\$prefix\/bin\/cope"/u);
  assert.match(installer, /--no-path-update/u);
  assert.match(installer, /Added by the Cope installer/u);
  assert.match(installer, /expected_version=.*package\.json/u);
  assert.match(installer, /"\$installed_version" = "\$expected_version"/u);
  assert.match(installer, /installed_version=\$\("\$cope_command" --version\)/u);
  assert.match(installer, /export COPE_SOURCE_DIR=/u);
  assert.match(installer, /"\$cope_command" setup/u);
  assert.doesNotMatch(installer, /(?:^|\n)\s*sudo\b/u);
  assert.doesNotMatch(installer, /playwright install|Microsoft Edge.*download/iu);

  const uninstaller = await readFile(uninstallPath, "utf8");
  assert.match(uninstaller, /npm uninstall --global --prefix "\$prefix"/u);
  assert.match(uninstaller, /--remove-state/u);
  assert.match(uninstaller, /--remove-profile/u);
  assert.match(uninstaller, /--require-existing --validate-tree/u);
  assert.match(uninstaller, /State and dedicated browser profiles were retained/u);
  assert.match(uninstaller, /CopilotBrowserAgentChromeProfile/u);
  assert.doesNotMatch(uninstaller, /(?:^|\n)\s*sudo\b/u);
  assert.doesNotMatch(uninstaller, /Microsoft Edge(?! profile)/iu);
});

test("macOS prefix validator accepts a private local descendant and rejects linked components", {
  skip: process.platform !== "darwin",
}, async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cope-prefix-validator-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, "home");
  await mkdir(home, { mode: 0o700 });
  await chmod(home, 0o700);

  const prefix = path.join(home, ".local");
  const accepted = await execFileAsync(process.execPath, [validatorPath, prefix], {
    env: { ...process.env, HOME: home },
  });
  assert.equal(accepted.stdout.trim(), path.join(await realpath(home), ".local"));

  const realDirectory = path.join(home, "real");
  const linkedDirectory = path.join(home, "linked");
  await mkdir(realDirectory, { mode: 0o700 });
  await symlink(realDirectory, linkedDirectory);
  await assert.rejects(
    execFileAsync(process.execPath, [validatorPath, path.join(linkedDirectory, "prefix")], {
      env: { ...process.env, HOME: home },
    }),
    (error: unknown) => {
      const stderr = typeof error === "object" && error !== null && "stderr" in error
        ? String(error.stderr)
        : "";
      return /not a real directory/u.test(stderr);
    },
  );

  const removalRoot = path.join(home, "removal-root");
  await mkdir(removalRoot, { mode: 0o700 });
  await symlink(realDirectory, path.join(removalRoot, "SingletonLock"));
  const removalAccepted = await execFileAsync(
    process.execPath,
    [validatorPath, removalRoot, "--require-existing", "--validate-tree"],
    { env: { ...process.env, HOME: home } },
  );
  assert.equal(removalAccepted.stdout.trim(), path.join(await realpath(home), "removal-root"));
});

test("hosted offline matrix covers all three architectures without claiming certification", async () => {
  const workflow = await readFile(path.resolve(".github/workflows/offline-matrix.yml"), "utf8");
  assert.match(workflow, /windows-2025/u);
  assert.match(workflow, /macos-26/u);
  assert.match(workflow, /macos-15-intel/u);
  assert.match(workflow, /node-version: 24/u);
  assert.match(workflow, /npm run check/u);
  assert.match(workflow, /not owner-tuple live certification/u);
  assert.match(workflow, /Isolated install and local update smoke/u);
  assert.match(workflow, /install-windows\.ps1 -SkipBuild -SkipSetup/u);
  assert.match(workflow, /GetEnvironmentVariable\("COPE_SOURCE_DIR", "User"\)/u);
  assert.match(workflow, /& \$cope update/u);
  assert.match(workflow, /SetEnvironmentVariable\("COPE_SOURCE_DIR", \$previousSource, "User"\)/u);
  assert.match(workflow, /install-macos\.sh --skip-build --skip-setup/u);
  assert.match(workflow, /uninstall-macos\.sh/u);
  assert.match(workflow, /cope clean home/u);
  assert.match(workflow, /export PATH="\$node_bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin"/u);
  assert.equal(workflow.match(/install-macos\.sh --skip-build --skip-setup/gu)?.length, 2);
});

test("macOS installer supports a spaced clean home, setup ordering, uninstall, and reinstall", {
  skip: process.platform !== "darwin",
}, async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cope-installer-smoke-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, "clean home");
  const fakeBin = path.join(temporary, "fake-bin");
  const prefix = path.join(home, "prefix with space");
  const log = path.join(temporary, "operations.log");
  await mkdir(home, { mode: 0o700 });
  await mkdir(fakeBin, { mode: 0o700 });
  await symlink(process.execPath, path.join(fakeBin, "node"));

  const npmStub = path.join(fakeBin, "npm");
  await writeFile(npmStub, `#!/bin/sh
set -eu
printf 'npm:%s\\n' "$*" >> "$SMOKE_LOG"
if [ "\${1:-}" = "--version" ]; then printf '11.0.0\\n'; exit 0; fi
operation=\${1:-}
shift || true
prefix=
destination=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) shift; prefix=$1 ;;
    --pack-destination) shift; destination=$1 ;;
  esac
  shift || true
done
case "$operation" in
  pack)
    /usr/bin/touch "$destination/fake-package.tgz"
    printf '[{"filename":"fake-package.tgz"}]\\n'
    ;;
  install)
    /bin/mkdir -p "$prefix/bin"
    /bin/cat > "$prefix/bin/cope" <<'COPE_STUB'
#!/bin/sh
set -eu
case "\${1:-}" in
  --version) printf 'version\\n' >> "$SMOKE_LOG"; printf '%s\\n' "$EXPECTED_VERSION" ;;
  setup) printf 'setup\\n' >> "$SMOKE_LOG" ;;
  *) exit 64 ;;
esac
COPE_STUB
    /bin/chmod 700 "$prefix/bin/cope"
    ;;
  uninstall)
    /bin/rm -f "$prefix/bin/cope"
    ;;
  *) exit 65 ;;
esac
`, { mode: 0o700 });
  await chmod(npmStub, 0o700);

  const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as { version: string };
  const environment = {
    ...process.env,
    HOME: home,
    COPE_INSTALL_PREFIX: prefix,
    EXPECTED_VERSION: packageJson.version,
    SMOKE_LOG: log,
    PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  await execFileAsync("/bin/sh", [installPath, "--skip-build"], { env: environment });
  const firstLog = await readFile(log, "utf8");
  assert.ok(firstLog.indexOf("version\n") < firstLog.indexOf("setup\n"), "version verification must precede setup");
  assert.equal((await execFileAsync(path.join(prefix, "bin", "cope"), ["--version"], { env: environment })).stdout.trim(), packageJson.version);
  await assert.rejects(lstat(path.join(home, ".zprofile")), { code: "ENOENT" });

  await execFileAsync("/bin/sh", [uninstallPath], { env: environment });
  await assert.rejects(lstat(path.join(prefix, "bin", "cope")), { code: "ENOENT" });
  await execFileAsync("/bin/sh", [installPath, "--skip-build", "--skip-setup"], { env: environment });
  assert.equal((await execFileAsync(path.join(prefix, "bin", "cope"), ["--version"], { env: environment })).stdout.trim(), packageJson.version);
  await execFileAsync("/bin/sh", [uninstallPath], { env: environment });

  const defaultEnvironment: NodeJS.ProcessEnv = { ...environment };
  delete defaultEnvironment.COPE_INSTALL_PREFIX;
  const defaultPrefix = path.join(home, ".local");
  await execFileAsync("/bin/sh", [installPath, "--skip-build", "--skip-setup"], { env: defaultEnvironment });
  await execFileAsync("/bin/sh", [installPath, "--skip-build", "--skip-setup"], { env: defaultEnvironment });
  const profile = await readFile(path.join(home, ".zprofile"), "utf8");
  assert.equal(profile.match(/export PATH="\$HOME\/\.local\/bin:\$PATH"/gu)?.length, 1);
  assert.equal(profile.match(/export COPE_SOURCE_DIR=/gu)?.length, 1);
  assert.equal((await execFileAsync(path.join(defaultPrefix, "bin", "cope"), ["--version"], { env: defaultEnvironment })).stdout.trim(), packageJson.version);
  await execFileAsync("/bin/sh", [uninstallPath], { env: defaultEnvironment });
});

test("build output keeps the linked-development CLI executable", {
  skip: process.platform === "win32",
}, async () => {
  const cli = await lstat(path.resolve("dist/src/cli/main.js"));
  assert.equal(cli.mode & 0o111, 0o111);
});
