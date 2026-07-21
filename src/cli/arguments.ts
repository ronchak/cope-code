import { AgentError } from "../shared/errors.js";
import type { AutonomyMode } from "../session/types.js";
import type { BrowserProduct } from "../browser/product.js";

export type TransportSelection = "edge" | "fixture" | "replay";

interface CommonOptions {
  readonly stateHome?: string;
  readonly json: boolean;
}

export type CliCommand =
  | ({
      readonly command: "interactive";
      readonly repository: string;
      readonly repositoryExplicit: boolean;
      readonly mode: AutonomyMode;
      readonly modeExplicit: boolean;
      readonly transport: TransportSelection;
      readonly continueRecent: boolean;
      readonly initialObjective?: string;
      readonly acceptanceCriteria: readonly string[];
      readonly approveGrant: boolean;
    } & CommonOptions)
  | ({
      readonly command: "demo";
      readonly repository: string;
      readonly mode: AutonomyMode;
    } & CommonOptions)
  | ({
      readonly command: "setup";
      readonly force: boolean;
      readonly identity?: string;
      readonly entryUrl?: string;
      readonly requireProtectionIndicator?: boolean;
      readonly browser?: BrowserProduct;
      readonly browserExecutable?: string;
    } & CommonOptions)
  | ({ readonly command: "doctor"; readonly repository: string } & CommonOptions)
  | ({ readonly command: "sessions"; readonly repository?: string; readonly all: boolean } & CommonOptions)
  | ({ readonly command: "init"; readonly repository: string; readonly force: boolean; readonly quick: boolean } & CommonOptions)
  | ({
      readonly command: "run";
      readonly objective: string;
      readonly repository: string;
      readonly mode: AutonomyMode;
      readonly transport: TransportSelection;
      readonly transcript?: string;
      readonly fixture?: string;
      readonly acceptanceCriteria: readonly string[];
      readonly approveGrant: boolean;
    } & CommonOptions)
  | ({
      readonly command: "resume";
      readonly sessionId: string;
      readonly transport?: TransportSelection;
      readonly transcript?: string;
      readonly fixture?: string;
      readonly approveGrant: boolean;
    } & CommonOptions)
  | ({ readonly command: "status"; readonly sessionId: string } & CommonOptions)
  | ({ readonly command: "pause"; readonly sessionId: string; readonly reason?: string } & CommonOptions)
  | ({ readonly command: "abort"; readonly sessionId: string; readonly reason?: string } & CommonOptions)
  | ({ readonly command: "rollback"; readonly sessionId: string; readonly checkpointId?: string; readonly force: boolean } & CommonOptions)
  | ({ readonly command: "verify-audit"; readonly sessionId: string } & CommonOptions)
  | ({ readonly command: "export-review"; readonly sessionId: string; readonly output?: string } & CommonOptions)
  | ({ readonly command: "help"; readonly advanced: boolean } & CommonOptions)
  | ({ readonly command: "version" } & CommonOptions);

const EXPLICIT_COMMANDS = new Set([
  "demo",
  "init",
  "run",
  "resume",
  "status",
  "pause",
  "abort",
  "rollback",
  "verify-audit",
  "export-review",
  "setup",
  "doctor",
  "sessions",
  "help",
  "version",
  "open",
]);

