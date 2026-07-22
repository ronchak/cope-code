import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadManagedPolicyBundle, MANAGED_POLICY_BUNDLE_VERSION, MANAGED_POLICY_TRUST_VERSION } from "../../src/config/managed-policy.js";
import { loadRuntimeConfiguration } from "../../src/config/loader.js";
import {
  createDefaultSessionGrant,
  DEFAULT_ORGANIZATION_POLICY,
  DEFAULT_REPOSITORY_POLICY,
  PolicyEngine,
  type PolicyDocument,
} from "../../src/policy/index.js";
import { sha256, stableJson } from "../../src/shared/crypto.js";

const NOW = new Date("2026-07-21T12:00:00.000Z");

test("managed policy verifies Ed25519 integrity and carries source-free provenance", async () => {
  const fixture = await signedFixture();
  const loaded = await loadManagedPolicyBundle({ ...fixture, now: NOW });
  assert.equal(loaded.organizationPolicy.policy_id, "managed-test");
  assert.equal(loaded.provenance.keyId, "test-key-1");
  assert.equal(loaded.provenance.sequence, 42);
  assert.match(loaded.provenance.bundleHash, /^[a-f0-9]{64}$/u);
});

test("managed organization policy remains stricter than repository and session grants", async () => {
  const fixture = await signedFixture({
    policy: {
      ...DEFAULT_ORGANIZATION_POLICY,
      policy_id: "managed-deny",
      capabilities: { ...DEFAULT_ORGANIZATION_POLICY.capabilities, tools: { deny: ["apply_patch"] } },
    },
  });
  const managed = await loadManagedPolicyBundle({ ...fixture, now: NOW });
  const engine = new PolicyEngine({
    organization: managed.organizationPolicy,
    repository: DEFAULT_REPOSITORY_POLICY,
    session: createDefaultSessionGrant({
      grant_id: "grant_12345678", task_id: "task_12345678", repository_root: "/repo",
      mode: "auto", tools: ["apply_patch"], writable_paths: ["**"],
    }),
  });
  assert.equal(engine.evaluate({
    tool: "apply_patch", paths: [{ path: "src/a.ts", access: "write" }],
    change: { files_changed: 1, changed_lines: 1, creates: 0, deletes: 0, dependency_manifest: false, local_commit: false },
    projected_usage: emptyUsage(),
  }).decision, "deny");
});

test("tampered, expired, stale, and untrusted managed bundles fail closed", async () => {
  const tampered = await signedFixture();
  const parsed = JSON.parse(await readText(tampered.bundleFile)) as Record<string, unknown>;
  parsed.sequence = 43;
  await writeFile(tampered.bundleFile, `${stableJson(parsed)}\n`, { mode: 0o600 });
  await assert.rejects(() => loadManagedPolicyBundle({ ...tampered, now: NOW }), /hash mismatch/u);

  const expired = await signedFixture({ expiresAt: "2026-07-21T11:59:59.000Z" });
  await assert.rejects(() => loadManagedPolicyBundle({ ...expired, now: NOW }), /expired/u);

  const stale = await signedFixture({ issuedAt: "2026-07-01T12:00:00.000Z", expiresAt: "2026-08-01T12:00:00.000Z" });
  await assert.rejects(() => loadManagedPolicyBundle({ ...stale, now: NOW }), /stale/u);

  const untrusted = await signedFixture();
  const trust = JSON.parse(await readText(untrusted.trustFile)) as { keys: Array<Record<string, unknown>> };
  trust.keys[0]!.key_id = "different-key";
  await writeFile(untrusted.trustFile, `${stableJson(trust)}\n`, { mode: 0o600 });
  await assert.rejects(() => loadManagedPolicyBundle({ ...untrusted, now: NOW }), /missing or ambiguous/u);
});

test("verified managed kill switch blocks configuration before repository access", async () => {
  const fixture = await signedFixture({ killSwitchEnabled: false, diagnosticCode: "INCIDENT_42" });
  await assert.rejects(() => loadRuntimeConfiguration({
    repositoryRoot: path.join(path.dirname(fixture.bundleFile), "missing-repository"),
    stateHome: path.dirname(path.dirname(fixture.bundleFile)),
    requireBrowser: false,
    managedPolicyBundleFile: fixture.bundleFile,
    managedPolicyTrustFile: fixture.trustFile,
    now: NOW,
  }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "TRANSPORT_UNAVAILABLE");
    assert.equal((error as { details?: { diagnosticCode?: string } }).details?.diagnosticCode, "INCIDENT_42");
    return true;
  });
});

async function signedFixture(options: {
  readonly policy?: PolicyDocument;
  readonly issuedAt?: string;
  readonly expiresAt?: string;
  readonly killSwitchEnabled?: boolean;
  readonly diagnosticCode?: string;
} = {}): Promise<{ readonly bundleFile: string; readonly trustFile: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "cba-managed-policy-"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const payload = {
    schema_version: MANAGED_POLICY_BUNDLE_VERSION,
    key_id: "test-key-1",
    sequence: 42,
    issued_at: options.issuedAt ?? "2026-07-21T11:00:00.000Z",
    expires_at: options.expiresAt ?? "2026-07-22T12:00:00.000Z",
    kill_switch: {
      enabled: options.killSwitchEnabled ?? true,
      ...(options.diagnosticCode === undefined ? {} : { diagnostic_code: options.diagnosticCode }),
    },
    organization_policy: options.policy ?? { ...DEFAULT_ORGANIZATION_POLICY, policy_id: "managed-test" },
  };
  const bundle = {
    ...payload,
    payload_sha256: sha256(stableJson(payload)),
    signature_base64: sign(null, Buffer.from(stableJson(payload)), privateKey).toString("base64"),
  };
  const trust = {
    schema_version: MANAGED_POLICY_TRUST_VERSION,
    keys: [{
      key_id: "test-key-1",
      algorithm: "ed25519",
      public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    }],
  };
  const bundleFile = path.join(root, "managed-policy-bundle.json");
  const trustFile = path.join(root, "managed-policy-trust.json");
  await writeFile(bundleFile, `${stableJson(bundle)}\n`, { mode: 0o600 });
  await writeFile(trustFile, `${stableJson(trust)}\n`, { mode: 0o600 });
  return { bundleFile, trustFile };
}

async function readText(filename: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(filename, "utf8");
}

function emptyUsage() {
  return {
    elapsed_ms: 0, turns: 0, operations: 0, read_files: 0, changed_files: 0, changed_lines: 0,
    disclosed_bytes: 0, commands: 0, command_output_bytes: 0, protocol_repairs: 0,
  } as const;
}
