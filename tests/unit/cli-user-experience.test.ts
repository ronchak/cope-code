import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CLI_VERSION, executeCommand } from "../../src/cli/commands.js";
import { configuredBrowserLabel, interactiveSetupCommand } from "../../src/cli/interactive.js";
import { chatFooter, renderUserMessage, setupHero, startupPanel } from "../../src/cli/presentation.js";
import { chatPromptStartRow, inputViewport } from "../../src/cli/prompts.js";
import {
  beginTerminalTakeover,
  commandUsesTerminalTakeover,
  displayWidth,
  repeatToWidth,
  stripAnsi,
  truncateMiddle,
} from "../../src/cli/terminal-layout.js";
import { syncWorkspaceCopy } from "../../src/cli/workspace.js";

class MemoryOutput {
  public value = "";
  public write(chunk: string): void { this.value += chunk; }
}

test("interactive transport label follows the configured Chrome product", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-interactive-browser-label-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const browserFile = path.join(root, "browser.json");
  await writeFile(browserFile, JSON.stringify({
    schema_version: "cba-browser-config/2",
    product: "chrome",
    browser_contract_version: "cope-visible-browser/v1",
    entry_url: "https://m365.cloud.microsoft/chat",
    approved_hosts: [{ hostname: "m365.cloud.microsoft", allow_subdomains: false }],
    expected_identity: "person@example.com",
    require_protection_indicator: false,
    profile_directory: path.join(root, "profile"),
    browser_executable: path.join(root, "Google Chrome"),
    browser_version: "149.0.1.2",
    browser_executable_sha256: "a".repeat(64),
  }), "utf8");
  assert.equal(await configuredBrowserLabel(browserFile), "visible Chrome");
});

test("the in-session setup command preserves valid configuration by default", () => {
  assert.deepEqual(interactiveSetupCommand("/managed/state"), {
    command: "setup",
    force: false,
    json: false,
    stateHome: "/managed/state",
  });
});

test("package and installer expose a durable global cope command", async () => {
  const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as {
    version: string;
    bin: Record<string, string>;
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.version, CLI_VERSION);
  assert.equal(packageJson.bin.cope, "dist/src/cli/main.js");
  assert.equal(packageJson.bin["copilot-agent"], "dist/src/cli/main.js");
  const devScript = packageJson.scripts.dev;
  assert.ok(devScript);
  assert.match(devScript, /dist\/src\/cli\/main\.js/u);
  assert.doesNotMatch(devScript, /experimental-strip-types/u);

  const installer = await readFile(path.resolve("scripts/install-windows.ps1"), "utf8");
  assert.match(installer, /npm\.cmd pack --json --ignore-scripts/u);
  assert.match(installer, /npm\.cmd install --global/u);
  assert.doesNotMatch(installer, /npm\.cmd link/u);
  assert.match(installer, /cope\.cmd/u);
  assert.match(installer, /SetEnvironmentVariable\("COPE_SOURCE_DIR", \$ProjectRoot, "User"\)/u);
});

test("normal help stays compact while advanced operations remain discoverable", async () => {
  const normal = new MemoryOutput();
  assert.equal(await executeCommand({ command: "help", advanced: false, json: false }, { stdout: normal, stderr: normal }), 0);
  assert.match(normal.value, /cope "fix the failing tests"/u);
  assert.match(normal.value, /cope demo/u);
  assert.match(normal.value, /cope help advanced/u);
  assert.doesNotMatch(normal.value, /verify-audit <session-id>/u);

  const advanced = new MemoryOutput();
  assert.equal(await executeCommand({ command: "help", advanced: true, json: false }, { stdout: advanced, stderr: advanced }), 0);
  assert.match(advanced.value, /verify-audit <session-id>/u);
  assert.match(advanced.value, /Compatibility alias: copilot-agent/u);
});

test("demo mode previews the terminal interface without live setup", async () => {
  const output = new MemoryOutput();
  const exitCode = await executeCommand({
    command: "demo",
    repository: process.cwd(),
    mode: "edit",
    json: false,
  }, { stdout: output, stderr: output });

  assert.equal(exitCode, 0);
  assert.match(output.value, /Demo mode/u);
  assert.match(output.value, /Demo workspace/u);
  assert.match(output.value, /demo \(offline\)/u);
  assert.match(output.value, /no browser will open/u);
});

