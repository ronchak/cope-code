import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import type { RepositoryAgentConfig } from "../config/types.js";
import {
  assertValidPolicyDocument,
  type PolicyDecision,
  type PolicyDocument,
} from "../policy/index.js";
import {
  runHostProbe,
  type HostPlatform,
  type ProbeResult,
  type ProbeRunner,
} from "../platform/index.js";
import { errorMessage } from "../shared/errors.js";

export interface DoctorProbeDependencies {
  readonly runProbe?: ProbeRunner;
  readonly resolveNpmCli?: () => Promise<string | undefined>;
}

export interface NpmDoctorProbeResult extends ProbeResult {
  readonly npmCli?: string;
}

export type TerminalToolDecisionField =
  | "capabilities.tools.deny"
  | "capabilities.tools.ask"
  | "capabilities.tools.allow"
  | "capabilities.tools.unmatched"
  | "default_decision";

export interface TerminalToolDecision {
  readonly decision: PolicyDecision;
  readonly field: TerminalToolDecisionField;
}

export interface DeveloperTerminalDoctorEvidence {
  readonly repository_config: {
    readonly file: string;
    readonly schema_version: RepositoryAgentConfig["schema_version"];
    readonly developer_terminal_enabled: boolean;
  };
  readonly repository_policy?: {
    readonly policy_id: string;
    readonly revision: string;
    readonly field: TerminalToolDecisionField;
    readonly decision: PolicyDecision;
  };
  readonly machine_policy: {
    readonly status: "not_read" | "absent" | "unreadable" | "malformed" | "valid";
    readonly path: string;
    readonly error?: string;
    readonly policy_id?: string;
    readonly revision?: string;
    readonly field?: TerminalToolDecisionField;
    readonly decision?: PolicyDecision;
  };
}

export interface DeveloperTerminalDoctorResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly evidence: DeveloperTerminalDoctorEvidence;
}

/**
 * Resolve the terminal tool exactly as the runtime resolves a tool rule. The
 * field is retained as evidence so doctor can explain which rule won without
 * exposing the policy document itself.
 */
export function resolveTerminalToolDecision(policy: PolicyDocument): TerminalToolDecision {
  const rules = policy.capabilities.tools;
  if (rules?.deny?.includes("terminal_exec") === true) {
    return { decision: "deny", field: "capabilities.tools.deny" };
  }
  if (rules?.ask?.includes("terminal_exec") === true) {
    return { decision: "ask", field: "capabilities.tools.ask" };
  }
  if (rules?.allow?.includes("terminal_exec") === true) {
    return { decision: "allow", field: "capabilities.tools.allow" };
  }
  if (rules?.unmatched !== undefined) {
    return { decision: rules.unmatched, field: "capabilities.tools.unmatched" };
  }
  return { decision: policy.default_decision, field: "default_decision" };
}

/**
 * Read-only, ordered diagnosis of terminal availability for a newly-created
 * Developer (internal mode `auto`) session. The organization policy is not
 * touched until the repository/session prerequisites and embedded repository
 * policy have both allowed terminal_exec.
 */
