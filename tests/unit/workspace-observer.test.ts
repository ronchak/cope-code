import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  lstat,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  LiveWorkspaceObserver,
  WORKSPACE_OBSERVATION_CONTRACT,
  createWorkspacePathFacts,
  isWorkspaceObservation,
  type SessionPreExistingBaseline,
  type WorkspaceObservation,
} from "../../src/repository/workspace-observer.js";
import {
  DEFAULT_GIT_EXECUTABLE,
  RepositoryBoundary,
} from "../../src/repository/boundary.js";
import {
  GitInspector,
  type IsolatedGitReadResult,
  type IsolatedGitNulReadResult,
  type GitObservationEntry,
  type GitStatusResult,
} from "../../src/repository/git.js";
import { sha256, stableJson } from "../../src/shared/crypto.js";
import { createFilesystemIdentity } from "../../src/shared/filesystem-identity.js";

const HASH = "a".repeat(64);
const execFileAsync = promisify(execFile);

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

test("workspace path facts use canonical Git UTF-8 ordering before exact digest and truncation", () => {
  const facts = createWorkspacePathFacts({
    created: ["z", "A", "\u{10000}", "\uE000", "A"],
    updated: ["updated"],
    deleted: [],
    renamed: [
      { from: "z", to: "a" },
      { from: "A", to: "b" },
    ],
    preExistingTouched: ["updated"],
  });
  assert.deepEqual(facts.created, ["A", "A", "z", "\uE000", "\u{10000}"]);
  assert.deepEqual(facts.renamed, [
    { from: "A", to: "b" },
    { from: "z", to: "a" },
  ]);
  assert.equal(facts.createdTotal, 5);
  assert.equal(facts.endpointTotal, 11);
  assert.equal(facts.truncated, false);
  assert.equal(
    facts.completeFactsSha256,
    sha256(stableJson({
      created: ["A", "A", "z", "\uE000", "\u{10000}"],
      updated: ["updated"],
      deleted: [],
      renamed: [
        { from: "A", to: "b" },
        { from: "z", to: "a" },
      ],
      preExistingTouched: ["updated"],
    })),
  );
});

test("live observer preserves GitInspector fingerprint identity and real index bytes for a clean no-op", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const baseline = emptyBaseline();
  const indexPath = path.join(fixture.root, ".git", "index");
  const indexBefore = await readFile(indexPath);
  const pre = await fixture.observer.capturePre(baseline);
  const independent = await fixture.git.status();
  const post = await fixture.observer.capturePost(pre);
  const effect = await fixture.observer.compare(pre, post, baseline);
  const indexAfter = await readFile(indexPath);

  assert.equal(pre.state, "complete");
  assert.equal(pre.repositoryFingerprint, independent.snapshotSha256);
  assert.equal(post.state, "complete");
  assert.equal(effect.outcome, "none");
  assert.equal(effect.paths.endpointTotal, 0);
  assert.deepEqual(indexAfter, indexBefore);
});

test("Git status preserves legacy locale ordering and fingerprints for mixed path names", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const mixedPaths = ["a.txt", "B.txt", "\uE000.txt", "\u{10000}.txt"];
  for (const relativePath of mixedPaths) {
    await writeFile(path.join(fixture.root, relativePath), `${relativePath}\n`);
  }
  const visible = await fixture.git.status();
  const legacyOrder = [...mixedPaths].sort((left, right) =>
    left.localeCompare(right));
  const gitByteOrder = [...mixedPaths].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  assert.notDeepEqual(legacyOrder, gitByteOrder);
  assert.deepEqual(
    visible.entries.map((entry) => entry.path),
    legacyOrder,
  );
  assert.equal(
    visible.snapshotSha256,
    sha256(stableJson({
      branch: visible.branch,
      head: visible.head,
      entries: visible.entries,
      excludedStateSha256: visible.excludedStateSha256,
    })),
  );

  const boundary = await RepositoryBoundary.create(fixture.root);
  const hiddenInspector = new GitInspector(boundary, {
    isPathAllowed: () => false,
  });
  const hidden = await hiddenInspector.status();
  const hiddenInternals = hiddenInspector as unknown as {
    integritySensitiveStateSha256(): Promise<string>;
    gitControlStateSha256(): Promise<string>;
  };
  const [protectedStateSha256, gitControlStateSha256] = await Promise.all([
    hiddenInternals.integritySensitiveStateSha256(),
    hiddenInternals.gitControlStateSha256(),
  ]);
  const expectedExcluded = sha256(stableJson({
    policyHiddenEntries: visible.entries,
    protectedStateSha256,
    gitControlStateSha256,
  }));
  assert.deepEqual(hidden.entries, []);
  assert.equal(hidden.excludedCount, mixedPaths.length);
  assert.equal(hidden.excludedStateSha256, expectedExcluded);
  assert.equal(
    hidden.snapshotSha256,
    sha256(stableJson({
      branch: hidden.branch,
      head: hidden.head,
      entries: [],
      excludedStateSha256: expectedExcluded,
    })),
  );
});

