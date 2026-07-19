import path from "node:path";

import { AgentError } from "../shared/errors.js";
import { normalizeRepositoryPath } from "../repository/boundary.js";

export type CommandParameterValue = string | readonly string[] | number | boolean;
export type CommandParameters = Readonly<Record<string, CommandParameterValue>>;
export type CommandRisk = "low" | "medium" | "high";

interface ParameterBase {
  readonly name: string;
  readonly required?: boolean;
  readonly flag?: string;
  readonly allowLeadingDash?: boolean;
}

export type CommandParameterDefinition =
  | (ParameterBase & {
      readonly kind: "string";
      readonly pattern: string;
      readonly maxLength?: number;
    })
  | (ParameterBase & {
      readonly kind: "repository-path";
      readonly mustExist?: boolean;
    })
  | (ParameterBase & {
      readonly kind: "enum";
      readonly values: readonly string[];
    })
  | (ParameterBase & {
      readonly kind: "integer";
      readonly minimum?: number;
      readonly maximum?: number;
    })
  | (ParameterBase & {
      readonly kind: "boolean";
      readonly flag: string;
    })
  | (ParameterBase & {
      readonly kind: "string-list";
      readonly pattern: string;
      readonly maxItems?: number;
      readonly maxItemLength?: number;
    });

export interface CommandDefinition {
  readonly id: string;
  readonly description?: string;
  readonly category: string;
  readonly risk: CommandRisk;
  readonly sideEffects: boolean;
  readonly networkRequired: boolean;
  readonly networkHosts?: readonly string[];
  readonly executable: string;
  readonly fixedArguments?: readonly string[];
  readonly parameters?: readonly CommandParameterDefinition[];
  readonly workingDirectory?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly successExitCodes?: readonly number[];
}

export interface RunCommandRequest {
  readonly command_id: string;
  readonly parameters?: CommandParameters;
  readonly timeout_ms?: number;
  readonly operationId?: string;
}

export interface ResolvedCommand {
  readonly id: string;
  readonly category: string;
  readonly risk: CommandRisk;
  readonly sideEffects: boolean;
  readonly networkRequired: boolean;
  readonly networkHosts: readonly string[];
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly successExitCodes: readonly number[];
  readonly repositoryPathParameters: readonly {
    readonly value: string;
    readonly mustExist: boolean;
  }[];
}

export interface CommandDescriptor {
  readonly id: string;
  readonly description?: string;
  readonly category: string;
  readonly risk: CommandRisk;
  readonly sideEffects: boolean;
  readonly networkRequired: boolean;
  readonly networkHosts: readonly string[];
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly parameters: readonly CommandParameterDefinition[];
}

const FORBIDDEN_EXECUTABLES = new Set([
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "tcsh",
  "csh",
  "wscript.exe",
  "cscript.exe",
]);

const FORBIDDEN_ENVIRONMENT_KEYS = new Set([
  "COMSPEC",
  "DYLD_FORCE_FLAT_NAMESPACE",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PATH",
  "PATHEXT",
  "PYTHONPATH",
]);

export class CommandCatalog {
  private readonly definitions = new Map<string, CommandDefinition>();

  public constructor(definitions: readonly CommandDefinition[]) {
    if (!Array.isArray(definitions) || definitions.length > 1_024) {
      throw new AgentError("CONFIG_INVALID", "Command catalog must be a bounded array");
    }
    for (const definition of definitions) {
      validateDefinition(definition);
      if (this.definitions.has(definition.id)) {
        throw new AgentError("CONFIG_INVALID", "Duplicate command catalog identifier", {
          commandId: definition.id,
        });
      }
      this.definitions.set(definition.id, freezeDefinition(definition));
    }
  }

  public list(): readonly CommandDescriptor[] {
    return [...this.definitions.values()].map((definition) => descriptor(definition));
  }

  /** Returns safe catalog metadata for outer policy evaluation; no executable is exposed. */
  public inspect(commandId: string): CommandDescriptor | undefined {
    const definition = this.definitions.get(commandId);
    return definition === undefined ? undefined : descriptor(definition);
  }