export async function diagnoseDeveloperTerminal(input: {
  readonly repositoryConfigFile: string;
  readonly repositoryConfig: RepositoryAgentConfig;
  readonly machinePolicyFile: string;
}): Promise<DeveloperTerminalDoctorResult> {
  const repositoryConfigEvidence = {
    file: input.repositoryConfigFile,
    schema_version: input.repositoryConfig.schema_version,
    developer_terminal_enabled: input.repositoryConfig.developer_terminal.enabled,
  } as const;
  const notReadMachine = {
    status: "not_read" as const,
    path: input.machinePolicyFile,
  };

  if (input.repositoryConfig.schema_version === "cba-repository-config/1") {
    return {
      ok: false,
      detail:
        `Developer terminal unavailable: ${input.repositoryConfigFile} uses repository schema cba-repository-config/1, ` +
        "so the session layer denies `terminal_exec` unconditionally for new sessions. " +
        "The machine policy was not read for this check. " +
        "If Developer mode is intended, run `cope init . --quick --force`; it overwrites `.cba/repository.json`, " +
        "including custom commands, limits, grants, and completion settings, so back up and diff it first.",
      evidence: {
        repository_config: repositoryConfigEvidence,
        machine_policy: notReadMachine,
      },
    };
  }

  if (!input.repositoryConfig.developer_terminal.enabled) {
    return {
      ok: false,
      detail:
        `Developer terminal unavailable: ${input.repositoryConfigFile} has developer_terminal.enabled=false; ` +
        "the session layer denies `terminal_exec` for new sessions. The machine policy was not read for this check. " +
        "If Developer mode is intended, optionally run `cope init . --quick --force`; it overwrites `.cba/repository.json`, " +
        "including custom commands, limits, grants, and completion settings, so back up and diff it first.",
      evidence: {
        repository_config: repositoryConfigEvidence,
        machine_policy: notReadMachine,
      },
    };
  }

  const repositoryDecision = resolveTerminalToolDecision(input.repositoryConfig.policy);
  const repositoryPolicyEvidence = policyDecisionEvidence(input.repositoryConfig.policy, repositoryDecision);
  if (repositoryDecision.decision !== "allow") {
    return {
      ok: false,
      detail:
        `Developer terminal unavailable: ${input.repositoryConfigFile}; ${repositoryDecision.field} selects decision ` +
        `"${repositoryDecision.decision}" for terminal_exec (policy_id "${input.repositoryConfig.policy.policy_id}", ` +
        `revision "${input.repositoryConfig.policy.revision}"). The machine policy was not read because the ` +
        "repository layer already blocks an unconditional grant for a new Developer (`auto`) session.",
      evidence: {
        repository_config: repositoryConfigEvidence,
        repository_policy: repositoryPolicyEvidence,
        machine_policy: notReadMachine,
      },
    };
  }

  const machinePolicy = await readOrganizationPolicy(input.machinePolicyFile);
  if (machinePolicy.status !== "valid") {
    return {
      ok: false,
      detail: machinePolicy.detail,
      evidence: {
        repository_config: repositoryConfigEvidence,
        repository_policy: repositoryPolicyEvidence,
        machine_policy: machinePolicy.evidence,
      },
    };
  }

  const machineDecision = resolveTerminalToolDecision(machinePolicy.policy);
  const machinePolicyEvidence = policyDecisionEvidence(machinePolicy.policy, machineDecision);
  if (machineDecision.decision !== "allow") {
    const askExplanation = machineDecision.decision === "ask"
      ? " It requires approval and is not a denial, but it blocks an unconditional initial terminal grant."
      : " It blocks an unconditional initial terminal grant.";
    return {
      ok: false,
      detail:
        `Developer terminal unavailable: ${input.machinePolicyFile}; ${machineDecision.field} selects decision ` +
        `"${machineDecision.decision}" for terminal_exec (policy_id "${machinePolicy.policy.policy_id}", revision "${machinePolicy.policy.revision}").` +
        askExplanation,
      evidence: {
        repository_config: repositoryConfigEvidence,
        repository_policy: repositoryPolicyEvidence,
        machine_policy: {
          status: "valid",
          path: input.machinePolicyFile,
          ...machinePolicyEvidence,
        },
      },
    };
  }

  return {
    ok: true,
    detail:
      "Developer terminal available for a new Developer (`auto`) session: the repository v2 enable bit, " +
      `embedded repository policy ${repositoryDecision.field} decision "allow", and machine policy ` +
      `${input.machinePolicyFile} ${machineDecision.field} decision "allow" all allow terminal_exec ` +
      `(repository policy_id "${input.repositoryConfig.policy.policy_id}" revision "${input.repositoryConfig.policy.revision}"; ` +
      `machine policy_id "${machinePolicy.policy.policy_id}" revision "${machinePolicy.policy.revision}").`,
    evidence: {
      repository_config: repositoryConfigEvidence,
      repository_policy: repositoryPolicyEvidence,
      machine_policy: {
        status: "valid",
        path: input.machinePolicyFile,
        ...machinePolicyEvidence,
      },
    },
  };
}

function policyDecisionEvidence(
  policy: PolicyDocument,
  decision: TerminalToolDecision,
): {
  readonly policy_id: string;
  readonly revision: string;
  readonly field: TerminalToolDecisionField;
  readonly decision: PolicyDecision;
} {
  return {
    policy_id: policy.policy_id,
    revision: policy.revision,
    field: decision.field,
    decision: decision.decision,
  };
}

type MachinePolicyReadResult =
  | {
      readonly status: "valid";
      readonly policy: PolicyDocument;
    }
  | {
      readonly status: "absent" | "unreadable" | "malformed";
      readonly detail: string;
      readonly evidence: DeveloperTerminalDoctorEvidence["machine_policy"];
    };

