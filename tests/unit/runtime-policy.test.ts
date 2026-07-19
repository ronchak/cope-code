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

async function harness(mode: "inspect" | "edit" | "auto" = "auto") {
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
  });
  return { root, policy };
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
