import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentError } from "../../src/shared/errors.js";
import { RepositoryBoundary } from "../../src/repository/boundary.js";
import { ContentSecurity } from "../../src/security/content-security.js";
import { DisclosureLedger } from "../../src/security/disclosure-ledger.js";
import { SecretScanner } from "../../src/security/secrets.js";
import { CommandCatalog } from "../../src/tools/command-catalog.js";
import { ProcessRunner } from "../../src/tools/process-runner.js";

test("command catalog rejects shells and Windows shims with target-compatible guidance", () => {
  for (const executable of [
    "npm.cmd",
    "C:\\Program Files\\nodejs\\npm.cmd",
    "C:\\Windows\\System32\\cmd.exe",
    "powershell.exe",
    "/bin/bash",
  ]) {
    assert.throws(
      () =>
        new CommandCatalog([
          {
            id: "unsafe",
            category: "test",
            risk: "low",
            sideEffects: false,
            networkRequired: false,
            executable,
          },
        ]),
      (error: unknown) =>
        error instanceof AgentError &&
        error.code === "CONFIG_INVALID" &&
        error.message.includes("npm-cli.js"),
      executable,
    );
  }
  assert.throws(
    () => new CommandCatalog([{
      id: "relative",
      category: "test",
      risk: "low",
      sideEffects: false,
      networkRequired: false,
      executable: "node",
    }]),
    /absolute path/,
  );
  assert.throws(
    () => new CommandCatalog([{
      id: "unc",
      category: "test",
      risk: "low",
      sideEffects: false,
      networkRequired: false,
      executable: "\\\\server\\share\\tool.exe",
    }]),
    /UNC and device paths/,
  );
});

test("command catalog deterministically validates parameter names, values, option injection, and timeout", () => {
  const catalog = new CommandCatalog([
    {
      id: "targeted-test",
      category: "test",
      risk: "low",
      sideEffects: false,
      networkRequired: false,
      executable: process.execPath,
      fixedArguments: ["test-runner.js"],
      parameters: [
        { name: "file", kind: "repository-path", flag: "--file", required: true },
        { name: "reporter", kind: "enum", flag: "--reporter", values: ["dot", "spec"] },
        { name: "repeat", kind: "integer", flag: "--repeat", minimum: 1, maximum: 3 },
        { name: "verbose", kind: "boolean", flag: "--verbose" },
      ],
      timeoutMs: 100,
      maxTimeoutMs: 500,
    },
  ]);
  const resolved = catalog.resolve({
    command_id: "targeted-test",
    parameters: { file: "tests/example.test.ts", reporter: "dot", repeat: 2, verbose: true },
    timeout_ms: 250,
  });
  assert.deepEqual(resolved.arguments, [
    "test-runner.js",
    "--file",
    "tests/example.test.ts",
    "--reporter",
    "dot",
    "--repeat",
    "2",
    "--verbose",
  ]);
  assert.deepEqual(catalog.describe("targeted-test"), {
    id: "targeted-test",
    category: "test",
    risk: "low",
    sideEffects: false,
    networkRequired: false,
    networkHosts: [],
    defaultTimeoutMs: 100,
    maxTimeoutMs: 500,
    maxOutputBytes: 256 * 1024,
    parameters: catalog.describe("targeted-test").parameters,
  });
  assert.equal(catalog.inspect("missing"), undefined);
  assert.equal("executable" in catalog.describe("targeted-test"), false);
  assert.throws(
    () => catalog.resolve({ command_id: "targeted-test", parameters: { file: "--help" } }),
    (error: unknown) => error instanceof AgentError && error.code === "POLICY_DENIED",
  );
  assert.throws(
    () =>
      catalog.resolve({
        command_id: "targeted-test",
        parameters: { file: "tests/x.ts", extra: "unapproved" },
      }),
    (error: unknown) => error instanceof AgentError && error.code === "POLICY_DENIED",
  );
  assert.throws(
    () => catalog.resolve({ command_id: "targeted-test", parameters: { file: "tests/x.ts" }, timeout_ms: 501 }),
    (error: unknown) => error instanceof AgentError && error.code === "POLICY_DENIED",
  );
});

test("command catalog fails closed on unknown fields and malformed nested configuration", () => {
  const base = {
    id: "strict",
    category: "test",
    risk: "low" as const,
    sideEffects: false,
    networkRequired: false,
    executable: process.execPath,
  };
  assert.throws(
    () => new CommandCatalog([{ ...base, surprise: true } as never]),
    (error: unknown) => error instanceof AgentError && error.code === "CONFIG_INVALID" && /unknown fields/u.test(error.message),
  );
  assert.throws(
    () => new CommandCatalog([{ ...base, fixedArguments: "--version" } as never]),
    /arguments must be an array/u,
  );
  assert.throws(
    () => new CommandCatalog([{ ...base, parameters: [null] } as never]),
    /parameter must be an object/u,
  );
  assert.throws(
    () => new CommandCatalog([{
      ...base,
      parameters: [{ name: "value", kind: "string", pattern: ".+", unexpected: 1 }],
    } as never]),
    /unknown fields/u,
  );
  assert.throws(
    () => new CommandCatalog([{
      ...base,
      parameters: [{ name: "verbose", kind: "boolean" }],
    } as never]),
    /require an explicit flag/u,
  );
  assert.throws(
    () => new CommandCatalog([{ ...base, environment: { NODE_OPTIONS: "--require=./inject.js" } }]),
    /environment entry is invalid/u,
  );
  assert.throws(
    () => new CommandCatalog([{ ...base, networkRequired: true }]),
    /network host metadata is invalid/u,
  );
});