test("live observer classifies create, update, and delete with deterministic line facts", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const baseline = emptyBaseline();
  const pre = await fixture.observer.capturePre(baseline);
  await writeFile(path.join(fixture.root, "README.md"), "one\ntwo changed\n");
  await writeFile(path.join(fixture.root, "created.txt"), "created\n");
  await rm(path.join(fixture.root, "delete.txt"));
  const post = await fixture.observer.capturePost(pre);
  const effect = await fixture.observer.compare(pre, post, baseline);

  assert.equal(effect.outcome, "observed");
  assert.deepEqual(effect.paths.created, ["created.txt"]);
  assert.deepEqual(effect.paths.updated, ["README.md"]);
  assert.deepEqual(effect.paths.deleted, ["delete.txt"]);
  assert.equal(effect.changedFiles, 3);
  assert.equal(effect.changedLines > 0, true);
  assert.equal(effect.repositoryFingerprint, post.repositoryFingerprint);
  assert.deepEqual(effect.postObservationControl, {
    branch: post.branch,
    head: post.head,
    excludedStateFingerprint: post.components?.excluded,
  });
});

test("live observer reports staged index and HEAD transitions as attributable", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const baseline = emptyBaseline();
  const pre = await fixture.observer.capturePre(baseline);
  await writeFile(path.join(fixture.root, "README.md"), "committed transition\n");
  await git(fixture.root, ["add", "--", "README.md"]);
  await git(fixture.root, [
    "-c",
    "user.name=Cope Test",
    "-c",
    "user.email=cope@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "transition",
  ]);
  const post = await fixture.observer.capturePost(pre);
  const effect = await fixture.observer.compare(pre, post, baseline);

  assert.equal(post.state, "complete");
  assert.equal(effect.outcome, "observed");
  assert.deepEqual(effect.paths.updated, ["README.md"]);
  assert.equal(post.transitionPaths.paths.includes("README.md"), true);
});

test("live observer attributes staged-only changes and a command that cleans them", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const baseline = emptyBaseline();
  const clean = await fixture.observer.capturePre(baseline);
  await writeFile(path.join(fixture.root, "README.md"), "staged content\n");
  await git(fixture.root, ["add", "--", "README.md"]);
  const staged = await fixture.observer.capturePost(clean);
  const stagedEffect = await fixture.observer.compare(clean, staged, baseline);
  assert.equal(stagedEffect.outcome, "observed");
  assert.deepEqual(stagedEffect.paths.updated, ["README.md"]);
  assert.equal(stagedEffect.changedLines > 0, true);

  const preClean = await fixture.observer.capturePre(baseline);
  await git(fixture.root, ["reset", "--hard", "HEAD"]);
  const cleaned = await fixture.observer.capturePost(preClean);
  const cleanedEffect = await fixture.observer.compare(
    preClean,
    cleaned,
    baseline,
  );
  assert.equal(cleanedEffect.outcome, "observed");
  assert.deepEqual(cleanedEffect.paths.updated, ["README.md"]);
  assert.equal(cleanedEffect.changedLines > 0, true);
});

test("live observer inventories an unborn repository's initial clean commit", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cope-observer-unborn-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "--quiet"]);
  const boundary = await RepositoryBoundary.create(root);
  const inspector = new GitInspector(boundary);
  const observer = new LiveWorkspaceObserver(boundary, inspector);
  const pre = await observer.capturePre(emptyBaseline());
  assert.equal(pre.head, null);
  await writeFile(path.join(root, "first.txt"), "first\n");
  await git(root, ["add", "--", "first.txt"]);
  await git(root, [
    "-c",
    "user.name=Cope Test",
    "-c",
    "user.email=cope@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "first",
  ]);
  const post = await observer.capturePost(pre);
  const effect = await observer.compare(pre, post, emptyBaseline());
  assert.notEqual(post.state, "unknown");
  if (post.state === "unknown") throw new Error("Post-observation is incomplete");
  assert.deepEqual(post.transitionPaths.paths, ["first.txt"]);
  assert.deepEqual(effect.paths.created, ["first.txt"]);
  assert.equal(effect.outcome, "observed");
});

test("live observer treats policy-hidden and nested repository drift as non-clean", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const baseline = emptyBaseline();
  const pre = await fixture.observer.capturePre(baseline);
  await writeFile(path.join(fixture.root, ".env"), "TOKEN=hidden\n");
  const hiddenPost = await fixture.observer.capturePost(pre);
  const hiddenEffect = await fixture.observer.compare(pre, hiddenPost, baseline);
  assert.equal(hiddenPost.state, "protected_or_hidden_changed");
  assert.equal(hiddenEffect.outcome, "protected_or_hidden_changed");

  await rm(path.join(fixture.root, ".env"));
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, [
    "init",
    "--quiet",
    path.join(fixture.root, "nested"),
  ]);
  const nestedPost = await fixture.observer.capturePost(pre);
  assert.equal(nestedPost.state, "protected_or_hidden_changed");
  assert.equal(nestedPost.nestedRepository, "present");
});