async function readOrganizationPolicy(machinePolicyFile: string): Promise<MachinePolicyReadResult> {
  let text: string;
  try {
    text = await readFile(machinePolicyFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        status: "absent",
        detail:
          `Developer terminal unavailable: machine policy file ${machinePolicyFile} is absent. ` +
          "No machine policy decision was available for the initial terminal grant.",
        evidence: { status: "absent", path: machinePolicyFile },
      };
    }
    const message = boundedDiagnosticError(error);
    return {
      status: "unreadable",
      detail:
        `Developer terminal unavailable: machine policy file ${machinePolicyFile} could not be read: ${message}. ` +
        "No machine policy decision was available for the initial terminal grant.",
      evidence: { status: "unreadable", path: machinePolicyFile, error: message },
    };
  }

  try {
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      throw new Error("Invalid JSON syntax");
    }
    assertValidPolicyDocument(raw);
    if (raw.layer !== "organization") {
      throw new Error(`Policy document has layer '${raw.layer}', expected organization`);
    }
    return { status: "valid", policy: raw };
  } catch (error) {
    const message = boundedDiagnosticError(error);
    return {
      status: "malformed",
      detail:
        `Developer terminal unavailable: machine policy file ${machinePolicyFile} was read but is malformed or not a valid ` +
        `organization policy: ${message}. No machine policy decision was available for the initial terminal grant.`,
      evidence: { status: "malformed", path: machinePolicyFile, error: message },
    };
  }
}

function boundedDiagnosticError(error: unknown): string {
  return errorMessage(error).replace(/[\r\n]+/gu, " ").slice(0, 240);
}

/**
 * Doctor is diagnostic code. A failed process launch must become a failed check,
 * not abort the command before the remaining checks can run.
 */
export async function runDoctorProbe(
  runner: ProbeRunner,
  executable: string,
  args: readonly string[],
  cwd: string,
  host: HostPlatform,
): Promise<ProbeResult> {
  try {
    return await runner(
      executable,
      args,
      cwd,
      host.probeEnvironment(process.env),
      host.platform === "win32",
    );
  } catch (error) {
    return { exitCode: null, stdout: "", stderr: errorMessage(error) };
  }
}

/**
 * npm.cmd is a Windows shell script and cannot be safely spawned with
 * shell=false. Resolve npm's JavaScript entrypoint and run it through the
 * current Node executable instead.
 */
export async function probeNpmVersion(
  host: HostPlatform,
  cwd: string,
  dependencies: DoctorProbeDependencies = {},
): Promise<NpmDoctorProbeResult> {
  let npmCli: string | undefined;
  try {
    npmCli = await (dependencies.resolveNpmCli ?? resolveNpmCliForCurrentRuntime)();
  } catch (error) {
    return { exitCode: null, stdout: "", stderr: errorMessage(error) };
  }
  if (npmCli === undefined) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "npm CLI could not be located in the active Node.js installation",
    };
  }
  if (!isNpmCliEntryPoint(npmCli)) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "Resolved package-manager entrypoint is not npm/bin/npm-cli.js",
    };
  }
  const result = await runDoctorProbe(
    dependencies.runProbe ?? runHostProbe,
    process.execPath,
    [npmCli, "--version"],
    cwd,
    host,
  );
  return { ...result, npmCli };
}

export async function resolveNpmCliForCurrentRuntime(): Promise<string | undefined> {
  const executableDirectory = path.dirname(process.execPath);
  const siblingNpmCli = await resolveSiblingNpmCli(executableDirectory);
  const candidates = unique([
    siblingNpmCli,
    path.join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    process.env.ProgramFiles === undefined
      ? undefined
      : path.join(process.env.ProgramFiles, "nodejs", "node_modules", "npm", "bin", "npm-cli.js"),
    process.env["ProgramFiles(x86)"] === undefined
      ? undefined
      : path.join(process.env["ProgramFiles(x86)"], "nodejs", "node_modules", "npm", "bin", "npm-cli.js"),
    process.env.APPDATA === undefined
      ? undefined
      : path.join(process.env.APPDATA, "npm", "node_modules", "npm", "bin", "npm-cli.js"),
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/share/nodejs/npm/bin/npm-cli.js",
  ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0));

  for (const candidate of candidates) {
    if (!isNpmCliEntryPoint(candidate)) continue;
    try {
      await access(candidate, constants.F_OK);
      return path.resolve(candidate);
    } catch {
      // Continue through the bounded, deterministic candidate list.
    }
  }
  return undefined;
}

async function resolveSiblingNpmCli(executableDirectory: string): Promise<string | undefined> {
  for (const name of ["npm", "npm.cmd"] as const) {
    try {
      const resolved = await realpath(path.join(executableDirectory, name));
      if (isNpmCliEntryPoint(resolved)) return resolved;
    } catch {
      // Continue through the bounded sibling launcher list.
    }
  }
  return undefined;
}

export function isNpmCliEntryPoint(candidate: string): boolean {
  const parts = candidate
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
  return parts.at(-1) === "npm-cli.js" &&
    parts.at(-2) === "bin" &&
    parts.at(-3) === "npm";
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
