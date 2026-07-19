import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ORGANIZATION_POLICY,
  DEFAULT_POLICY_BUDGETS,
  DEFAULT_REPOSITORY_POLICY,
  PolicyEngine,
  createDefaultSessionGrant,
  validatePolicyDocument,
  validateSessionGrant,
  zeroPolicyBudgetUsage,
  type PolicyDocument,
  type PolicyOperation,
  type SessionGrant,
} from "../../src/policy/index.js";

function session(
  mode: "inspect" | "edit" | "auto" = "edit",
  overrides: Partial<Parameters<typeof createDefaultSessionGrant>[0]> = {},
): SessionGrant {
  return createDefaultSessionGrant({
    grant_id: "grant_1",
    task_id: "task_1",
    repository_root: "C:\\work\\repo",
    mode,
    readable_paths: ["**"],
    writable_paths: ["src/**", "tests/**"],
    command_ids: ["unit"],
    ...overrides,
  });
}

function engine(grant = session(), organization = DEFAULT_ORGANIZATION_POLICY, repository = DEFAULT_REPOSITORY_POLICY) {
  return new PolicyEngine({ organization, repository, session: grant });
}

function operation(overrides: Partial<PolicyOperation> = {}): PolicyOperation {
  return { tool: "git_status", projected_usage: zeroPolicyBudgetUsage(), ...overrides };
}

test("default policy documents and generated session grant validate", () => {
  assert.equal(validatePolicyDocument(DEFAULT_ORGANIZATION_POLICY).valid, true);
  assert.equal(validatePolicyDocument(DEFAULT_REPOSITORY_POLICY).valid, true);
  assert.equal(validateSessionGrant(session()).valid, true);
});

test("schema and semantic validation reject unknown fields, overlapping rules, and traversal patterns", () => {
  assert.equal(validatePolicyDocument({ ...DEFAULT_ORGANIZATION_POLICY, surprise: true }).valid, false);
  const overlap: PolicyDocument = {
    ...DEFAULT_ORGANIZATION_POLICY,
    capabilities: {
      ...DEFAULT_ORGANIZATION_POLICY.capabilities,
      paths: { read: { allow: ["src/**"], deny: ["SRC/**"] } },
    },
  };
  assert.match(validatePolicyDocument(overlap).errors.join(" "), /appears in both allow and deny/u);

  const traversal: PolicyDocument = {
    ...DEFAULT_ORGANIZATION_POLICY,
    capabilities: {
      ...DEFAULT_ORGANIZATION_POLICY.capabilities,
      paths: { read: { allow: ["../outside/**"] } },
    },
  };
  assert.match(validatePolicyDocument(traversal).errors.join(" "), /unsafe pattern/u);
});

test("most restrictive organization, repository, and session decision wins", () => {
  const repository: PolicyDocument = {
    ...DEFAULT_REPOSITORY_POLICY,
    capabilities: {
      ...DEFAULT_REPOSITORY_POLICY.capabilities,
      paths: { read: { allow: ["**"], deny: ["secret/**"] } },
    },
  };
  const result = engine(session(), DEFAULT_ORGANIZATION_POLICY, repository).evaluate(
    operation({ tool: "read_file", paths: [{ path: "secret/data.txt", access: "read" }] }),
  );
  assert.equal(result.decision, "deny");
  assert.ok(result.reasons.some((reason) => reason.layer === "repository" && reason.reason_code === "PATH_NOT_GRANTED"));
});