  public describe(commandId: string): CommandDescriptor {
    const result = this.inspect(commandId);
    if (result === undefined) {
      throw new AgentError("POLICY_DENIED", "Command is not present in the approved catalog", {
        commandId,
      });
    }
    return result;
  }

  public resolve(request: RunCommandRequest): ResolvedCommand {
    const definition = this.definitions.get(request.command_id);
    if (definition === undefined) {
      throw new AgentError("POLICY_DENIED", "Command is not present in the approved catalog", {
        commandId: request.command_id,
      });
    }
    const supplied = request.parameters ?? {};
    const knownNames = new Set((definition.parameters ?? []).map((parameter) => parameter.name));
    const unknown = Object.keys(supplied).filter((name) => !knownNames.has(name));
    if (unknown.length > 0) {
      throw new AgentError("POLICY_DENIED", "Command contains unapproved parameters", {
        commandId: definition.id,
        parameters: unknown,
      });
    }

    const arguments_: string[] = [...(definition.fixedArguments ?? [])];
    const repositoryPathParameters: Array<{ readonly value: string; readonly mustExist: boolean }> = [];
    for (const parameter of definition.parameters ?? []) {
      const value = supplied[parameter.name];
      if (value === undefined) {
        if (parameter.required === true) {
          throw new AgentError("PROTOCOL_INVALID", "Required command parameter is missing", {
            commandId: definition.id,
            parameter: parameter.name,
          });
        }
        continue;
      }
      const serialized = serializeParameter(parameter, value);
      if (parameter.kind === "repository-path") {
        repositoryPathParameters.push({
          value: serialized[0] ?? "",
          mustExist: parameter.mustExist ?? true,
        });
      }
      if (parameter.kind === "boolean") {
        arguments_.push(...serialized);
      } else if (parameter.flag !== undefined) {
        for (const argument of serialized) {
          arguments_.push(parameter.flag, argument);
        }
      } else {
        arguments_.push(...serialized);
      }
    }

    const configuredMaximum = definition.maxTimeoutMs ?? definition.timeoutMs ?? 120_000;
    const timeoutMs = request.timeout_ms ?? definition.timeoutMs ?? configuredMaximum;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > configuredMaximum
    ) {
      throw new AgentError("POLICY_DENIED", "Requested command timeout exceeds the catalog limit", {
        commandId: definition.id,
        timeoutMs,
        maxTimeoutMs: configuredMaximum,
      });
    }

    return {
      id: definition.id,
      category: definition.category,
      risk: definition.risk,
      sideEffects: definition.sideEffects,
      networkRequired: definition.networkRequired,
      networkHosts: definition.networkHosts ?? [],
      executable: definition.executable,
      arguments: arguments_,
      workingDirectory: normalizeWorkingDirectory(definition.workingDirectory),
      environment: { ...(definition.environment ?? {}) },
      timeoutMs,
      maxOutputBytes: definition.maxOutputBytes ?? 256 * 1024,
      successExitCodes: definition.successExitCodes ?? [0],
      repositoryPathParameters,
    };
  }
}

