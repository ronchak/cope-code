import path from "node:path";

import type { AutonomyMode } from "../session/types.js";
import {
  displayWidth,
  isPlainTerminal,
  padDisplay,
  repeatToWidth,
  terminalColumns,
  truncateEnd,
  truncateMiddle,
  wrapText,
} from "./terminal-layout.js";

export interface Writable {
  write(value: string): unknown;
}

const colorEnabled = (): boolean => process.env.NO_COLOR === undefined && process.stdout.isTTY === true;
const paint = (code: number, value: string): string => colorEnabled() ? `[${code}m${value}[0m` : value;

export const bold = (value: string): string => paint(1, value);
export const dim = (value: string): string => paint(2, value);
export const red = (value: string): string => paint(31, value);
export const green = (value: string): string => paint(32, value);
export const yellow = (value: string): string => paint(33, value);
export const cyan = (value: string): string => paint(36, value);
export const magenta = (value: string): string => paint(35, value);

export const symbols = Object.freeze({
  ok: process.platform === "win32" ? "OK" : "✓",
  error: process.platform === "win32" ? "X" : "✕",
  warning: "!",
  info: "i",
  arrow: process.platform === "win32" ? ">" : "›",
  bullet: process.platform === "win32" ? "*" : "•",
});

export interface StartupPanelOptions {
  readonly version: string;
  readonly repositoryRoot: string;
  readonly mode: AutonomyMode;
  readonly transport: string;
  readonly demo?: boolean;
  readonly columns?: number;
}

export interface ChatContext {
  readonly repositoryRoot: string;
  readonly mode: AutonomyMode;
  readonly transport: string;
  readonly demo?: boolean;
}

export interface SetupHeroOptions {
  readonly columns?: number;
}

export function banner(version: string, output: Writable): void {
  output.write(`\n${bold(magenta("COPE"))} ${dim(`v${version}`)}\n`);
  output.write(`${dim("Copilot coding, without the copy and paste loop")}\n\n`);
}

export function setupHero(output: Writable, options: SetupHeroOptions = {}): void {
  const width = Math.max(24, Math.min(options.columns ?? terminalColumns(), 72));
  const characters = frameCharacters();
  const innerWidth = width - 4;
  const title = ` ${bold(magenta("COPE CODE"))} `;
  const topFill = Math.max(0, width - displayWidth(title) - 3);
  const line = (value = ""): void => framedLine(value, innerWidth, characters, output);
  const wrapped = (value: string, decorate: (line: string) => string = (line) => line): void => {
    for (const wrappedLine of wrapText(value, innerWidth)) line(decorate(wrappedLine));
  };

  output.write(`\n${characters.topLeft}${characters.horizontal}${title}${repeatToWidth(characters.horizontal, topFill)}${characters.topRight}\n`);
  line();
  line(bold("Welcome to Cope Code"));
  wrapped("A quick setup, then you're ready to build.", dim);
  line();

  if (width >= 48) {
    line(`${magenta("●")} ${bold("Browser")}  ${dim("──")}  ${dim("○ Account")}  ${dim("──")}  ${dim("○ Ready")}`);
  } else {
    line(`${magenta("●")} ${bold("Step 1 of 3 · Browser")}`);
    line(dim("Next: account, then ready"));
  }
  line();
  line(`${dim("Created by")} ${bold("Ronak Chakraborty")}`);
  wrapped("Your password stays in the browser.", dim);
  line();
  output.write(`${characters.bottomLeft}${repeatToWidth(characters.horizontal, width - 2)}${characters.bottomRight}\n\n`);
}

export function startupPanel(options: StartupPanelOptions, output: Writable): void {
  const width = Math.max(36, Math.min(options.columns ?? terminalColumns(), 140));
  const characters = frameCharacters();
  const innerWidth = width - 4;
  const title = startupTitle(options.version, width - 3);
  output.write(`\n${characters.topLeft}${characters.horizontal}${title}${repeatToWidth(characters.horizontal, Math.max(0, width - displayWidth(title) - 3))}${characters.topRight}\n`);

  if (width >= 70) renderWideStartup(options, innerWidth, characters, output);
  else renderCompactStartup(options, innerWidth, characters, output);

  output.write(`${characters.bottomLeft}${repeatToWidth(characters.horizontal, width - 2)}${characters.bottomRight}\n\n`);
}

export function readySummary(context: ChatContext, output: Writable): void {
  section("Workspace", output);
  keyValue("Project", context.repositoryRoot, output);
  keyValue("Mode", context.mode, output);
  keyValue("Transport", context.transport, output);
}

export function renderUserMessage(message: string, output: Writable): void {
  const characters = isPlainTerminal()
    ? { top: "+-", rail: "|", bottom: "+-" }
    : { top: "╭─", rail: "│", bottom: "╰─" };
  const lines = message.split(/\r?\n/u);
  output.write(`\n${cyan(characters.top)} ${bold(cyan("You"))} ${dim("· sent")}\n`);
  for (const line of lines) output.write(`${cyan(characters.rail)} ${bold(line)}\n`);
  output.write(`${cyan(characters.bottom)}\n\n`);
}

