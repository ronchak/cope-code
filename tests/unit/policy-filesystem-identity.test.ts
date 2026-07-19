import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ORGANIZATION_POLICY,
  DEFAULT_REPOSITORY_POLICY,
  PolicyEngine,
  createDefaultSessionGrant,
  zeroPolicyBudgetUsage,
  type PolicyDocument,
  type PolicyOperation,
  type SessionCapabilityExpansion,
} from "../../src/policy/index.js";
import { createFilesystemIdentity } from "../../src/shared/filesystem-identity.js";

const organization: PolicyDocument = {
  ...DEFAULT_ORGANIZATION_POLICY,
  capabilities: {
    ...DEFAULT_ORGANIZATION_POLICY.capabilities,
    paths: {
      ...DEFAULT_ORGANIZATION_POLICY.capabilities.paths,
      write: { ask: ["**"], unmatched: "allow" },
    },
  },
};

const grant = createDefaultSessionGrant({
  grant_id: "grant_identity",
  task_id: "task_identity",
  repository_root: "/synthetic/repository",
  mode: "edit",
  writable_paths: [],
});

function operation(path: string): PolicyOperation {
  return {
    tool: "apply_patch",
    paths: [{ path, access: "write" }],
    change: {
      files_changed: 1,
      changed_lines: 1,
      creates: 0,
      deletes: 0,
      dependency_manifest: false,
      local_commit: false,
    },
    projected_usage: zeroPolicyBudgetUsage(),
  };
}

function twoPathOperation(first: string, second: string): PolicyOperation {
  return {
    tool: "apply_patch",
    paths: [{ path: first, access: "write" }, { path: second, access: "write" }],
    change: {
      files_changed: 2,
      changed_lines: 2,
      creates: 0,
      deletes: 0,
      dependency_manifest: false,
      local_commit: false,
    },
    projected_usage: zeroPolicyBudgetUsage(),
  };
}

function expandedEngine(facts: { caseSensitive: boolean; unicodeNormalizationAliases: boolean }, path: string): PolicyEngine {
  const identity = createFilesystemIdentity({ device: 1, ...facts });
  const engine = new PolicyEngine({
    organization,
    repository: DEFAULT_REPOSITORY_POLICY,
    session: grant,
    pathKey: identity.pathKey,
  });
  const expansion: SessionCapabilityExpansion = { kind: "path", access: "write", path };
  const expanded = engine.expandSessionGrant(expansion, "2026-07-18T00:00:00.000Z");
  assert.notEqual(expanded.decision, "deny");
  return new PolicyEngine({
    organization,
    repository: DEFAULT_REPOSITORY_POLICY,
    session: expanded.grant,
    pathKey: identity.pathKey,
  });
}

function scopedEngine(
  facts: { caseSensitive: boolean; unicodeNormalizationAliases: boolean },
  path: string,
): PolicyEngine {
  const identity = createFilesystemIdentity({ device: 2, ...facts });
  return new PolicyEngine({
    organization: DEFAULT_ORGANIZATION_POLICY,
    repository: DEFAULT_REPOSITORY_POLICY,
    session: createDefaultSessionGrant({
      grant_id: "grant_scope",
      task_id: "task_scope",
      repository_root: "/synthetic/repository",
      mode: "edit",
      writable_paths: [path],
    }),
    pathKey: identity.pathKey,
  });
}

test("concrete path grants match actual case and Unicode volume identity", () => {
  const sensitive = scopedEngine({ caseSensitive: true, unicodeNormalizationAliases: false }, "src/A.ts");
  assert.equal(sensitive.evaluate(operation("src/A.ts")).decision, "allow");
  assert.equal(sensitive.evaluate(operation("src/a.ts")).decision, "ask");

  const insensitive = scopedEngine({ caseSensitive: false, unicodeNormalizationAliases: false }, "src/A.ts");
  assert.equal(insensitive.evaluate(operation("src/a.ts")).decision, "allow");

  const normalizing = scopedEngine({ caseSensitive: true, unicodeNormalizationAliases: true }, "src/caf\u00e9.ts");
  assert.equal(normalizing.evaluate(operation("src/cafe\u0301.ts")).decision, "allow");

  assert.equal(sensitive.evaluate(twoPathOperation("src/A.ts", "src/a.ts")).decision, "ask");
  assert.equal(
    insensitive.evaluate(twoPathOperation("src/A.ts", "src/a.ts")).checks.some(
      (check) => check.reason_code === "INVALID_OPERATION_CONTEXT",
    ),
    true,
  );
});

test("persisted path approvals use actual case and Unicode volume identity", () => {
  const sensitive = expandedEngine({ caseSensitive: true, unicodeNormalizationAliases: false }, "src/A.ts");
  assert.equal(sensitive.evaluate(operation("src/A.ts")).decision, "allow");
  assert.equal(sensitive.evaluate(operation("src/a.ts")).decision, "ask");

  const insensitive = expandedEngine({ caseSensitive: false, unicodeNormalizationAliases: false }, "src/A.ts");
  assert.equal(insensitive.evaluate(operation("src/a.ts")).decision, "allow");

  const normalizing = expandedEngine({ caseSensitive: true, unicodeNormalizationAliases: true }, "src/caf\u00e9.ts");
  assert.equal(normalizing.evaluate(operation("src/cafe\u0301.ts")).decision, "allow");

  const nonNormalizing = expandedEngine({ caseSensitive: true, unicodeNormalizationAliases: false }, "src/caf\u00e9.ts");
  assert.equal(nonNormalizing.evaluate(operation("src/cafe\u0301.ts")).decision, "ask");
});