function validateDefinition(definition: CommandDefinition): void {
  assertExactObjectKeys(definition, [
    "id",
    "description",
    "category",
    "risk",
    "sideEffects",
    "networkRequired",
    "networkHosts",
    "executable",
    "fixedArguments",
    "parameters",
    "workingDirectory",
    "environment",
    "timeoutMs",
    "maxTimeoutMs",
    "maxOutputBytes",
    "successExitCodes",
  ], "command definition");
  if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(definition.id)) {
    throw new AgentError("CONFIG_INVALID", "Command identifier is invalid", {
      commandId: definition.id,
    });
  }
  if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(definition.category)) {
    throw new AgentError("CONFIG_INVALID", "Command category is invalid", {
      commandId: definition.id,
      category: definition.category,
    });
  }
  if (!(["low", "medium", "high"] as const).includes(definition.risk)) {
    throw new AgentError("CONFIG_INVALID", "Command risk is invalid", {
      commandId: definition.id,
      risk: definition.risk,
    });
  }
  if (
    definition.description !== undefined &&
    (typeof definition.description !== "string" || definition.description.length > 4_096)
  ) {
    throw new AgentError("CONFIG_INVALID", "Command description is invalid", {
      commandId: definition.id,
    });
  }
  if (typeof definition.sideEffects !== "boolean" || typeof definition.networkRequired !== "boolean") {
    throw new AgentError("CONFIG_INVALID", "Command side-effect and network facts must be explicit", {
      commandId: definition.id,
    });
  }
  const networkHosts = definition.networkHosts;
  if (
    (networkHosts !== undefined && !Array.isArray(networkHosts)) ||
    (definition.networkRequired && (!Array.isArray(networkHosts) || networkHosts.length === 0)) ||
    (!definition.networkRequired && networkHosts !== undefined && networkHosts.length > 0) ||
    (Array.isArray(networkHosts) &&
      (new Set(networkHosts.map((host) => typeof host === "string" ? host.toLowerCase() : host)).size !== networkHosts.length ||
        !networkHosts.every(isExactHostname)))
  ) {
    throw new AgentError("CONFIG_INVALID", "Command network host metadata is invalid", {
      commandId: definition.id,
    });
  }
  if (
    typeof definition.executable !== "string" ||
    definition.executable === "" ||
    definition.executable.length > 32_768 ||
    definition.executable.includes("\0") ||
    /^(?:\\\\|\/\/|\\\\\?\\|\\\\\.\\|\\\?\?\\)/u.test(definition.executable)
  ) {
    throw new AgentError("CONFIG_INVALID", "Command executable is invalid; UNC and device paths are not allowed", {
      commandId: definition.id,
    });
  }
  const executableName = path.basename(definition.executable.replaceAll("\\", "/")).toLowerCase();
  if (
    FORBIDDEN_EXECUTABLES.has(executableName) ||
    /\.(?:cmd|bat|ps1)$/iu.test(executableName)
  ) {
    throw new AgentError(
      "CONFIG_INVALID",
      "Shells and Windows command-script shims are not allowed; invoke the underlying executable directly (for npm, use node.exe with npm-cli.js as a fixed argument)",
      { commandId: definition.id, executable: definition.executable },
    );
  }
  if (!path.isAbsolute(definition.executable) && !path.win32.isAbsolute(definition.executable)) {
    throw new AgentError("CONFIG_INVALID", "Command executable must be an absolute path", {
      commandId: definition.id,
      executable: definition.executable,
    });
  }
  for (const [name, value] of [
    ["timeoutMs", definition.timeoutMs],
    ["maxTimeoutMs", definition.maxTimeoutMs],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new AgentError("CONFIG_INVALID", "Command timeout is invalid", {
        commandId: definition.id,
        field: name,
      });
    }
  }
  if (
    definition.timeoutMs !== undefined &&
    definition.maxTimeoutMs !== undefined &&
    definition.timeoutMs > definition.maxTimeoutMs
  ) {
    throw new AgentError("CONFIG_INVALID", "Default command timeout exceeds its maximum", {
      commandId: definition.id,
    });
  }
  if (
    definition.successExitCodes !== undefined &&
    (!Array.isArray(definition.successExitCodes) ||
      definition.successExitCodes.length === 0 ||
      new Set(definition.successExitCodes).size !== definition.successExitCodes.length ||
      !definition.successExitCodes.every((code) => Number.isSafeInteger(code)))
  ) {
    throw new AgentError("CONFIG_INVALID", "Command success exit-code list is invalid", {
      commandId: definition.id,
    });
  }
  if (definition.fixedArguments !== undefined && !Array.isArray(definition.fixedArguments)) {
    throw new AgentError("CONFIG_INVALID", "Fixed command arguments must be an array", {
      commandId: definition.id,
    });
  }
  for (const argument of definition.fixedArguments ?? []) {
    if (typeof argument !== "string" || argument.length > 32_768 || argument.includes("\0")) {
      throw new AgentError("CONFIG_INVALID", "Fixed command argument is invalid", {
        commandId: definition.id,
      });
    }
  }
  if (
    definition.maxOutputBytes !== undefined &&
    (!Number.isSafeInteger(definition.maxOutputBytes) || definition.maxOutputBytes < 1)
  ) {
    throw new AgentError("CONFIG_INVALID", "Command output limit is invalid", {
      commandId: definition.id,
    });
  }
  if (definition.parameters !== undefined && !Array.isArray(definition.parameters)) {
    throw new AgentError("CONFIG_INVALID", "Command parameters must be an array", {
      commandId: definition.id,
    });
  }
  const names = new Set<string>();
  const flags = new Set<string>();
  for (const parameter of definition.parameters ?? []) {
    if (parameter === null || typeof parameter !== "object" || Array.isArray(parameter)) {
      throw new AgentError("CONFIG_INVALID", "command parameter must be an object", {
        commandId: definition.id,
      });
    }
    const runtimeKind = (parameter as unknown as { readonly kind?: unknown }).kind;
    if (typeof runtimeKind !== "string") {
      throw new AgentError("CONFIG_INVALID", "Command parameter kind is invalid", {
        commandId: definition.id,
      });
    }
    assertExactObjectKeys(
      parameter,
      parameterKeys(runtimeKind as CommandParameterDefinition["kind"]),
      "command parameter",
    );
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(parameter.name) || names.has(parameter.name)) {
      throw new AgentError("CONFIG_INVALID", "Command parameter name is invalid or duplicated", {
        commandId: definition.id,
        parameter: parameter.name,
      });
    }
    names.add(parameter.name);
    if (parameter.required !== undefined && typeof parameter.required !== "boolean") {
      throw new AgentError("CONFIG_INVALID", "Command parameter required flag is invalid", {
        commandId: definition.id,
        parameter: parameter.name,
      });
    }
    if (parameter.allowLeadingDash !== undefined && typeof parameter.allowLeadingDash !== "boolean") {
      throw new AgentError("CONFIG_INVALID", "Command parameter leading-dash flag is invalid", {
        commandId: definition.id,
        parameter: parameter.name,
      });
    }
    if (parameter.flag !== undefined && !/^--?[a-zA-Z0-9][a-zA-Z0-9-]*$/u.test(parameter.flag)) {
      throw new AgentError("CONFIG_INVALID", "Command parameter flag is invalid", {
        commandId: definition.id,
        parameter: parameter.name,
      });
    }
    if (parameter.kind === "boolean" && parameter.flag === undefined) {
      throw new AgentError("CONFIG_INVALID", "Boolean command parameters require an explicit flag", {
        commandId: definition.id,
        parameter: parameter.name,
      });
    }
    if (parameter.flag !== undefined) {
      if (flags.has(parameter.flag)) {
        throw new AgentError("CONFIG_INVALID", "Command parameter flags must be unique", {
          commandId: definition.id,
          flag: parameter.flag,
        });
      }
      flags.add(parameter.flag);
    }
    if ((parameter.kind === "string" || parameter.kind === "string-list")) {
      if (typeof parameter.pattern !== "string" || parameter.pattern.length === 0 || parameter.pattern.length > 4_096) {
        throw new AgentError("CONFIG_INVALID", "Command parameter pattern is invalid", {
          commandId: definition.id,
          parameter: parameter.name,
        });
      }
      try {
        void new RegExp(parameter.pattern, "u");
      } catch (error) {
        throw new AgentError(
          "CONFIG_INVALID",
          "Command parameter pattern is invalid",
          { commandId: definition.id, parameter: parameter.name },
          { cause: error },
        );
      }
    }
    validateParameterBounds(definition.id, parameter);
  }
  if (
    definition.environment !== undefined &&
    (definition.environment === null ||
      typeof definition.environment !== "object" ||
      Array.isArray(definition.environment))
  ) {
    throw new AgentError("CONFIG_INVALID", "Command environment must be an object", {
      commandId: definition.id,
    });
  }
  for (const [name, value] of Object.entries(definition.environment ?? {})) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      FORBIDDEN_ENVIRONMENT_KEYS.has(name.toUpperCase()) ||
      typeof value !== "string" ||
      value.length > 32_768 ||
      value.includes("\0")
    ) {
      throw new AgentError("CONFIG_INVALID", "Command environment entry is invalid", {
        commandId: definition.id,
        name,
      });
    }
  }
  if (definition.workingDirectory !== undefined && typeof definition.workingDirectory !== "string") {
    throw new AgentError("CONFIG_INVALID", "Command working directory is invalid", {
      commandId: definition.id,
    });
  }
  normalizeWorkingDirectory(definition.workingDirectory);
}

