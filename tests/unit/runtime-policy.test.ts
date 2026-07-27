import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_ORGANIZATION_POLICY,
  DEFAULT_REPOSITORY_POLICY,
  PolicyEngine,
  createDefaultSessionGrant,
  type BudgetUsage as PolicyBudgetUsage,
  zeroPolicyBudgetUsage,
} from "../../src/policy/index.js";
import { LayeredRuntimePolicy } from "../../src/orchestrator/runtime-policy.js";
import { RepositoryBoundary } from "../../src/repository/boundary.js";
import { CommandCatalog } from "../../src/tools/command-catalog.js";
import { sha256 } from "../../src/shared/crypto.js";
import type {
  BudgetMetric,
  ToolName,
} from "../../src/protocol/index.js";

async function harness(
  mode: "inspect" | "edit" | "auto" = "auto",
  options: {
    readonly tools?: readonly ToolName[];
    readonly maxMutationFileBytes?: number;
    readonly maxPatchBytes?: number;
    readonly maxDisclosureFiles?: number;
    readonly budgets?: Readonly<Partial<Record<BudgetMetric, number>>>;
    readonly currentUsage?: PolicyBudgetUsage;
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
    ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  });
  const organization = options.maxDisclosureFiles === undefined
    ? DEFAULT_ORGANIZATION_POLICY
    : {
        ...DEFAULT_ORGANIZATION_POLICY,
        capabilities: {
          ...DEFAULT_ORGANIZATION_POLICY.capabilities,
          disclosure: {
            ...DEFAULT_ORGANIZATION_POLICY.capabilities.disclosure,
            max_files_per_operation: options.maxDisclosureFiles,
          },
        },
      };
  const policy = new LayeredRuntimePolicy({
    engine: new PolicyEngine({
      organization,
      repository: DEFAULT_REPOSITORY_POLICY,
      session,
    }),
    boundary,
    commandCatalog: catalog,
    currentUsage: () => options.currentUsage ?? zeroPolicyBudgetUsage(),
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

test("default list_files request is bounded and oversized denials name the exact file limit", async () => {
  const { policy } = await harness("auto", { maxDisclosureFiles: 20 });
  const defaultDecision = await policy.authorize({
    operationId: "op_list_default",
    name: "list_files",
    arguments: { path: "." },
  });
  assert.equal(defaultDecision.outcome, "allow");

  const oversized = await policy.authorize({
    operationId: "op_list_oversized",
    name: "list_files",
    arguments: { path: ".", max_results: 200 },
  });
  assert.equal(oversized.outcome, "deny");
  assert.equal(oversized.reasonCode, "DISCLOSURE_OPERATION_LIMIT_EXCEEDED");
  assert.match(
    oversized.explanation,
    /organization per-operation disclosure file limit 20 would be exceeded by 200 files/u,
  );

  const notes = policy.summarize().notes;
  assert.ok(Array.isArray(notes));
  assert.match(
    notes.filter((note): note is string => typeof note === "string").join(" "),
    /20 files.*hard ceilings are separate from cumulative task budgets/u,
  );
});

test("standalone budget capability cannot shrink an active disclosure budget", async () => {
  const { policy } = await harness("auto", {
    budgets: { disclosed_bytes: 2_000_000 },
    currentUsage: {
      ...zeroPolicyBudgetUsage(),
      disclosed_bytes: 50_000,
    },
  });
  assert.equal(
    await policy.expandSessionGrant({
      kind: "budget",
      metric: "disclosed_bytes",
      requested_limit: 2_000,
    }),
    false,
  );
  assert.equal(
    policy.sessionGrant.capabilities.budgets?.disclosed_bytes,
    2_000_000,
  );
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

test("layered runtime policy returns a conflict when an edit target was deleted", async () => {
  const { root, policy } = await harness();
  const before = "old\nvalue\n";
  await rm(path.join(root, "src", "a.txt"));
  const decision = await policy.authorize({
    operationId: "op_edit_deleted",
    name: "edit_text",
    arguments: {
      path: "src/a.txt",
      base_sha256: sha256(before),
      old_text: "old",
      new_text: "new",
      expected_occurrences: 1,
    },
  });
  assert.equal(decision.outcome, "conflict");
  assert.equal(decision.reasonCode, "STALE_STATE");
});

test("completion path scope accepts an edit_text-only session grant", async () => {
  const { policy } = await harness("auto", { tools: ["edit_text"] });
  assert.equal(policy.isPathInScope("src/a.txt"), true);
  assert.equal(policy.isPathInScope("README.md"), false);
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

test("one-time budget authorization returns the exact scoped runtime ceiling", async () => {
  const { policy } = await harness("auto", {
    budgets: { changed_lines: 0 },
  });
  const call = {
    operationId: "op_edit_budget_once",
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
  if (initial.outcome !== "ask") throw new Error("expected budget capability request");
  assert.deepEqual(initial.capability.expansion, {
    kind: "budget",
    metric: "changed_lines",
    requested_limit: 2,
  });
  const approved = await policy.authorizeOnce(call, initial.capability);
  assert.equal(approved.outcome, "allow");
  assert.deepEqual(
    approved.outcome === "allow" ? approved.oneTimeBudgetLimits : undefined,
    { changed_lines: 2 },
  );
  assert.equal((await policy.authorize(call)).outcome, "ask");
});

test("disclosure budget approval reserves the complete protocol boundary", async () => {
  const { policy } = await harness("auto", {
    budgets: { disclosed_bytes: 0 },
  });
  const call = {
    operationId: "op_read_disclosure_once",
    name: "read_file" as const,
    arguments: { path: "src/a.txt", max_bytes: 1 },
  };
  const initial = await policy.authorize(call);
  if (initial.outcome !== "ask") throw new Error("expected disclosure budget request");
  const expansion = initial.capability.expansion as {
    readonly kind: string;
    readonly metric: string;
    readonly requested_limit: number;
  };
  assert.equal(expansion.kind, "budget");
  assert.equal(expansion.metric, "disclosed_bytes");
  assert.equal(expansion.requested_limit > 1, true);

  const approved = await policy.authorizeOnce(call, initial.capability);
  if (approved.outcome !== "allow") throw new Error("expected one-time approval");
  assert.equal(approved.plannedDisclosureBytes, expansion.requested_limit);
  assert.deepEqual(approved.oneTimeBudgetLimits, {
    disclosed_bytes: expansion.requested_limit,
  });
});

test("one-time authorization rejects budgets not consumed by the exact operation", async () => {
  const { policy } = await harness();
  const call = {
    operationId: "op_status_unsupported_budget",
    name: "git_status" as const,
    arguments: {},
  };
  for (const metric of ["elapsed_ms", "turns", "operations", "protocol_repairs"] as const) {
    const decision = await policy.authorizeOnce(call, {
      expansion: {
        kind: "budget",
        metric,
        requested_limit: 999,
      },
    });
    assert.equal(decision.outcome, "deny", metric);
    assert.equal(
      decision.outcome === "deny" ? decision.reasonCode : undefined,
      "CAPABILITY_EXPANSION_DENIED",
      metric,
    );
  }
});