test("nested scan-cap exhaustion is metadata-limited for launch and unknown for attribution", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const boundary = await RepositoryBoundary.create(fixture.root);
  const observer = new LiveWorkspaceObserver(boundary, fixture.git, {
    nestedScanMaxEntries: 1,
  });
  const baseline = emptyBaseline();
  const pre = await observer.capturePre(baseline);
  assert.equal(pre.state, "metadata_limited");
  assert.equal(pre.nestedRepository, "unknown");
  assert.equal(
    pre.limitationCodes.includes(
      "NESTED_REPOSITORY_SCAN_BOUND_EXCEEDED",
    ),
    true,
  );
  assert.equal(isWorkspaceObservation(pre), true);

  await writeFile(path.join(fixture.root, "after-bound.txt"), "changed\n");
  const post = await observer.capturePost(pre);
  const effect = await observer.compare(pre, post, baseline);
  assert.equal(post.state, "metadata_limited");
  assert.equal(post.nestedRepository, "unknown");
  assert.equal(
    post.limitationCodes.includes(
      "NESTED_REPOSITORY_SCAN_BOUND_EXCEEDED",
    ),
    true,
  );
  assert.equal(effect.outcome, "unknown");
  assert.equal(effect.repositoryFingerprint, undefined);
});

test("an enumerated nested marker wins at the scan boundary while an unvisited marker remains bounded", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const boundary = await RepositoryBoundary.create(fixture.root);
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, [
    "init",
    "--quiet",
    path.join(fixture.root, "nested-low-bound"),
  ]);
  const rootEntryCount = (await readdir(fixture.root)).length;
  const observer = new LiveWorkspaceObserver(boundary, fixture.git, {
    // The root consumes the exact bound. The nested .git marker is the next
    // enumerated child and must win before exhaustion is returned.
    nestedScanMaxEntries: rootEntryCount,
  });
  const pre = await observer.capturePre(emptyBaseline());
  assert.equal(pre.state, "protected_or_hidden_changed");
  assert.equal(pre.nestedRepository, "present");
  assert.equal(
    pre.limitationCodes.includes("NESTED_REPOSITORY_PRESENT"),
    true,
  );
  assert.equal(
    pre.limitationCodes.includes(
      "NESTED_REPOSITORY_SCAN_BOUND_EXCEEDED",
    ),
    false,
  );

  const boundedObserver = new LiveWorkspaceObserver(boundary, fixture.git, {
    // Exhaust inside the root enumeration, before the queued nested directory
    // is visited. Its marker is therefore genuinely unobserved.
    nestedScanMaxEntries: rootEntryCount - 1,
  });
  const boundedPre = await boundedObserver.capturePre(emptyBaseline());
  assert.equal(boundedPre.state, "metadata_limited");
  assert.equal(boundedPre.nestedRepository, "unknown");
  assert.equal(
    boundedPre.limitationCodes.includes(
      "NESTED_REPOSITORY_SCAN_BOUND_EXCEEDED",
    ),
    true,
  );
});

test("live observer content-binds a pre-existing dirty path hidden only by policy", async (context) => {
  const fixture = await createRepositoryFixture(context, {
    isPathAllowed: (candidate) => candidate !== "policy-hidden.txt",
  });
  await writeFile(path.join(fixture.root, "policy-hidden.txt"), "committed\n");
  await git(fixture.root, ["add", "--", "policy-hidden.txt"]);
  await git(fixture.root, [
    "-c",
    "user.name=Cope Test",
    "-c",
    "user.email=cope@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "hidden baseline",
  ]);
  await writeFile(path.join(fixture.root, "policy-hidden.txt"), "dirty-one\n");
  const pre = await fixture.observer.capturePre(emptyBaseline());
  await writeFile(path.join(fixture.root, "policy-hidden.txt"), "dirty-two\n");
  const post = await fixture.observer.capturePost(pre);
  const effect = await fixture.observer.compare(pre, post, emptyBaseline());
  assert.equal(post.state, "protected_or_hidden_changed");
  assert.equal(effect.outcome, "protected_or_hidden_changed");
});

