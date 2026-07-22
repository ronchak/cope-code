import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = process.cwd();
const generate = path.join(root, "scripts/release/generate.mjs");
const verify = path.join(root, "scripts/release/verify.mjs");
const activate = path.join(root, "scripts/release/activate.mjs");

test("release metadata is reproducible, signed when configured, and fails closed on tampering", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "cope-release-"));
  const output = path.join(temporary, "out");
  await mkdir(output);
  const artifact = path.join(output, "cope.tgz");
  await writeFile(artifact, "artifact", "utf8");
  const fixturePackage = path.join(temporary, "package.json");
  const fixtureLock = path.join(temporary, "package-lock.json");
  await writeFile(fixturePackage, JSON.stringify({ name: "cope", version: "1.2.3" }));
  await writeFile(fixtureLock, JSON.stringify({ packages: { "node_modules/example": { version: "2.0.0", resolved: "https://example.invalid/example.tgz" } } }));
  const { privateKey } = generateKeyPairSync("ed25519");
  const keyFile = path.join(temporary, "key.pem");
  await writeFile(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  const args = [generate, "--output", output, "--package", fixturePackage, "--lock", fixtureLock,
    "--platform", "darwin", "--arch", "arm64", "--commit", "a".repeat(40),
    "--created", "2026-01-01T00:00:00.000Z", "--channel", "preview", "--artifact", artifact];
  assert.equal(spawnSync(process.execPath, args, { env: { ...process.env, COPE_RELEASE_SIGNING_KEY_FILE: keyFile } }).status, 0);
  const firstManifest = await readFile(path.join(output, "manifest.json"), "utf8");
  assert.equal(spawnSync(process.execPath, [verify, output, "--require-signature"]).status, 0);
  const signature = JSON.parse(await readFile(path.join(output, "manifest.sig.json"), "utf8")) as { keyId: string };
  const installRoot = path.join(temporary, "install");
  await mkdir(path.join(installRoot, "current"), { recursive: true });
  await writeFile(path.join(installRoot, "current", "prior.txt"), "prior");
  assert.equal(spawnSync(process.execPath, [activate, output, installRoot], {
    env: { ...process.env, COPE_RELEASE_TRUSTED_KEY_ID: signature.keyId },
  }).status, 0);
  assert.equal(await readFile(path.join(installRoot, "previous", "prior.txt"), "utf8"), "prior");
  assert.equal(await readFile(path.join(installRoot, "current", "manifest.json"), "utf8"), firstManifest);
  assert.equal(spawnSync(process.execPath, args, { env: { ...process.env, COPE_RELEASE_SIGNING_KEY_FILE: keyFile } }).status, 0);
  assert.equal(await readFile(path.join(output, "manifest.json"), "utf8"), firstManifest);
  await writeFile(artifact, "tampered", "utf8");
  assert.notEqual(spawnSync(process.execPath, [verify, output, "--require-signature"]).status, 0);
});

test("unsigned development metadata is explicit and production verification rejects it", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "cope-unsigned-"));
  const output = path.join(temporary, "out"); await mkdir(output);
  const artifact = path.join(output, "cope.tgz"); await writeFile(artifact, "artifact");
  const fixturePackage = path.join(temporary, "package.json"); await writeFile(fixturePackage, JSON.stringify({ name: "cope", version: "1.0.0" }));
  const fixtureLock = path.join(temporary, "package-lock.json"); await writeFile(fixtureLock, JSON.stringify({ packages: {} }));
  const args = [generate, "--output", output, "--package", fixturePackage, "--lock", fixtureLock,
    "--platform", "windows", "--arch", "x64", "--commit", "b".repeat(40),
    "--created", "2026-01-01T00:00:00.000Z", "--channel", "preview", "--artifact", artifact];
  assert.equal(spawnSync(process.execPath, args).status, 0);
  assert.match(await readFile(path.join(output, "channel.json"), "utf8"), /unsigned-development/);
  assert.equal(spawnSync(process.execPath, [verify, output]).status, 0);
  assert.notEqual(spawnSync(process.execPath, [verify, output, "--require-signature"]).status, 0);
});
