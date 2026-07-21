import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { AutonomyMode } from "../session/types.js";
import { AgentError } from "../shared/errors.js";
import type { CliCommand } from "./arguments.js";
import { executeDoctorCommand } from "./doctor.js";
import {
  configurationPaths,
  ensureMachineConfiguration,
  ensureRepositoryConfiguration,
  executeSetupCommand,
} from "./onboarding.js";
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
import { loadPreferences, updatePreferences } from "./preferences.js";
import { chatPrompt, selectPrompt, textPrompt } from "./prompts.js";
import { executeSessionsCommand, listSessions, mostRecentResumableSession } from "./sessions.js";
import { resolveWorkspace, syncWorkspaceCopy } from "./workspace.js";
import type { HostPlatform } from "../platform/index.js";
import { preparePrivateStateHome } from "../platform/private-storage.js";
import { browserProductPresentation } from "../browser/index.js";
import { parseBrowserConfig } from "../config/loader.js";

export interface CliIo {
  readonly stdout: Writable;
  readonly stderr: Writable;
}

export type CommandExecutor = (command: CliCommand, io: CliIo) => Promise<number>;

export async function executeInteractiveCommand(
  command: Extract<CliCommand, { readonly command: "interactive" }>,
  io: CliIo,
  execute: CommandExecutor,
  version: string,
  host: HostPlatform,
): Promise<number> {
  const interactive = !command.json && process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (command.transport !== "edge") {
    throw new AgentError(
      "CONFIG_INVALID",
      "The guided interface currently uses the live browser transport",
      { next: "Use cope run with --transport fixture or --transport replay for offline automation." },
    );
  }
  const launch = await resolveLaunchInput(command.repository, command.repositoryExplicit, command.initialObjective);
  if (!interactive && launch.objective === undefined && !command.continueRecent) {
    throw new AgentError(
      "CONFIG_INVALID",
      "Interactive mode needs a terminal or an objective",
      { next: "Run cope \"your task\" for one-shot use, or open a terminal and run cope." },
    );
  }

  const paths = configurationPaths(command.stateHome, host);
  await preparePrivateStateHome(paths.stateHome, host);
  const preferences = await loadPreferences(paths.stateHome);
  let mode = interactive && !command.modeExplicit ? preferences.mode : command.mode;
  let workspace = await resolveWorkspace(launch.repository, {
    interactive,
    output: io.stdout,
    implicitSelection: !launch.repositoryExplicit,
    ...(preferences.last_repository === undefined ? {} : { preferredRepository: preferences.last_repository }),
  });
  let repositoryRoot = workspace.repositoryRoot;
  await updatePreferences(paths.stateHome, { lastRepository: repositoryRoot, mode });

  await ensureMachineConfiguration({
    interactive,
    output: io.stdout,
    host,
    ...(command.stateHome === undefined ? {} : { stateHome: command.stateHome }),
  });
  await ensureRepositoryConfiguration({
    repositoryRoot,
    interactive,
    output: io.stdout,
    ...(!interactive
      ? { preferredProfile: mode === "inspect" ? "inspect" as const : "standard" as const }
      : mode === "inspect"
        ? { preferredProfile: "inspect" as const }
        : {}),
  });
  let transportLabel = await configuredBrowserLabel(paths.browser);

  if (interactive) {
    startupPanel({ version, repositoryRoot, mode, transport: transportLabel }, io.stdout);
  } else {
    showReady(repositoryRoot, mode, transportLabel, io.stdout);
  }
  if (interactive && workspace.copiedFromFile !== undefined) {
    info("This standalone file is running in a safe Git workspace.", io.stdout);
    keyValue("Original", workspace.copiedFromFile, io.stdout);
    keyValue("Workspace", repositoryRoot, io.stdout);
    hint("After a verified task, Cope will ask before copying changes back to the original.", io.stdout);
  }

  if (command.continueRecent) {
    const code = await continueRecentSession(repositoryRoot, command, io, execute, host);
    if (code === 0) workspace = await syncWorkspaceCopy(workspace, { interactive, output: io.stdout });
    return code;
  }
  if (launch.objective !== undefined) {
    const code = await runObjective(launch.objective, repositoryRoot, mode, command, io, execute);
    if (code === 0) workspace = await syncWorkspaceCopy(workspace, { interactive, output: io.stdout });
    return code;
  }

  while (true) {
    const input = await chatPrompt({ repositoryRoot, mode, transport: transportLabel });
    if (!input.startsWith("/")) {
      const code = await runObjective(input, repositoryRoot, mode, command, io, execute);
      if (code === 0) workspace = await syncWorkspaceCopy(workspace, { interactive: true, output: io.stdout });
      continue;
    }

    const [slashCommand = "", ...rest] = input.trim().split(/\s+/u);
    switch (slashCommand.toLowerCase()) {
      case "/exit":
      case "/quit":
        success("Session closed.", io.stdout);
        return 0;
      case "/help":
        showSlashHelp(io.stdout);
        break;
      case "/mode":
        mode = await selectMode(mode);
        await updatePreferences(paths.stateHome, { lastRepository: repositoryRoot, mode });
        info(`Mode set to ${mode}.`, io.stdout);
        break;
      case "/doctor":
        await executeDoctorCommand({
          command: "doctor",
          repository: repositoryRoot,
          json: false,
          ...(command.stateHome === undefined ? {} : { stateHome: command.stateHome }),
        }, io, host);
        break;
      case "/sessions":
        await executeSessionsCommand({
          command: "sessions",
          repository: repositoryRoot,
          all: rest.includes("all"),
          json: false,
          ...(command.stateHome === undefined ? {} : { stateHome: command.stateHome }),
        }, io, host);
        break;
      case "/resume": {
        const code = await resumeSession(repositoryRoot, command, io, execute, host);
        if (code === 0) workspace = await syncWorkspaceCopy(workspace, { interactive: true, output: io.stdout });
        break;
      }
      case "/repo": {
        const selection = rest.length > 0 ? rest.join(" ") : await textPrompt("Project folder or file");
        workspace = await resolveWorkspace(selection, { interactive: true, output: io.stdout, implicitSelection: false });
        repositoryRoot = workspace.repositoryRoot;
        await updatePreferences(paths.stateHome, { lastRepository: repositoryRoot, mode });
        await ensureRepositoryConfiguration({
          repositoryRoot,
          interactive: true,
          output: io.stdout,
          ...(mode === "inspect" ? { preferredProfile: "inspect" as const } : {}),
        });
        showReady(repositoryRoot, mode, transportLabel, io.stdout);
        break;
      }
      case "/sync":
        workspace = await syncWorkspaceCopy(workspace, { interactive: true, output: io.stdout });
        break;
      case "/setup":
        await executeSetupCommand({
          command: "setup",
          force: true,
          json: false,
          ...(command.stateHome === undefined ? {} : { stateHome: command.stateHome }),
        }, io, host);
        transportLabel = await configuredBrowserLabel(paths.browser);
        break;
      case "/config":
        section("Configuration", io.stdout);
        keyValue("Project", path.join(repositoryRoot, ".cba", "repository.json"), io.stdout);
        keyValue("Browser", paths.browser, io.stdout);
        keyValue("Policy", paths.organizationPolicy, io.stdout);
        keyValue("State", paths.stateHome, io.stdout);
        break;
      default:
        warning(`Unknown command: ${slashCommand}`, io.stdout);
        hint("Type /help for the small command list.", io.stdout);
        break;
    }
  }
}

