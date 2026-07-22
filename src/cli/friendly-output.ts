import { AgentError, errorMessage } from "../shared/errors.js";
import { bold, cyan, dim, green, red, symbols, yellow } from "./presentation.js";

export function renderHumanResult(value: Readonly<Record<string, unknown>>): string {
  if (value.initialized === true) return renderInitialization(value);

  const status = stringValue(value.status) ?? stringValue(recordValue(value.handoff)?.status);
  const sessionId = stringValue(value.sessionId) ?? stringValue(recordValue(value.handoff)?.sessionId);
  const modelSummary = stringValue(value.modelSummary) ??
    stringValue(recordValue(recordValue(value.completionReport)?.claim)?.summary) ??
    stringValue(recordValue(recordValue(recordValue(value.handoff)?.completionReport)?.claim)?.summary);
  const message = stringValue(value.message);
  const lines: string[] = [];

  if (status !== undefined) {
    const marker = status === "completed" ? green(symbols.ok) :
      status === "paused" ? yellow(symbols.warning) : red(symbols.error);
    lines.push(`\n${marker} ${bold(humanStatus(status))}`);
  }
  if (modelSummary !== undefined) lines.push(`\n${modelSummary}`);
  if (message !== undefined && message !== modelSummary) lines.push(`\n${message}`);
  if (sessionId !== undefined) lines.push(`\n${dim(`Session ${sessionId}`)}`);

  const handoff = recordValue(value.handoff);
  const repository = recordValue(handoff?.repository);
  const current = recordValue(repository?.current);
  const entries = Array.isArray(current?.entries) ? current.entries : undefined;
  if (entries !== undefined && entries.length > 0) {
    lines.push(`\n${bold("Changed files")}`);
    for (const entry of entries.slice(0, 20)) {
      const record = recordValue(entry);
      const file = stringValue(record?.path);
      const state = stringValue(record?.kind) ?? stringValue(record?.status);
      if (file !== undefined) lines.push(`  ${cyan(symbols.bullet)} ${file}${state === undefined ? "" : ` ${dim(`(${state})`)}`}`);
    }
    if (entries.length > 20) lines.push(`  ${dim(`…and ${entries.length - 20} more`)}`);
  }

  const validation = Array.isArray(handoff?.validation) ? handoff.validation : undefined;
  if (validation !== undefined && validation.length > 0) {
    lines.push(`\n${bold("Validation")}`);
    for (const item of validation.slice(-5)) {
      const record = recordValue(item);
      const command = stringValue(record?.commandId) ?? "command";
      const outcome = stringValue(record?.outcome) ?? "unknown";
      lines.push(`  ${outcome === "success" ? green(symbols.ok) : yellow(symbols.warning)} ${command}: ${outcome}`);
    }
  }

  if (lines.length === 0) return `${JSON.stringify(value, null, 2)}\n`;
  return `${lines.join("\n")}\n`;
}

export function renderHumanError(error: unknown): string {
  const message = errorMessage(error);
  const lines = [`\n${red(symbols.error)} ${bold(message)}`];
  if (error instanceof AgentError) {
    const summary = error.details.summary;
    if (typeof summary === "string" && summary.length > 0 && summary !== message) {
      lines.push(`\n${summary}`);
    }
    const diagnosticCode = error.details.diagnosticCode;
    const state = error.details.state;
    if (typeof diagnosticCode === "string" && diagnosticCode.length > 0) {
      const stateSuffix = typeof state === "string" && state.length > 0 ? ` (${state})` : "";
      lines.push(`\n${dim(`Diagnostic: ${diagnosticCode}${stateSuffix}`)}`);
    }
    const semanticGroup = error.details.semanticGroup;
    const semanticOperation = error.details.semanticOperation;
    if (
      typeof semanticGroup === "string" && semanticGroup.length > 0 &&
      typeof semanticOperation === "string" && semanticOperation.length > 0
    ) {
      const locatorKind = error.details.locatorKind;
      const locatorCandidateIndex = error.details.locatorCandidateIndex;
      const elementIndex = error.details.elementIndex;
      const candidate = typeof locatorKind === "string" &&
          typeof locatorCandidateIndex === "number"
        ? `; ${locatorKind} candidate ${locatorCandidateIndex}`
        : "";
      const element = typeof elementIndex === "number" ? `; element ${elementIndex}` : "";
      lines.push(`${dim(`Stalled browser probe: ${semanticGroup} / ${semanticOperation}${candidate}${element}`)}`);
    }
    const missingSignals = error.details.missingSignals;
    if (Array.isArray(missingSignals)) {
      const signals = missingSignals.filter((value): value is string => typeof value === "string" && value.length > 0);
      if (signals.length > 0) lines.push(`${dim(`Missing browser signals: ${signals.join(", ")}`)}`);
    }
    const next = error.details.next;
    if (typeof next === "string" && next.length > 0) lines.push(`\n${cyan("Next:")} ${next}`);
    const problems = error.details.problems;
    if (Array.isArray(problems)) {
      for (const problem of problems.slice(0, 6)) if (typeof problem === "string") lines.push(`  ${yellow(symbols.warning)} ${problem}`);
    }
  }
  lines.push(`\n${dim("Run cope doctor for environment checks, or cope help for the quick guide.")}\n`);
  return lines.join("\n");
}

function renderInitialization(value: Readonly<Record<string, unknown>>): string {
  const repository = stringValue(value.repository) ?? "project";
  const configuration = stringValue(value.configuration);
  const profile = stringValue(value.profile);
  const validations = numberValue(value.validationCommands);
  const lines = [
    `\n${green(symbols.ok)} ${bold("Project ready")}`,
    `  ${dim("Project:")} ${repository}`,
  ];
  if (profile !== undefined) lines.push(`  ${dim("Access:")} ${profile}`);
  if (validations !== undefined) lines.push(`  ${dim("Validation commands:")} ${validations}`);
  if (configuration !== undefined) lines.push(`  ${dim("Configuration:")} ${configuration}`);
  lines.push(`\n${dim("Run cope and describe the task in plain English.")}\n`);
  return lines.join("\n");
}

function humanStatus(status: string): string {
  if (status === "completed") return "Task completed";
  if (status === "paused") return "Task paused";
  if (status === "aborted") return "Task aborted";
  if (status === "blocked") return "Task blocked";
  if (status === "failed") return "Task failed";
  return `Session ${status.replaceAll("_", " ")}`;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" ? value : undefined; }
