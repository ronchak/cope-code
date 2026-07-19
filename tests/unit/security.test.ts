import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentError } from "../../src/shared/errors.js";
import { ContentSecurity } from "../../src/security/content-security.js";
import { DisclosureLedger } from "../../src/security/disclosure-ledger.js";
import { ProtectedPathPolicy } from "../../src/security/protected-paths.js";
import { SecretScanner } from "../../src/security/secrets.js";
import {
  loadFingerprintKey,
  loadOrCreateFingerprintKey,
} from "../../src/security/fingerprint-key.js";

test("secret scanner detects high-confidence forms and redacts deterministically without retaining values", () => {
  const scanner = new SecretScanner();
  const source = [
    "const token = 'ghp_abcdefghijklmnopqrstuvwxyz123456';",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    "password=supersecretvalue123",
  ].join("\n");
  const first = scanner.redact(source);
  const second = scanner.redact(source);
  assert.equal(first.redactionCount, 3);
  assert.equal(first.content, second.content);
  assert.equal(first.content.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(first.content.includes("supersecretvalue123"), false);
  assert.equal(first.content.includes("[REDACTED:github-token:"), true);
  assert.throws(
    () => scanner.assertNoSecrets(source),
    (error: unknown) => error instanceof AgentError && error.code === "POLICY_DENIED",
  );
});

test("content security blocks repository secrets, redacts command output, and records source-free ledger metadata", async () => {
  const ledger = new DisclosureLedger("session_security");
  const security = new ContentSecurity(new SecretScanner(), ledger, { classification: "internal" });
  await assert.rejects(
    security.process({
      operationId: "read_secret",
      source: "repository-file",
      path: "src/config.ts",
      content: "api_key=abcdefghijklmnop",
    }),
    (error: unknown) => error instanceof AgentError && error.code === "POLICY_DENIED",
  );
  const command = await security.process({
    operationId: "command_1",
    source: "command-output",
    content: "password=abcdefghijklmnop",
  });
  assert.equal(command.redactionCount, 1);
  assert.equal(command.content.includes("abcdefghijklmnop"), false);
  const serialized = await security.inspectAndSerialize("safe final envelope", { kind: "tool_result" });
  assert.equal(serialized, "safe final envelope");
  assert.equal(ledger.records().length, 3);
  assert.equal(ledger.records()[0]?.disclosed, false);
  assert.equal(ledger.records()[1]?.disclosed, true);
  assert.equal(ledger.records().every((record) => record.classification === "internal"), true);
  assert.equal(JSON.stringify(ledger.records()).includes("abcdefghijklmnop"), false);
  assert.equal(ledger.verifyIntegrity(), true);
});

test("persistent disclosure ledger is hash chained and tamper evident", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-disclosure-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const outputFile = path.join(temporary, "ledger.jsonl");
  const ledger = new DisclosureLedger("session_file", { outputFile });
  await ledger.record({
    operationId: "one",
    source: "tool-result",
    content: "safe content",
    originalByteCount: 12,
  });
  await ledger.record({
    operationId: "two",
    source: "repository-search",
    path: "src/file.ts",
    content: "other safe content",
    originalByteCount: 18,
  });
  assert.equal(await DisclosureLedger.verifyFile(outputFile), true);
  await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      ledger.record({
        operationId: `parallel_${String(index)}`,
        source: "tool-result",
        content: `value ${String(index)}`,
        originalByteCount: 7,
      }),
    ),
  );
  assert.equal(ledger.verifyIntegrity(), true);
  assert.equal(await DisclosureLedger.verifyFile(outputFile), true);
  const raw = await readFile(outputFile, "utf8");
  await writeFile(outputFile, raw.replace('"operationId":"one"', '"operationId":"evil"'));
  assert.equal(await DisclosureLedger.verifyFile(outputFile), false);
});

test("persistent disclosure ledger resumes the existing chain", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-disclosure-resume-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const outputFile = path.join(temporary, "ledger.jsonl");
  const first = new DisclosureLedger("session_file", { outputFile });
  const original = await first.record({
    operationId: "before_restart",
    source: "tool-result",
    content: "first",
    originalByteCount: 5,
  });
  const resumed = new DisclosureLedger("session_file", { outputFile });
  await resumed.initialize();
  const appended = await resumed.record({
    operationId: "after_restart",
    source: "tool-result",
    content: "second",
    originalByteCount: 6,
  });
  assert.equal(appended.previousRecordHash, original.recordHash);
  assert.equal(resumed.records().length, 2);
  assert.equal(await DisclosureLedger.verifyFile(outputFile), true);
});

test("protected path defaults cover trust, credential, key, and deployment controls", () => {
  const policy = new ProtectedPathPolicy();
  for (const protectedPath of [
    ".git/config",
    ".GIT/CONFIG",
    ".copilot-agent/session.json",
    ".cba/session.json",
    ".env",
    "config/.env.production",
    "private.pem",
    ".github/workflows/release.yml",
  ]) {
    assert.throws(
      () => policy.assertAllowed(protectedPath, "update"),
      (error: unknown) => error instanceof AgentError && error.code === "PATH_PROTECTED",
      protectedPath,
    );
  }
  assert.doesNotThrow(() => policy.assertAllowed("src/index.ts", "update"));

  const unicodePolicy = new ProtectedPathPolicy([{ pattern: "private/café.txt" }], false);
  assert.throws(
    () => unicodePolicy.assertAllowed("PRIVATE/cafe\u0301.txt", "read"),
    (error: unknown) => error instanceof AgentError && error.code === "PATH_PROTECTED",
  );
});

test("per-session fingerprint key is stable and rejects corrupt persisted state", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-fingerprint-key-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const filename = path.join(temporary, "fingerprint.key");
  const first = await loadOrCreateFingerprintKey(filename);
  assert.deepEqual(await loadFingerprintKey(filename), first);
  const second = await loadOrCreateFingerprintKey(filename);
  assert.deepEqual(second, first);
  await writeFile(filename, "short", "utf8");
  await assert.rejects(() => loadOrCreateFingerprintKey(filename), /malformed/);
  await rm(filename);
  await assert.rejects(() => loadFingerprintKey(filename), /unavailable/);
});
