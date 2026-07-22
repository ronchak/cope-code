import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import type { UserInteraction } from "../orchestrator/contracts.js";
import { bold, cyan, dim, keyValue, section, warning, type Writable } from "./presentation.js";

export interface TerminalUserInteractionOptions {
  readonly output?: Writable;
  readonly silentPreapprovedGrant?: boolean;
}

export class TerminalUserInteraction implements UserInteraction {
  private readonly output: Writable;
  private readonly silentPreapprovedGrant: boolean;

  public constructor(options: TerminalUserInteractionOptions = {}) {
    this.output = options.output ?? stdout;
    this.silentPreapprovedGrant = options.silentPreapprovedGrant ?? false;
  }

  public async approveInitialGrant(summary: string, preapproved: boolean): Promise<boolean> {
    if (!(preapproved && this.silentPreapprovedGrant)) {
      this.renderGrant(summary);
    }
    if (preapproved) {
      if (!this.silentPreapprovedGrant) {
        this.output.write(`${dim("Approved by --approve-grant.")}\n`);
      }
      return true;
    }
    return this.askYesNo(`${cyan("?")} Allow Cope to start this task? [y/N] `);
  }

  public async requestInput(request: {
    readonly question: string;
    readonly choices?: readonly string[];
  }): Promise<Readonly<Record<string, unknown>>> {
    section("Copilot has a question", this.output);
    this.output.write(`${request.question}\n`);
    if (request.choices && request.choices.length > 0) {
      request.choices.forEach((choice, index) => this.output.write(`  ${cyan(String(index + 1))}  ${choice}\n`));
    }
    const answer = await this.readLine(`${cyan(">")} `);
    return { answer };
  }

  public async requestPlanApproval(request: {
    readonly summary: string;
    readonly steps: readonly string[];
    readonly anticipatedMutations: readonly string[];
    readonly validation: readonly string[];
  }): Promise<boolean> {
    section("Implementation plan", this.output);
    this.output.write(`${request.summary}\n\n`);
    request.steps.forEach((step, index) => this.output.write(`  ${cyan(String(index + 1))}  ${step}\n`));
    if (request.anticipatedMutations.length > 0) {
      this.output.write(`\n${bold("Anticipated mutations")}\n`);
      request.anticipatedMutations.forEach((item) => this.output.write(`  - ${item}\n`));
    }
    if (request.validation.length > 0) {
      this.output.write(`\n${bold("Validation")}\n`);
      request.validation.forEach((item) => this.output.write(`  - ${item}\n`));
    }
    return this.askYesNo(`\n${cyan("?")} Approve this plan before mutation? [y/N] `);
  }

  public async requestCapability(request: {
    readonly capability: Readonly<Record<string, unknown>>;
    readonly reason: string;
    readonly risk?: string;
  }): Promise<{ readonly decision: "deny" | "allow_once" | "allow_session"; readonly note?: string }> {
    section("Permission needed", this.output);
    this.output.write(`${request.reason}\n`);
    this.renderCapability(request.capability);
    if (request.risk) warning(`Risk: ${request.risk}`, this.output);
    this.output.write(`\n  ${bold("1")}  Allow once\n`);
    this.output.write(`  ${bold("2")}  Allow for this session\n`);
    this.output.write(`  ${bold("3")}  Deny ${dim("(default)")}\n`);
    const answer = (await this.readLine(`${cyan("?")} Choose [1/2/3]: `)).trim().toLowerCase();
    if (answer === "1" || answer === "once" || answer === "y" || answer === "yes") {
      return { decision: "allow_once" };
    }
    if (answer === "2" || answer === "session" || answer === "always") {
      return { decision: "allow_session" };
    }
    return { decision: "deny" };
  }

