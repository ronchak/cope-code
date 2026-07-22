import { createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AgentError } from "../shared/errors.js";
import { sha256, stableJson } from "../shared/crypto.js";
import { assertValidPolicyDocument, type PolicyDocument } from "../policy/index.js";

export const MANAGED_POLICY_BUNDLE_VERSION = "cba-managed-policy-bundle/1" as const;
export const MANAGED_POLICY_TRUST_VERSION = "cba-managed-policy-trust/1" as const;
const MAX_MANAGED_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;

export interface ManagedPolicyProvenance {
  readonly bundleVersion: typeof MANAGED_POLICY_BUNDLE_VERSION;
  readonly keyId: string;
  readonly sequence: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly bundleHash: string;
  readonly payloadHash: string;
}

export interface VerifiedManagedPolicyBundle {
  readonly organizationPolicy: PolicyDocument;
  readonly killSwitch: { readonly enabled: boolean; readonly diagnosticCode?: string };
  readonly provenance: ManagedPolicyProvenance;
}

export async function loadManagedPolicyBundle(options: {
  readonly bundleFile: string;
  readonly trustFile: string;
  readonly now?: Date;
  readonly maxAgeMs?: number;
}): Promise<VerifiedManagedPolicyBundle> {
  const bundleRaw = await readBoundedJson(options.bundleFile, "managed policy bundle");
  const trustRaw = await readBoundedJson(options.trustFile, "managed policy trust store");
  const bundle = exactRecord(bundleRaw, [
    "schema_version", "key_id", "sequence", "issued_at", "expires_at", "kill_switch",
    "organization_policy", "payload_sha256", "signature_base64",
  ], "managed policy bundle");
  const trust = exactRecord(trustRaw, ["schema_version", "keys"], "managed policy trust store");
  if (bundle.schema_version !== MANAGED_POLICY_BUNDLE_VERSION) {
    throw invalid(`Expected managed bundle schema ${MANAGED_POLICY_BUNDLE_VERSION}`);
  }
  if (trust.schema_version !== MANAGED_POLICY_TRUST_VERSION || !Array.isArray(trust.keys)) {
    throw invalid(`Expected managed trust schema ${MANAGED_POLICY_TRUST_VERSION}`);
  }
  const keyId = identifier(bundle.key_id, "key_id");
  const sequence = nonNegativeInteger(bundle.sequence, "sequence");
  const issuedAt = timestamp(bundle.issued_at, "issued_at");
  const expiresAt = timestamp(bundle.expires_at, "expires_at");
  const killSwitchRecord = exactRecord(bundle.kill_switch, ["enabled", "diagnostic_code"], "kill_switch", true);
  if (typeof killSwitchRecord.enabled !== "boolean") throw invalid("kill_switch.enabled must be boolean");
  const diagnosticCode = killSwitchRecord.diagnostic_code === undefined
    ? undefined
    : identifier(killSwitchRecord.diagnostic_code, "kill_switch.diagnostic_code");
  assertValidPolicyDocument(bundle.organization_policy);
  if (bundle.organization_policy.layer !== "organization") {
    throw invalid("Managed policy must contain an organization-layer policy");
  }
  const payload = {
    schema_version: MANAGED_POLICY_BUNDLE_VERSION,
    key_id: keyId,
    sequence,
    issued_at: issuedAt,
    expires_at: expiresAt,
    kill_switch: {
      enabled: killSwitchRecord.enabled,
      ...(diagnosticCode === undefined ? {} : { diagnostic_code: diagnosticCode }),
    },
    organization_policy: bundle.organization_policy,
  };
  const payloadHash = sha256(stableJson(payload));
  if (bundle.payload_sha256 !== payloadHash) throw invalid("Managed policy payload hash mismatch");
  if (typeof bundle.signature_base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(bundle.signature_base64)) {
    throw invalid("Managed policy signature is not canonical base64");
  }
  const keys = trust.keys.map((entry, index) => parseTrustKey(entry, index));
  const matches = keys.filter((entry) => entry.keyId === keyId);
  if (matches.length !== 1) throw invalid("Managed policy signing key is missing or ambiguous");
  let signature: Buffer;
  try {
    signature = Buffer.from(bundle.signature_base64, "base64");
    if (signature.toString("base64") !== bundle.signature_base64) throw new Error("non-canonical");
    const publicKey = createPublicKey(matches[0]!.publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519" || !verify(null, Buffer.from(stableJson(payload)), publicKey, signature)) {
      throw new Error("signature invalid");
    }
  } catch {
    throw invalid("Managed policy signature verification failed");
  }
  const now = (options.now ?? new Date()).getTime();
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) throw new TypeError("maxAgeMs must be a positive integer");
  if (issued > now + CLOCK_SKEW_MS) throw invalid("Managed policy was issued in the future");
  if (expires <= issued || expires <= now) throw invalid("Managed policy is expired or has an invalid validity window");
  if (now - issued > maxAgeMs) throw invalid("Managed policy is stale and must be refreshed");

  return {
    organizationPolicy: bundle.organization_policy,
    killSwitch: {
      enabled: killSwitchRecord.enabled,
      ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
    },
    provenance: {
      bundleVersion: MANAGED_POLICY_BUNDLE_VERSION,
      keyId,
      sequence,
      issuedAt,
      expiresAt,
      bundleHash: sha256(stableJson(bundleRaw)),
      payloadHash,
    },
  };
}

function parseTrustKey(value: unknown, index: number): { readonly keyId: string; readonly publicKeyPem: string } {
  const record = exactRecord(value, ["key_id", "algorithm", "public_key_pem"], `trust key ${index}`);
  if (record.algorithm !== "ed25519") throw invalid(`trust key ${index} must use ed25519`);
  if (typeof record.public_key_pem !== "string" || record.public_key_pem.length > 16 * 1024) {
    throw invalid(`trust key ${index} has an invalid public key`);
  }
  return { keyId: identifier(record.key_id, `trust key ${index} key_id`), publicKeyPem: record.public_key_pem };
}

async function readBoundedJson(filename: string, label: string): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filename);
  } catch {
    throw invalid(`Cannot read ${label}`);
  }
  if (bytes.length === 0 || bytes.length > MAX_MANAGED_FILE_BYTES || bytes[0] === 0xef) {
    throw invalid(`${label} is empty, oversized, or contains an unsupported BOM`);
  }
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw invalid(`${label} is not valid JSON`); }
}

function exactRecord(value: unknown, keys: readonly string[], label: string, optional = false): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key)) || (!optional && keys.some((key) => !(key in record)))) {
    throw invalid(`${label} has missing or unknown fields`);
  }
  return record;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value)) throw invalid(`${label} is invalid`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw invalid(`${label} is invalid`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(`${label} must be a non-negative integer`);
  return value as number;
}

function invalid(message: string): AgentError {
  return new AgentError("CONFIG_INVALID", message, { diagnosticCode: "MANAGED_POLICY_INVALID" });
}
