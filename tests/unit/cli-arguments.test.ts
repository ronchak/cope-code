import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArguments } from "../../src/cli/arguments.js";

test("CLI parses run objective, bounded mode, and repeated acceptance criteria", () => {
  const command = parseCliArguments([
    "run",
    "Fix the parser",
    "--mode",
    "auto",
    "--transport",
    "replay",
    "--transcript",
    "fixture.json",
    "--accept",
    "tests pass",
    "--accept",
    "no path escape",
  ]);
  assert.equal(command.command, "run");
  if (command.command !== "run") return;
  assert.equal(command.mode, "auto");
  assert.deepEqual(command.acceptanceCriteria, ["tests pass", "no path escape"]);
});

test("CLI rejects missing transport inputs and unknown options", () => {
  assert.throws(() => parseCliArguments(["run", "Fix", "--transport", "replay"]), /transcript/);
  assert.throws(() => parseCliArguments(["run", "Fix", "--unsafe-shell"]), /Unexpected/);
  assert.throws(() => parseCliArguments(["run", "Fix", "--mode", "unrestricted"]), /Invalid mode/);
});

test("setup accepts optional browser automation choices and rejects unsupported products", () => {
  const chrome = parseCliArguments([
    "setup",
    "--browser",
    "chrome",
    "--browser-executable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ]);
  assert.equal(chrome.command, "setup");
  if (chrome.command !== "setup") return;
  assert.equal(chrome.browser, "chrome");
  assert.equal(chrome.browserExecutable, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.throws(() => parseCliArguments(["setup", "--browser", "brave"]), /edge or chrome/iu);
});

test("CLI parses pause and pins explicit resume transport sources", () => {
  const pause = parseCliArguments(["pause", "session_12345678", "--reason", "operator break"]);
  assert.deepEqual(pause, {
    command: "pause",
    sessionId: "session_12345678",
    reason: "operator break",
    json: false,
  });

  const resume = parseCliArguments([
    "resume",
    "session_12345678",
    "--transport",
    "fixture",
    "--fixture",
    "model.json",
    "--approve-grant",
  ]);
  assert.equal(resume.command, "resume");
  if (resume.command !== "resume") return;
  assert.equal(resume.transport, "fixture");
  assert.equal(resume.fixture, "model.json");
  assert.equal(resume.approveGrant, true);
});

test("CLI rejects transport source flags without matching transport", () => {
  assert.throws(
    () => parseCliArguments(["resume", "session_12345678", "--fixture", "model.json"]),
    /--fixture requires/,
  );
  assert.throws(
    () => parseCliArguments(["run", "Fix", "--transport", "edge", "--transcript", "log.json"]),
    /--transcript requires/,
  );
});

test("CLI parses review-package export and validates its arguments", () => {
  assert.deepEqual(
    parseCliArguments([
      "export-review",
      "session_12345678",
      "--output",
      "review.json",
      "--state-home",
      "state",
      "--json",
    ]),
    {
      command: "export-review",
      sessionId: "session_12345678",
      output: "review.json",
      stateHome: "state",
      json: true,
    },
  );
  assert.throws(() => parseCliArguments(["export-review"]), /requires a session identifier/);
  assert.throws(
    () => parseCliArguments(["export-review", "session_12345678", "--output"]),
    /--output requires a value/,
  );
});

test("CLI requires an explicit force flag for divergent rollback override", () => {
  assert.deepEqual(
    parseCliArguments(["rollback", "session_12345678", "--checkpoint", "checkpoint_123", "--force"]),
    {
      command: "rollback",
      sessionId: "session_12345678",
      checkpointId: "checkpoint_123",
      force: true,
      json: false,
    },
  );
  const safeDefault = parseCliArguments(["rollback", "session_12345678"]);
  assert.equal(safeDefault.command, "rollback");
  if (safeDefault.command === "rollback") assert.equal(safeDefault.force, false);
});

test("CLI defaults to the guided interface and accepts mode shortcuts", () => {
  const defaultCommand = parseCliArguments([]);
  assert.equal(defaultCommand.command, "interactive");
  if (defaultCommand.command !== "interactive") return;
  assert.equal(defaultCommand.repository, process.cwd());
  assert.equal(defaultCommand.repositoryExplicit, false);
  assert.equal(defaultCommand.mode, "edit");
  assert.equal(defaultCommand.modeExplicit, false);

  const inspect = parseCliArguments(["--inspect"]);
  assert.equal(inspect.command, "interactive");
  if (inspect.command !== "interactive") return;
  assert.equal(inspect.mode, "inspect");
  assert.equal(inspect.modeExplicit, true);
});

test("CLI parses the side-effect-free terminal demo command", () => {
  const command = parseCliArguments(["demo", "-C", "sample-project", "--inspect"]);
  assert.deepEqual(command, {
    command: "demo",
    repository: "sample-project",
    mode: "inspect",
    json: false,
  });
});

test("CLI accepts plain-English tasks, path-first launch, and project targeting", () => {
  const task = parseCliArguments(["fix", "the", "failing", "tests"]);
  assert.equal(task.command, "interactive");
  if (task.command !== "interactive") return;
  assert.equal(task.initialObjective, "fix the failing tests");

  const file = parseCliArguments(["C:\\work\\dashboard.html"]);
  assert.equal(file.command, "interactive");
  if (file.command !== "interactive") return;
  assert.equal(file.initialObjective, "C:\\work\\dashboard.html");

  const targeted = parseCliArguments(["-C", "C:\\work\\project", "fix", "tests"]);
  assert.equal(targeted.command, "interactive");
  if (targeted.command !== "interactive") return;
  assert.equal(targeted.repository, "C:\\work\\project");
  assert.equal(targeted.repositoryExplicit, true);
  assert.equal(targeted.initialObjective, "fix tests");
});

test("guided open and init do not consume flags as positional paths", () => {
  const open = parseCliArguments(["open", "--inspect"]);
  assert.equal(open.command, "interactive");
  if (open.command !== "interactive") return;
  assert.equal(open.repository, process.cwd());
  assert.equal(open.repositoryExplicit, false);
  assert.equal(open.mode, "inspect");

  const init = parseCliArguments(["init", "--quick"]);
  assert.equal(init.command, "init");
  if (init.command !== "init") return;
  assert.equal(init.repository, process.cwd());
  assert.equal(init.quick, true);
});