async function runObjective(
  objective: string,
  repositoryRoot: string,
  mode: AutonomyMode,
  parent: Extract<CliCommand, { readonly command: "interactive" }>,
  io: CliIo,
  execute: CommandExecutor,
): Promise<number> {
  if (!parent.json) renderUserMessage(objective, io.stdout);
  return execute({
    command: "run",
    objective,
    repository: repositoryRoot,
    mode,
    transport: "edge",
    acceptanceCriteria: parent.acceptanceCriteria,
    approveGrant: parent.approveGrant,
    json: parent.json,
    ...(parent.stateHome === undefined ? {} : { stateHome: parent.stateHome }),
  }, io);
}

async function continueRecentSession(
  repositoryRoot: string,
  parent: Extract<CliCommand, { readonly command: "interactive" }>,
  io: CliIo,
  execute: CommandExecutor,
  host: HostPlatform,
): Promise<number> {
  const session = await mostRecentResumableSession({
    repositoryRoot,
    ...(parent.stateHome === undefined ? {} : { stateHome: parent.stateHome }),
    host,
  });
  if (session === undefined) {
    warning("There is no resumable session for this project.", io.stdout);
    hint("Run cope to start a new task.", io.stdout);
    return 1;
  }
  info(`Resuming: ${session.objective}`, io.stdout);
  return execute({
    command: "resume",
    sessionId: session.sessionId,
    approveGrant: parent.approveGrant,
    json: parent.json,
    ...(parent.stateHome === undefined ? {} : { stateHome: parent.stateHome }),
  }, io);
}

