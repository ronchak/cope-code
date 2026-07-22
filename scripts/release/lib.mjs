import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const MANIFEST_VERSION = "cope-release-manifest/1";
export const CHANNEL_VERSION = "cope-release-channel/1";

export const stableJson = (value) => JSON.stringify(sort(value));
export const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const sha256File = async (filename) => sha256Bytes(await readFile(filename));
export const safeName = (value, label) => {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(value)) throw new Error(`Unsafe ${label}`);
  return value;
};
export const relativeArtifact = (root, filename) => {
  const relative = path.relative(root, filename).replaceAll(path.sep, "/");
  if (relative.startsWith("../") || path.isAbsolute(relative) || relative === "") throw new Error("Artifact escapes release root");
  return relative;
};
export const publicKeyId = (publicKey) => sha256Bytes(createPublicKey(publicKey).export({ type: "spki", format: "der" }));
export const signManifest = (manifestBytes, privateKeyPem) => {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Release signing key must be Ed25519");
  return {
    algorithm: "ed25519",
    keyId: publicKeyId(privateKey),
    signature: sign(null, manifestBytes, privateKey).toString("base64"),
    publicKey: createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString(),
  };
};
export const verifyManifestSignature = (manifestBytes, signature) => {
  if (signature.algorithm !== "ed25519" || publicKeyId(signature.publicKey) !== signature.keyId) return false;
  return verify(null, manifestBytes, signature.publicKey, Buffer.from(signature.signature, "base64"));
};
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
  }
  return value;
}
