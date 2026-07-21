import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { DiscoveredBrowser } from "../../src/browser/index.js";
import {
  browserSetupPrompt,
  reduceBrowserSetupKey,
  renderBrowserSetupScreen,
  type BrowserSetupScreen,
} from "../../src/cli/browser-setup-ui.js";
import { PromptCancelledError } from "../../src/cli/prompts.js";
import { displayWidth, stripAnsi } from "../../src/cli/terminal-layout.js";

function browser(product: "edge" | "chrome", overrides: Partial<DiscoveredBrowser> = {}): DiscoveredBrowser {
  return {
    product,
    executablePath: product === "edge"
      ? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
      : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    version: "149.0.4022.98",
    executableSha256: "a".repeat(64),
    size: 42,
    modifiedMs: 1,
    evidence: {
      platform: "darwin",
      productName: product === "edge" ? "Microsoft Edge Stable" : "Google Chrome Stable",
      publisher: product === "edge" ? "UBF8T346G9" : "EQHXZ8M8AV",
      identifier: product === "edge" ? "com.microsoft.edgemac" : "com.google.Chrome",
      signatureStatus: "valid",
    },
    source: "automatic",
    locationLabel: "Found in Applications",
    ...overrides,
  };
}

test("two-browser setup uses arrows, Enter, Escape, and Ctrl+C as distinct events", () => {
  let screen: BrowserSetupScreen = {
    kind: "choose",
    browsers: [browser("edge"), browser("chrome")],
    selectedIndex: 0,
  };
  const down = reduceBrowserSetupKey(screen, "down");
  screen = down.screen;
  assert.equal(screen.kind, "choose");
  if (screen.kind !== "choose") return;
  assert.equal(screen.selectedIndex, 1);
  const selected = reduceBrowserSetupKey(screen, "enter");
  assert.equal(selected.action?.action, "continue");
  if (selected.action?.action === "continue") assert.equal(selected.action.browser.product, "chrome");
  assert.equal(reduceBrowserSetupKey(screen, "back").back, true);
  assert.equal(reduceBrowserSetupKey(screen, "interrupt").interrupt, true);
});

test("current, single, and missing-browser screens expose meaningful actions without redundant questions", () => {
  const current: BrowserSetupScreen = { kind: "current", browser: browser("edge") };
  assert.equal(reduceBrowserSetupKey(current, "enter").action?.action, "continue");
  assert.equal(reduceBrowserSetupKey(current, "change").action?.action, "change");

  const single: BrowserSetupScreen = { kind: "single", browser: browser("chrome") };
  assert.equal(reduceBrowserSetupKey(single, "enter").action?.action, "continue");
  assert.equal(reduceBrowserSetupKey(single, "change").action?.action, "advanced");

  const none: BrowserSetupScreen = {
    kind: "none",
    searched: ["Microsoft Edge Stable", "Google Chrome Stable"],
  };
  assert.equal(reduceBrowserSetupKey(none, "retry").action?.action, "retry");
  assert.equal(reduceBrowserSetupKey(none, "advanced").action?.action, "advanced");
  assert.equal(reduceBrowserSetupKey(none, "back").back, true);
});

test("browser setup remains readable at 54 columns and after resize without exposing paths", () => {
  const screen: BrowserSetupScreen = {
    kind: "choose",
    browsers: [
      browser("edge", { version: "149.0.4022.98-extra-details-that-must-not-reach-primary-layout" }),
      browser("chrome"),
    ],
    selectedIndex: 1,
  };
  for (const columns of [100, 54, 36]) {
    const rendered = stripAnsi(renderBrowserSetupScreen(screen, { columns }));
    const lines = rendered.split("\n").filter((line) => line.length > 0);
    assert.ok(lines.every((line) => displayWidth(line) <= columns), `${String(columns)} columns`);
    assert.match(rendered, /Choose a browser/u);
    assert.match(rendered, /Microsoft Edge Stable/u);
    assert.match(rendered, /Google Chrome Stable/u);
    assert.match(rendered, /● Google Chrome/u);
    assert.match(rendered, /Enter Continue/u);
    assert.doesNotMatch(rendered, /\/Applications|\\Program Files|browser_executable/u);
  }
});