export function chatFooter(context: ChatContext, width = terminalColumns()): string {
  const project = path.basename(context.repositoryRoot) || context.repositoryRoot;
  const transport = context.demo ? "demo offline" : context.transport;
  const available = Math.max(1, width - 2);
  const full = `${context.mode} mode  ·  ${transport}  ·  ${project}  ·  Enter submit  ·  /help commands  ·  Ctrl+C cancel`;
  if (displayWidth(full) <= available) return full;
  return truncateEnd(
    `Enter submit  ·  Ctrl+C cancel  ·  ${context.mode} mode  ·  ${transport}  ·  ${project}`,
    available,
  );
}

export function section(title: string, output: Writable): void {
  output.write(`\n${bold(title)}\n`);
}

export function keyValue(key: string, value: string | number | boolean, output: Writable): void {
  output.write(`  ${dim(`${key}:`)} ${String(value)}\n`);
}

export function success(message: string, output: Writable): void {
  output.write(`${green(symbols.ok)} ${message}\n`);
}

export function warning(message: string, output: Writable): void {
  output.write(`${yellow(symbols.warning)} ${message}\n`);
}

export function info(message: string, output: Writable): void {
  output.write(`${cyan(symbols.info)} ${message}\n`);
}

export function hint(message: string, output: Writable): void {
  output.write(`  ${dim(message)}\n`);
}

export function commandHint(command: string, description: string, output: Writable): void {
  output.write(`  ${cyan(command.padEnd(22))} ${description}\n`);
}

function startupTitle(version: string, availableWidth: number): string {
  const brand = bold(magenta("COPE"));
  const attribution = `${dim("· by")} ${magenta("Ronak Chakraborty")}`;
  const full = ` ${brand} ${dim(`v${version}`)} ${attribution} `;
  if (displayWidth(full) <= availableWidth) return full;
  return ` ${brand} ${attribution} `;
}

function renderWideStartup(
  options: StartupPanelOptions,
  innerWidth: number,
  characters: ReturnType<typeof frameCharacters>,
  output: Writable,
): void {
  const dividerWidth = 3;
  const leftWidth = Math.min(42, Math.max(28, Math.floor(innerWidth * 0.36)));
  const rightWidth = innerWidth - leftWidth - dividerWidth;
  const left = [
    bold("Welcome to Cope"),
    dim("Copilot coding, without the copy and paste loop"),
    "",
    dim("Workspace"),
    truncateMiddle(options.repositoryRoot, leftWidth),
    dim(`${options.mode} mode  ·  ${options.transport}`),
  ];
  const right = options.demo
    ? [
        bold(cyan("Demo workspace")),
        "Explore the interface without starting a session.",
        dim("No browser, network request, or file operation will run."),
        repeatToWidth(characters.horizontal, rightWidth),
        bold(cyan("Try it")),
        "Describe a sample coding task in plain English.",
      ]
    : [
        bold(cyan("Ready to work")),
        "Describe a coding task in plain English.",
        dim("Policy and project checks run before Copilot receives context."),
        repeatToWidth(characters.horizontal, rightWidth),
        bold(cyan("Shortcuts")),
        "/mode changes access  ·  /resume continues recent work",
      ];
  const rows = Math.max(left.length, right.length);
  for (let index = 0; index < rows; index += 1) {
    const leftValue = left[index] ?? "";
    const rightValue = right[index] ?? "";
    framedLine(
      `${padDisplay(leftValue, leftWidth)} ${dim(characters.vertical)} ${padDisplay(rightValue, rightWidth)}`,
      innerWidth,
      characters,
      output,
    );
  }
}

function renderCompactStartup(
  options: StartupPanelOptions,
  innerWidth: number,
  characters: ReturnType<typeof frameCharacters>,
  output: Writable,
): void {
  const rows = [
    bold("Welcome to Cope"),
    dim("Copilot coding, without the copy and paste loop"),
    "",
    `${dim("Project:")} ${truncateMiddle(options.repositoryRoot, Math.max(8, innerWidth - 9))}`,
    `${dim("Mode:")} ${options.mode}`,
    `${dim("Transport:")} ${options.transport}`,
    repeatToWidth(characters.horizontal, innerWidth),
    bold(cyan(options.demo ? "Demo workspace" : "Ready to work")),
    options.demo ? "Type a sample task; nothing will run." : "Describe a coding task in plain English.",
    dim(options.demo ? "No browser, network, or file changes." : "/help commands  ·  /mode access  ·  /resume recent work"),
  ];
  for (const row of rows) framedLine(row, innerWidth, characters, output);
}

function framedLine(
  value: string,
  width: number,
  characters: ReturnType<typeof frameCharacters>,
  output: Writable,
): void {
  output.write(`${characters.vertical} ${padDisplay(value, width)} ${characters.vertical}\n`);
}

function frameCharacters(): {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly vertical: string;
  readonly horizontal: string;
} {
  if (isPlainTerminal()) {
    return { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", vertical: "|", horizontal: "-" };
  }
  return { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", vertical: "│", horizontal: "─" };
}
