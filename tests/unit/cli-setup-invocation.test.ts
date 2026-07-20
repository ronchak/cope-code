import assert from "node:assert/strict";
import test from "node:test";

import type { CliCommand } from "../../src/cli/arguments.js";
import { enableInteractiveSetupRerun } from "../../src/cli/setup-invocation.js";

type SetupCommand = Extract<CliCommand, { readonly command: "setup" }>;

function setupCommand(overrides: Partial<SetupCommand> = {}): SetupCommand {
  return { command: "setup", force: false, json: false, ...overrides };
}

test("plain interactive cope setup reruns an existing machine setup", () => {
  const prepared = enableInteractiveSetupRerun(
    setupCommand(),
    { stdinIsTTY: true, stdoutIsTTY: true },
  );

  assert.equal(prepared.command, "setup");
  assert.equal(prepared.force, true);
});

test("redirected and JSON setup invocations remain idempotent", () => {
  const redirectedInput = setupCommand();
  const redirectedOutput = setupCommand();
  const json = setupCommand({ json: true });

  assert.strictEqual(enableInteractiveSetupRerun(
    redirectedInput,
    { stdinIsTTY: false, stdoutIsTTY: true },
  ), redirectedInput);
  assert.strictEqual(enableInteractiveSetupRerun(
    redirectedOutput,
    { stdinIsTTY: true, stdoutIsTTY: false },
  ), redirectedOutput);
  assert.strictEqual(enableInteractiveSetupRerun(
    json,
    { stdinIsTTY: true, stdoutIsTTY: true },
  ), json);
});

test("an explicit setup force flag is preserved", () => {
  const command = setupCommand({ force: true });
  assert.strictEqual(enableInteractiveSetupRerun(
    command,
    { stdinIsTTY: true, stdoutIsTTY: true },
  ), command);
});
