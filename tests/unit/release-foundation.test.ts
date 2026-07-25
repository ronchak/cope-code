import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const repositoryRoot = process.cwd();
const generateScript = path.join(repositoryRoot, "scripts", "release", "generate.mjs");
const verifyScript = path.join(repositoryRoot, "scripts", "release", "verify.mjs");
const activateScript = path.join(repositoryRoot, "scripts", "release", "activate.mjs");
const compareScript = path.join(repositoryRoot, "scripts", "release", "compare.mjs");
const buildScript = path.join(repositoryRoot, "scripts", "release", "build.mjs");

test("release evidence is canonical, reproducible, SPDX-correct, and explicit about trust", async (context) => {
  const fixture = await releaseFixture(context);
  const first = await fixture.candidate("first", "stable", "alpha");
  const second = await fixture.candidate("second", "stable", "alpha");

  expectSuccess(invoke(compareScript, [first, second]));
  const verified = expectSuccess(invoke(verifyScript, [
    first,
    "--trusted-public-key",
    fixture.publicKeyFile,
  ]));
  assert.deepEqual(JSON.parse(verified.stdout), {
    verified: true,
    integrityVerified: true,
    signaturePresent: true,
    publisherAuthenticated: true,
    manifestSha256: JSON.parse(await readFile(path.join(first, "manifest.sig.json"), "utf8")).manifestSha256,
    version: "1.2.3",
    channel: "stable",
    artifact: "cope.tgz",
  });

  const sbom = JSON.parse(await readFile(path.join(first, "sbom.spdx.json"), "utf8")) as {
    packages: Array<{
      SPDXID: string;
      checksums?: Array<{ algorithm: string; checksumValue: string }>;
      filesAnalyzed: boolean;
      copyrightText: string;
    }>;
    documentDescribes: string[];
  };
  assert.equal(sbom.packages.length, 2, "development-only packages must not enter the release SBOM");
  assert.deepEqual(sbom.documentDescribes, ["SPDXRef-Package-Cope"]);
  assert.equal(sbom.packages[0]?.filesAnalyzed, false);
  assert.equal(sbom.packages[0]?.copyrightText, "NOASSERTION");
  assert.match(sbom.packages[1]?.checksums?.[0]?.checksumValue ?? "", /^[a-f0-9]{128}$/u);
  const firstSpdx = JSON.parse(await readFile(path.join(first, "sbom.spdx.json"), "utf8")) as {
    creationInfo: { created: string };
    documentNamespace: string;
  };
  assert.equal(firstSpdx.creationInfo.created, "2026-01-01T00:00:00Z");

  const baselineTimestamp = await fixture.emptyCandidate("baseline-timestamp", "alpha");
  expectSuccess(invoke(
    generateScript,
    generationArguments(fixture, baselineTimestamp, "preview"),
    { COPE_RELEASE_SIGNING_KEY_FILE: undefined },
  ));
  const baselineSpdx = JSON.parse(await readFile(path.join(baselineTimestamp, "sbom.spdx.json"), "utf8")) as {
    documentNamespace: string;
  };
  const laterTimestamp = await fixture.emptyCandidate("later-timestamp", "alpha");
  const laterArguments = generationArguments(fixture, laterTimestamp, "preview");
  laterArguments[laterArguments.indexOf("--created") + 1] = "2026-01-01T00:00:01Z";
  expectSuccess(invoke(
    generateScript,
    laterArguments,
    { COPE_RELEASE_SIGNING_KEY_FILE: undefined },
  ));
  const laterSpdx = JSON.parse(await readFile(path.join(laterTimestamp, "sbom.spdx.json"), "utf8")) as {
    documentNamespace: string;
  };
  assert.notEqual(laterSpdx.documentNamespace, baselineSpdx.documentNamespace);
  const channel = JSON.parse(await readFile(path.join(first, "channel.json"), "utf8")) as {
    signature: { status: string };
  };
  assert.equal(channel.signature.status, "present-requires-external-trust");

  const untrusted = expectSuccess(invoke(verifyScript, [first]));
  assert.equal(JSON.parse(untrusted.stdout).publisherAuthenticated, false);

  const preview = await fixture.candidate("preview", "preview", "preview", false);
  const previewResult = expectSuccess(invoke(verifyScript, [preview]));
  assert.equal(JSON.parse(previewResult.stdout).signaturePresent, false);
  expectFailure(invoke(verifyScript, [preview, "--require-signature"]), /signature is required/iu);

  const unsignedStable = await fixture.emptyCandidate("unsigned-stable", "unsigned");
  expectFailure(invokeTestGenerator(
    generationArguments(fixture, unsignedStable, "stable"),
    { COPE_RELEASE_SIGNING_KEY_FILE: undefined },
  ), /requires COPE_RELEASE_SIGNING_KEY_FILE/iu);

  for (const [name, dependencies] of [
    ["missing-lock-dependency", { example: "2.0.0", "not-in-lock": "1.0.0" }],
    ["changed-lock-dependency", { example: "9.0.0" }],
  ] as const) {
    const candidate = await fixture.emptyCandidate(name, "dependency-drift");
    const packageJson = npmPackageJson("1.2.3", { dependencies });
    await writeFile(path.join(candidate, "cope.tgz"), npmArchive([
      { archivePath: "package/package.json", content: packageJson },
      { archivePath: "package/payload.txt", content: "dependency-drift" },
    ]));
    const packageFile = path.join(fixture.root, `${name}.package.json`);
    await writeFile(packageFile, packageJson);
    const arguments_ = generationArguments(fixture, candidate, "preview");
    arguments_[arguments_.indexOf("--package") + 1] = packageFile;
    expectFailure(
      invoke(generateScript, arguments_, { COPE_RELEASE_SIGNING_KEY_FILE: undefined }),
      /root dependencies do not match package\.json/iu,
    );
  }

  const unresolvedCandidate = await fixture.emptyCandidate("unresolved-lock-dependency", "dependency-drift");
  const unresolvedPackageJson = npmPackageJson("1.2.3", {
    dependencies: { example: "2.0.0", "not-resolved": "1.0.0" },
  });
  await writeFile(path.join(unresolvedCandidate, "cope.tgz"), npmArchive([
    { archivePath: "package/package.json", content: unresolvedPackageJson },
  ]));
  const unresolvedPackageFile = path.join(fixture.root, "unresolved.package.json");
  const unresolvedLockFile = path.join(fixture.root, "unresolved.package-lock.json");
  const unresolvedLock = JSON.parse(await readFile(fixture.lockFile, "utf8")) as {
    packages: Record<string, { dependencies?: Record<string, string> }>;
  };
  unresolvedLock.packages[""]!.dependencies = { example: "2.0.0", "not-resolved": "1.0.0" };
  await writeFile(unresolvedPackageFile, unresolvedPackageJson);
  await writeFile(unresolvedLockFile, JSON.stringify(unresolvedLock));
  const unresolvedArguments = generationArguments(fixture, unresolvedCandidate, "preview");
  unresolvedArguments[unresolvedArguments.indexOf("--package") + 1] = unresolvedPackageFile;
  unresolvedArguments[unresolvedArguments.indexOf("--lock") + 1] = unresolvedLockFile;
  expectFailure(
    invoke(generateScript, unresolvedArguments, { COPE_RELEASE_SIGNING_KEY_FILE: undefined }),
    /does not resolve runtime dependency: not-resolved/iu,
  );

  for (const [name, declaredSpec, resolvedVersion, resolvedName] of [
    ["exact", "2.0.0", "2.0.0", undefined],
    ["range", "^2.0.0", "2.9.1", undefined],
    ["alias", "npm:real-example@^2.0.0", "2.4.0", "real-example"],
  ] as const) {
    const candidate = await fixture.emptyCandidate(`satisfied-${name}`, `satisfied-${name}`);
    const packageJson = npmPackageJson("1.2.3", { dependencies: { example: declaredSpec } });
    await writeFile(path.join(candidate, "cope.tgz"), npmArchive([
      { archivePath: "package/package.json", content: packageJson },
    ]));
    const packageFile = path.join(fixture.root, `satisfied-${name}.package.json`);
    const lockFile = path.join(fixture.root, `satisfied-${name}.package-lock.json`);
    const lockDocument = JSON.parse(await readFile(fixture.lockFile, "utf8")) as {
      packages: Record<string, {
        dependencies?: Record<string, string>;
        integrity?: string;
        name?: string;
        version?: string;
      }>;
    };
    lockDocument.packages[""]!.dependencies = { example: declaredSpec };
    lockDocument.packages["node_modules/example"]!.version = resolvedVersion;
    if (resolvedName !== undefined) lockDocument.packages["node_modules/example"]!.name = resolvedName;
    await writeFile(packageFile, packageJson);
    await writeFile(lockFile, JSON.stringify(lockDocument));
    const arguments_ = generationArguments(fixture, candidate, "preview");
    arguments_[arguments_.indexOf("--package") + 1] = packageFile;
    arguments_[arguments_.indexOf("--lock") + 1] = lockFile;
    expectSuccess(invoke(generateScript, arguments_, { COPE_RELEASE_SIGNING_KEY_FILE: undefined }));
  }

  const mismatchedResolution = await fixture.emptyCandidate("mismatched-resolution", "dependency-drift");
  const mismatchedPackageJson = npmPackageJson("1.2.3", { dependencies: { example: "^2.0.0" } });
  await writeFile(path.join(mismatchedResolution, "cope.tgz"), npmArchive([
    { archivePath: "package/package.json", content: mismatchedPackageJson },
  ]));
  const mismatchedPackageFile = path.join(fixture.root, "mismatched-resolution.package.json");
  const mismatchedLockFile = path.join(fixture.root, "mismatched-resolution.package-lock.json");
  const mismatchedLock = JSON.parse(await readFile(fixture.lockFile, "utf8")) as {
    packages: Record<string, {
      dependencies?: Record<string, string>;
      version?: string;
    }>;
  };
  mismatchedLock.packages[""]!.dependencies = { example: "^2.0.0" };
  mismatchedLock.packages["node_modules/example"]!.version = "9.0.0";
  await writeFile(mismatchedPackageFile, mismatchedPackageJson);
  await writeFile(mismatchedLockFile, JSON.stringify(mismatchedLock));
  const mismatchedArguments = generationArguments(fixture, mismatchedResolution, "preview");
  mismatchedArguments[mismatchedArguments.indexOf("--package") + 1] = mismatchedPackageFile;
  mismatchedArguments[mismatchedArguments.indexOf("--lock") + 1] = mismatchedLockFile;
  expectFailure(
    invoke(generateScript, mismatchedArguments, { COPE_RELEASE_SIGNING_KEY_FILE: undefined }),
    /resolved version 9\.0\.0 does not satisfy example@\^2\.0\.0/iu,
  );

  for (const [name, declaredSpec, resolvedName, pattern] of [
    ["wrong-alias-target", "npm:real-example@^2.0.0", "other-example", /alias example to the wrong package/iu],
    ["unsupported-git-spec", "git+https://example.invalid/example.git", undefined, /unsupported runtime dependency spec/iu],
  ] as const) {
    const candidate = await fixture.emptyCandidate(name, "dependency-drift");
    const packageJson = npmPackageJson("1.2.3", { dependencies: { example: declaredSpec } });
    await writeFile(path.join(candidate, "cope.tgz"), npmArchive([
      { archivePath: "package/package.json", content: packageJson },
    ]));
    const packageFile = path.join(fixture.root, `${name}.package.json`);
    const lockFile = path.join(fixture.root, `${name}.package-lock.json`);
    const lockDocument = JSON.parse(await readFile(fixture.lockFile, "utf8")) as {
      packages: Record<string, {
        dependencies?: Record<string, string>;
        name?: string;
      }>;
    };
    lockDocument.packages[""]!.dependencies = { example: declaredSpec };
    if (resolvedName !== undefined) lockDocument.packages["node_modules/example"]!.name = resolvedName;
    await writeFile(packageFile, packageJson);
    await writeFile(lockFile, JSON.stringify(lockDocument));
    const arguments_ = generationArguments(fixture, candidate, "preview");
    arguments_[arguments_.indexOf("--package") + 1] = packageFile;
    arguments_[arguments_.indexOf("--lock") + 1] = lockFile;
    expectFailure(invoke(generateScript, arguments_, { COPE_RELEASE_SIGNING_KEY_FILE: undefined }), pattern);
  }

  const largeLeft = path.join(fixture.root, "large-compare-left");
  const largeRight = path.join(fixture.root, "large-compare-right");
  await mkdir(largeLeft);
  await mkdir(largeRight);
  const largeArtifact = Buffer.alloc(3 * 1024 * 1024, 0x5a);
  await writeFile(path.join(largeLeft, "large.tgz"), largeArtifact);
  await writeFile(path.join(largeRight, "large.tgz"), largeArtifact);
  expectSuccess(invoke(compareScript, [largeLeft, largeRight]));

  await writeFile(path.join(first, "channel.json"), `${await readFile(path.join(first, "channel.json"), "utf8")} `);
  expectFailure(invoke(verifyScript, [first]), /canonical key-sorted JSON/iu);
  expectFailure(invoke(buildScript, [repositoryRoot, "preview"]), /outside the source checkout/iu);
});

