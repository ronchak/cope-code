import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../../src/cli/main.js";
import type { CliCommand } from "../../src/cli/arguments.js";
import { PromptCancelledError } from "../../src/cli/prompts.js";

test("main leaves plain setup non-forced so interactive setup can rerun without rewriting unchanged configuration", async () => {
  let observed: CliCommand | undefined;
  const exitCode = await main(["setup"], {
    stdout: { write: () => true } as unknown as typeof process.stdout,
    stderr: { write: () => true } as unknown as typeof process.stderr,
    executeCommand: async (command) => { observed = command; return 0; },
  });

  assert.equal(exitCode, 0);
  assert.equal(observed?.command, "setup");
  assert.equal(observed?.command === "setup" ? observed.force : undefined, false);
});

test("main propagates prompt Ctrl+C cancellation as exit status 130", async () => {
  let stdout = "";
  let stderr = "";
  const exitCode = await main(["setup"], {
    stdout: { write: (value: string) => { stdout += value; return true; } } as unknown as typeof process.stdout,
    stderr: { write: (value: string) => { stderr += value; return true; } } as unknown as typeof process.stderr,
    executeCommand: async () => { throw new PromptCancelledError(); },
  });
  assert.equal(exitCode, 130);
  assert.equal(stdout, "");
  assert.match(stderr, /Cancelled/u);
});

test("main emits structured cancellation with the same status in JSON mode", async () => {
  let stdout = "";
  const exitCode = await main(["setup", "--json"], {
    stdout: { write: (value: string) => { stdout += value; return true; } } as unknown as typeof process.stdout,
    stderr: { write: () => true } as unknown as typeof process.stderr,
    executeCommand: async () => { throw new PromptCancelledError(); },
  });
  assert.equal(exitCode, 130);
  assert.deepEqual(JSON.parse(stdout), { ok: false, code: "CANCELLED", message: "Cancelled by user" });
});