test("session scope produces ask once while protected and escaping paths are hard denials", () => {
  const evaluator = engine();
  const outsideGrant = evaluator.evaluate(
    operation({ tool: "read_file", paths: [{ path: "docs/private.md", access: "write" }] }),
  );
  assert.equal(outsideGrant.decision, "ask");
  assert.ok(outsideGrant.reasons.some((reason) => reason.reason_code === "PATH_REQUIRES_APPROVAL"));

  const protectedPath = evaluator.evaluate(
    operation({ tool: "apply_patch", paths: [{ path: ".git/config", access: "write" }], change: emptyChange() }),
  );
  assert.equal(protectedPath.decision, "deny");
  assert.ok(protectedPath.reasons.some((reason) => reason.reason_code === "PATH_PROTECTED"));

  const traversal = evaluator.evaluate(
    operation({ tool: "read_file", paths: [{ path: "src/../../secret", access: "read" }] }),
  );
  assert.equal(traversal.decision, "deny");
  assert.ok(traversal.reasons.some((reason) => reason.reason_code === "INVALID_REPOSITORY_PATH"));
});

test("inspect, edit, and auto modes apply their distinct mutation and command boundaries", () => {
  const patch = operation({
    tool: "apply_patch",
    paths: [{ path: "src/a.ts", access: "create" }],
    change: { ...emptyChange(), files_changed: 1, changed_lines: 3, creates: 1 },
  });
  assert.equal(engine(session("inspect")).evaluate(patch).decision, "deny");
  assert.equal(engine(session("edit")).evaluate(patch).decision, "allow");

  const highRiskCommand = operation({
    tool: "run_command",
    command: { id: "unit", category: "test", risk: "high", side_effects: false, timeout_ms: 10_000 },
    network: { required: false, hosts: [] },
  });
  assert.equal(engine(session("edit")).evaluate(highRiskCommand).decision, "ask");
  assert.equal(engine(session("auto")).evaluate(highRiskCommand).decision, "ask");
});

test("command ID, category, side-effect, timeout, and network constraints are independently enforced", () => {
  const evaluator = engine();
  const allowed = evaluator.evaluate(
    operation({
      tool: "run_command",
      command: { id: "unit", category: "test", risk: "low", side_effects: false, timeout_ms: 30_000 },
      network: { required: false, hosts: [] },
    }),
  );
  assert.equal(allowed.decision, "allow");

  const unknown = evaluator.evaluate(
    operation({
      tool: "run_command",
      command: { id: "publish", category: "release", risk: "low", side_effects: true, timeout_ms: 30_000 },
      network: { required: false, hosts: [] },
    }),
  );
  assert.equal(unknown.decision, "ask");
  assert.ok(unknown.reasons.some((reason) => reason.reason_code === "COMMAND_REQUIRES_APPROVAL"));

  const networked = evaluator.evaluate(
    operation({
      tool: "run_command",
      command: { id: "unit", category: "test", risk: "low", side_effects: false, timeout_ms: 30_000 },
      network: { required: true, hosts: ["registry.npmjs.org"] },
    }),
  );
  assert.equal(networked.decision, "deny");
  assert.ok(networked.reasons.some((reason) => reason.reason_code === "NETWORK_DENIED"));
});

test("classification, secret, disclosure, change, and cumulative budgets are enforced", () => {
  const evaluator = engine(session("auto"));
  const confidential = evaluator.evaluate(
    operation({
      tool: "read_file",
      paths: [{ path: "src/a.ts", access: "read" }],
      disclosure: { classification: "confidential", byte_count: 10, file_count: 1, contains_secret: false },
    }),
  );
  assert.equal(confidential.decision, "ask");

  const secret = evaluator.evaluate(
    operation({
      tool: "read_file",
      paths: [{ path: "src/a.ts", access: "read" }],
      disclosure: { classification: "internal", byte_count: 10, file_count: 1, contains_secret: true },
    }),
  );
  assert.equal(secret.decision, "deny");
  assert.ok(secret.reasons.some((reason) => reason.reason_code === "SECRET_DISCLOSURE_DENIED"));

  const deletion = evaluator.evaluate(
    operation({
      tool: "apply_patch",
      paths: [{ path: "src/a.ts", access: "delete" }],
      change: { ...emptyChange(), files_changed: 1, changed_lines: 10, deletes: 1 },
    }),
  );
  assert.equal(deletion.decision, "ask");

  const usage = { ...zeroPolicyBudgetUsage(), changed_lines: DEFAULT_POLICY_BUDGETS.changed_lines + 1 };
  const overBudget = evaluator.evaluate(operation({ projected_usage: usage }));
  assert.equal(overBudget.decision, "deny");
  assert.ok(overBudget.reasons.some((reason) => reason.reason_code === "BUDGET_EXCEEDED"));
});