async function resumeSession(
  repositoryRoot: string,
  parent: Extract<CliCommand, { readonly command: "interactive" }>,
  io: CliIo,
  execute: CommandExecutor,
  host: HostPlatform,
): Promise<number> {
  const sessions = (await listSessions({
    repositoryRoot,
    limit: 20,
    ...(parent.stateHome === undefined ? {} : { stateHome: parent.stateHome }),
    host,
  })).filter((session) => session.resumable);
  if (sessions.length === 0) {
    warning("There are no resumable sessions for this project.", io.stdout);
    return 1;
  }
  const selected = await selectPrompt("Choose a session", sessions.map((session) => ({
    value: session.sessionId,
    label: session.objective,
    description: `${session.status} · ${session.updatedAt.slice(0, 16).replace("T", " ")}`,
  })));
  return execute({
    command: "resume",
    sessionId: selected,
    approveGrant: parent.approveGrant,
    json: false,
    ...(parent.stateHome === undefined ? {} : { stateHome: parent.stateHome }),
  }, io);
}

async function resolveLaunchInput(
  repository: string,
  repositoryExplicit: boolean,
  objective: string | undefined,
): Promise<{ readonly repository: string; readonly repositoryExplicit: boolean; readonly objective?: string }> {
  if (objective === undefined) return { repository, repositoryExplicit };
  const possiblePath = path.resolve(objective);
  try {
    const entry = await stat(possiblePath);
    if (entry.isFile() || entry.isDirectory()) return { repository: possiblePath, repositoryExplicit: true };
  } catch {
    // Normal task text is not expected to resolve to a local path.
  }
  return { repository, repositoryExplicit, objective };
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

function showReady(repositoryRoot: string, mode: AutonomyMode, transport: string, output: Writable): void {
  readySummary({ repositoryRoot, mode, transport }, output);
}

export async function configuredBrowserLabel(filename: string): Promise<string> {
  try {
    const parsed = parseBrowserConfig(JSON.parse(await readFile(filename, "utf8")) as unknown);
    return `visible ${browserProductPresentation(parsed.config.product).shortName}`;
  } catch {
    return "visible browser";
  }
}

function showSlashHelp(output: Writable): void {
  section("Interactive commands", output);
  commandHint("/mode", "Switch between inspect, edit, and auto", output);
  commandHint("/resume", "Resume a paused or interrupted session", output);
  commandHint("/sessions", "Show recent work for this project", output);
  commandHint("/repo PATH", "Open another project or standalone file", output);
  commandHint("/sync", "Copy verified standalone-file changes back to the original", output);
  commandHint("/doctor", "Check Node, Git, browser, and configuration", output);
  commandHint("/config", "Show configuration locations", output);
  commandHint("/setup", "Redo machine onboarding", output);
  commandHint("/exit", "Close Cope", output);
}