test("live observer never retains or classifies policy-hidden clean HEAD transitions", async (context) => {
  const hiddenPath = "policy-hidden.txt";
  const fixture = await createRepositoryFixture(context, {
    isPathAllowed: (candidate) => candidate !== hiddenPath,
  });
  await writeFile(path.join(fixture.root, hiddenPath), "hidden baseline\n");
  await git(fixture.root, ["add", "--", hiddenPath]);
  await git(fixture.root, [
    "-c",
    "user.name=Cope Test",
    "-c",
    "user.email=cope@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "hidden baseline",
  ]);

  const pre = await fixture.observer.capturePre(emptyBaseline());
  await writeFile(path.join(fixture.root, hiddenPath), "hidden transition\n");
  await writeFile(path.join(fixture.root, "README.md"), "visible transition\n");
  await git(fixture.root, ["add", "--", hiddenPath, "README.md"]);
  await git(fixture.root, [
    "-c",
    "user.name=Cope Test",
    "-c",
    "user.email=cope@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "mixed policy transition",
  ]);

  const post = await fixture.observer.capturePost(pre);
  assert.equal(post.state, "protected_or_hidden_changed");
  assert.deepEqual(post.transitionPaths.paths, ["README.md"]);
  assert.equal(post.transitionPaths.total, 1);
  assert.equal(post.transitionPaths.omitted, 0);
  assert.equal(post.limitationCodes.includes("POLICY_HIDDEN_TRANSITION"), true);
  assert.notEqual(post.components?.excluded, pre.components?.excluded);
  assert.equal(JSON.stringify(post).includes(hiddenPath), false);

  const effect = await fixture.observer.compare(pre, post, emptyBaseline());
  assert.equal(effect.outcome, "protected_or_hidden_changed");
  assert.equal(JSON.stringify(effect).includes(hiddenPath), false);
});

test("live observer bounds ignored summaries and separates Git control drift", async (context) => {
  const fixture = await createRepositoryFixture(context);
  await writeFile(path.join(fixture.root, ".gitignore"), "*.ignored\n");
  await git(fixture.root, ["add", "--", ".gitignore"]);
  await git(fixture.root, [
    "-c",
    "user.name=Cope Test",
    "-c",
    "user.email=cope@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "ignore rule",
  ]);
  const pre = await fixture.observer.capturePre(emptyBaseline());
  await writeFile(path.join(fixture.root, "output.ignored"), "build output\n");
  const ignoredPost = await fixture.observer.capturePost(pre);
  const ignoredEffect = await fixture.observer.compare(
    pre,
    ignoredPost,
    emptyBaseline(),
  );
  assert.notEqual(ignoredPost.state, "unknown");
  if (ignoredPost.state === "unknown") {
    throw new Error("Ignored observation is incomplete");
  }
  assert.equal(ignoredPost.ignoredCount, 1);
  assert.equal(ignoredPost.ignoredSummaryTruncated, false);
  assert.equal(ignoredEffect.outcome, "none");

  await git(fixture.root, ["config", "cope.observer-test", "changed"]);
  const controlPost = await fixture.observer.capturePost(ignoredPost);
  const controlEffect = await fixture.observer.compare(
    ignoredPost,
    controlPost,
    emptyBaseline(),
  );
  assert.equal(controlPost.state, "protected_or_hidden_changed");
  assert.equal(controlEffect.outcome, "protected_or_hidden_changed");
});

test("live observer refuses unsafe visible identity prelaunch and reports it unknown postlaunch", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const pre = await fixture.observer.capturePre(emptyBaseline());
  try {
    await symlink("README.md", path.join(fixture.root, "linked.txt"));
  } catch (error) {
    if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      context.skip("Host account cannot create symbolic links");
      return;
    }
    throw error;
  }
  const post = await fixture.observer.capturePost(pre);
  assert.equal(post.state, "unknown");
  assert.equal(post.limitationCodes.includes("OBSERVATION_INSUFFICIENT"), true);
  await assert.rejects(
    fixture.observer.capturePre(emptyBaseline()),
    /stable reconstructible state|safely observable regular file/iu,
  );
});

test("live pre-observation refuses non-reconstructible session-start bytes but permits identity-only task state", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const largePath = path.join(fixture.root, "large.bin");
  await writeFile(largePath, Buffer.alloc(1024 * 1024 + 1, 1));
  const unavailable: SessionPreExistingBaseline = {
    paths: ["large.bin"],
    hasReconstructibleBaseline: async () => false,
  };
  await assert.rejects(
    fixture.observer.capturePre(unavailable),
    /reconstructible prelaunch baseline/iu,
  );

  const pre = await fixture.observer.capturePre(emptyBaseline());
  assert.equal(pre.state, "complete");
  assert.equal(
    pre.beforeImages.some(
      (image) =>
        image.kind === "identity_only" &&
        image.identity.path === "large.bin",
    ),
    true,
  );
  const post = await fixture.observer.capturePost(pre);
  const effect = await fixture.observer.compare(pre, post, emptyBaseline());
  assert.equal(effect.outcome, "none");
});