test("plain and no-color setup uses numbered options and explicit selection markers", () => {
  const prior = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    const rendered = renderBrowserSetupScreen({
      kind: "choose",
      browsers: [browser("edge"), browser("chrome")],
      selectedIndex: 0,
    }, { columns: 54, plain: true });
    assert.doesNotMatch(rendered, /\x1b\[/u);
    assert.match(rendered, /1\. \[x\] Microsoft Edge/u);
    assert.match(rendered, /2\. \[ \] Google Chrome/u);
    assert.match(rendered, /Established compatibility target/u);
    assert.match(rendered, /preview candidate \/ offline evidence\s+only/u);
    assert.match(rendered, /Number Select/u);
  } finally {
    if (prior === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prior;
  }
});

test("browser changes require a separate from-to confirmation", () => {
  const screen: BrowserSetupScreen = {
    kind: "confirm-change",
    from: browser("edge"),
    to: browser("chrome"),
  };
  assert.equal(reduceBrowserSetupKey(screen, "enter").action?.action, "confirm-change");
  assert.equal(reduceBrowserSetupKey(screen, "back").back, true);
  const rendered = stripAnsi(renderBrowserSetupScreen(screen, { columns: 54 }));
  assert.match(rendered, /From: Microsoft Edge Stable/u);
  assert.match(rendered, /To:\s+Google Chrome Stable/u);
  assert.match(rendered, /authentication is not\s+copied/u);
});

test("active raw prompt clears from a known viewport origin after resize", async () => {
  const priorTerm = process.env.TERM;
  process.env.TERM = "xterm-256color";
  try {
  const input = new PassThrough() as unknown as typeof process.stdin;
  const terminalOutput = new PassThrough() as unknown as typeof process.stdout;
  Object.defineProperty(input, "isTTY", { value: true });
  Object.defineProperty(terminalOutput, "isTTY", { value: true });
  let raw = false;
  Object.defineProperty(input, "isRaw", { get: () => raw, configurable: true });
  input.setRawMode = (enabled: boolean) => { raw = enabled; return input; };
  let rendered = "";
  const screen: BrowserSetupScreen = {
    kind: "choose",
    browsers: [browser("edge"), browser("chrome")],
    selectedIndex: 0,
  };
  const pending = browserSetupPrompt(screen, { write: (value) => { rendered += value; } }, {
    input,
    terminalOutput,
    emitKeypress: () => undefined,
  });
  await Promise.resolve();
  terminalOutput.emit("resize");
  input.emit("keypress", undefined, { name: "down" });
  input.emit("keypress", undefined, { name: "enter" });
  const action = await pending;
  assert.equal(action.action, "continue");
  if (action.action === "continue") assert.equal(action.browser.product, "chrome");
  assert.match(rendered, /\x1b\[2J\x1b\[H/u);
  assert.equal(raw, false);
  } finally {
    if (priorTerm === undefined) delete process.env.TERM;
    else process.env.TERM = priorTerm;
  }
});

test("plain redirected prompt accepts numbered input without cursor-control output", async () => {
  const input = new PassThrough() as unknown as typeof process.stdin;
  const terminalOutput = new PassThrough() as unknown as typeof process.stdout;
  Object.defineProperty(input, "isTTY", { value: true });
  Object.defineProperty(terminalOutput, "isTTY", { value: false });
  let rendered = "";
  let questions = "";
  terminalOutput.on("data", (chunk) => { questions += String(chunk); });
  const pending = browserSetupPrompt({
    kind: "choose",
    browsers: [browser("edge"), browser("chrome")],
    selectedIndex: 0,
  }, { write: (value) => { rendered += value; } }, { input, terminalOutput });
  input.end("2\n");
  const action = await pending;
  assert.equal(action.action, "continue");
  if (action.action === "continue") assert.equal(action.browser.product, "chrome");
  assert.doesNotMatch(`${rendered}${questions}`, /\x1b\[/u);
  assert.match(rendered, /1\. \[x\].*Edge/su);
  assert.match(rendered, /2\. \[ \].*Chrome/su);
});

test("active prompt propagates Ctrl+C as cancellation", async () => {
  const priorTerm = process.env.TERM;
  process.env.TERM = "xterm-256color";
  try {
  const input = new PassThrough() as unknown as typeof process.stdin;
  const terminalOutput = new PassThrough() as unknown as typeof process.stdout;
  Object.defineProperty(input, "isTTY", { value: true });
  Object.defineProperty(terminalOutput, "isTTY", { value: true });
  let raw = false;
  Object.defineProperty(input, "isRaw", { get: () => raw, configurable: true });
  input.setRawMode = (enabled: boolean) => { raw = enabled; return input; };
  const pending = browserSetupPrompt({ kind: "single", browser: browser("edge") }, { write: () => undefined }, {
    input,
    terminalOutput,
    emitKeypress: () => undefined,
  });
  await Promise.resolve();
  input.emit("keypress", "c", { name: "c", ctrl: true });
  await assert.rejects(pending, PromptCancelledError);
  assert.equal(raw, false);
  } finally {
    if (priorTerm === undefined) delete process.env.TERM;
    else process.env.TERM = priorTerm;
  }
});