test("release generation rejects traversal, links, and non-regular payload boundaries", async (context) => {
  const fixture = await releaseFixture(context);
  const traversal = await fixture.emptyCandidate("traversal", "bad");
  await writeFile(path.join(traversal, "cope.tgz"), npmArchive([
    { archivePath: "package/../escape.js", content: "escape" },
  ]));
  expectFailure(invoke(generateScript, generationArguments(fixture, traversal, "preview")), /Unsafe release archive path/iu);

  const archiveLink = await fixture.emptyCandidate("archive-link", "bad");
  await writeFile(path.join(archiveLink, "cope.tgz"), npmArchive([
    { archivePath: "package/link.js", content: "", type: "2", linkName: "../../outside" },
  ]));
  expectFailure(invoke(generateScript, generationArguments(fixture, archiveLink, "preview")), /non-regular entry type/iu);

  const nonZeroPadding = await fixture.emptyCandidate("non-zero-padding", "bad");
  const paddedArchive = await readFile(path.join(nonZeroPadding, "cope.tgz"));
  const paddedTar = gunzipSync(paddedArchive);
  paddedTar[512 + Buffer.byteLength(npmPackageJson("1.2.3"))] = 1;
  await writeFile(path.join(nonZeroPadding, "cope.tgz"), deterministicGzip(paddedTar));
  expectFailure(
    invoke(generateScript, generationArguments(fixture, nonZeroPadding, "preview")),
    /non-zero entry padding/iu,
  );

  const hiddenNumericData = await fixture.emptyCandidate("hidden-numeric-data", "bad");
  const hiddenNumericTar = gunzipSync(await readFile(path.join(hiddenNumericData, "cope.tgz")));
  hiddenNumericTar.fill(0, 108, 116);
  hiddenNumericTar[108] = 0x30;
  hiddenNumericTar[110] = 0x41;
  rewriteTarChecksum(hiddenNumericTar.subarray(0, 512));
  await writeFile(path.join(hiddenNumericData, "cope.tgz"), deterministicGzip(hiddenNumericTar));
  expectFailure(
    invoke(generateScript, generationArguments(fixture, hiddenNumericData, "preview")),
    /hidden data in its numeric uid field/iu,
  );

  const collidingPaths = await fixture.emptyCandidate("colliding-paths", "bad");
  await writeFile(path.join(collidingPaths, "cope.tgz"), npmArchive([
    { archivePath: "package/package.json", content: npmPackageJson("1.2.3") },
    { archivePath: "package/Foo.js", content: "first" },
    { archivePath: "package/foo.js", content: "second" },
  ]));
  expectFailure(
    invoke(generateScript, generationArguments(fixture, collidingPaths, "preview")),
    /collide on a portable filesystem/iu,
  );

  for (const [name, archivePath] of [
    ["drive-path", "package/C:/escape.js"],
    ["reserved-path", "package/CON.txt"],
    ["trailing-dot-path", "package/readme."],
  ] as const) {
    const candidate = await fixture.emptyCandidate(name, "bad");
    await writeFile(path.join(candidate, "cope.tgz"), npmArchive([
      { archivePath: "package/package.json", content: npmPackageJson("1.2.3") },
      { archivePath, content: "bad" },
    ]));
    expectFailure(
      invoke(generateScript, generationArguments(fixture, candidate, "preview")),
      /path is not portable/iu,
    );
  }

  const concatenated = await fixture.emptyCandidate("concatenated-gzip", "bad");
  const firstMember = await readFile(path.join(concatenated, "cope.tgz"));
  await writeFile(path.join(concatenated, "cope.tgz"), Buffer.concat([
    firstMember,
    deterministicGzip(Buffer.alloc(1024)),
  ]));
  expectFailure(
    invoke(generateScript, generationArguments(fixture, concatenated, "preview")),
    /invalid or concatenated gzip framing/iu,
  );

  for (const [name, packageJson, pattern] of [
    ["missing-package-json", undefined, /missing package\/package\.json/iu],
    ["malformed-package-json", "{", /not valid UTF-8 JSON/iu],
    ["wrong-package-name", npmPackageJson("1.2.3", { name: "not-cope" }), /does not match the source package metadata/iu],
    ["wrong-package-version", npmPackageJson("9.9.9"), /does not match the source package metadata/iu],
    ["wrong-package-bin", npmPackageJson("1.2.3", { copeBin: "other.js" }), /unexpected name, version, or executable/iu],
  ] as const) {
    const candidate = await fixture.emptyCandidate(name, "bad");
    const entries = packageJson === undefined
      ? [{ archivePath: "package/payload.txt", content: "missing" }]
      : [{ archivePath: "package/package.json", content: packageJson }];
    await writeFile(path.join(candidate, "cope.tgz"), npmArchive(entries));
    expectFailure(invoke(generateScript, generationArguments(fixture, candidate, "preview")), pattern);
  }

  const duplicatePackageJson = await fixture.emptyCandidate("duplicate-package-json", "bad");
  await writeFile(path.join(duplicatePackageJson, "cope.tgz"), npmArchive([
    { archivePath: "package/package.json", content: npmPackageJson("1.2.3") },
    { archivePath: "package/package.json", content: npmPackageJson("1.2.3") },
  ]));
  expectFailure(
    invoke(generateScript, generationArguments(fixture, duplicatePackageJson, "preview")),
    /duplicate path/iu,
  );

  const invalidDependencyName = await fixture.emptyCandidate("invalid-dependency-name", "bad");
  await writeFile(path.join(invalidDependencyName, "cope.tgz"), npmArchive([
    {
      archivePath: "package/package.json",
      content: npmPackageJson("1.2.3", {
        dependencies: JSON.parse('{"__proto__":"1.0.0"}') as Record<string, string>,
      }),
    },
  ]));
  expectFailure(
    invoke(generateScript, generationArguments(fixture, invalidDependencyName, "preview")),
    /invalid runtime dependency metadata/iu,
  );

  for (const artifactName of ["CON.tgz", "cope.tgz."]) {
    const candidate = await fixture.emptyCandidate(`top-level-${artifactName.replaceAll(".", "-")}`, "bad");
    const artifactPath = path.join(candidate, artifactName);
    await rename(path.join(candidate, "cope.tgz"), artifactPath);
    const arguments_ = generationArguments(fixture, candidate, "preview");
    arguments_[arguments_.indexOf("--artifact") + 1] = artifactPath;
    expectFailure(invoke(generateScript, arguments_), /Unsafe artifact filename/iu);
  }

  if (process.platform !== "win32") {
    const filesystemLink = await fixture.emptyCandidate("filesystem-link", "bad");
    const outside = path.join(fixture.root, "outside.tgz");
    await writeFile(outside, npmArchive([{ archivePath: "package/package.json", content: "{}" }]));
    await rm(path.join(filesystemLink, "cope.tgz"));
    await symlink(outside, path.join(filesystemLink, "cope.tgz"));
    expectFailure(invoke(generateScript, generationArguments(fixture, filesystemLink, "preview")), /not regular|regular file/iu);
  }
});