test("live pre-observation refuses a disappeared session-start path unless its baseline is reconstructible", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const userWorkPath = path.join(fixture.root, "disappeared-user-work.txt");
  await writeFile(userWorkPath, "untracked session-start work\n");
  await rm(userWorkPath);
  let checks = 0;
  const unavailable: SessionPreExistingBaseline = {
    paths: ["disappeared-user-work.txt"],
    hasReconstructibleBaseline: async () => {
      checks += 1;
      return false;
    },
  };
  await assert.rejects(
    fixture.observer.capturePre(unavailable),
    /reconstructible prelaunch baseline/iu,
  );
  assert.equal(checks > 0, true);

  const reconstructible: SessionPreExistingBaseline = {
    paths: ["disappeared-user-work.txt"],
    hasReconstructibleBaseline: async () => true,
  };
  const pre = await fixture.observer.capturePre(reconstructible);
  assert.equal(pre.state, "complete");
  assert.deepEqual(pre.beforeImages, [{
    kind: "absent",
    exists: false,
    path: "disappeared-user-work.txt",
  }]);
});

test("live pre-observation authenticates an oversized untracked blob already in the object database", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const existingPath = "large-odb.bin";
  await writeFile(
    path.join(fixture.root, existingPath),
    Buffer.alloc(1024 * 1024 + 1, 23),
  );
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, [
    "-C",
    fixture.root,
    "hash-object",
    "-w",
    "--no-filters",
    "--",
    existingPath,
  ]);
  const baseline: SessionPreExistingBaseline = {
    paths: [existingPath],
    hasReconstructibleBaseline: async () => false,
  };
  const pre = await fixture.observer.capturePre(baseline);
  assert.equal(pre.state, "complete");
  const image = pre.beforeImages.find(
    (value) =>
      value.kind === "git_blob" &&
      value.identity.path === existingPath,
  );
  assert.equal(image?.kind, "git_blob");
  if (image?.kind !== "git_blob") throw new Error("ODB image was not retained");
  assert.equal(image.blobRole, "odb");
  assert.equal(isWorkspaceObservation(pre), true);

  const missingPath = "large-missing-odb.bin";
  await writeFile(
    path.join(fixture.root, missingPath),
    Buffer.alloc(1024 * 1024 + 1, 24),
  );
  await assert.rejects(
    fixture.observer.capturePre({
      paths: [missingPath],
      hasReconstructibleBaseline: async () => false,
    }),
    /reconstructible prelaunch baseline/iu,
  );
});

test("live pre-observation uses the repository object format for SHA-256 ODB evidence", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cope-observer-sha256-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  try {
    await git(root, ["init", "--quiet", "--object-format=sha256"]);
  } catch {
    context.skip("Installed Git does not support SHA-256 repositories");
    return;
  }
  await writeFile(path.join(root, "README.md"), "sha256 repository\n");
  await git(root, ["add", "--", "README.md"]);
  await git(root, [
    "-c",
    "user.name=Cope Test",
    "-c",
    "user.email=cope@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "initial",
  ]);
  const relativePath = "large-sha256-odb.bin";
  await writeFile(
    path.join(root, relativePath),
    Buffer.alloc(1024 * 1024 + 1, 31),
  );
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, [
    "-C",
    root,
    "hash-object",
    "-w",
    "--no-filters",
    "--",
    relativePath,
  ]);
  const boundary = await RepositoryBoundary.create(root);
  const observer = new LiveWorkspaceObserver(
    boundary,
    new GitInspector(boundary),
  );
  const pre = await observer.capturePre({
    paths: [relativePath],
    hasReconstructibleBaseline: async () => false,
  });
  assert.equal(pre.state, "complete");
  const image = pre.beforeImages.find(
    (value) =>
      value.kind === "git_blob" &&
      value.identity.path === relativePath,
  );
  assert.equal(image?.kind, "git_blob");
  if (image?.kind !== "git_blob") {
    throw new Error("SHA-256 ODB image was not retained");
  }
  assert.equal(image.blobRole, "odb");
  assert.equal(image.blob.length, 64);
});

test("live observer conservatively verifies a staged rename", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const baseline = emptyBaseline();
  const pre = await fixture.observer.capturePre(baseline);
  await git(fixture.root, ["mv", "--", "README.md", "Renamed.md"]);
  const post = await fixture.observer.capturePost(pre);
  const liveEffect = await fixture.observer.compare(pre, post, baseline);
  assert.deepEqual(liveEffect.paths.renamed, [
    { from: "README.md", to: "Renamed.md" },
  ]);
  const comparisonBoundary = await RepositoryBoundary.create(fixture.root);
  const comparisonObserver = new LiveWorkspaceObserver(
    comparisonBoundary,
    new GitInspector(comparisonBoundary),
  );
  const effect = await comparisonObserver.compare(
    pre,
    withWindowsWorktreeMode(post),
    baseline,
  );
  assert.equal(effect.outcome, "observed");
  assert.deepEqual(effect.paths.renamed, [
    { from: "README.md", to: "Renamed.md" },
  ]);
  assert.equal(effect.paths.createdTotal, 0);
  assert.equal(effect.paths.deletedTotal, 0);

  const contentMismatch = withRenamedEntry(post, (entry) =>
    entry.worktreeIdentity === undefined
      ? entry
      : {
          ...entry,
          worktreeIdentity: {
            ...entry.worktreeIdentity,
            contentSha256: "f".repeat(64),
            mode: 0o100666,
          },
        });
  assert.deepEqual(
    (
      await comparisonObserver.compare(pre, contentMismatch, baseline)
    ).paths.renamed,
    [],
  );

  const modeMismatch = withRenamedEntry(post, (entry) =>
    entry.worktreeIdentity === undefined
      ? entry
      : {
          ...entry,
          worktreeMode: "100755",
          worktreeIdentity: {
            ...entry.worktreeIdentity,
            mode: 0o100777,
          },
        });
  assert.deepEqual(
    (
      await comparisonObserver.compare(pre, modeMismatch, baseline)
    ).paths.renamed,
    [],
  );
});

