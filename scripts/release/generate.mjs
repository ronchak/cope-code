#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { CHANNEL_VERSION, MANIFEST_VERSION, relativeArtifact, safeName, sha256Bytes, sha256File, signManifest, stableJson } from "./lib.mjs";

const options = parse(process.argv.slice(2));
const output = path.resolve(options.output);
await mkdir(output, { recursive: true, mode: 0o755 });
const packageDocument = JSON.parse(await readFile(path.resolve(options.package), "utf8"));
const lock = JSON.parse(await readFile(path.resolve(options.lock), "utf8"));
const artifacts = await Promise.all(options.artifacts.sort().map(async (item) => {
  const filename = path.resolve(item);
  const bytes = (await readFile(filename)).length;
  return { path: relativeArtifact(output, filename), bytes, sha256: await sha256File(filename) };
}));
const dependencies = Object.entries(lock.packages ?? {}).filter(([name]) => name !== "").map(([name, entry]) => ({
  SPDXID: `SPDXRef-${sha256Bytes(name).slice(0, 16)}`, name: name.replace(/^node_modules\//u, ""),
  versionInfo: entry.version ?? "unknown", downloadLocation: entry.resolved ?? "NOASSERTION",
  checksums: entry.integrity ? [{ algorithm: "SHA512", checksumValue: entry.integrity.replace(/^sha512-/u, "") }] : [],
})).sort((a, b) => a.name.localeCompare(b.name));
const sbom = {
  spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT",
  name: `${packageDocument.name}-${packageDocument.version}`, documentNamespace: `https://cope.invalid/spdx/${packageDocument.version}/${options.platform}/${options.arch}`,
  creationInfo: { created: options.created, creators: ["Tool: cope-release-generator/1"] }, packages: dependencies,
};
await writeFile(path.join(output, "sbom.spdx.json"), `${stableJson(sbom)}\n`, { mode: 0o644 });
const manifest = {
  schemaVersion: MANIFEST_VERSION, product: "cope", version: packageDocument.version,
  platform: safeName(options.platform, "platform"), arch: safeName(options.arch, "architecture"),
  createdAt: options.created, sourceCommit: safeName(options.commit, "source commit"), artifacts,
  sbom: { path: "sbom.spdx.json", sha256: await sha256File(path.join(output, "sbom.spdx.json")) },
};
const manifestBytes = Buffer.from(`${stableJson(manifest)}\n`);
await writeFile(path.join(output, "manifest.json"), manifestBytes, { mode: 0o644 });
let signature = null;
if (process.env.COPE_RELEASE_SIGNING_KEY_FILE) {
  signature = signManifest(manifestBytes, await readFile(process.env.COPE_RELEASE_SIGNING_KEY_FILE, "utf8"));
  await writeFile(path.join(output, "manifest.sig.json"), `${stableJson(signature)}\n`, { mode: 0o644 });
}
const channel = {
  schemaVersion: CHANNEL_VERSION, channel: safeName(options.channel, "channel"), version: packageDocument.version,
  platform: options.platform, arch: options.arch, manifestSha256: sha256Bytes(manifestBytes),
  signing: signature === null ? { status: "unsigned-development" } : { status: "signed", algorithm: signature.algorithm, keyId: signature.keyId },
};
await writeFile(path.join(output, "channel.json"), `${stableJson(channel)}\n`, { mode: 0o644 });
process.stdout.write(`${JSON.stringify({ output, signed: signature !== null })}\n`);

function parse(args) {
  const result = { artifacts: [] };
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i]; const value = args[i + 1];
    if (key === "--artifact" && value) { result.artifacts.push(value); i += 1; }
    else if (key?.startsWith("--") && value) { result[key.slice(2).replaceAll("-", "_")] = value; i += 1; }
    else throw new Error(`Invalid release argument: ${key}`);
  }
  for (const key of ["output", "package", "lock", "platform", "arch", "commit", "created", "channel"]) if (!result[key]) throw new Error(`Missing --${key.replaceAll("_", "-")}`);
  if (result.artifacts.length === 0) throw new Error("At least one --artifact is required");
  if (!Number.isFinite(Date.parse(result.created))) throw new Error("--created must be ISO-8601");
  return result;
}