test("activation is publisher-authenticated, locked, pointer-atomic, and explicitly reversible", async (context) => {
  const fixture = await releaseFixture(context);
  const first = await fixture.candidate("candidate-one", "stable", "one");
  const second = await fixture.candidate("candidate-two", "stable", "two", true, "1.2.4");
  const firstId = await manifestDigest(first);
  const secondId = await manifestDigest(second);
  const installRoot = path.join(fixture.root, "install-root");

  const firstActivation = expectSuccess(invoke(activateScript, [
    first,
    installRoot,
    "--trusted-public-key",
    fixture.publicKeyFile,
  ]));
  assert.equal(JSON.parse(firstActivation.stdout).current, firstId);
  assert.deepEqual(await activationState(installRoot), {
    current: { manifestSha256: firstId, version: "1.2.3" },
    previous: null,
    schemaVersion: "cope-release-activation/2",
  });

  const residueDirectory = path.join(installRoot, ".staged-00000000-0000-4000-8000-000000000000");
  const residueState = path.join(installRoot, ".activation-00000000-0000-4000-8000-000000000000.json");
  await mkdir(residueDirectory);
  await writeFile(path.join(residueDirectory, "partial"), "partial");
  await writeFile(residueState, "partial");
  expectSuccess(invoke(activateScript, [
    second,
    installRoot,
    "--trusted-public-key",
    fixture.publicKeyFile,
  ]));
  assert.deepEqual(await activationState(installRoot), {
    current: { manifestSha256: secondId, version: "1.2.4" },
    previous: { manifestSha256: firstId, version: "1.2.3" },
    schemaVersion: "cope-release-activation/2",
  });
  assert.equal((await readdir(installRoot)).includes(path.basename(residueDirectory)), false);
  assert.equal((await readdir(installRoot)).includes(path.basename(residueState)), false);

  expectFailure(invoke(activateScript, [
    first,
    installRoot,
    "--trusted-public-key",
    fixture.publicKeyFile,
  ]), /refuses a signed downgrade/iu);
  assert.equal((await activationState(installRoot)).current.manifestSha256, secondId);

  await mkdir(path.join(installRoot, ".activation.lock"));
  expectFailure(invoke(activateScript, [
    first,
    installRoot,
    "--trusted-public-key",
    fixture.publicKeyFile,
  ]), /Another activation may be running/iu);
  assert.equal((await activationState(installRoot)).current.manifestSha256, secondId);
  await rm(path.join(installRoot, ".activation.lock"), { recursive: true });

  expectSuccess(invoke(activateScript, [
    "--rollback",
    installRoot,
    "--trusted-public-key",
    fixture.publicKeyFile,
  ]));
  assert.deepEqual(await activationState(installRoot), {
    current: { manifestSha256: firstId, version: "1.2.3" },
    previous: { manifestSha256: secondId, version: "1.2.4" },
    schemaVersion: "cope-release-activation/2",
  });

  const equivocation = await fixture.candidate("same-version-different-release", "stable", "different");
  expectFailure(invoke(activateScript, [
    equivocation,
    installRoot,
    "--trusted-public-key",
    fixture.publicKeyFile,
  ]), /refuses same-version release equivocation/iu);

  const rememberedEquivocation = await fixture.candidate(
    "remembered-version-different-release",
    "stable",
    "different-remembered",
    true,
    "1.2.4",
  );
  expectFailure(invoke(activateScript, [
    rememberedEquivocation,
    installRoot,
    "--trusted-public-key",
    fixture.publicKeyFile,
  ]), /refuses same-version release equivocation/iu);

  await writeFile(path.join(second, "cope.tgz"), Buffer.from("tampered"));
  expectFailure(invoke(activateScript, [
    second,
    installRoot,
    "--trusted-public-key",
    fixture.publicKeyFile,
  ]), /decompressed|gzip-compressed|digest/iu);
  assert.equal((await activationState(installRoot)).current.manifestSha256, firstId);
  assert.equal((await readdir(installRoot)).some((name) => name.startsWith(".staged-")), false);

  const inRootTrust = path.join(installRoot, "untrusted-location.pem");
  await copyFile(fixture.publicKeyFile, inRootTrust);
  expectFailure(invoke(activateScript, [
    first,
    installRoot,
    "--trusted-public-key",
    inRootTrust,
  ]), /outside the candidate and install root/iu);

  const nestedCandidate = await fixture.candidate("nested-candidate", "stable", "nested");
  await mkdir(path.join(nestedCandidate, "unbounded-tree"));
  expectFailure(invoke(activateScript, [
    nestedCandidate,
    installRoot,
    "--trusted-public-key",
    fixture.publicKeyFile,
  ]), /only four or five regular top-level files/iu);
  assert.equal((await readdir(installRoot)).some((name) => name.startsWith(".staged-")), false);
});