test("live observer uses boundary path identity for a case-only rename", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const rootState = await lstat(fixture.root);
  const boundary = await RepositoryBoundary.create(
    fixture.root,
    createFilesystemIdentity({
      device: rootState.dev,
      caseSensitive: false,
      unicodeNormalizationAliases: false,
    }),
  );
  const inspector = new GitInspector(boundary);
  const observer = new LiveWorkspaceObserver(boundary, inspector);
  const pre = await observer.capturePre(emptyBaseline());
  await git(fixture.root, ["mv", "--", "README.md", "readme.md"]);
  const post = await observer.capturePost(pre);
  const liveEffect = await observer.compare(pre, post, emptyBaseline());
  assert.deepEqual(liveEffect.paths.renamed, [
    { from: "README.md", to: "readme.md" },
  ]);
  const comparisonObserver = new LiveWorkspaceObserver(boundary, inspector);
  const effect = await comparisonObserver.compare(
    pre,
    withWindowsWorktreeMode(post),
    emptyBaseline(),
  );
  assert.deepEqual(effect.paths.renamed, [
    { from: "README.md", to: "readme.md" },
  ]);
});

test("live observer merges HEAD transitions in Git raw UTF-8 byte order", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const pre = await fixture.observer.capturePre(emptyBaseline());
  const bmpPath = "\uE000.txt";
  const astralPath = "\u{10000}.txt";
  await writeFile(path.join(fixture.root, bmpPath), "bmp\n");
  await writeFile(path.join(fixture.root, astralPath), "astral\n");
  await git(fixture.root, ["add", "--", bmpPath, astralPath]);
  await git(fixture.root, [
    "-c",
    "user.name=Cope Test",
    "-c",
    "user.email=cope@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "unicode path order",
  ]);
  const post = await fixture.observer.capturePost(pre);
  assert.equal(post.state, "complete");
  assert.equal(post.limitationCodes.includes("OBSERVATION_CHURN"), false);
  assert.deepEqual(post.transitionPaths.paths, [bmpPath, astralPath]);
  const effect = await fixture.observer.compare(pre, post, emptyBaseline());
  assert.equal(effect.outcome, "observed");
  assert.deepEqual(effect.paths.created, [bmpPath, astralPath]);
});

test("live observer retries one stable-boundary race and degrades persistent post churn", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const boundary = await RepositoryBoundary.create(fixture.root);
  const retryingInspector = new ChurningStatusInspector(boundary, false);
  const retryingObserver = new LiveWorkspaceObserver(boundary, retryingInspector);
  const pre = await retryingObserver.capturePre(emptyBaseline());
  assert.equal(pre.state, "complete");
  assert.equal(retryingInspector.statusCalls, 4);

  const stableInspector = new GitInspector(boundary);
  const stableObserver = new LiveWorkspaceObserver(boundary, stableInspector);
  const stablePre = await stableObserver.capturePre(emptyBaseline());
  const churningObserver = new LiveWorkspaceObserver(
    boundary,
    new ChurningStatusInspector(boundary, true),
  );
  const post = await churningObserver.capturePost(stablePre);
  assert.equal(post.state, "unknown");
  assert.deepEqual(post.limitationCodes, ["OBSERVATION_CHURN"]);
});

test("observation cancellation refuses prelaunch while post-observation owns a fresh deadline", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    fixture.observer.capturePre(emptyBaseline(), cancelled.signal),
    /bounded deadline/iu,
  );
  const pre = await fixture.observer.capturePre(emptyBaseline());
  const post = await fixture.observer.capturePost(pre, cancelled.signal);
  assert.equal(post.state, "complete");
});

test("compare-time immutable reads abort on their internal deadline and return a bounded outcome", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const pre = await fixture.observer.capturePre(emptyBaseline());
  await writeFile(path.join(fixture.root, "README.md"), "deadline change\n");
  const post = await fixture.observer.capturePost(pre);
  const boundary = await RepositoryBoundary.create(fixture.root);
  const slowInspector = new SlowCompareInspector(boundary);
  const observer = new LiveWorkspaceObserver(boundary, slowInspector, {
    compareTimeoutMs: 25,
  });
  const started = Date.now();
  const effect = await observer.compare(pre, post, emptyBaseline());
  assert.equal(effect.outcome, "unknown");
  assert.equal(effect.limitationCodes.includes("COMPARE_TIMEOUT"), true);
  assert.equal(effect.repositoryFingerprint, undefined);
  assert.equal(slowInspector.sawAbort, true);
  assert.equal(Date.now() - started < 1_000, true);
});