export function parseCliArguments(argv: readonly string[]): CliCommand {
  const args = [...argv];

  if (args.length === 0) return interactiveCommand(args);

  if (args[0] === "--help" || args[0] === "-h") {
    args.shift();
    const advanced = args.shift() === "advanced";
    assertNoUnknown(args);
    return { command: "help", advanced, json: false };
  }
  if (args[0] === "--version" || args[0] === "-v") {
    args.shift();
    assertNoUnknown(args);
    return { command: "version", json: false };
  }

  const first = args[0];
  if (first !== undefined && !EXPLICIT_COMMANDS.has(first)) return convenienceCommand(args);

  const command = args.shift() ?? "help";
  const common = takeCommonOptions(args);

  switch (command) {
    case "demo": {
      const repository = takeOptionAny(args, ["--repo", "-C"]) ?? takeOptionalPositional(args) ?? process.cwd();
      const mode = takeMode(args, "edit").mode;
      assertNoUnknown(args);
      return { command, repository, mode, ...common };
    }
    case "open": {
      const repositoryOption = takeOptionAny(args, ["--repo", "-C"]);
      const repositoryPositional = repositoryOption === undefined ? takeOptionalPositional(args) : undefined;
      const repository = repositoryOption ?? repositoryPositional ?? process.cwd();
      const modeSelection = takeMode(args, "edit");
      const transport = parseTransport(takeOption(args, "--transport") ?? "edge");
      const continueRecent = takeFlagAny(args, ["--continue", "-c"]);
      const acceptanceCriteria = takeRepeatedOption(args, "--accept");
      const approveGrant = takeFlagAny(args, ["--approve-grant", "--yes", "-y"]);
      assertNoUnknown(args);
      return {
        command: "interactive",
        repository,
        repositoryExplicit: repositoryOption !== undefined || repositoryPositional !== undefined,
        mode: modeSelection.mode,
        modeExplicit: modeSelection.explicit,
        transport,
        continueRecent,
        acceptanceCriteria,
        approveGrant,
        ...common,
      };
    }
    case "setup": {
      const force = takeFlag(args, "--force");
      const identity = takeOption(args, "--identity");
      const entryUrl = takeOption(args, "--entry-url");
      const browserValue = takeOption(args, "--browser");
      const browser = browserValue === undefined ? undefined : parseBrowserProduct(browserValue);
      const browserExecutable = takeOption(args, "--browser-executable");
      const noProtection = takeFlag(args, "--no-protection");
      const requireProtection = takeFlag(args, "--require-protection");
      if (noProtection && requireProtection) {
        throw new AgentError("CONFIG_INVALID", "Choose either --no-protection or --require-protection, not both");
      }
      assertNoUnknown(args);
      return {
        command,
        force,
        ...common,
        ...(identity === undefined ? {} : { identity }),
        ...(entryUrl === undefined ? {} : { entryUrl }),
        ...(browser === undefined ? {} : { browser }),
        ...(browserExecutable === undefined ? {} : { browserExecutable }),
        ...(noProtection
          ? { requireProtectionIndicator: false }
          : requireProtection
            ? { requireProtectionIndicator: true }
            : {}),
      };
    }
    case "doctor": {
      const repository = takeOptionAny(args, ["--repo", "-C"]) ?? takeOptionalPositional(args) ?? process.cwd();
      assertNoUnknown(args);
      return { command, repository, ...common };
    }
    case "sessions": {
      const repository = takeOptionAny(args, ["--repo", "-C"]);
      const all = takeFlag(args, "--all");
      assertNoUnknown(args);
      return { command, all, ...common, ...(repository === undefined ? {} : { repository }) };
    }
    case "init": {
      const repository = takeOptionAny(args, ["--repo", "-C"]) ?? takeOptionalPositional(args) ?? process.cwd();
      const force = takeFlag(args, "--force");
      const quick = takeFlag(args, "--quick");
      assertNoUnknown(args);
      return { command, repository, force, quick, ...common };
    }
    case "run": {
      const repository = takeOptionAny(args, ["--repo", "-C"]) ?? process.cwd();
      const mode = takeMode(args, "edit").mode;
      const transport = parseTransport(takeOption(args, "--transport") ?? "edge");
      const transcript = takeOption(args, "--transcript");
      const fixture = takeOption(args, "--fixture");
      const acceptanceCriteria = takeRepeatedOption(args, "--accept");
      const approveGrant = takeFlagAny(args, ["--approve-grant", "--yes", "-y"]);
      const objective = takeOption(args, "--objective") ?? collectPositionals(args);
      validateRunTransport(transport, transcript, fixture);
      if (!objective || objective.trim().length === 0) {
        throw new AgentError("CONFIG_INVALID", "run requires a non-empty objective");
      }
      assertNoUnknown(args);
      return {
        command,
        objective,
        repository,
        mode,
        transport,
        acceptanceCriteria,
        approveGrant,
        ...common,
        ...(transcript === undefined ? {} : { transcript }),
        ...(fixture === undefined ? {} : { fixture }),
      };
    }
    case "resume": {
      const sessionId = requirePositional(args, "resume requires a session identifier");
      const transportValue = takeOption(args, "--transport");
      const transport = transportValue === undefined ? undefined : parseTransport(transportValue);
      const transcript = takeOption(args, "--transcript");
      const fixture = takeOption(args, "--fixture");
      const approveGrant = takeFlagAny(args, ["--approve-grant", "--yes", "-y"]);
      validateResumeTransport(transport, transcript, fixture);
      assertNoUnknown(args);
      return {
        command,
        sessionId,
        approveGrant,
        ...common,
        ...(transport === undefined ? {} : { transport }),
        ...(transcript === undefined ? {} : { transcript }),
        ...(fixture === undefined ? {} : { fixture }),
      };
    }
    case "status": {
      const sessionId = requirePositional(args, "status requires a session identifier");
      assertNoUnknown(args);
      return { command, sessionId, ...common };
    }
    case "verify-audit": {
      const sessionId = requirePositional(args, "verify-audit requires a session identifier");
      assertNoUnknown(args);
      return { command, sessionId, ...common };
    }
    case "export-review": {
      const sessionId = requirePositional(args, "export-review requires a session identifier");
      const output = takeOption(args, "--output");
      assertNoUnknown(args);
      return { command, sessionId, ...common, ...(output === undefined ? {} : { output }) };
    }
    case "pause": {
      const sessionId = requirePositional(args, "pause requires a session identifier");
      const reason = takeOption(args, "--reason");
      assertNoUnknown(args);
      return { command, sessionId, ...common, ...(reason === undefined ? {} : { reason }) };
    }
    case "abort": {
      const sessionId = requirePositional(args, "abort requires a session identifier");
      const reason = takeOption(args, "--reason");
      assertNoUnknown(args);
      return { command, sessionId, ...common, ...(reason === undefined ? {} : { reason }) };
    }
    case "rollback": {
      const sessionId = requirePositional(args, "rollback requires a session identifier");
      const checkpointId = takeOption(args, "--checkpoint");
      const force = takeFlag(args, "--force");
      assertNoUnknown(args);
      return { command, sessionId, force, ...common, ...(checkpointId === undefined ? {} : { checkpointId }) };
    }
    case "help": {
      const advanced = args.shift() === "advanced";
      assertNoUnknown(args);
      return { command, advanced, ...common };
    }
    case "version":
      assertNoUnknown(args);
      return { command, ...common };
    default:
      throw new AgentError("CONFIG_INVALID", `Unknown command '${command}'`);
  }
}