test("release evidence remains deliberately separate from current local installers and updater", async () => {
  const [windowsInstaller, macInstaller, updater, documentation] = await Promise.all([
    readFile(path.join(repositoryRoot, "scripts", "install-windows.ps1"), "utf8"),
    readFile(path.join(repositoryRoot, "scripts", "install-macos.sh"), "utf8"),
    readFile(path.join(repositoryRoot, "src", "cli", "update.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "docs", "RELEASE-SUPPLY-CHAIN.md"), "utf8"),
  ]);
  for (const currentSurface of [windowsInstaller, macInstaller, updater]) {
    assert.doesNotMatch(currentSurface, /release[\\/]activate\.mjs|activation\.json/iu);
  }
  assert.match(documentation, /not wired into the current installers or `cope update`/u);
  assert.match(documentation, /Neither path downloads or activates this release evidence/u);
});

interface ReleaseFixture {
  readonly root: string;
  readonly packageFile: string;
  readonly lockFile: string;
  readonly privateKeyFile: string;
  readonly publicKeyFile: string;
  emptyCandidate(name: string, content: string, version?: string): Promise<string>;
  candidate(
    name: string,
    channel: "preview" | "stable",
    content: string,
    signed?: boolean,
    version?: string,
  ): Promise<string>;
}

async function releaseFixture(context: { after(callback: () => Promise<void>): void }): Promise<ReleaseFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "cope-release-foundation-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const packageFile = path.join(root, "package.json");
  const lockFile = path.join(root, "package-lock.json");
  const integrity = Buffer.alloc(64, 0x5a).toString("base64");
  const writeMetadata = async (version: string): Promise<void> => {
    await writeFile(packageFile, JSON.stringify({
      name: "@local/copilot-browser-agent",
      version,
      bin: {
        cope: "dist/src/cli/main.js",
        "copilot-agent": "dist/src/cli/main.js",
      },
      dependencies: { example: "2.0.0" },
    }));
    await writeFile(lockFile, JSON.stringify({
      name: "@local/copilot-browser-agent",
      version,
      packages: {
        "": {
          name: "@local/copilot-browser-agent",
          version,
          dependencies: { example: "2.0.0" },
        },
        "node_modules/example": { version: "2.0.0", integrity: `sha512-${integrity}` },
        "node_modules/dev-only": { version: "3.0.0", dev: true, integrity: `sha512-${integrity}` },
      },
    }));
  };
  await writeMetadata("1.2.3");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyFile = path.join(root, "private.pem");
  const publicKeyFile = path.join(root, "public.pem");
  await writeFile(privateKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  await writeFile(publicKeyFile, publicKey.export({ type: "spki", format: "pem" }));

  const emptyCandidate = async (name: string, content: string, version = "1.2.3"): Promise<string> => {
    const output = path.join(root, name);
    await mkdir(output);
    await writeFile(path.join(output, "cope.tgz"), npmArchive([
      { archivePath: "package/package.json", content: npmPackageJson(version) },
      { archivePath: "package/payload.txt", content },
    ]));
    return output;
  };
  const fixture: ReleaseFixture = {
    root,
    packageFile,
    lockFile,
    privateKeyFile,
    publicKeyFile,
    emptyCandidate,
    candidate: async (name, channel, content, signed = true, version = "1.2.3") => {
      await writeMetadata(version);
      const output = await emptyCandidate(name, content, version);
      const environment = signed
        ? { COPE_RELEASE_SIGNING_KEY_FILE: privateKeyFile }
        : { COPE_RELEASE_SIGNING_KEY_FILE: undefined };
      const generation = signed && channel === "stable"
        ? invokeTestGenerator(generationArguments(fixture, output, channel), environment)
        : invoke(generateScript, generationArguments(fixture, output, channel), environment);
      expectSuccess(generation);
      return output;
    },
  };
  return fixture;
}

function generationArguments(fixture: Pick<ReleaseFixture, "packageFile" | "lockFile">, output: string, channel: string): string[] {
  return [
    "--output", output,
    "--package", fixture.packageFile,
    "--lock", fixture.lockFile,
    "--platform", "darwin",
    "--arch", "arm64",
    "--commit", "a".repeat(40),
    "--created", "2026-01-01T00:00:00Z",
    "--channel", channel,
    "--artifact", path.join(output, "cope.tgz"),
    "--node-version", "24.13.0",
    "--npm-version", "11.12.1",
  ];
}

function invoke(
  script: string,
  args: string[],
  changes: Record<string, string | undefined> = {},
): SpawnSyncReturns<string> {
  const environment = { ...process.env };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repositoryRoot,
    env: environment,
    encoding: "utf8",
  });
}

