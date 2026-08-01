import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { LEGACY_REPOSITORY_CONFIG_VERSION, REPOSITORY_CONFIG_VERSION } from "../../src/config/types.js";
import { executeDoctorCommand } from "../../src/cli/doctor.js";
import { resolveTerminalToolDecision } from "../../src/cli/doctor-probe.js";
import { configurationPaths } from "../../src/cli/onboarding.js";
import {
  DEFAULT_DEVELOPER_ORGANIZATION_POLICY,
  DEFAULT_DEVELOPER_REPOSITORY_POLICY,
  DEFAULT_REPOSITORY_POLICY,
  PolicyEngine,
  createDefaultSessionGrant,
  validatePolicyDocument,
  zeroPolicyBudgetUsage,
  type PolicyDocument,
} from "../../src/policy/index.js";
import { DEFAULT_GIT_EXECUTABLE } from "../../src/repository/boundary.js";
import { createStandardUserHost } from "../helpers/standard-user-host.js";

const execFileAsync = promisify(execFile);

interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly evidence?: Record<string, unknown>;
  readonly required: boolean;
}

interface DoctorReport {
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

interface Fixture {
  readonly root: string;
  readonly stateHome: string;
  readonly configFile: string;
  readonly machinePolicyFile: string;
}

test("doctor reports v1 repository session denial and overwrite-safe remedy without reading machine policy", async (context) => {
  const fixture = await createFixture(context);
  await writeRepositoryConfig(fixture, repositoryConfig({
    schema_version: LEGACY_REPOSITORY_CONFIG_VERSION,
    policy: DEFAULT_REPOSITORY_POLICY,
  }));
  await writeMalformedMachinePolicy(fixture);

  const check = await runDoctor(fixture);

  assert.equal(check.ok, false);
  assert.match(check.detail, /cba-repository-config\/1/u);
  assert.match(check.detail, /session layer denies `terminal_exec` unconditionally/u);
  assert.match(check.detail, /machine policy was not read for this check/u);
  assert.match(check.detail, /cope init \. --quick --force/u);
  assert.match(check.detail, /overwrites `.cba\/repository\.json`/u);
  assert.match(check.detail, /custom commands, limits, grants, and completion settings/u);
  assert.equal(repositoryEvidence(check).file, fixture.configFile);
  assert.equal(repositoryEvidence(check).schema_version, LEGACY_REPOSITORY_CONFIG_VERSION);
  assert.deepEqual(machineEvidence(check), { status: "not_read", path: fixture.machinePolicyFile });
});

test("doctor reports a disabled v2 developer_terminal field without reading machine policy", async (context) => {
  const fixture = await createFixture(context);
  await writeRepositoryConfig(fixture, repositoryConfig({
    schema_version: REPOSITORY_CONFIG_VERSION,
    developer_terminal_enabled: false,
    policy: DEFAULT_REPOSITORY_POLICY,
  }));
  await writeMalformedMachinePolicy(fixture);

  const check = await runDoctor(fixture);

  assert.equal(check.ok, false);
  assert.match(check.detail, /developer_terminal\.enabled=false/u);
  assert.match(check.detail, /session layer denies `terminal_exec`/u);
  assert.match(check.detail, /machine policy was not read for this check/u);
  assert.match(check.detail, /If Developer mode is intended, optionally run `cope init \. --quick --force`/u);
  assert.match(check.detail, /overwrites `.cba\/repository\.json`/u);
  assert.equal(repositoryEvidence(check).developer_terminal_enabled, false);
  assert.deepEqual(machineEvidence(check), { status: "not_read", path: fixture.machinePolicyFile });
});

test("doctor reports an embedded repository policy blocker without reading machine policy", async (context) => {
  const fixture = await createFixture(context);
  const repositoryPolicy = policyWithTerminalRules(
    DEFAULT_DEVELOPER_REPOSITORY_POLICY,
    { deny: ["terminal_exec"] },
    { policy_id: "repository-blocker", revision: "17" },
  );
  await writeRepositoryConfig(fixture, repositoryConfig({
    schema_version: REPOSITORY_CONFIG_VERSION,
    developer_terminal_enabled: true,
    policy: repositoryPolicy,
  }));
  await writeMalformedMachinePolicy(fixture);

  const check = await runDoctor(fixture);
  const repositoryPolicyEvidence = check.evidence?.repository_policy as Record<string, unknown> | undefined;

  assert.equal(check.ok, false);
  assert.match(check.detail, new RegExp(escapeRegExp(fixture.configFile), "u"));
  assert.match(check.detail, /capabilities\.tools\.deny/u);
  assert.match(check.detail, /decision "deny"/u);
  assert.match(check.detail, /policy_id "repository-blocker"/u);
  assert.match(check.detail, /revision "17"/u);
  assert.match(check.detail, /machine policy was not read because the repository layer already blocks/u);
  assert.equal(repositoryPolicyEvidence?.field, "capabilities.tools.deny");
  assert.equal(repositoryPolicyEvidence?.decision, "deny");
  assert.equal(repositoryPolicyEvidence?.policy_id, "repository-blocker");
  assert.equal(repositoryPolicyEvidence?.revision, "17");
  assert.deepEqual(machineEvidence(check), { status: "not_read", path: fixture.machinePolicyFile });
});

test("doctor reports the exact machine deny provenance and policy identity", async (context) => {
  const fixture = await createFixture(context);
  await writeRepositoryConfig(fixture, repositoryConfig({
    schema_version: REPOSITORY_CONFIG_VERSION,
    developer_terminal_enabled: true,
    policy: DEFAULT_DEVELOPER_REPOSITORY_POLICY,
  }));
  const machinePolicy = policyWithTerminalRules(
    DEFAULT_DEVELOPER_ORGANIZATION_POLICY,
    { deny: ["terminal_exec"] },
    { policy_id: "machine-deny", revision: "9" },
  );
  await writeMachinePolicy(fixture, machinePolicy);

  const check = await runDoctor(fixture);
  const machine = machineEvidence(check);

  assert.equal(check.ok, false);
  assert.match(check.detail, new RegExp(escapeRegExp(fixture.machinePolicyFile), "u"));
  assert.match(check.detail, /capabilities\.tools\.deny/u);
  assert.match(check.detail, /decision "deny"/u);
  assert.match(check.detail, /policy_id "machine-deny"/u);
  assert.match(check.detail, /revision "9"/u);
  assert.equal(machine.status, "valid");
  assert.equal(machine.path, fixture.machinePolicyFile);
  assert.equal(machine.field, "capabilities.tools.deny");
  assert.equal(machine.decision, "deny");
  assert.equal(machine.policy_id, "machine-deny");
  assert.equal(machine.revision, "9");
});

test("doctor distinguishes an absent machine policy from a denial", async (context) => {
  const fixture = await createFixture(context);
  await writeRepositoryConfig(fixture, repositoryConfig({
    schema_version: REPOSITORY_CONFIG_VERSION,
    developer_terminal_enabled: true,
    policy: DEFAULT_DEVELOPER_REPOSITORY_POLICY,
  }));

  const check = await runDoctor(fixture);

  assert.equal(check.ok, false);
  assert.match(check.detail, new RegExp(escapeRegExp(fixture.machinePolicyFile), "u"));
  assert.match(check.detail, /is absent/u);
  assert.doesNotMatch(check.detail, /decision "(?:allow|ask|deny)"/u);
  assert.deepEqual(machineEvidence(check), { status: "absent", path: fixture.machinePolicyFile });
});

test("doctor distinguishes an unreadable machine policy from a denial", async (context) => {
  const fixture = await createFixture(context);
  await writeRepositoryConfig(fixture, repositoryConfig({
    schema_version: REPOSITORY_CONFIG_VERSION,
    developer_terminal_enabled: true,
    policy: DEFAULT_DEVELOPER_REPOSITORY_POLICY,
  }));
  await mkdir(fixture.machinePolicyFile, { recursive: true, mode: 0o700 });

  const check = await runDoctor(fixture);
  const machine = machineEvidence(check);

  assert.equal(check.ok, false);
  assert.match(check.detail, new RegExp(escapeRegExp(fixture.machinePolicyFile), "u"));
  assert.match(check.detail, /could not be read/u);
  assert.equal(machine.status, "unreadable");
  assert.equal(machine.path, fixture.machinePolicyFile);
  assert.equal(typeof machine.error, "string");
  assert.equal("policy_id" in machine, false);
  assert.equal("decision" in machine, false);
});

test("doctor distinguishes a malformed machine policy from a denial", async (context) => {
  const fixture = await createFixture(context);
  await writeRepositoryConfig(fixture, repositoryConfig({
    schema_version: REPOSITORY_CONFIG_VERSION,
    developer_terminal_enabled: true,
    policy: DEFAULT_DEVELOPER_REPOSITORY_POLICY,
  }));
  await writeFile(fixture.machinePolicyFile, "{not-json\n", "utf8");

  const check = await runDoctor(fixture);
  const machine = machineEvidence(check);

  assert.equal(check.ok, false);
  assert.match(check.detail, new RegExp(escapeRegExp(fixture.machinePolicyFile), "u"));
  assert.match(check.detail, /was read but is malformed or not a valid organization policy/u);
  assert.doesNotMatch(check.detail, /not-json/u);
  assert.equal(machine.status, "malformed");
  assert.equal(machine.path, fixture.machinePolicyFile);
  assert.equal(machine.error, "Invalid JSON syntax");
  assert.equal("policy_id" in machine, false);
  assert.equal("decision" in machine, false);
});

test("doctor reports terminal available only when every configured layer allows it", async (context) => {
  const fixture = await createFixture(context);
  await writeRepositoryConfig(fixture, repositoryConfig({
    schema_version: REPOSITORY_CONFIG_VERSION,
    developer_terminal_enabled: true,
    policy: DEFAULT_DEVELOPER_REPOSITORY_POLICY,
  }));
  await writeMachinePolicy(fixture, DEFAULT_DEVELOPER_ORGANIZATION_POLICY);

  const check = await runDoctor(fixture);
  const repositoryPolicyEvidence = check.evidence?.repository_policy as Record<string, unknown> | undefined;
  const machine = machineEvidence(check);

  assert.equal(check.ok, true);
  assert.match(check.detail, /new Developer \(`auto`\) session/u);
  assert.match(check.detail, /repository v2 enable bit/u);
  assert.match(check.detail, /all allow terminal_exec/u);
  assert.equal(repositoryPolicyEvidence?.field, "capabilities.tools.allow");
  assert.equal(repositoryPolicyEvidence?.decision, "allow");
  assert.equal(machine.status, "valid");
  assert.equal(machine.field, "capabilities.tools.allow");
  assert.equal(machine.decision, "allow");
  assert.equal(machine.policy_id, DEFAULT_DEVELOPER_ORGANIZATION_POLICY.policy_id);
  assert.equal(machine.revision, DEFAULT_DEVELOPER_ORGANIZATION_POLICY.revision);
});

test("doctor identifies ask, unmatched, and default_decision terminal provenance", async (context) => {
  const fixture = await createFixture(context);
  const cases: readonly {
    readonly policy: PolicyDocument;
    readonly field: string;
    readonly decision: "ask";
  }[] = [
    {
      policy: policyWithTerminalRules(DEFAULT_DEVELOPER_REPOSITORY_POLICY, { ask: ["terminal_exec"] }),
      field: "capabilities.tools.ask",
      decision: "ask",
    },
    {
      policy: policyWithTerminalRules(DEFAULT_DEVELOPER_REPOSITORY_POLICY, { unmatched: "ask" }),
      field: "capabilities.tools.unmatched",
      decision: "ask",
    },
    {
      policy: policyWithoutTerminalRules(DEFAULT_DEVELOPER_REPOSITORY_POLICY, "ask"),
      field: "default_decision",
      decision: "ask",
    },
  ];

  for (const [index, entry] of cases.entries()) {
    await writeRepositoryConfig(fixture, repositoryConfig({
      schema_version: REPOSITORY_CONFIG_VERSION,
      developer_terminal_enabled: true,
      policy: { ...entry.policy, policy_id: `repository-provenance-${String(index)}` },
    }));
    await writeMalformedMachinePolicy(fixture);
    const check = await runDoctor(fixture);
    const repositoryPolicyEvidence = check.evidence?.repository_policy as Record<string, unknown> | undefined;

    assert.equal(check.ok, false);
    assert.match(check.detail, new RegExp(escapeRegExp(entry.field), "u"));
    assert.match(check.detail, /decision "ask"/u);
    assert.equal(repositoryPolicyEvidence?.field, entry.field);
    assert.equal(repositoryPolicyEvidence?.decision, entry.decision);
    assert.deepEqual(machineEvidence(check), { status: "not_read", path: fixture.machinePolicyFile });
  }
});

test("doctor reports machine ask provenance without calling it a denial", async (context) => {
  const fixture = await createFixture(context);
  await writeRepositoryConfig(fixture, repositoryConfig({
    schema_version: REPOSITORY_CONFIG_VERSION,
    developer_terminal_enabled: true,
    policy: DEFAULT_DEVELOPER_REPOSITORY_POLICY,
  }));
  await writeMachinePolicy(fixture, policyWithTerminalRules(
    DEFAULT_DEVELOPER_ORGANIZATION_POLICY,
    { ask: ["terminal_exec"] },
    { policy_id: "machine-ask", revision: "12" },
  ));

  const check = await runDoctor(fixture);
  const machine = machineEvidence(check);

  assert.equal(check.ok, false);
  assert.match(check.detail, /capabilities\.tools\.ask selects decision "ask"/u);
  assert.match(check.detail, /policy_id "machine-ask", revision "12"/u);
  assert.match(check.detail, /requires approval and is not a denial/u);
  assert.equal(machine.status, "valid");
  assert.equal(machine.field, "capabilities.tools.ask");
  assert.equal(machine.decision, "ask");
  assert.equal(machine.policy_id, "machine-ask");
  assert.equal(machine.revision, "12");
});

test("terminal resolver pins deny, ask, and explicit-rule provenance precedence", () => {
  const cases: readonly {
    readonly name: string;
    readonly policy: PolicyDocument;
    readonly decision: "allow" | "ask" | "deny";
    readonly field: string;
    readonly valid: boolean;
  }[] = [
    {
      name: "deny wins over allow",
      policy: policyWithTerminalRules(
        DEFAULT_DEVELOPER_ORGANIZATION_POLICY,
        { deny: ["terminal_exec"], allow: ["terminal_exec"] },
      ),
      decision: "deny",
      field: "capabilities.tools.deny",
      valid: false,
    },
    {
      name: "ask wins over allow",
      policy: policyWithTerminalRules(
        DEFAULT_DEVELOPER_ORGANIZATION_POLICY,
        { ask: ["terminal_exec"], allow: ["terminal_exec"] },
      ),
      decision: "ask",
      field: "capabilities.tools.ask",
      valid: false,
    },
    {
      name: "explicit allow wins over unmatched deny",
      policy: policyWithTerminalRules(
        DEFAULT_DEVELOPER_ORGANIZATION_POLICY,
        { allow: ["terminal_exec"], unmatched: "deny" },
      ),
      decision: "allow",
      field: "capabilities.tools.allow",
      valid: true,
    },
  ];

  for (const entry of cases) {
    assert.deepEqual(
      resolveTerminalToolDecision(entry.policy),
      { decision: entry.decision, field: entry.field },
      entry.name,
    );
    assert.equal(validatePolicyDocument(entry.policy).valid, entry.valid, entry.name);
  }
});

test("terminal resolver agrees with PolicyEngine across valid tool-rule combinations", () => {
  const decisions = ["allow", "ask", "deny"] as const;
  const cases: {
    readonly name: string;
    readonly policy: PolicyDocument;
    readonly field: string;
  }[] = [];

  for (const explicit of decisions) {
    for (const unmatched of decisions) {
      cases.push({
        name: `${explicit} rule with ${unmatched} unmatched`,
        policy: policyWithTerminalRules(
          DEFAULT_DEVELOPER_ORGANIZATION_POLICY,
          { [explicit]: ["terminal_exec"], unmatched },
        ),
        field: `capabilities.tools.${explicit}`,
      });
    }
  }
  for (const unmatched of decisions) {
    cases.push({
      name: `unmatched ${unmatched}`,
      policy: policyWithTerminalRules(DEFAULT_DEVELOPER_ORGANIZATION_POLICY, { unmatched }),
      field: "capabilities.tools.unmatched",
    });
  }
  for (const defaultDecision of decisions) {
    cases.push({
      name: `default ${defaultDecision}`,
      policy: policyWithoutTerminalRules(DEFAULT_DEVELOPER_ORGANIZATION_POLICY, defaultDecision),
      field: "default_decision",
    });
  }

  const session = createDefaultSessionGrant({
    grant_id: "grant_doctor_terminal_precedence",
    task_id: "task_doctor_terminal_precedence",
    repository_root: process.cwd(),
    mode: "auto",
    readable_paths: ["**"],
    writable_paths: ["**"],
    enable_terminal_exec: true,
  });

  for (const entry of cases) {
    assert.equal(validatePolicyDocument(entry.policy).valid, true, entry.name);
    const resolved = resolveTerminalToolDecision(entry.policy);
    const effective = new PolicyEngine({
      organization: entry.policy,
      repository: DEFAULT_DEVELOPER_REPOSITORY_POLICY,
      session,
    }).evaluate({
      tool: "terminal_exec",
      projected_usage: zeroPolicyBudgetUsage(),
      planned_disclosure_bytes: 0,
    });
    const engineCheck = effective.checks.find(
      (check) => check.layer === "organization" && check.dimension === "tool",
    );

    assert.ok(engineCheck, `${entry.name}: PolicyEngine omitted the organization tool check`);
    assert.equal(resolved.decision, engineCheck.decision, entry.name);
    assert.equal(resolved.field, entry.field, entry.name);
  }
});

test("doctor reports persisted overlapping terminal rules as malformed", async (context) => {
  const fixture = await createFixture(context);
  await writeRepositoryConfig(fixture, repositoryConfig({
    schema_version: REPOSITORY_CONFIG_VERSION,
    developer_terminal_enabled: true,
    policy: DEFAULT_DEVELOPER_REPOSITORY_POLICY,
  }));
  await writeMachinePolicy(fixture, policyWithTerminalRules(
    DEFAULT_DEVELOPER_ORGANIZATION_POLICY,
    { deny: ["terminal_exec"], allow: ["terminal_exec"] },
    { policy_id: "machine-conflict", revision: "3" },
  ));

  const check = await runDoctor(fixture);
  const machine = machineEvidence(check);

  assert.equal(check.ok, false);
  assert.match(check.detail, /malformed or not a valid organization policy/u);
  assert.match(String(machine.error), /appears in both allow and deny/u);
  assert.equal(machine.status, "malformed");
  assert.equal(machine.path, fixture.machinePolicyFile);
  assert.equal("field" in machine, false);
  assert.equal("decision" in machine, false);
  assert.equal("policy_id" in machine, false);
});

async function createFixture(context: test.TestContext): Promise<Fixture> {
  const root = await mkdtemp(path.join(process.cwd(), ".doctor-terminal-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["init", "--quiet", root]);
  const canonicalRoot = await realpath(root);
  const stateHome = path.join(canonicalRoot, "state");
  await mkdir(stateHome, { mode: 0o700 });
  const configDirectory = path.join(stateHome, "config");
  await mkdir(configDirectory, { mode: 0o700 });
  return {
    root: canonicalRoot,
    stateHome,
    configFile: path.join(canonicalRoot, ".cba", "repository.json"),
    machinePolicyFile: configurationPaths(stateHome, createStandardUserHost()).organizationPolicy,
  };
}

async function writeRepositoryConfig(fixture: Fixture, value: unknown): Promise<void> {
  await mkdir(path.dirname(fixture.configFile), { recursive: true, mode: 0o700 });
  await writeFile(fixture.configFile, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function writeMachinePolicy(fixture: Fixture, policy: PolicyDocument): Promise<void> {
  await writeFile(fixture.machinePolicyFile, `${JSON.stringify(policy)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function writeMalformedMachinePolicy(fixture: Fixture): Promise<void> {
  await writeFile(fixture.machinePolicyFile, "{not-json\n", { encoding: "utf8", mode: 0o600 });
}

function repositoryConfig(options: {
  readonly schema_version: typeof LEGACY_REPOSITORY_CONFIG_VERSION | typeof REPOSITORY_CONFIG_VERSION;
  readonly developer_terminal_enabled?: boolean;
  readonly policy: PolicyDocument;
}): Record<string, unknown> {
  return {
    schema_version: options.schema_version,
    ...(options.schema_version === REPOSITORY_CONFIG_VERSION
      ? { developer_terminal: { enabled: options.developer_terminal_enabled ?? true } }
      : {}),
    classification: "internal",
    policy: options.policy,
    grant_defaults: {
      readable_paths: ["**"],
      writable_paths: ["**"],
      disclosure_classifications: ["internal"],
    },
    commands: [],
    completion: {
      required_command_ids: [],
      require_validation_after_last_mutation: false,
    },
    limits: {
      max_file_bytes: 1_048_576,
      max_read_bytes: 131_072,
      max_search_output_bytes: 131_072,
      max_diff_bytes: 524_288,
      max_checkpoint_bytes: 16_777_216,
      max_patch_bytes: 4_194_304,
    },
    retention: { retain_source_artifacts_on_completion: false },
  };
}

function policyWithTerminalRules(
  policy: PolicyDocument,
  tools: NonNullable<PolicyDocument["capabilities"]["tools"]>,
  identity: Partial<Pick<PolicyDocument, "policy_id" | "revision">> = {},
): PolicyDocument {
  return {
    ...policy,
    ...identity,
    capabilities: { ...policy.capabilities, tools },
  };
}

function policyWithoutTerminalRules(policy: PolicyDocument, defaultDecision: PolicyDocument["default_decision"]): PolicyDocument {
  const { tools: _tools, ...capabilities } = policy.capabilities;
  return { ...policy, default_decision: defaultDecision, capabilities };
}

async function runDoctor(fixture: Fixture): Promise<DoctorCheck> {
  let output = "";
  await executeDoctorCommand({
    command: "doctor",
    repository: fixture.root,
    stateHome: fixture.stateHome,
    json: true,
  }, {
    stdout: { write: (value) => { output += value; } },
    stderr: { write: () => undefined },
  }, createStandardUserHost());
  const report = JSON.parse(output) as DoctorReport;
  const check = report.checks.find((candidate) => candidate.name === "Developer terminal");
  assert.ok(check, "doctor report did not include Developer terminal");
  return check;
}

function repositoryEvidence(check: DoctorCheck): Record<string, unknown> {
  const evidence = check.evidence?.repository_config;
  assert.ok(evidence && typeof evidence === "object");
  return evidence as Record<string, unknown>;
}

function machineEvidence(check: DoctorCheck): Record<string, unknown> {
  const evidence = check.evidence?.machine_policy;
  assert.ok(evidence && typeof evidence === "object");
  return evidence as Record<string, unknown>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