function convenienceCommand(args: string[]): CliCommand {
  const common = takeCommonOptions(args);
  const repositoryOption = takeOptionAny(args, ["--repo", "-C"]);
  const repository = repositoryOption ?? process.cwd();
  const modeSelection = takeMode(args, "edit");
  const transport = parseTransport(takeOption(args, "--transport") ?? "edge");
  const continueRecent = takeFlagAny(args, ["--continue", "-c"]);
  const acceptanceCriteria = takeRepeatedOption(args, "--accept");
  const approveGrant = takeFlagAny(args, ["--approve-grant", "--yes", "-y"]);
  const initialObjective = takeOption(args, "--objective") ?? collectPositionals(args);
  assertNoUnknown(args);
  if (continueRecent && initialObjective !== undefined) {
    throw new AgentError("CONFIG_INVALID", "--continue cannot be combined with a new objective");
  }
  return {
    command: "interactive",
    repository,
    repositoryExplicit: repositoryOption !== undefined,
    mode: modeSelection.mode,
    modeExplicit: modeSelection.explicit,
    transport,
    continueRecent,
    acceptanceCriteria,
    approveGrant,
    ...common,
    ...(initialObjective === undefined ? {} : { initialObjective }),
  };
}

function interactiveCommand(args: string[]): CliCommand {
  const common = takeCommonOptions(args);
  const repositoryOption = takeOptionAny(args, ["--repo", "-C"]);
  const repository = repositoryOption ?? process.cwd();
  const modeSelection = takeMode(args, "edit");
  const transport = parseTransport(takeOption(args, "--transport") ?? "edge");
  const continueRecent = takeFlagAny(args, ["--continue", "-c"]);
  const acceptanceCriteria = takeRepeatedOption(args, "--accept");
  const approveGrant = takeFlagAny(args, ["--approve-grant", "--yes", "-y"]);
  assertNoUnknown(args);
  return {
    command: "interactive",
    repository,
    repositoryExplicit: repositoryOption !== undefined,
    mode: modeSelection.mode,
    modeExplicit: modeSelection.explicit,
    transport,
    continueRecent,
    acceptanceCriteria,
    approveGrant,
    ...common,
  };
}

function takeCommonOptions(args: string[]): CommonOptions {
  const stateHome = takeOption(args, "--state-home");
  return { json: takeFlag(args, "--json"), ...(stateHome === undefined ? {} : { stateHome }) };
}