  private renderGrant(summary: string): void {
    section("Task access", this.output);
    const parsed = parseRecord(summary);
    if (parsed === undefined) {
      this.output.write(`${summary}\n\n`);
      return;
    }

    const mode = stringValue(parsed.mode) ?? "unknown";
    keyValue("Project", stringValue(parsed.repository_root) ?? "unknown", this.output);
    keyValue("Mode", humanMode(mode), this.output);
    const branch = stringValue(parsed.branch);
    if (branch !== undefined) keyValue("Branch", branch, this.output);

    const readable = stringArray(parsed.readable_paths);
    const writable = stringArray(parsed.writable_paths);
    const creatable = stringArray(parsed.creatable_paths);
    const deletable = stringArray(parsed.deletable_paths);
    const commands = stringArray(parsed.command_ids);
    const disclosure = stringArray(parsed.disclosure_classifications);
    const network = recordValue(parsed.network);

    this.output.write("\n");
    keyValue("Read", compactList(readable, "none"), this.output);
    keyValue("Edit", mode === "inspect" ? "none, read-only session" : compactList(writable, "none"), this.output);
    if (creatable.length > 0) keyValue("Create", compactList(creatable, "none"), this.output);
    if (deletable.length > 0) keyValue("Delete", compactList(deletable, "none"), this.output);
    keyValue("Commands", compactList(commands, "none"), this.output);
    if (disclosure.length > 0) keyValue("Copilot data", compactList(disclosure, "none"), this.output);
    keyValue("Network", stringValue(network?.session_access) ?? "deny", this.output);

    if (mode !== "inspect" && writable.length > 0) {
      this.output.write(`\n${dim("Cope checkpoints file edits before applying them and asks again when policy requires more access.")}\n`);
    } else {
      this.output.write(`\n${dim("This session cannot modify project files.")}\n`);
    }
  }

  private renderCapability(capability: Readonly<Record<string, unknown>>): void {
    const expansion = recordValue(capability.expansion) ?? capability;
    const kind = stringValue(expansion.kind);
    this.output.write("\n");
    if (kind === "path") {
      keyValue("Action", `${stringValue(expansion.access) ?? "access"} file`, this.output);
      keyValue("Path", stringValue(expansion.path) ?? compactList(stringArray(expansion.paths), "unknown"), this.output);
      return;
    }
    if (kind === "command") {
      keyValue("Action", "run command", this.output);
      keyValue("Command", stringValue(expansion.command_id) ?? compactList(stringArray(expansion.command_ids), "unknown"), this.output);
      const risk = stringValue(expansion.risk);
      if (risk !== undefined) keyValue("Risk", risk, this.output);
      return;
    }
    if (kind === "network") {
      keyValue("Action", "use network", this.output);
      keyValue("Host", stringValue(expansion.host) ?? compactList(stringArray(expansion.hosts), "unspecified"), this.output);
      return;
    }
    if (kind === "tool") {
      keyValue("Action", "use tool", this.output);
      keyValue("Tool", stringValue(expansion.tool) ?? compactList(stringArray(expansion.tools), "unknown"), this.output);
      return;
    }
    if (kind === "change") {
      keyValue("Action", (stringValue(expansion.change) ?? "project change").replaceAll("_", " "), this.output);
      return;
    }
    if (kind === "disclosure") {
      keyValue("Action", "share project data with Copilot", this.output);
      keyValue("Classification", stringValue(expansion.classification) ?? compactList(stringArray(expansion.classifications), "unknown"), this.output);
      return;
    }
    if (kind === "budget") {
      keyValue("Action", "raise task limit", this.output);
      keyValue("Limit", stringValue(expansion.metric) ?? "unknown", this.output);
      const requested = expansion.requested_limit;
      if (typeof requested === "number") keyValue("Requested", requested, this.output);
      return;
    }
    const key = stringValue(capability.key);
    keyValue("Capability", key ?? compactObject(capability), this.output);
  }

  private async askYesNo(prompt: string): Promise<boolean> {
    const answer = (await this.readLine(prompt)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  }

  private async readLine(prompt: string): Promise<string> {
    if (!stdin.isTTY || !stdout.isTTY) {
      throw new Error("Interactive input is required but no terminal is attached");
    }
    const readline = createInterface({ input: stdin, output: stdout });
    try {
      return await readline.question(prompt);
    } finally {
      readline.close();
    }
  }
}

function parseRecord(value: string): Readonly<Record<string, unknown>> | undefined {
  try {
    return recordValue(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function compactList(values: readonly string[], fallback: string): string {
  if (values.length === 0) return fallback;
  const shown = values.slice(0, 4);
  return `${shown.join(", ")}${values.length > shown.length ? `, +${values.length - shown.length} more` : ""}`;
}

function compactObject(value: Readonly<Record<string, unknown>>): string {
  return Object.entries(value)
    .slice(0, 4)
    .map(([key, item]) => `${key}=${typeof item === "string" || typeof item === "number" ? String(item) : "…"}`)
    .join(", ") || "unknown";
}

function humanMode(mode: string): string {
  if (mode === "inspect") return "inspect, read-only";
  if (mode === "edit") return "edit, approvals as needed";
  if (mode === "auto") return "auto, within project policy";
  return mode;
}
