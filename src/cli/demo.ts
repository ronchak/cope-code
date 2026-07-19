import path from "node:path";

import type { AutonomyMode } from "../session/types.js";
import type { CliCommand } from "./arguments.js";
import {
  commandHint,
  hint,
  info,
  keyValue,
  readySummary,
  renderUserMessage,
  section,
  startupPanel,
  success,
  warning,
  type Writable,
} from "./presentation.js";
import { chatPrompt, selectPrompt, textPrompt } from "./prompts.js";

export interface DemoCliIo {
  readonly stdout: Writable;
  readonly stderr: Writable;
}

/** Runs a side-effect-free preview of the guided terminal interface. */
export async function executeDemoCommand(
  command: Extract<CliCommand, { readonly command: "demo" }>,
  io: DemoCliIo,
  version: string,
): Promise<number> {
  let repositoryRoot = path.resolve(command.repository);
  let mode = command.mode;

  if (command.json) {
    io.stdout.write(`${JSON.stringify({
      ok: true,
      demo: true,
      version,
      repository: repositoryRoot,
      mode,
      transport: "disabled",
      sideEffects: false,
    })}\n`);
    return 0;
  }

  startupPanel({
    version,
    repositoryRoot,
    mode,
    transport: "demo (offline)",
    demo: true,
  }, io.stdout);
  warning("Demo mode — no browser will open and no task will run.", io.stdout);

  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!interactive) {
    hint("Run cope demo in an interactive terminal to explore the command loop.", io.stdout);
    return 0;
  }

  while (true) {
    const input = await chatPrompt({ repositoryRoot, mode, transport: "demo (offline)", demo: true });
    if (!input.startsWith("/")) {
      showSimulatedTask(input, io.stdout);
      continue;
    }

    const [slashCommand = "", ...rest] = input.trim().split(/\s+/u);
    switch (slashCommand.toLowerCase()) {
      case "/exit":
      case "/quit":
        success("Demo closed.", io.stdout);
        return 0;
      case "/help":
        showSlashHelp(io.stdout);
        break;
      case "/mode":
        mode = await selectMode(mode);
        info(`Mode set to ${mode}.`, io.stdout);
        showReady(repositoryRoot, mode, io.stdout);
        break;
      case "/repo":
        repositoryRoot = path.resolve(rest.length > 0 ? rest.join(" ") : await textPrompt("Project folder or file"));
        info("Demo project changed. The path was not opened or modified.", io.stdout);
        showReady(repositoryRoot, mode, io.stdout);
        break;
      case "/doctor":
        showDemoDoctor(io.stdout);
        break;
      case "/config":
        section("Configuration", io.stdout);
        keyValue("Status", "not loaded in demo mode", io.stdout);
        hint("Run cope setup on Windows to configure a live Edge session.", io.stdout);
        break;
      case "/sessions":
      case "/resume":
      case "/sync":
      case "/setup":
        warning(`${slashCommand} is disabled in demo mode.`, io.stdout);
        hint("Demo mode never reads or changes sessions, configuration, or project files.", io.stdout);
        break;
      default:
        warning(`Unknown command: ${slashCommand}`, io.stdout);
        hint("Type /help for the command list.", io.stdout);
        break;
    }
  }
}

function showReady(repositoryRoot: string, mode: AutonomyMode, output: Writable): void {
  readySummary({ repositoryRoot, mode, transport: "demo (offline)", demo: true }, output);
}

function showSimulatedTask(objective: string, output: Writable): void {
  renderUserMessage(objective, output);
  info("Task captured for demonstration only.", output);
  hint("A live session would now verify policy, open Edge, and ask Copilot to work on the project.", output);
  hint("No browser, network request, session, configuration, or file operation occurred.", output);
  output.write("\n");
}

function showDemoDoctor(output: Writable): void {
  section("Environment check", output);
  keyValue("Platform", process.platform, output);
  keyValue("Node", process.versions.node, output);
  keyValue("Live Edge", "skipped in demo mode", output);
  success("Terminal demo is available.", output);
}

async function selectMode(current: AutonomyMode): Promise<AutonomyMode> {
  const choices = [
    { value: "inspect", label: "Inspect", description: "Read only" },
    { value: "edit", label: "Edit", description: "Change files and ask for consequential permissions" },
    { value: "auto", label: "Auto", description: "Fewer prompts inside the configured project policy" },
  ] as const;
  return selectPrompt("Choose session mode", choices, {
    defaultIndex: Math.max(0, choices.findIndex((choice) => choice.value === current)),
  });
}

function showSlashHelp(output: Writable): void {
  section("Interactive commands", output);
  commandHint("/mode", "Preview inspect, edit, and auto modes", output);
  commandHint("/repo PATH", "Display another project path without opening it", output);
  commandHint("/doctor", "Show the demo environment check", output);
  commandHint("/config", "Explain live configuration status", output);
  commandHint("/sessions", "Disabled: demo mode does not read sessions", output);
  commandHint("/resume", "Disabled: demo mode does not resume work", output);
  commandHint("/setup", "Disabled: demo mode does not create configuration", output);
  commandHint("/exit", "Close the demo", output);
}