function takeMode(args: string[], fallback: AutonomyMode): { readonly mode: AutonomyMode; readonly explicit: boolean } {
  const explicit = takeOption(args, "--mode");
  const aliases = [
    ["--inspect", "inspect"],
    ["--edit", "edit"],
    ["--auto", "auto"],
  ] as const;
  const selected = aliases.filter(([flag]) => takeFlag(args, flag)).map(([, mode]) => mode);
  if (explicit !== undefined && selected.length > 0) {
    throw new AgentError("CONFIG_INVALID", "Use --mode or a mode shortcut, not both");
  }
  if (selected.length > 1) {
    throw new AgentError("CONFIG_INVALID", "Choose only one of --inspect, --edit, or --auto");
  }
  return {
    mode: parseMode(explicit ?? selected[0] ?? fallback),
    explicit: explicit !== undefined || selected.length > 0,
  };
}

function validateRunTransport(transport: TransportSelection, transcript: string | undefined, fixture: string | undefined): void {
  if (transport === "replay" && !transcript) throw new AgentError("CONFIG_INVALID", "--transport replay requires --transcript");
  if (transport === "fixture" && !fixture) throw new AgentError("CONFIG_INVALID", "--transport fixture requires --fixture");
  if (transport !== "replay" && transcript !== undefined) throw new AgentError("CONFIG_INVALID", "--transcript requires --transport replay");
  if (transport !== "fixture" && fixture !== undefined) throw new AgentError("CONFIG_INVALID", "--fixture requires --transport fixture");
}

function validateResumeTransport(transport: TransportSelection | undefined, transcript: string | undefined, fixture: string | undefined): void {
  if (transport === "replay" && transcript === undefined) throw new AgentError("CONFIG_INVALID", "--transport replay requires --transcript");
  if (transport === "fixture" && fixture === undefined) throw new AgentError("CONFIG_INVALID", "--transport fixture requires --fixture");
  if (transport !== "replay" && transcript !== undefined) throw new AgentError("CONFIG_INVALID", "--transcript requires --transport replay");
  if (transport !== "fixture" && fixture !== undefined) throw new AgentError("CONFIG_INVALID", "--fixture requires --transport fixture");
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) throw new AgentError("CONFIG_INVALID", `${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeOptionAny(args: string[], names: readonly string[]): string | undefined {
  const found = names.filter((name) => args.includes(name));
  if (found.length > 1) throw new AgentError("CONFIG_INVALID", `Use only one of ${names.join(" or ")}`);
  return found[0] === undefined ? undefined : takeOption(args, found[0]);
}

function takeRepeatedOption(args: string[], name: string): string[] {
  const values: string[] = [];
  while (args.includes(name)) {
    const value = takeOption(args, name);
    if (value !== undefined) values.push(value);
  }
  return values;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function takeFlagAny(args: string[], names: readonly string[]): boolean {
  const found = names.filter((name) => args.includes(name));
  if (found.length > 1) throw new AgentError("CONFIG_INVALID", `Use only one of ${names.join(" or ")}`);
  return found[0] === undefined ? false : takeFlag(args, found[0]);
}

function parseMode(value: string): AutonomyMode {
  if (value !== "inspect" && value !== "edit" && value !== "auto") {
    throw new AgentError("CONFIG_INVALID", `Invalid mode '${value}'`);
  }
  return value;
}

function parseTransport(value: string): TransportSelection {
  if (value !== "edge" && value !== "fixture" && value !== "replay") {
    throw new AgentError("CONFIG_INVALID", `Invalid transport '${value}'`);
  }
  return value;
}

function parseBrowserProduct(value: string): BrowserProduct {
  if (value !== "edge" && value !== "chrome") {
    throw new AgentError("CONFIG_INVALID", `Invalid browser '${value}'; choose edge or chrome`);
  }
  return value;
}

function requirePositional(args: string[], message: string): string {
  const value = args.shift();
  if (!value || value.startsWith("--")) throw new AgentError("CONFIG_INVALID", message);
  return value;
}

function takeOptionalPositional(args: string[]): string | undefined {
  const value = args[0];
  if (value === undefined || value.startsWith("-")) return undefined;
  args.shift();
  return value;
}

function collectPositionals(args: string[]): string | undefined {
  const firstOption = args.findIndex((entry) => entry.startsWith("-"));
  const count = firstOption === -1 ? args.length : firstOption;
  if (count === 0) return undefined;
  return args.splice(0, count).join(" ").trim() || undefined;
}

function assertNoUnknown(args: readonly string[]): void {
  if (args.length > 0) throw new AgentError("CONFIG_INVALID", `Unexpected argument(s): ${args.join(" ")}`);
}