test("process runner uses no shell, a controlled environment/cwd, bounded output, and redaction", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cba-runner-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const boundary = await RepositoryBoundary.create(root);
  const repositoryExecutable = path.join(root, "repo-controlled-tool");
  await writeFile(repositoryExecutable, "not trusted\n");
  const ledger = new DisclosureLedger("runner_session");
  const security = new ContentSecurity(new SecretScanner(), ledger);
  const catalog = new CommandCatalog([
    {
      id: "echo-parameter",
      category: "test",
      risk: "low",
      sideEffects: false,
      networkRequired: false,
      executable: process.execPath,
      fixedArguments: [
        "-e",
        "console.log(process.argv[1]); console.log('cwd=' + process.cwd()); console.log(process.env.CBA_TEST_SECRET ?? 'not-inherited'); console.error('password=abcdefghijklmnop')",
      ],
      parameters: [{ name: "value", kind: "string", pattern: "[\\s\\S]+", maxLength: 100 }],
      maxOutputBytes: 4_096,
      timeoutMs: 2_000,
    },
    {
      id: "bounded-output",
      category: "test",
      risk: "low",
      sideEffects: false,
      networkRequired: false,
      executable: process.execPath,
      fixedArguments: ["-e", "process.stdout.write('x'.repeat(10000))"],
      maxOutputBytes: 100,
      timeoutMs: 2_000,
    },
    {
      id: "truncated-secret",
      category: "test",
      risk: "low",
      sideEffects: false,
      networkRequired: false,
      executable: process.execPath,
      fixedArguments: [
        "-e",
        "process.stdout.write('x'.repeat(90) + 'ghp_abcdefghijklmnopqrstuvwxyz123456')",
      ],
      maxOutputBytes: 100,
      timeoutMs: 2_000,
    },
    {
      id: "failure",
      category: "test",
      risk: "low",
      sideEffects: false,
      networkRequired: false,
      executable: process.execPath,
      fixedArguments: ["-e", "process.exit(3)"],
      timeoutMs: 2_000,
    },
    {
      id: "repository-executable",
      category: "test",
      risk: "low",
      sideEffects: false,
      networkRequired: false,
      executable: repositoryExecutable,
      timeoutMs: 2_000,
    },
  ]);
  const runner = new ProcessRunner(boundary, catalog, { contentProcessor: security });
  process.env.CBA_TEST_SECRET = "must-not-leak";
  context.after(() => {
    delete process.env.CBA_TEST_SECRET;
  });

  const literal = "safe; echo would-have-been-shell-injection";
  const outcome = await runner.run({
    command_id: "echo-parameter",
    parameters: { value: literal },
    operationId: "command_echo",
  });
  assert.equal(outcome.outcome, "success");
  assert.equal(outcome.stdout.includes(literal), true);
  const observedCwd = outputValue(outcome.stdout, "cwd");
  const canonicalCwd = await realpath(observedCwd);
  assert.equal(boundary.pathKey(canonicalCwd), boundary.pathKey(boundary.root));
  assert.equal(outcome.stdout.includes("not-inherited"), true);
  assert.equal(outcome.stdout.includes("must-not-leak"), false);
  assert.equal(outcome.stderr.includes("abcdefghijklmnop"), false);
  assert.equal(outcome.stderr.includes("[REDACTED:credential-assignment:"), true);

  const bounded = await runner.run({ command_id: "bounded-output" });
  assert.equal(bounded.outcome, "success");
  assert.equal(Buffer.byteLength(bounded.stdout) <= 100, true);
  assert.equal(bounded.truncated, true);

  const truncatedSecret = await runner.run({ command_id: "truncated-secret" });
  assert.equal(truncatedSecret.truncated, true);
  assert.equal(truncatedSecret.stdout.includes("ghp_"), false);
  assert.equal(truncatedSecret.stdout.includes("OUTPUT_TAIL_REDACTED"), true);

  const failed = await runner.run({ command_id: "failure" });
  assert.equal(failed.outcome, "failure");
  assert.equal(failed.exitCode, 3);

  const repositoryControlled = await runner.run({ command_id: "repository-executable" });
  assert.equal(repositoryControlled.outcome, "policy-denied");
  assert.match(repositoryControlled.error ?? "", /Repository-writable executables/);
});

function outputValue(output: string, key: string): string {
  const prefix = `${key}=`;
  const line = output.split(/\r?\n/u).find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) assert.fail(`Missing ${key} output marker`);
  return line.slice(prefix.length);
}

test("process runner classifies timeout and caller cancellation and terminates the process tree", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cba-runner-stop-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const boundary = await RepositoryBoundary.create(root);
  const catalog = new CommandCatalog([
    {
      id: "wait",
      category: "test",
      risk: "low",
      sideEffects: false,
      networkRequired: false,
      executable: process.execPath,
      fixedArguments: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      timeoutMs: 80,
      maxTimeoutMs: 1_000,
    },
  ]);
  const runner = new ProcessRunner(boundary, catalog, { terminationGraceMs: 20 });
  const timeout = await runner.run({ command_id: "wait" });
  assert.equal(timeout.outcome, "timeout");

  const controller = new AbortController();
  const pending = runner.run({ command_id: "wait", timeout_ms: 1_000 }, controller.signal);
  setTimeout(() => controller.abort(), 30).unref();
  const cancelled = await pending;
  assert.equal(cancelled.outcome, "cancelled");

  const globallyStopped = runner.run({ command_id: "wait", timeout_ms: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await runner.cancelAll();
  assert.equal((await globallyStopped).outcome, "cancelled");
});
