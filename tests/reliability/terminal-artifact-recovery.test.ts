import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { TERMINAL_EXEC_CONTRACT } from "../../src/protocol/terminal-exec.js";
import { SessionArtifactStore } from "../../src/session/artifact-store.js";
import { TerminalArtifactPersistence } from "../../src/session/terminal-artifacts.js";
import { sha256, stableJson } from "../../src/shared/crypto.js";

const crashChild = fileURLToPath(
  new URL("../fixtures/reliability-terminal-artifact-crash.js", import.meta.url),
);
const operationId = "op_terminal_crash";
const requestHash = sha256(stableJson({
  contract: TERMINAL_EXEC_CONTRACT,
  mode: "argv",
  executable: "node",
  arguments: ["script.js"],
  cwd: ".",
}));

test("terminal artifact crash windows never infer or replay uncertain execution", async () => {
  for (const boundary of ["request", "pre", "exit", "post", "result"] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), "cope-terminal-crash-"));
    try {
      const crash = spawnSync(process.execPath, [crashChild, root, boundary], {
        encoding: "utf8",
        timeout: 10_000,
        env: withoutNodeTestContext(process.env),
      });
      assert.equal(
        crash.status,
        86,
        `${boundary} did not hard-exit at the requested durable boundary\n${crash.stderr}`,
      );
      const persistence = new TerminalArtifactPersistence(
        new SessionArtifactStore(path.join(root, "artifacts")),
      );
      const recover = () =>
        persistence.recoverCompleted({
          operationId,
          tool: "terminal_exec",
          requestHash,
        });
      if (boundary === "request" || boundary === "pre") {
        assert.equal(await recover(), undefined, boundary);
      } else if (boundary === "exit" || boundary === "post") {
        await assert.rejects(recover, /without a complete durable result/u);
      } else {
        const replay = await recover();
        assert.equal(replay?.stdout.head, "exact");
        assert.equal(replay?.replayed, true);
        assert.equal(replay?.outcome, "completed");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

function withoutNodeTestContext(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  delete result.NODE_TEST_CONTEXT;
  return result;
}