test("session capability expansion is durable but bounded by higher policies", () => {
  const original = session("edit");
  const evaluator = engine(original);

  const disclosureExpansion = evaluator.expandSessionGrant(
    { kind: "disclosure", classification: "confidential" },
    "2026-07-17T00:00:00.000Z",
  );
  assert.equal(disclosureExpansion.decision, "ask");
  assert.notEqual(disclosureExpansion.grant, original);
  assert.ok(disclosureExpansion.grant.approved_capabilities.some((entry) => entry.key === "disclosure:confidential"));

  const expandedEvaluator = engine(disclosureExpansion.grant);
  const nowAllowed = expandedEvaluator.evaluate(
    operation({
      tool: "read_file",
      paths: [{ path: "src/a.ts", access: "read" }],
      disclosure: { classification: "confidential", byte_count: 10, file_count: 1, contains_secret: false },
    }),
  );
  assert.equal(nowAllowed.decision, "allow");

  const network = evaluator.expandSessionGrant({ kind: "network", host: "registry.npmjs.org" });
  assert.equal(network.decision, "deny");
  assert.equal(network.grant, original);

  const protectedPath = evaluator.expandSessionGrant({ kind: "path", access: "write", path: ".git/config" });
  assert.equal(protectedPath.decision, "deny");
  assert.equal(protectedPath.grant, original);
});

test("session budget may grow only up to the strict higher-layer limit", () => {
  const lowSession = session("auto", { budgets: { turns: 5 } });
  const evaluator = engine(lowSession);
  const withinBoundary = evaluator.expandSessionGrant({ kind: "budget", metric: "turns", requested_limit: 10 });
  assert.equal(withinBoundary.decision, "allow");
  assert.equal(withinBoundary.grant.capabilities.budgets?.turns, 10);

  const beyondBoundary = evaluator.expandSessionGrant({ kind: "budget", metric: "turns", requested_limit: 1_000 });
  assert.equal(beyondBoundary.decision, "deny");
  assert.equal(beyondBoundary.grant, lowSession);
});

test("invalid or incomplete deterministic facts fail closed instead of bypassing policy", () => {
  const evaluator = engine();
  const missingNetworkMetadata = evaluator.evaluate(
    operation({
      tool: "run_command",
      command: { id: "unit", category: "test", risk: "low", side_effects: false, timeout_ms: 30_000 },
    }),
  );
  assert.equal(missingNetworkMetadata.decision, "deny");
  assert.ok(missingNetworkMetadata.reasons.some((reason) => reason.reason_code === "OPERATION_CONTEXT_MISSING"));

  const forgedPatchInventory = evaluator.evaluate(
    operation({
      tool: "apply_patch",
      paths: [{ path: "src/a.ts", access: "write" }],
      change: emptyChange(),
    }),
  );
  assert.equal(forgedPatchInventory.decision, "deny");
  assert.ok(forgedPatchInventory.reasons.some((reason) => reason.reason_code === "INVALID_OPERATION_CONTEXT"));

  const invalidUsage = evaluator.evaluate(
    operation({ projected_usage: { ...zeroPolicyBudgetUsage(), turns: Number.NaN } }),
  );
  assert.equal(invalidUsage.decision, "deny");
  assert.ok(invalidUsage.reasons.some((reason) => reason.reason_code === "INVALID_OPERATION_CONTEXT"));
});

function emptyChange() {
  return {
    files_changed: 0,
    changed_lines: 0,
    creates: 0,
    deletes: 0,
    dependency_manifest: false,
    local_commit: false,
  } as const;
}
