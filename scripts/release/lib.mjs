import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

export const MANIFEST_VERSION = "cope-release-manifest/2";
export const CHANNEL_VERSION = "cope-release-channel/2";
export const SIGNATURE_VERSION = "cope-release-signature/2";
export const ACTIVATION_VERSION = "cope-release-activation/2";
export const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
export const MAX_METADATA_BYTES = 2 * 1024 * 1024;

export function canonicalJson(value) {
  return JSON.stringify(sortJson(value, new Set()));
}

export function canonicalJsonLine(value) {
  return `${canonicalJson(value)}\n`;
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(filename, maximumBytes = MAX_ARTIFACT_BYTES) {
  const bytes = await readRegularFile(filename, maximumBytes);
  return { bytes: bytes.length, sha256: sha256Bytes(bytes) };
}

export async function readRegularFile(filename, maximumBytes = MAX_METADATA_BYTES) {
  const before = await lstat(filename, { bigint: true });
  validateRegularStat(before, filename, maximumBytes);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(filename, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    validateRegularStat(opened, filename, maximumBytes);
    if (!sameFileSnapshot(before, opened)) throw new Error(`File changed before it was read: ${filename}`);
    const bytes = await handle.readFile();
    const afterOpen = await handle.stat({ bigint: true });
    const afterPath = await lstat(filename, { bigint: true });
    if (BigInt(bytes.length) !== opened.size ||
        !sameFileSnapshot(opened, afterOpen) ||
        !sameFileSnapshot(before, afterPath)) {
      throw new Error(`File changed while it was being read: ${filename}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function regularFileStat(filename, maximumBytes = MAX_ARTIFACT_BYTES) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${filename}`);
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maximumBytes) {
    throw new Error(`File exceeds the ${maximumBytes}-byte limit: ${filename}`);
  }
  return stat;
}

function validateRegularStat(stat, filename, maximumBytes) {
  if (!stat.isFile() || stat.isSymbolicLink() ||
      stat.size < 0n || stat.size > BigInt(maximumBytes)) {
    throw new Error(`File exceeds the ${maximumBytes}-byte limit or is not regular: ${filename}`);
  }
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

export function safeTopLevelFilename(value, label = "release filename") {
  if (typeof value !== "string" || value.length === 0 || value.length > 180 ||
      value === "." || value === ".." || value.startsWith(".") ||
      value.includes("/") || value.includes("\\") ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(value)) {
    throw new Error(`Unsafe ${label}`);
  }
  return value;
}

export function exactObjectKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
  return value;
}

export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function publicKeyId(key) {
  const publicKey = key?.type === "public" ? key : createPublicKey(key);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Release trust keys must be Ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  return `sha256:${sha256Bytes(der)}`;
}

export function signManifest(manifestBytes, privateKeyBytes) {
  const privateKey = createPrivateKey(privateKeyBytes);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Release signing keys must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  return {
    schemaVersion: SIGNATURE_VERSION,
    algorithm: "ed25519",
    keyId: publicKeyId(publicKey),
    manifestSha256: sha256Bytes(manifestBytes),
    publicKeySpki: publicKeyDer.toString("base64"),
    signature: sign(null, manifestBytes, privateKey).toString("base64"),
  };
}

export function verifyManifestSignature(manifestBytes, signature, externalPublicKey) {
  exactObjectKeys(signature, [
    "algorithm",
    "keyId",
    "manifestSha256",
    "publicKeySpki",
    "schemaVersion",
    "signature",
  ], "Release signature");
  if (signature.schemaVersion !== SIGNATURE_VERSION || signature.algorithm !== "ed25519") {
    throw new Error("Unsupported release signature");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(signature.keyId) ||
      signature.manifestSha256 !== sha256Bytes(manifestBytes)) {
    throw new Error("Release signature metadata does not match the manifest");
  }
  const embeddedDer = decodeCanonicalBase64(signature.publicKeySpki, "embedded public key");
  const signatureBytes = decodeCanonicalBase64(signature.signature, "release signature");
  if (signatureBytes.length !== 64) throw new Error("Ed25519 signatures must contain exactly 64 bytes");
  const embeddedKey = createPublicKey({ key: embeddedDer, type: "spki", format: "der" });
  if (embeddedKey.asymmetricKeyType !== "ed25519" || publicKeyId(embeddedKey) !== signature.keyId) {
    throw new Error("Embedded release public key does not match its key ID");
  }
  if (!verify(null, manifestBytes, embeddedKey, signatureBytes)) {
    throw new Error("Release manifest signature verification failed");
  }

  if (externalPublicKey === undefined) return { publisherAuthenticated: false };
  const trustedKey = createPublicKey(externalPublicKey);
  if (trustedKey.asymmetricKeyType !== "ed25519" || publicKeyId(trustedKey) !== signature.keyId) {
    throw new Error("Release signer does not match the externally trusted publisher key");
  }
  if (!verify(null, manifestBytes, trustedKey, signatureBytes)) {
    throw new Error("Release signature does not verify with the externally trusted publisher key");
  }
  return { publisherAuthenticated: true };
}

export function decodeCanonicalBase64(value, label) {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error(`Invalid base64 ${label}`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error(`Non-canonical base64 ${label}`);
  return decoded;
}

export function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sortJson(value, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error("Canonical JSON contains an unsupported number");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("Canonical JSON cannot contain cycles");
    seen.add(value);
    const sorted = value.map((entry) => sortJson(entry, seen));
    seen.delete(value);
    return sorted;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Canonical JSON only supports plain objects");
    }
    if (seen.has(value)) throw new Error("Canonical JSON cannot contain cycles");
    seen.add(value);
    const result = Object.create(null);
    for (const key of Object.keys(value).sort(compareText)) {
      const entry = value[key];
      if (entry === undefined || typeof entry === "bigint" || typeof entry === "function" || typeof entry === "symbol") {
        throw new Error(`Canonical JSON contains an unsupported value at ${key}`);
      }
      result[key] = sortJson(entry, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new Error("Canonical JSON contains an unsupported value");
}
