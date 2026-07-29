import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKSPACE_OBSERVATION_CONTRACT,
  isWorkspaceObservation,
  type WorkspaceObservation,
} from "../../src/repository/workspace-observer.js";
import { sha256 } from "../../src/shared/crypto.js";

const HASH = "a".repeat(64);

test("workspace observation contract distinguishes complete and metadata-limited evidence", () => {
  const complete = observation("complete");
  assert.equal(isWorkspaceObservation(complete), true);

  const metadataLimited = {
    ...complete,
    state: "metadata_limited",
    repositoryFingerprint: undefined,
    limitationCodes: ["VISIBLE_STATE_BOUND_EXCEEDED"],
  };
  assert.equal(isWorkspaceObservation(metadataLimited), true);
  assert.equal(
    isWorkspaceObservation({
      ...metadataLimited,
      repositoryFingerprint: HASH,
    }),
    false,
  );
  assert.equal(
    isWorkspaceObservation({
      ...complete,
      unexpected: true,
    }),
    false,
  );
  assert.equal(
    isWorkspaceObservation({
      contract: WORKSPACE_OBSERVATION_CONTRACT,
      phase: "post",
      observedAt: "2026-07-29T00:00:01.000Z",
      durationMs: 20_000,
      state: "unknown",
      limitationCodes: ["POST_OBSERVATION_TIMEOUT"],
    }),
    true,
  );
});

test("workspace observation contract bounds aggregate retained before-images", () => {
  const content = Buffer.alloc(1024 * 1024);
  const contentBase64 = content.toString("base64");
  const retained = Array.from({ length: 4 }, (_, index) => ({
    kind: "retained" as const,
    exists: true as const,
    identity: {
      path: `src/file-${index}.txt`,
      mode: 0o100644,
      size: 1024 * 1024,
    },
    sha256: sha256(content),
    binary: false,
    contentBase64,
  }));
  assert.equal(
    isWorkspaceObservation({
      ...observation("complete"),
      beforeImages: retained,
    }),
    false,
  );
});

test("workspace observation accepts Git reconstruction identities and authenticates retained bytes", () => {
  const content = Buffer.from("before\n");
  const complete = observation("complete");
  assert.equal(
    isWorkspaceObservation({
      ...complete,
      entries: [{
        path: "src/file.ts",
        kind: "ordinary",
        indexStatus: "M",
        worktreeStatus: "M",
        stateSha256: HASH,
        headMode: "100644",
        indexMode: "100644",
        worktreeMode: "100644",
        headObject: "b".repeat(40),
        indexObject: "c".repeat(40),
        worktreeIdentity: {
          mode: 0o100644,
          size: content.length,
          contentSha256: sha256(content),
        },
      }],
      beforeImages: [{
        kind: "retained",
        exists: true,
        identity: {
          path: "src/file.ts",
          mode: 0o100644,
          size: content.length,
        },
        sha256: sha256(content),
        binary: false,
        contentBase64: content.toString("base64"),
      }],
    }),
    true,
  );
  assert.equal(
    isWorkspaceObservation({
      ...complete,
      beforeImages: [{
        kind: "retained",
        exists: true,
        identity: {
          path: "src/file.ts",
          mode: 0o100644,
          size: content.length,
        },
        sha256: "f".repeat(64),
        binary: false,
        contentBase64: content.toString("base64"),
      }],
    }),
    false,
  );
});

test("workspace transition inventories enforce their aggregate UTF-8 bound", () => {
  const path = "x".repeat(32_000);
  const paths = Array.from({ length: 9 }, (_, index) => `${index}${path}`);
  assert.equal(
    isWorkspaceObservation({
      ...observation("complete"),
      transitionPaths: {
        paths,
        total: paths.length,
        omitted: 0,
        truncated: false,
        completeFactsSha256: HASH,
      },
    }),
    false,
  );
});

export function observation(
  state: WorkspaceObservation["state"],
  phase: WorkspaceObservation["phase"] = "pre",
): WorkspaceObservation {
  const facts = {
    contract: WORKSPACE_OBSERVATION_CONTRACT,
    phase,
    observedAt: "2026-07-29T00:00:00.000Z",
    durationMs: 25,
    branch: "main",
    head: "b".repeat(40),
    components: {
      index: "1".repeat(64),
      visible: "2".repeat(64),
      excluded: "3".repeat(64),
      protectedWorktree: "4".repeat(64),
      gitTransitions: "5".repeat(64),
      gitControls: "6".repeat(64),
    },
    entries: [],
    beforeImages: [],
    transitionPaths: {
      paths: [],
      total: 0,
      omitted: 0,
      truncated: false,
      completeFactsSha256: "7".repeat(64),
    },
    ignoredCount: 0,
    ignoredSummarySha256: "8".repeat(64),
    ignoredSummaryTruncated: false,
    nestedRepository: "none" as const,
    limitationCodes: state === "complete" ? [] : ["LIMITED"],
  };
  if (state === "complete") {
    return { ...facts, state, repositoryFingerprint: HASH };
  }
  return { ...facts, state };
}
