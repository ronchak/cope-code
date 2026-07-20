import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { parseCliArguments } from "../../src/cli/arguments.js";
import { executeCommand } from "../../src/cli/commands.js";
import {
  DEFAULT_ORGANIZATION_POLICY,
  DEFAULT_REPOSITORY_POLICY,
} from "../../src/policy/index.js";
import { serializeProtocolEnvelope, type ProtocolMessage } from "../../src/protocol/index.js";
import { DEFAULT_GIT_EXECUTABLE } from "../../src/repository/boundary.js";
import { createStandardUserHost } from "../helpers/standard-user-host.js";

const execFileAsync = promisify(execFile);

test("runnable CLI completes a policy-loaded offline fixture session", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-cli-e2e-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const repository = path.join(temporary, "repository");
  const stateHome = path.join(temporary, "state");
  await mkdir(path.join(repository, ".cba"), { recursive: true });
  await mkdir(path.join(stateHome, "config"), { recursive: true, mode: 0o700 });
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["init", "--quiet", repository]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", repository, "config", "user.name", "CBA CLI Test"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", repository, "config", "user.email", "cba-cli@example.invalid"]);
  await writeFile(path.join(repository, "README.md"), "# fixture repository\n", "utf8");
  await writeFile(path.join(repository, ".cba", "repository.json"), JSON.stringify({
    schema_version: "cba-repository-config/1",
    classification: "internal",
    policy: DEFAULT_REPOSITORY_POLICY,
    grant_defaults: {
      readable_paths: ["**"],
      writable_paths: [],
      disclosure_classifications: ["internal"],
    },
    commands: [],
    completion: {
      required_command_ids: [],
      require_validation_after_last_mutation: true,
    },
    limits: {
      max_file_bytes: 1_048_576,
      max_read_bytes: 131_072,
      max_search_output_bytes: 131_072,
      max_diff_bytes: 524_288,
      max_checkpoint_bytes: 16_777_216,
      max_patch_bytes: 4_194_304,
    },
    retention: { retain_source_artifacts_on_completion: false },
  }, null, 2));
  await writeFile(
    path.join(stateHome, "config", "organization-policy.json"),
    JSON.stringify(DEFAULT_ORGANIZATION_POLICY, null, 2),
    { mode: 0o600 },
  );
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", repository, "add", "--", "README.md", ".cba/repository.json"]);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", repository, "commit", "--quiet", "-m", "fixture"]);

  const criterion = "The deterministic harness can verify the unchanged repository state";
  const completion: ProtocolMessage = {
    protocol: "cba/1",
    message_type: "completion",
    message_id: "fixture_completion_1",
    task_id: "TASK_ID_PLACEHOLDER",
    turn_id: 1,
    operation_id: "fixture_complete",
    report: {
      summary: "Verified that the configured repository requires no changes for this fixture objective.",
      acceptance_criteria: [{ criterion, status: "satisfied", evidence: "Harness repository inspection" }],
      validation: [],
      skipped_validation: [],
      remaining_risks: [],
      follow_up: [],
    },
    verified: false,
  };
  const fixtureFile = path.join(temporary, "model-fixture.json");
  await writeFile(fixtureFile, JSON.stringify({
    schema_version: "cba-scripted-fixture/1",
    turns: [{
      expected_content_contains: "cba/1",
      response: {
        status: "completed",
        content: serializeProtocolEnvelope(completion).replace("TASK_ID_PLACEHOLDER", "{{TASK_ID}}"),
      },
    }],
  }));

  let stdout = "";
  let stderr = "";
  const command = parseCliArguments([
    "run",
    "Verify the unchanged fixture repository",
    "--repo",
    repository,
    "--state-home",
    stateHome,
    "--transport",
    "fixture",
    "--fixture",
    fixtureFile,
    "--accept",
    criterion,
    "--approve-grant",
    "--json",
  ]);
  const exitCode = await executeCommand(command, {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  }, { host: createStandardUserHost() });

  assert.equal(exitCode, 0, stderr || stdout);
  const lines = stdout.trim().split("\n");
  const result = JSON.parse(lines.at(-1) ?? "{}") as {
    status?: string;
    completion?: { accepted?: boolean };
    handoff?: {
      repository?: {
        current?: {
          known?: boolean;
          matchesVerifiedCompletion?: boolean;
          branch?: string | null;
          head?: string | null;
          entries?: readonly unknown[];
          diff?: { sections?: readonly { content?: string; rawSha256?: string }[] };
        };
      };
      completionReport?: { integrity?: string; claim?: { summary?: string } };
    };
  };
  assert.equal(result.status, "completed");
  assert.equal(result.completion?.accepted, true);
  assert.equal(result.handoff?.repository?.current?.known, true);
  assert.equal(result.handoff?.repository?.current?.matchesVerifiedCompletion, true);
  assert.equal(Array.isArray(result.handoff?.repository?.current?.entries), true);
  assert.equal(result.handoff?.repository?.current?.diff?.sections?.length, 1);
  assert.match(result.handoff?.completionReport?.integrity ?? "", /^[a-f0-9]{64}$/u);
  assert.match(result.handoff?.completionReport?.claim?.summary ?? "", /configured repository/);
});