function parameterKeys(kind: CommandParameterDefinition["kind"]): readonly string[] {
  const base = ["name", "kind", "required", "flag", "allowLeadingDash"] as const;
  switch (kind) {
    case "string": return [...base, "pattern", "maxLength"];
    case "repository-path": return [...base, "mustExist"];
    case "enum": return [...base, "values"];
    case "integer": return [...base, "minimum", "maximum"];
    case "boolean": return [...base];
    case "string-list": return [...base, "pattern", "maxItems", "maxItemLength"];
    default:
      throw new AgentError("CONFIG_INVALID", "Command parameter kind is invalid");
  }
}

function assertExactObjectKeys(
  value: unknown,
  allowed: readonly string[],
  label: string,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentError("CONFIG_INVALID", `${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new AgentError("CONFIG_INVALID", `${label} contains unknown fields`, { fields: unknown });
  }
}

function serializeParameter(
  definition: CommandParameterDefinition,
  value: CommandParameterValue,
): readonly string[] {
  if (definition.kind === "boolean") {
    if (typeof value !== "boolean") {
      throw wrongType(definition.name, "boolean");
    }
    return value ? [definition.flag] : [];
  }
  if (definition.kind === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      (definition.minimum !== undefined && value < definition.minimum) ||
      (definition.maximum !== undefined && value > definition.maximum)
    ) {
      throw new AgentError("POLICY_DENIED", "Integer command parameter is outside its approved range", {
        parameter: definition.name,
      });
    }
    return [String(value)];
  }
  if (definition.kind === "string-list") {
    if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
      throw wrongType(definition.name, "string array");
    }
    if (value.length > (definition.maxItems ?? 20)) {
      throw new AgentError("POLICY_DENIED", "Command list parameter contains too many items", {
        parameter: definition.name,
      });
    }
    return value.map((item) =>
      validateString(item, definition.name, definition.pattern, definition.maxItemLength ?? 256, definition.allowLeadingDash),
    );
  }
  if (typeof value !== "string") {
    throw wrongType(definition.name, "string");
  }
  if (definition.kind === "repository-path") {
    const normalized = normalizeRepositoryPath(value);
    assertNoLeadingDash(normalized, definition.name, definition.allowLeadingDash);
    return [normalized];
  }
  if (definition.kind === "enum") {
    if (!definition.values.includes(value)) {
      throw new AgentError("POLICY_DENIED", "Command enum parameter is outside its approved values", {
        parameter: definition.name,
      });
    }
    assertNoLeadingDash(value, definition.name, definition.allowLeadingDash);
    return [value];
  }
  return [
    validateString(
      value,
      definition.name,
      definition.pattern,
      definition.maxLength ?? 256,
      definition.allowLeadingDash,
    ),
  ];
}

function validateString(
  value: string,
  name: string,
  pattern: string,
  maxLength: number,
  allowLeadingDash: boolean | undefined,
): string {
  if (
    value.length > maxLength ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n") ||
    !new RegExp(`^(?:${pattern})$`, "u").test(value)
  ) {
    throw new AgentError("POLICY_DENIED", "String command parameter does not match its approved pattern", {
      parameter: name,
    });
  }
  assertNoLeadingDash(value, name, allowLeadingDash);
  return value;
}

function assertNoLeadingDash(value: string, name: string, allowLeadingDash: boolean | undefined): void {
  if (allowLeadingDash !== true && value.startsWith("-")) {
    throw new AgentError("POLICY_DENIED", "Command parameter cannot introduce an option", {
      parameter: name,
    });
  }
}

function wrongType(parameter: string, expected: string): AgentError {
  return new AgentError("PROTOCOL_INVALID", `Command parameter must be a ${expected}`, { parameter });
}

function normalizeWorkingDirectory(workingDirectory: string | undefined): string {
  return workingDirectory === undefined || workingDirectory === "."
    ? ""
    : normalizeRepositoryPath(workingDirectory, true);
}

function freezeDefinition(definition: CommandDefinition): CommandDefinition {
  return Object.freeze({
    ...definition,
    fixedArguments: Object.freeze([...(definition.fixedArguments ?? [])]),
    parameters: Object.freeze((definition.parameters ?? []).map(freezeParameter)),
    networkHosts: Object.freeze([...(definition.networkHosts ?? [])]),
    environment: Object.freeze({ ...(definition.environment ?? {}) }),
    successExitCodes: Object.freeze([...(definition.successExitCodes ?? [0])]),
  });
}

function descriptor(definition: CommandDefinition): CommandDescriptor {
  const maxTimeoutMs = definition.maxTimeoutMs ?? definition.timeoutMs ?? 120_000;
  return Object.freeze({
    id: definition.id,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    category: definition.category,
    risk: definition.risk,
    sideEffects: definition.sideEffects,
    networkRequired: definition.networkRequired,
    networkHosts: Object.freeze([...(definition.networkHosts ?? [])]),
    defaultTimeoutMs: definition.timeoutMs ?? maxTimeoutMs,
    maxTimeoutMs,
    maxOutputBytes: definition.maxOutputBytes ?? 256 * 1024,
    parameters: Object.freeze((definition.parameters ?? []).map(freezeParameter)),
  });
}

function freezeParameter(parameter: CommandParameterDefinition): CommandParameterDefinition {
  if (parameter.kind === "enum") {
    return Object.freeze({ ...parameter, values: Object.freeze([...parameter.values]) });
  }
  return Object.freeze({ ...parameter });
}

function validateParameterBounds(commandId: string, parameter: CommandParameterDefinition): void {
  const invalidPositive = (value: number | undefined): boolean =>
    value !== undefined && (!Number.isSafeInteger(value) || value < 1);
  if (parameter.kind === "enum") {
    if (
      !Array.isArray(parameter.values) ||
      parameter.values.length === 0 ||
      new Set(parameter.values).size !== parameter.values.length ||
      parameter.values.some((value) =>
        typeof value !== "string" || value === "" || value.includes("\0"))
    ) {
      throw new AgentError("CONFIG_INVALID", "Command enum parameter values are invalid", {
        commandId,
        parameter: parameter.name,
      });
    }
  } else if (parameter.kind === "repository-path" &&
    parameter.mustExist !== undefined && typeof parameter.mustExist !== "boolean") {
    throw new AgentError("CONFIG_INVALID", "Repository-path existence flag is invalid", {
      commandId,
      parameter: parameter.name,
    });
  } else if (parameter.kind === "string" && invalidPositive(parameter.maxLength)) {
    throw new AgentError("CONFIG_INVALID", "Command string parameter limit is invalid", {
      commandId,
      parameter: parameter.name,
    });
  } else if (
    parameter.kind === "string-list" &&
    (invalidPositive(parameter.maxItems) || invalidPositive(parameter.maxItemLength))
  ) {
    throw new AgentError("CONFIG_INVALID", "Command list parameter limits are invalid", {
      commandId,
      parameter: parameter.name,
    });
  } else if (
    parameter.kind === "integer" &&
    ((parameter.minimum !== undefined && !Number.isSafeInteger(parameter.minimum)) ||
      (parameter.maximum !== undefined && !Number.isSafeInteger(parameter.maximum)) ||
      (parameter.minimum !== undefined &&
        parameter.maximum !== undefined &&
        parameter.minimum > parameter.maximum))
  ) {
    throw new AgentError("CONFIG_INVALID", "Command integer parameter range is invalid", {
      commandId,
      parameter: parameter.name,
    });
  }
}

function isExactHostname(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 253) return false;
  if (value !== value.toLowerCase() || value.endsWith(".") || value.includes("\0")) return false;
  if (value === "localhost") return true;
  if (!/^[a-z0-9.-]+$/u.test(value) || value.includes("..")) return false;
  return value.split(".").every((label) =>
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label));
}