test("live observer caps aggregate retained bytes and makes a changed identity-only path non-clean", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const content = Buffer.alloc(900 * 1024, 1);
  for (let index = 0; index < 4; index += 1) {
    await writeFile(path.join(fixture.root, `large-${index}.bin`), content);
  }
  const baseline = emptyBaseline();
  const pre = await fixture.observer.capturePre(baseline);
  assert.notEqual(pre.state, "unknown");
  if (pre.state === "unknown") throw new Error("Pre-observation is incomplete");
  const retainedBytes = pre.beforeImages.reduce(
    (total, image) =>
      total +
      (image.kind === "retained"
        ? Buffer.from(image.contentBase64, "base64").length
        : 0),
    0,
  );
  assert.equal(retainedBytes <= 3 * 1024 * 1024, true);
  assert.equal(
    pre.beforeImages.some(
      (image) =>
        image.kind === "identity_only" &&
        image.identity.path === "large-3.bin",
    ),
    true,
  );

  await writeFile(
    path.join(fixture.root, "large-3.bin"),
    Buffer.alloc(900 * 1024, 2),
  );
  const post = await fixture.observer.capturePost(pre);
  const effect = await fixture.observer.compare(pre, post, baseline);
  assert.equal(effect.outcome, "unknown");
  assert.equal(effect.unavailableBaselineCount, 1);
  assert.equal(effect.repositoryFingerprint, undefined);
  assert.equal(effect.postObservationControl, undefined);
  assert.equal(effect.limitationCodes.includes("CHANGED_BASELINE_UNAVAILABLE"), true);
});

test("live observer degrades oversized porcelain input to metadata-limited evidence", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cope-observer-porcelain-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "--quiet"]);
  const boundary = await RepositoryBoundary.create(root);
  const inspector = new OversizedPorcelainInspector(boundary);
  const observer = new LiveWorkspaceObserver(boundary, inspector);
  const pre = await observer.capturePre(emptyBaseline());
  assert.equal(pre.state, "metadata_limited");
  assert.equal(pre.repositoryFingerprint, undefined);
  assert.equal(
    pre.limitationCodes.includes("PORCELAIN_STATUS_BOUND_EXCEEDED"),
    true,
  );
});

test("live observer streams and truncates a large clean HEAD transition with exact totals and digest", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const pre = await fixture.observer.capturePre(emptyBaseline());
  const transitionPaths = Array.from(
    { length: 2_055 },
    (_, index) => `transition-${String(index).padStart(4, "0")}.txt`,
  );
  for (let offset = 0; offset < transitionPaths.length; offset += 128) {
    await Promise.all(
      transitionPaths.slice(offset, offset + 128).map((relativePath) =>
        writeFile(path.join(fixture.root, relativePath), `${relativePath}\n`)),
    );
  }
  await git(fixture.root, ["add", "--", "."]);
  await git(fixture.root, [
    "-c",
    "user.name=Cope Test",
    "-c",
    "user.email=cope@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "large transition",
  ]);
  const post = await fixture.observer.capturePost(pre);
  assert.equal(post.state, "complete");
  assert.equal(post.transitionPaths.total, transitionPaths.length);
  assert.equal(post.transitionPaths.paths.length, 2_048);
  assert.equal(post.transitionPaths.omitted, 7);
  assert.equal(post.transitionPaths.truncated, true);
  assert.equal(
    post.transitionPaths.completeFactsSha256,
    sha256(stableJson(transitionPaths)),
  );
  assert.equal(
    post.limitationCodes.includes("TRANSITION_PATHS_TRUNCATED"),
    true,
  );
  const effect = await fixture.observer.compare(pre, post, emptyBaseline());
  assert.equal(effect.outcome, "unknown");
  assert.equal(effect.unavailableBaselineCount, 7);
  assert.equal(effect.paths.createdTotal, transitionPaths.length);
  assert.equal(effect.paths.updatedTotal, 0);
  assert.equal(effect.paths.deletedTotal, 0);
  assert.equal(effect.paths.renamedTotal, 0);
  assert.equal(effect.paths.endpointTotal, transitionPaths.length);
  assert.equal(effect.paths.created.length, 2_048);
  assert.equal(effect.paths.omittedEndpointTotal, 7);
  assert.equal(effect.paths.truncated, true);
  const completeFacts = createWorkspacePathFacts({
    created: transitionPaths,
    updated: [],
    deleted: [],
    renamed: [],
    preExistingTouched: [],
  });
  assert.equal(
    effect.paths.completeFactsSha256,
    completeFacts.completeFactsSha256,
  );
  assert.equal(effect.changedFiles, transitionPaths.length);
  assert.equal(effect.repositoryFingerprint, undefined);
});

