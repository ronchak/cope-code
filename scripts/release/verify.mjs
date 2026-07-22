#!/usr/bin/env node
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { CHANNEL_VERSION, MANIFEST_VERSION, sha256Bytes, sha256File, verifyManifestSignature } from "./lib.mjs";

const root = path.resolve(process.argv[2] ?? "");
const requireSignature = process.argv.includes("--require-signature");
const trustedKeyIndex = process.argv.indexOf("--trusted-key-id");
const trustedKeyId = trustedKeyIndex < 0 ? undefined : process.argv[trustedKeyIndex + 1];
const manifestBytes = await readFile(path.join(root, "manifest.json"));
const manifest = JSON.parse(manifestBytes);
if (manifest.schemaVersion !== MANIFEST_VERSION || !Array.isArray(manifest.artifacts)) throw new Error("Unsupported release manifest");
const expectedFiles = new Set(["manifest.json", "channel.json", "sbom.spdx.json", ...manifest.artifacts.map((entry) => entry.path)]);
for (const entry of [...manifest.artifacts, manifest.sbom]) {
  if (!entry || typeof entry.path !== "string" || entry.path.includes("..") || entry.path.includes("/") || path.isAbsolute(entry.path)) throw new Error("Unsafe manifest path");
  const filename = path.join(root, entry.path);
  if (!(await lstat(filename)).isFile()) throw new Error(`Release payload is not a regular file: ${entry.path}`);
  if (await sha256File(filename) !== entry.sha256) throw new Error(`Digest mismatch: ${entry.path}`);
}
let signature;
try { signature = JSON.parse(await readFile(path.join(root, "manifest.sig.json"), "utf8")); } catch (error) {
  if (error.code !== "ENOENT" || requireSignature) throw new Error("A trusted release signature is required", { cause: error });
}
if (signature) expectedFiles.add("manifest.sig.json");
const actualFiles = await readdir(root);
if (actualFiles.length !== expectedFiles.size || actualFiles.some((name) => !expectedFiles.has(name))) throw new Error("Release directory contains unexpected entries");
if (signature && !verifyManifestSignature(manifestBytes, signature)) throw new Error("Release signature verification failed");
if (trustedKeyId !== undefined && signature?.keyId !== trustedKeyId) throw new Error("Release signer is not trusted");
const channel = JSON.parse(await readFile(path.join(root, "channel.json"), "utf8"));
if (channel.schemaVersion !== CHANNEL_VERSION || channel.manifestSha256 !== sha256Bytes(manifestBytes) ||
    channel.version !== manifest.version || channel.platform !== manifest.platform || channel.arch !== manifest.arch) {
  throw new Error("Release channel metadata does not match the manifest");
}
process.stdout.write(`${JSON.stringify({ verified: true, signed: signature !== undefined, version: manifest.version, platform: manifest.platform, arch: manifest.arch })}\n`);
