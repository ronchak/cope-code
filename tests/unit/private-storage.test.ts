import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentError } from "../../src/shared/errors.js";
import { DarwinHostPlatform } from "../../src/platform/darwin.js";
import {
  preparePrivateStateHome,
  verifyDarwinDedicatedProfileRoot,
  verifyDarwinPrivateStateHome,
} from "../../src/platform/private-storage.js";

const host = new DarwinHostPlatform();
const darwinOnly = { skip: process.platform !== "darwin" };

test("Darwin state storage requires exact private ownership and modes", darwinOnly, async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cope-private-state-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const stateHome = await preparePrivateStateHome(path.join(temporary, "state"), host);
  await mkdir(path.join(stateHome, "sessions"), { mode: 0o700 });
  await writeFile(path.join(stateHome, "sessions", "record.json"), "{}\n", { mode: 0o600 });
  await verifyDarwinPrivateStateHome(stateHome);
  assert.equal((await stat(stateHome)).mode & 0o777, 0o700);

  await chmod(path.join(stateHome, "sessions", "record.json"), 0o644);
  await assert.rejects(
    verifyDarwinPrivateStateHome(stateHome),
    (error: unknown) =>
      error instanceof AgentError &&
      error.details.diagnosticCode === "DARWIN_PRIVATE_STATE_UNSAFE" &&
      error.details.observedMode === "644",
  );
});

test("Darwin private storage refuses broad roots, links, and unbounded trees", darwinOnly, async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cope-private-unsafe-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const broad = path.join(temporary, "broad");
  await mkdir(broad, { mode: 0o700 });
  await chmod(broad, 0o755);
  await assert.rejects(verifyDarwinPrivateStateHome(broad), /permissions are broader/u);

  const linked = path.join(temporary, "linked");
  await mkdir(linked, { mode: 0o700 });
  const outside = path.join(temporary, "outside");
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, path.join(linked, "escape"));
  await assert.rejects(verifyDarwinPrivateStateHome(linked), /must not contain links/u);

  const bounded = path.join(temporary, "bounded");
  await mkdir(bounded, { mode: 0o700 });
  await writeFile(path.join(bounded, "one"), "1", { mode: 0o600 });
  await writeFile(path.join(bounded, "two"), "2", { mode: 0o600 });
  await assert.rejects(
    verifyDarwinPrivateStateHome(bounded, 1),
    (error: unknown) => error instanceof AgentError && error.code === "BUDGET_EXCEEDED",
  );
});

test("Darwin profile verifies its private root and Cope files without imposing modes on Edge data", darwinOnly, async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cope-private-profile-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const profile = path.join(temporary, "profile");
  await mkdir(path.join(profile, "Default"), { recursive: true, mode: 0o700 });
  await chmod(profile, 0o700);
  await chmod(path.join(profile, "Default"), 0o755);
  await writeFile(path.join(profile, "Default", "Preferences"), "{}", { mode: 0o644 });
  await writeFile(path.join(profile, ".copilot-agent-profile.lock"), "{}", { mode: 0o600 });
  await writeFile(path.join(profile, ".copilot-agent-profile-v1.json"), "{}", { mode: 0o600 });
  await verifyDarwinDedicatedProfileRoot(profile);

  await chmod(path.join(profile, ".copilot-agent-profile-v1.json"), 0o644);
  await assert.rejects(
    verifyDarwinDedicatedProfileRoot(profile),
    (error: unknown) =>
      error instanceof AgentError && error.details.diagnosticCode === "DARWIN_PRIVATE_PROFILE_UNSAFE",
  );
});
