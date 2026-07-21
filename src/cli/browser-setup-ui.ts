import { emitKeypressEvents, type Key } from "node:readline";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import type { DiscoveredBrowser } from "../browser/discovery.js";
import { browserProductPresentation, type BrowserProduct } from "../browser/product.js";
import { PromptCancelledError } from "./prompts.js";
import { bold, dim, magenta, success, type Writable } from "./presentation.js";
import { displayWidth, isPlainTerminal, terminalColumns, wrapText } from "./terminal-layout.js";

export class PromptBackError extends Error {
  public constructor() {
    super("Prompt returned to the previous screen");
    this.name = "PromptBackError";
  }
}

export type BrowserSetupScreen =
  | { readonly kind: "current"; readonly browser: DiscoveredBrowser }
  | { readonly kind: "single"; readonly browser: DiscoveredBrowser }
  | { readonly kind: "choose"; readonly browsers: readonly [DiscoveredBrowser, ...DiscoveredBrowser[]]; readonly selectedIndex: number }
  | { readonly kind: "none"; readonly searched: readonly string[]; readonly guidance?: string }
  | { readonly kind: "manual-product"; readonly selectedIndex: number }
  | { readonly kind: "confirm-change"; readonly from: DiscoveredBrowser; readonly to: DiscoveredBrowser };

export type BrowserSetupAction =
  | { readonly action: "continue"; readonly browser: DiscoveredBrowser }
  | { readonly action: "change" }
  | { readonly action: "retry" }
  | { readonly action: "advanced" }
  | { readonly action: "manual-product"; readonly product: BrowserProduct }
  | { readonly action: "confirm-change"; readonly browser: DiscoveredBrowser };

export type BrowserSetupKey =
  | "up"
  | "down"
  | "enter"
  | "change"
  | "retry"
  | "advanced"
  | "back"
  | "interrupt";

export interface BrowserSetupTransition {
  readonly screen: BrowserSetupScreen;
  readonly action?: BrowserSetupAction;
  readonly back?: boolean;
  readonly interrupt?: boolean;
}

export interface BrowserSetupPromptEnvironment {
  readonly input?: typeof stdin;
  readonly terminalOutput?: typeof stdout;
  readonly emitKeypress?: (stream: typeof stdin) => void;
  readonly createReadline?: typeof createInterface;
}

export function reduceBrowserSetupKey(
  screen: BrowserSetupScreen,
  key: BrowserSetupKey,
): BrowserSetupTransition {
  if (key === "interrupt") return { screen, interrupt: true };
  if (key === "back") return { screen, back: true };
  switch (screen.kind) {
    case "current":
      if (key === "enter") return { screen, action: { action: "continue", browser: screen.browser } };
      if (key === "change") return { screen, action: { action: "change" } };
      return { screen };
    case "single":
      if (key === "enter") return { screen, action: { action: "continue", browser: screen.browser } };
      if (key === "change" || key === "advanced") return { screen, action: { action: "advanced" } };
      return { screen };
    case "choose": {
      if (key === "enter") {
        return { screen, action: { action: "continue", browser: screen.browsers[screen.selectedIndex]! } };
      }
      if (key !== "up" && key !== "down") return { screen };
      const offset = key === "up" ? -1 : 1;
      const selectedIndex = (screen.selectedIndex + offset + screen.browsers.length) % screen.browsers.length;
      return { screen: { ...screen, selectedIndex } };
    }
    case "none":
      if (key === "retry") return { screen, action: { action: "retry" } };
      if (key === "advanced") return { screen, action: { action: "advanced" } };
      return { screen };
    case "manual-product": {
      if (key === "enter") {
        return {
          screen,
          action: { action: "manual-product", product: screen.selectedIndex === 0 ? "edge" : "chrome" },
        };
      }
      if (key !== "up" && key !== "down") return { screen };
      return { screen: { ...screen, selectedIndex: screen.selectedIndex === 0 ? 1 : 0 } };
    }
    case "confirm-change":
      if (key === "enter") return { screen, action: { action: "confirm-change", browser: screen.to } };
      return { screen };
  }
}