function invokeTestGenerator(
  args: string[],
  changes: Record<string, string | undefined> = {},
): SpawnSyncReturns<string> {
  const environment = { ...process.env };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  const moduleUrl = pathToFileURL(generateScript).href;
  const source = [
    `import { generateRelease, parseArguments } from ${JSON.stringify(moduleUrl)};`,
    "try {",
    `  const result = await generateRelease(parseArguments(${JSON.stringify(args)}), process.env, { allowTestOnlyLocalSigning: true });`,
    "  process.stdout.write(`${JSON.stringify(result)}\\n`);",
    "} catch (error) {",
    "  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\\n`);",
    "  process.exitCode = 1;",
    "}",
  ].join("\n");
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: repositoryRoot,
    env: environment,
    encoding: "utf8",
  });
}

function expectSuccess(result: SpawnSyncReturns<string>): SpawnSyncReturns<string> {
  assert.equal(result.status, 0, `process failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

function expectFailure(result: SpawnSyncReturns<string>, pattern: RegExp): void {
  assert.notEqual(result.status, 0, "process unexpectedly succeeded");
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}

async function manifestDigest(candidate: string): Promise<string> {
  const signature = JSON.parse(await readFile(path.join(candidate, "manifest.sig.json"), "utf8")) as {
    manifestSha256: string;
  };
  return signature.manifestSha256;
}

async function activationState(installRoot: string): Promise<{
  current: { manifestSha256: string; version: string };
  previous: { manifestSha256: string; version: string } | null;
  schemaVersion: string;
}> {
  return JSON.parse(await readFile(path.join(installRoot, "activation.json"), "utf8"));
}

function npmPackageJson(
  version: string,
  overrides: {
    name?: string;
    copeBin?: string;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  } = {},
): string {
  return JSON.stringify({
    name: overrides.name ?? "@local/copilot-browser-agent",
    version,
    bin: {
      cope: overrides.copeBin ?? "dist/src/cli/main.js",
      "copilot-agent": "dist/src/cli/main.js",
    },
    dependencies: overrides.dependencies ?? { example: "2.0.0" },
    ...(overrides.optionalDependencies === undefined ? {} : { optionalDependencies: overrides.optionalDependencies }),
    ...(overrides.peerDependencies === undefined ? {} : { peerDependencies: overrides.peerDependencies }),
  });
}

function npmArchive(entries: Array<{
  archivePath: string;
  content: string;
  type?: string;
  linkName?: string;
}>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content);
    const header = Buffer.alloc(512);
    writeField(header, 0, 100, entry.archivePath);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.type === "2" ? 0 : content.length);
    writeOctal(header, 136, 12, 499162500);
    header.fill(0x20, 148, 156);
    writeField(header, 156, 1, entry.type ?? "0");
    if (entry.linkName !== undefined) writeField(header, 157, 100, entry.linkName);
    writeField(header, 257, 6, "ustar");
    writeField(header, 263, 2, "00");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header);
    if (entry.type !== "2") {
      blocks.push(content);
      const padding = (512 - (content.length % 512)) % 512;
      if (padding > 0) blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return deterministicGzip(Buffer.concat(blocks));
}

function deterministicGzip(bytes: Buffer): Buffer {
  const gzip = gzipSync(bytes, { level: 9 });
  gzip[3] = 0;
  gzip.writeUInt32LE(0, 4);
  gzip[8] = 2;
  gzip[9] = 255;
  return gzip;
}

function writeField(buffer: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value);
  assert.ok(bytes.length <= length);
  bytes.copy(buffer, offset, 0, length);
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  writeField(buffer, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function rewriteTarChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.fill(0, 148, 156);
  writeField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
}