test("terminal takeover requires an explicit fullscreen opt-in", () => {
  assert.equal(commandUsesTerminalTakeover("interactive", false, false), false);
  assert.equal(commandUsesTerminalTakeover("interactive", false, true), true);
  assert.equal(commandUsesTerminalTakeover("demo", false, true), true);
  assert.equal(commandUsesTerminalTakeover("run", false), false);
  assert.equal(commandUsesTerminalTakeover("demo", true, true), false);
});

test("fullscreen takeover uses an alternate buffer without clearing scrollback", () => {
  const output = new MemoryOutput();
  const end = beginTerminalTakeover(output, {
    inputIsTTY: true,
    outputIsTTY: true,
    term: "xterm-256color",
    fullscreen: true,
  });

  assert.match(output.value, /\x1b\[\?1049h/u);
  assert.doesNotMatch(output.value, /\x1b\[2J|\x1b\[3J/u);
  assert.match(output.value, /\x1b\[H/u);
  const afterStart = output.value;
  end();
  assert.equal(output.value, `${afterStart}\x1b[0m\x1b[?25h\x1b[?1049l`);
  end();
  assert.equal(output.value, `${afterStart}\x1b[0m\x1b[?25h\x1b[?1049l`);
});

test("terminal takeover leaves redirected and plain-terminal output untouched", () => {
  const cases = [
    { inputIsTTY: false, outputIsTTY: true, term: "xterm-256color" },
    { inputIsTTY: true, outputIsTTY: false, term: "xterm-256color" },
    { inputIsTTY: true, outputIsTTY: true, term: "dumb" },
  ] as const;
  for (const options of cases) {
    const output = new MemoryOutput();
    const end = beginTerminalTakeover(output, options);
    end();
    assert.equal(output.value, "");
  }
  const defaultOutput = new MemoryOutput();
  beginTerminalTakeover(defaultOutput, { inputIsTTY: true, outputIsTTY: true, term: "xterm-256color", fullscreen: false })();
  assert.equal(defaultOutput.value, "");
});

test("startup panel is responsive and preserves Cope workspace information", () => {
  const wide = new MemoryOutput();
  startupPanel({
    version: CLI_VERSION,
    repositoryRoot: "/Users/example/projects/copilot-browser-agent",
    mode: "edit",
    transport: "demo (offline)",
    demo: true,
    columns: 100,
  }, wide);
  assert.match(wide.value, /Welcome to Cope/u);
  assert.match(wide.value, /Demo workspace/u);
  assert.match(wide.value, /browser-agent/u);
  assert.match(wide.value, /edit mode/u);

  const compact = new MemoryOutput();
  startupPanel({
    version: CLI_VERSION,
    repositoryRoot: "/Users/example/projects/copilot-browser-agent",
    mode: "inspect",
    transport: "visible Edge",
    columns: 48,
  }, compact);
  assert.match(compact.value, /Project:/u);
  assert.match(compact.value, /Mode:\s+inspect/u);
  assert.match(compact.value, /Ready to work/u);
  assert.doesNotMatch(compact.value, /Demo workspace/u);
});

test("startup panel credits Ronak Chakraborty in the responsive top bar", () => {
  for (const columns of [36, 100]) {
    const output = new MemoryOutput();
    startupPanel({
      version: CLI_VERSION,
      repositoryRoot: "/Users/example/projects/copilot-browser-agent",
      mode: "edit",
      transport: "visible Edge",
      columns,
    }, output);

    const lines = stripAnsi(output.value).split("\n").filter((line) => line.length > 0);
    assert.match(lines[0] ?? "", /COPE.*by Ronak Chakraborty/u);
    assert.ok(lines.every((line) => displayWidth(line) === columns));
    if (columns === 36) assert.doesNotMatch(lines[0] ?? "", new RegExp(`v${escapeRegExp(CLI_VERSION)}`, "u"));
    else assert.match(lines[0] ?? "", new RegExp(`v${escapeRegExp(CLI_VERSION)}`, "u"));
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

test("one-time setup opens with a responsive Cope Code hero and creator credit", () => {
  for (const columns of [36, 88]) {
    const output = new MemoryOutput();
    setupHero(output, { columns });

    const rendered = stripAnsi(output.value);
    const lines = rendered.split("\n").filter((line) => line.length > 0);
    assert.match(rendered, /Welcome to Cope Code/u);
    assert.match(rendered, /Ronak Chakraborty/u);
    assert.match(rendered, /Browser/u);
    assert.match(rendered, /Account|account/u);
    assert.match(rendered, /Ready|ready/u);
    assert.match(rendered, /password stays.*browser/isu);
    assert.ok(lines.every((line) => displayWidth(line) === Math.min(columns, 72)), `${String(columns)} columns`);
  }
});

test("terminal layout measures wide characters and keeps footer on one row", () => {
  assert.equal(displayWidth("a界🙂"), 5);
  assert.equal(displayWidth(truncateMiddle("/a/very/long/project/path", 12)), 12);
  const footer = chatFooter({
    repositoryRoot: "/Users/example/projects/copilot-browser-agent",
    mode: "auto",
    transport: "visible Edge",
  }, 54);
  assert.ok(displayWidth(footer) <= 52);
  assert.doesNotMatch(footer, /\n/u);
  assert.match(footer, /^Enter submit/u);
  assert.match(footer, /Ctrl\+C cancel/u);
});

test("terminal layout handles emoji clusters and zero-width formatting", () => {
  assert.equal(displayWidth("🇺🇸"), 2);
  assert.equal(displayWidth("1️⃣"), 2);
  assert.equal(displayWidth("​⁠"), 0);
  assert.equal(displayWidth(repeatToWidth("界", 5)), 4);
});

test("task input viewport tracks the grapheme cursor", () => {
  assert.deepEqual(inputViewport("", 0, 20), { text: "", cursorCells: 0 });
  assert.deepEqual(inputViewport("abc", 3, 20), { text: "abc", cursorCells: 3 });
  assert.deepEqual(inputViewport("a界🙂", 2, 20), { text: "a界🙂", cursorCells: 3 });
  assert.deepEqual(inputViewport("éx", 1, 20), { text: "éx", cursorCells: 1 });
  assert.deepEqual(inputViewport("abc", 1, 20), { text: "abc", cursorCells: 1 });
});

test("task composer is anchored to the bottom four terminal rows", () => {
  assert.equal(chatPromptStartRow(24), 21);
  assert.equal(chatPromptStartRow(40), 37);
  assert.equal(chatPromptStartRow(3), 1);
});

test("sent messages use a distinct transcript block without retaining the task composer", () => {
  const output = new MemoryOutput();
  renderUserMessage("whats up brodie", output);
  const rendered = stripAnsi(output.value);

  assert.match(rendered, /(?:╭─|\+-) You · sent/u);
  assert.match(rendered, /(?:│|\|) whats up brodie/u);
  assert.doesNotMatch(rendered, /Task|Describe a task/u);
  assert.equal(rendered.match(/whats up brodie/gu)?.length, 1);
});

test("task input viewport keeps cursor visible when text overflows", () => {
  const end = inputViewport("abcdefghij", 10, 6);
  assert.deepEqual(end, { text: "…fghij", cursorCells: 6 });
  assert.equal(displayWidth(end.text), 6);

  const start = inputViewport("abcdefghij", 0, 6);
  assert.deepEqual(start, { text: "abcde…", cursorCells: 0 });
  assert.equal(displayWidth(start.text), 6);

  const middle = inputViewport("abcdefghij", 5, 6);
  assert.ok(displayWidth(middle.text) <= 6);
  assert.ok(middle.cursorCells >= 0 && middle.cursorCells <= displayWidth(middle.text));
  assert.match(middle.text, /^….*…$/u);
});

test("standalone-file sync never overwrites without an interactive approval", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-file-sync-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const original = path.join(root, "dashboard.html");
  const repositoryRoot = path.join(root, "dashboard-cope");
  await mkdir(repositoryRoot);
  const workspaceFile = path.join(repositoryRoot, "dashboard.html");
  await writeFile(original, "before\n", "utf8");
  await writeFile(workspaceFile, "after\n", "utf8");

  const output = new MemoryOutput();
  const result = await syncWorkspaceCopy({
    repositoryRoot,
    originalSelection: original,
    copiedFromFile: original,
    copiedFileName: "dashboard.html",
    originalSha256: "9160d4be34c8695bd172a76c7c7966587ea5a4d991ad22c87b2b91af54aa9ebb",
  }, { interactive: false, output });

  assert.equal(await readFile(original, "utf8"), "before\n");
  assert.equal(result.originalSha256, "9160d4be34c8695bd172a76c7c7966587ea5a4d991ad22c87b2b91af54aa9ebb");
  assert.match(output.value, /left both copies untouched|remain in the project copy/u);
});