test("streaming isolated Git reads terminate and clean their view when a record consumer throws", async (context) => {
  const fixture = await createRepositoryFixture(context);
  await writeFile(path.join(fixture.root, "README.md"), "changed\n");
  const before = await isolatedViewDirectories();
  await assert.rejects(
    fixture.git.readIsolatedNul(
      ["diff", "--name-only", "-z", "HEAD", "--"],
      32_768,
      () => {
        throw new Error("stop transition consumption");
      },
    ),
    /stop transition consumption/iu,
  );
  assert.deepEqual(await isolatedViewDirectories(), before);
  assert.equal((await fixture.git.status()).entries.length, 1);
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

function withWindowsWorktreeMode(
  observation: WorkspaceObservation,
): WorkspaceObservation {
  return withRenamedEntry(observation, (entry) =>
    entry.worktreeIdentity === undefined
      ? entry
      : {
          ...entry,
          worktreeIdentity: {
            ...entry.worktreeIdentity,
            mode: 0o100666,
          },
        });
}

function withRenamedEntry(
  observation: WorkspaceObservation,
  update: (entry: GitObservationEntry) => GitObservationEntry,
): WorkspaceObservation {
  if (observation.state === "unknown") return observation;
  return {
    ...observation,
    entries: observation.entries.map((entry) =>
      entry.kind === "renamed" ? update(entry) : entry),
  };
}

async function createRepositoryFixture(
  context: { after(callback: () => Promise<void>): void },
  inspectorOptions: ConstructorParameters<typeof GitInspector>[1] = {},
): Promise<{
  readonly root: string;
  readonly git: GitInspector;
  readonly observer: LiveWorkspaceObserver;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cope-observer-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "--quiet"]);
  await writeFile(path.join(root, "README.md"), "one\ntwo\n");
  await writeFile(path.join(root, "delete.txt"), "delete me\n");
  await git(root, ["add", "--", "README.md", "delete.txt"]);
  await git(root, [
    "-c",
    "user.name=Cope Test",
    "-c",
    "user.email=cope@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "initial",
  ]);
  const boundary = await RepositoryBoundary.create(root);
  const inspector = new GitInspector(boundary, inspectorOptions);
  return {
    root,
    git: inspector,
    observer: new LiveWorkspaceObserver(boundary, inspector),
  };
}

async function git(root: string, args: readonly string[]): Promise<void> {
  await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", root, ...args]);
}

function emptyBaseline(): SessionPreExistingBaseline {
  return {
    paths: [],
    hasReconstructibleBaseline: async () => false,
  };
}

class OversizedPorcelainInspector extends GitInspector {
  public override async readIsolated(
    fixedArguments: readonly string[],
    maxBytes: number,
    signal?: AbortSignal,
    allowTruncation = false,
  ): Promise<IsolatedGitReadResult> {
    if (fixedArguments[0] !== "status") {
      return super.readIsolated(
        fixedArguments,
        maxBytes,
        signal,
        allowTruncation,
      );
    }
    const prefix = Buffer.from(
      "# branch.oid (initial)\0# branch.head main\0",
      "utf8",
    );
    return {
      bytes: Buffer.concat([
        prefix,
        Buffer.alloc(Math.max(0, maxBytes - prefix.length), 120),
      ]),
      truncated: true,
      branch: "main",
      head: null,
    };
  }
}

class ChurningStatusInspector extends GitInspector {
  public statusCalls = 0;

  public constructor(
    boundary: RepositoryBoundary,
    private readonly alwaysChurn: boolean,
  ) {
    super(boundary);
  }

  public override async status(signal?: AbortSignal): Promise<GitStatusResult> {
    const status = await super.status(signal);
    this.statusCalls += 1;
    if (!this.alwaysChurn && this.statusCalls !== 1) return status;
    return {
      ...status,
      snapshotSha256: sha256(
        `${status.snapshotSha256}:${String(this.statusCalls)}`,
      ),
    };
  }
}

class SlowCompareInspector extends GitInspector {
  public sawAbort = false;

  public override async readIsolatedNul(
    fixedArguments: readonly string[],
    maxRecordBytes: number,
    onRecord: (record: Buffer) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<IsolatedGitNulReadResult> {
    if (fixedArguments[0] !== "ls-tree") {
      return super.readIsolatedNul(
        fixedArguments,
        maxRecordBytes,
        onRecord,
        signal,
      );
    }
    await new Promise<void>((_resolve, reject) => {
      const abort = (): void => {
        this.sawAbort = true;
        const error = new Error("slow compare read aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (signal?.aborted === true) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
    throw new Error("unreachable slow compare read");
  }
}

async function isolatedViewDirectories(): Promise<readonly string[]> {
  return (await readdir(os.tmpdir()))
    .filter((entry) => entry.startsWith("cba-git-view-"))
    .sort();
}
