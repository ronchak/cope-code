import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
import { SessionArtifactStore } from "../../src/session/artifact-store.js";
import { SessionStore } from "../../src/session/store.js";
import type { SessionState } from "../../src/session/types.js";
import { createStandardUserHost } from "../helpers/standard-user-host.js";

const execFileAsync = promisify(execFile);

test("CLI fallback terminalization cleans recovery data after a transient failed-state write", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cba-cli-terminal-fallback-"));
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

  const mismatched: ProtocolMessage = {
    protocol: "cba/1",
    message_type: "completion",
    message_id: "fixture_wrong_task",
    task_id: "task_from_another_session",
    turn_id: 1,
    operation_id: "fixture_complete",
    report: {
      summary: "This response belongs to another task.",
      acceptance_criteria: [],
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
        content: serializeProtocolEnvelope(mismatched),
      },
    }],
  }));

  const originalWrite = SessionStore.prototype.write;
  let injectedRecoveryData = false;
  let failedWriteAttempts = 0;
  SessionStore.prototype.write = async function (session: SessionState): Promise<void> {
    if (session.submission?.state === "answered" && !injectedRecoveryData) {
      injectedRecoveryData = true;
      session.completionHandoff = {
        version: "completion-handoff/1",
        integrity: "a".repeat(64),
        createdAt: "2026-01-01T00:00:00.000Z",
        redactionCount: 0,
      };
      const handoffDirectory = path.join(stateHome, "sessions", session.sessionId, "handoff");
      await mkdir(handoffDirectory, { recursive: true });
      await writeFile(path.join(handoffDirectory, "completion.json"), "provisional handoff\n");
    }
    if (session.status === "failed") {
      failedWriteAttempts += 1;
      if (failedWriteAttempts === 1) throw new Error("transient failure state write");
      assert.equal(session.completionHandoff, undefined);
    }
    await originalWrite.call(this, session);
  };
  context.after(() => {
    SessionStore.prototype.write = originalWrite;
  });

  const command = parseCliArguments([
    "run",
    "Reject a response from another task",
    "--repo",
    repository,
    "--state-home",
    stateHome,
    "--transport",
    "fixture",
    "--fixture",
    fixtureFile,
    "--approve-grant",
    "--json",
  ]);
  await assert.rejects(executeCommand(command, {
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
  }, {
    host: createStandardUserHost(),
  }), /transient failure state write/u);

  assert.equal(injectedRecoveryData, true);
  assert.equal(failedWriteAttempts, 2, "runtime failure and CLI fallback must each attempt one terminal write");
  const sessionIds = await readdir(path.join(stateHome, "sessions"));
  assert.equal(sessionIds.length, 1);
  const sessionId = sessionIds[0]!;
  const store = new SessionStore(stateHome);
  const durable = await store.read(sessionId);
  assert.equal(durable.status, "failed");
  assert.equal(durable.completionHandoff, undefined);
  const artifacts = new SessionArtifactStore(path.join(store.sessionDirectory(sessionId), "artifacts"));
  assert.equal(await artifacts.getOptional("response", "turn_0001"), undefined);
  await assert.rejects(
    readFile(path.join(store.sessionDirectory(sessionId), "handoff", "completion.json")),
    /ENOENT/u,
  );
});