export function renderBrowserSetupScreen(
  screen: BrowserSetupScreen,
  options: { readonly columns?: number; readonly plain?: boolean } = {},
): string {
  const width = Math.max(24, options.columns ?? terminalColumns());
  const contentWidth = Math.max(20, width - 4);
  const lines: string[] = [];
  const addWrapped = (value: string, indent = "  "): void => {
    const available = Math.max(8, contentWidth - displayWidth(indent));
    for (const line of wrapText(value, available)) lines.push(`${indent}${line}`);
  };
  const addBrowser = (browser: DiscoveredBrowser, selected: boolean, index?: number): void => {
    const presentation = browserProductPresentation(browser.product);
    const marker = options.plain === true
      ? `${index === undefined ? "" : `${String(index + 1)}. `}${selected ? "[x]" : "[ ]"}`
      : selected ? magenta("●") : dim("○");
    const version = browser.version.split(".")[0] ?? browser.version;
    addWrapped(`${marker} ${presentation.productName} ${version}`.trim());
    if (browser.product === "chrome") addWrapped(dim("Cope support for Chrome is in preview."), "    ");
  };
  const addControls = (items: readonly string[]): void => {
    const available = Math.max(8, contentWidth - 2);
    const separator = "  ·  ";
    let current = "";
    for (const item of items) {
      const candidate = current.length === 0 ? item : `${current}${separator}${item}`;
      if (current.length > 0 && displayWidth(candidate) > available) {
        lines.push(`  ${dim(current)}`);
        current = item;
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) lines.push(`  ${dim(current)}`);
  };

  switch (screen.kind) {
    case "current":
      lines.push(bold("Your browser"), "");
      addBrowser(screen.browser, true);
      addWrapped(dim(screen.browser.locationLabel), "    ");
      lines.push("");
      addWrapped("Cope uses a separate profile, keeping your everyday browsing data untouched.");
      lines.push("");
      addControls(["[Enter] Continue", "[C] Change browser", "[Esc] Back"]);
      break;
    case "single":
      lines.push(bold("Browser found"), "");
      addBrowser(screen.browser, true);
      addWrapped(dim(screen.browser.locationLabel), "    ");
      lines.push("");
      addWrapped("Cope uses a separate profile, keeping your everyday browsing data untouched.");
      lines.push("");
      addControls(["[Enter] Continue", "[C] Other installation", "[Esc] Back"]);
      break;
    case "choose":
      lines.push(bold("Choose a browser"), "");
      screen.browsers.forEach((browser, index) => addBrowser(browser, index === screen.selectedIndex, index));
      lines.push("");
      addWrapped("Your selection opens in a separate profile, away from your everyday browsing data.");
      lines.push("");
      addControls(options.plain === true
        ? ["[Number] Select", "[Enter] Continue", "[Esc] Back"]
        : ["[↑/↓] Select", "[Enter] Continue", "[Esc] Back"]);
      break;
    case "none":
      lines.push(bold("No supported browser found"), "");
      addWrapped("Cope looked for:");
      screen.searched.forEach((product) => addWrapped(`${options.plain === true ? "*" : "•"} ${product}`, "  "));
      lines.push("");
      addWrapped("Install Microsoft Edge Stable or Google Chrome Stable, then choose Retry.");
      if (screen.guidance !== undefined) addWrapped(screen.guidance);
      lines.push("");
      addControls(["[R] Retry", "[A] Other installation", "[Esc] Exit setup"]);
      break;
    case "manual-product":
      lines.push(bold("Choose the installation type"), "");
      (["edge", "chrome"] as const).forEach((product, index) => {
        const selected = screen.selectedIndex === index;
        const marker = options.plain === true
          ? `${String(index + 1)}. ${selected ? "[x]" : "[ ]"}`
          : selected ? "●" : "○";
        addWrapped(`${marker} ${browserProductPresentation(product).productName}`);
      });
      lines.push("");
      addControls(options.plain === true
        ? ["[Number] Select", "[Enter] Continue", "[Esc] Back"]
        : ["[↑/↓] Select", "[Enter] Continue", "[Esc] Back"]);
      break;
    case "confirm-change":
      lines.push(bold("Change browser?"), "");
      addWrapped(`From: ${browserProductPresentation(screen.from.product).productName} ${screen.from.version}`);
      addWrapped(`To:   ${browserProductPresentation(screen.to.product).productName} ${screen.to.version}`);
      lines.push("");
      addWrapped(screen.from.product === screen.to.product
        ? "Cope will keep this browser product's dedicated profile and reverify the selected installation."
        : "The new browser uses a different dedicated profile. Existing browser authentication is not copied.");
      lines.push("");
      addControls(["[Enter] Confirm change", "[Esc] Back"]);
      break;
  }
  return `${lines.join("\n")}\n`;
}

export async function browserSetupPrompt(
  initialScreen: BrowserSetupScreen,
  output: Writable = stdout,
  environment: BrowserSetupPromptEnvironment = {},
): Promise<BrowserSetupAction> {
  const input = environment.input ?? stdin;
  const terminalOutput = environment.terminalOutput ?? stdout;
  if (
    input.isTTY !== true || terminalOutput.isTTY !== true || typeof input.setRawMode !== "function" ||
    isPlainTerminal()
  ) {
    return plainBrowserSetupPrompt(initialScreen, output, input, terminalOutput, environment.createReadline);
  }
  let screen = initialScreen;
  let renderedLines = 0;
  const wasRaw = input.isRaw === true;
  (environment.emitKeypress ?? emitKeypressEvents)(input);
  input.setRawMode(true);
  input.resume();
  const render = (afterResize = false): void => {
    if (afterResize) {
      // Narrowing a terminal can reflow already printed logical lines into
      // additional physical rows. Clear the viewport from a known origin so
      // redraw never relies on the old row count after reflow.
      output.write("\x1b[2J\x1b[H");
      renderedLines = 0;
    }
    if (renderedLines > 0) output.write(`\x1b[${String(renderedLines)}A\r\x1b[J`);
    const rendered = renderBrowserSetupScreen(screen);
    output.write(rendered);
    renderedLines = rendered.split("\n").length - 1;
  };
  render();
  try {
    return await new Promise<BrowserSetupAction>((resolve, reject) => {
      const cleanup = (): void => {
        input.off("keypress", onKeypress);
        terminalOutput.off("resize", onResize);
        if (!wasRaw) input.setRawMode(false);
        input.pause();
      };
      const onResize = (): void => render(true);
      const onKeypress = (input: string | undefined, key: Key): void => {
        const setupKey = normalizeKey(input, key);
        if (setupKey === undefined) return;
        const transition = reduceBrowserSetupKey(screen, setupKey);
        screen = transition.screen;
        if (transition.interrupt === true) {
          cleanup();
          reject(new PromptCancelledError());
          return;
        }
        if (transition.back === true) {
          cleanup();
          reject(new PromptBackError());
          return;
        }
        if (transition.action !== undefined) {
          cleanup();
          if (renderedLines > 0) output.write(`\x1b[${String(renderedLines)}A\r\x1b[J`);
          const selectedBrowser = transition.action.action === "continue" || transition.action.action === "confirm-change"
            ? transition.action.browser
            : undefined;
          if (selectedBrowser !== undefined) {
            const presentation = browserProductPresentation(selectedBrowser.product);
            const version = selectedBrowser.version.split(".")[0] ?? selectedBrowser.version;
            success(`${presentation.productName} ${version} selected.`, output);
            output.write("\n");
          }
          resolve(transition.action);
          return;
        }
        render();
      };
      input.on("keypress", onKeypress);
      terminalOutput.on("resize", onResize);
    });
  } finally {
    if (!wasRaw && input.isRaw === true) input.setRawMode(false);
  }
}

async function plainBrowserSetupPrompt(
  initialScreen: BrowserSetupScreen,
  output: Writable,
  input: typeof stdin,
  terminalOutput: typeof stdout,
  createReadline: typeof createInterface = createInterface,
): Promise<BrowserSetupAction> {
  let screen = initialScreen;
  const rl = createReadline({
    input,
    output: terminalOutput,
    terminal: input.isTTY === true && terminalOutput.isTTY === true && !isPlainTerminal(),
  });
  let interrupted = false;
  rl.on("SIGINT", () => {
    interrupted = true;
    rl.close();
  });
  try {
    for (;;) {
      output.write(renderBrowserSetupScreen(screen, { plain: true }));
      let answer: string;
      try {
        answer = (await rl.question("> ")).trim().toLowerCase();
      } catch (error) {
        if (interrupted) throw new PromptCancelledError();
        throw error;
      }
      if (screen.kind === "choose" || screen.kind === "manual-product") {
        const index = Number.parseInt(answer || String(screen.selectedIndex + 1), 10) - 1;
        const count = screen.kind === "choose" ? screen.browsers.length : 2;
        if (Number.isSafeInteger(index) && index >= 0 && index < count) {
          screen = { ...screen, selectedIndex: index };
          if (screen.kind === "choose") return { action: "continue", browser: screen.browsers[index]! };
          return { action: "manual-product", product: index === 0 ? "edge" : "chrome" };
        }
      }
      const key = plainAnswerKey(answer);
      if (key === undefined) continue;
      const transition = reduceBrowserSetupKey(screen, key);
      screen = transition.screen;
      if (transition.back === true) throw new PromptBackError();
      if (transition.interrupt === true) throw new PromptCancelledError();
      if (transition.action !== undefined) return transition.action;
    }
  } finally {
    rl.close();
  }
}

function normalizeKey(input: string | undefined, key: Key): BrowserSetupKey | undefined {
  if (key.ctrl && key.name === "c") return "interrupt";
  if (key.name === "escape") return "back";
  if (key.name === "return" || key.name === "enter") return "enter";
  if (key.name === "up") return "up";
  if (key.name === "down") return "down";
  if (input?.toLowerCase() === "c") return "change";
  if (input?.toLowerCase() === "r") return "retry";
  if (input?.toLowerCase() === "a") return "advanced";
  return undefined;
}

function plainAnswerKey(answer: string): BrowserSetupKey | undefined {
  if (answer === "q" || answer === "back" || answer === "escape") return "back";
  if (answer === "" || answer === "enter" || answer === "y" || answer === "yes") return "enter";
  if (answer === "c") return "change";
  if (answer === "r") return "retry";
  if (answer === "a") return "advanced";
  return undefined;
}
