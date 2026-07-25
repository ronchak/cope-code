import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_ORGANIZATION_POLICY,
  DEFAULT_REPOSITORY_POLICY,
  PolicyEngine,
  createDefaultSessionGrant,
  zeroPolicyBudgetUsage,
} from "../../src/policy/index.js";
import { LayeredRuntimePolicy } from "../../src/orchestrator/runtime-policy.js";
import { RepositoryBoundary } from "../../src/repository/boundary.js";
import { CommandCatalog } from "../../src/tools/command-catalog.js";
import { sha256 } from "../../src/shared/crypto.js";
import type { ToolName } from "../../src/protocol/index.js";

async function harness(
  mode: "inspect" | "edit" | "auto" = "auto",
  options: {
    readonly tools?: readonly ToolName[];
    readonly maxMutationFileBytes?: number;
    readonly maxPatchBytes?: number;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "cba-policy-adapter-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.txt"), "old\nvalue\n", "utf8");
  const boundary = await RepositoryBoundary.create(root);
  const catalog = new CommandCatalog([
    {
      id: "test",
      category: "test",
      risk: "low",
      sideEffects: false,
      networkRequired: false,
      executable: process.execPath,
      fixedArguments: ["--version"],
    },
  ]);
  const session = createDefaultSessionGrant({
    grant_id: "grant_1",
    task_id: "task_1",
    repository_root: root,
    mode,
    writable_paths: ["src/**"],
    command_ids: ["test"],
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  });
  const policy = new LayeredRuntimePolicy({
    engine: new PolicyEngine({
      organization: DEFAULT_ORGANIZATION_POLICY,
      repository: DEFAULT_REPOSITORY_POLICY,
      session,
    }),
    boundary,
    commandCatalog: catalog,
    currentUsage: zeroPolicyBudgetUsage,
    ...(options.maxMutationFileBytes === undefined
      ? {}
      : { maxMutationFileBytes: options.maxMutationFileBytes }),
    ...(options.maxPatchBytes === undefined ? {} : { maxPatchBytes: options.maxPatchBytes }),
  });
  return { root, policy, boundary, catalog };
}

test("layered runtime policy allows in-scope reads, patches, and catalog commands", async () => {
  const { policy } = await harness();
  assert.equal((await policy.authorize({ operationId: "op_read", name: "read_file", arguments: { path: "src/a.txt", max_bytes: 20 } })).outcome, "allow");
  assert.equal((await policy.authorize({
    operationId: "op_patch",
    name: "apply_patch",
    arguments: { changes: [{ kind: "update", path: "src/a.txt", content: "new\nvalue\n", base_sha256: "0".repeat(64) }] },
  })).outcome, "allow");
  assert.equal((await policy.authorize({ operationId: "op_test", name: "run_command", arguments: { command_id: "test" } })).outcome, "allow");
  assert.equal(policy.isPathInScope("src/a.txt"), true);
  assert.equal(policy.isPathInScope("README.md"), false);
});

test("layered runtime policy denies protected controls and inspect-mode mutation", async () => {
  const { policy } = await harness("inspect");
  const inspectDenied = await policy.authorize({
    operationId: "op_patch",
    name: "apply_patch",
    arguments: { changes: [{ kind: "create", path: "src/new.txt", content: "x" }] },
  });
  assert.equal(inspectDenied.outcome, "deny");

  const protectedDenied = await policy.authorize({
    operationId: "op_policy",
    name: "apply_patch",
    arguments: { changes: [{ kind: "create", path: ".cba/policy.json", content: "{}" }] },
  });
  assert.equal(protectedDenied.outcome, "deny");
});

test("session grant expansion cannot override higher-layer network denial", async () => {
  const { policy } = await harness();
  assert.equal(await policy.expandSessionGrant({ kind: "network" }), false);
});

test("layered runtime policy plans edit_text exactly, including empty replacements", async () => {
  const { policy } = await harness();
  const before = "old\nvalue\n";
  const decision = await policy.authorize({
    operationId: "op_edit",
    name: "edit_text",
    arguments: {
      path: "src/a.txt",
      base_sha256: sha256(before).toUpperCase(),
      old_text: "old\n",
      new_text: "",
      expected_occurrences: 1,
    },
  });
  assert.equal(decision.outcome, "allow");
  assert.deepEqual(
    decision.outcome === "allow" ? decision.plannedMutation : undefined,
    { changedFiles: 1, changedLines: 1 },
  );
});

test("layered runtime policy returns conflicts for stale edit hashes and occurrence counts", async () => {
  const { policy } = await harness();
  for (const arguments_ of [
    {
      path: "src/a.txt",
      base_sha256: "0".repeat(64),
      old_text: "old",
      new_text: "new",
      expected_occurrences: 1,
    },
    {
      path: "src/a.txt",
      base_sha256: sha256("old\nvalue\n"),
      old_text: "old",
      new_text: "new",
      expected_occurrences: 2,
    },
  ]) {
    const decision = await policy.authorize({
      operationId: "op_edit_stale",
      name: "edit_text",
      arguments: arguments_,
    });
    assert.equal(decision.outcome, "conflict");
    assert.equal(decision.reasonCode, "STALE_STATE");
  }
});

test("layered runtime policy rejects edit no-ops and byte expansion before authorization", async () => {
  const { policy } = await harness("auto", {
    maxMutationFileBytes: 12,
    maxPatchBytes: 12,
  });
  const before = "old\nvalue\n";
  const noOp = await policy.authorize({
    operationId: "op_edit_noop",
    name: "edit_text",
    arguments: {
      path: "src/a.txt",
      base_sha256: sha256(before),
      old_text: "old",
      new_text: "old",
      expected_occurrences: 1,
    },
  });
  assert.equal(noOp.outcome, "deny");
  assert.equal(noOp.reasonCode, "PROTOCOL_INVALID");

  const expansion = await policy.authorize({
    operationId: "op_edit_large",
    name: "edit_text",
    arguments: {
      path: "src/a.txt",
      base_sha256: sha256(before),
      old_text: "old",
      new_text: "0123456789",
      expected_occurrences: 1,
    },
  });
  assert.equal(expansion.outcome, "deny");
  assert.equal(expansion.reasonCode, "BUDGET_EXCEEDED");
});

test("one-time capability authorization re-evaluates the exact edit without persisting it", async () => {
  const { policy } = await harness("auto", { tools: ["read_file"] });
  const call = {
    operationId: "op_edit_once",
    name: "edit_text" as const,
    arguments: {
      path: "src/a.txt",
      base_sha256: sha256("old\nvalue\n"),
      old_text: "old",
      new_text: "new",
      expected_occurrences: 1,
    },
  };
  const initial = await policy.authorize(call);
  assert.equal(initial.outcome, "ask");
  assert.equal(initial.outcome === "ask", true);
  if (initial.outcome !== "ask") throw new Error("expected capability request");
  assert.equal((await policy.authorizeOnce(call, initial.capability)).outcome, "allow");
  assert.equal((await policy.authorize(call)).outcome, "ask");
});
