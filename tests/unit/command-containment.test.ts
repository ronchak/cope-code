import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { UnsupportedHostPlatform } from "../../src/platform/index.js";
import { RepositoryBoundary } from "../../src/repository/boundary.js";
import { CommandCatalog } from "../../src/tools/command-catalog.js";
import {
  COMMAND_CONTAINMENT_PROFILE_VERSION,
  BubblewrapContainmentBackend,
  SeatbeltContainmentBackend,
  type CommandContainmentBackend,
  type ContainmentLaunchRequest,
  type CommandContainmentProfile,
} from "../../src/tools/command-containment.js";
import { ProcessRunner } from "../../src/tools/process-runner.js";

const denyProfile: CommandContainmentProfile = {
  version: COMMAND_CONTAINMENT_PROFILE_VERSION,
  filesystem: { repository: "read-only", system: "read-only", temporary: "deny" },
  network: { mode: "deny" },
};

test("platform backends encode repository and network denial in their launch boundary", async () => {
  const request: ContainmentLaunchRequest = {
    profile: denyProfile,
    executable: process.execPath,
    arguments: ["--version"],
    repositoryRoot: "/workspace/repository",
    workingDirectory: "/workspace/repository",
  };
  const bubblewrap = await new BubblewrapContainmentBackend([process.execPath]).prepare(request);
  assert.equal(bubblewrap.arguments.includes("--unshare-net"), true);
  assert.deepEqual(
    bubblewrap.arguments.slice(bubblewrap.arguments.indexOf("--ro-bind", 5), bubblewrap.arguments.indexOf("--ro-bind", 5) + 3),
    ["--ro-bind", "/workspace/repository", "/workspace/repository"],
  );

  const seatbelt = await new SeatbeltContainmentBackend([process.execPath]).prepare(request);
  const profile = seatbelt.arguments[1] ?? "";
  assert.match(profile, /\(deny file-write\*\)/u);
  assert.match(profile, /\(deny network\*\)/u);
  assert.doesNotMatch(profile, /allow file-write/u);

  const hostScoped = { ...request, profile: { ...denyProfile, network: { mode: "allow-listed", hosts: ["example.com"] } } } as const;
  await assert.rejects(
    new BubblewrapContainmentBackend([process.execPath]).prepare(hostScoped),
    /Host-scoped network containment is not implemented/u,
  );
});

test("process runner requires successful containment preparation before launch", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cope-containment-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const boundary = await RepositoryBoundary.create(root);
  const catalog = new CommandCatalog([{
    id: "contained",
    category: "test",
    risk: "low",
    sideEffects: false,
    networkRequired: false,
    executable: process.execPath,
    fixedArguments: ["-e", "process.stdout.write('contained')"],
  }]);
  let observed: ContainmentLaunchRequest | undefined;
  const backend: CommandContainmentBackend = {
    prepare: async (request) => {
      observed = request;
      return { backend: "darwin-seatbelt", executable: request.executable, arguments: request.arguments };
    },
  };
  const runner = new ProcessRunner(boundary, catalog, { containment: { profile: denyProfile, backend } });
  const outcome = await runner.run({ command_id: "contained" });
  assert.equal(outcome.outcome, "success");
  assert.equal(outcome.stdout, "contained");
  assert.deepEqual(outcome.containment, {
    profileVersion: COMMAND_CONTAINMENT_PROFILE_VERSION,
    backend: "darwin-seatbelt",
  });
  assert.equal(observed?.profile, denyProfile);
  assert.equal(observed?.repositoryRoot, boundary.root);
  assert.equal(observed?.workingDirectory, boundary.root);
});

test("required containment fails closed when the platform has no backend", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cope-containment-unavailable-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const boundary = await RepositoryBoundary.create(root);
  const catalog = new CommandCatalog([{
    id: "never-started",
    category: "test",
    risk: "low",
    sideEffects: false,
    networkRequired: false,
    executable: process.execPath,
  }]);
  const runner = new ProcessRunner(boundary, catalog, {
    host: new UnsupportedHostPlatform("win32"),
    containment: { profile: denyProfile },
  });
  const outcome = await runner.run({ command_id: "never-started" });
  assert.equal(outcome.outcome, "policy-denied");
  assert.match(outcome.error ?? "", /containment is unavailable/u);
});

test("backend errors fail before command launch", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cope-containment-deny-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const boundary = await RepositoryBoundary.create(root);
  const catalog = new CommandCatalog([{
    id: "never-started",
    category: "test",
    risk: "low",
    sideEffects: false,
    networkRequired: false,
    executable: process.execPath,
  }]);
  const backend: CommandContainmentBackend = {
    prepare: async () => { throw new Error("backend refused profile"); },
  };
  const runner = new ProcessRunner(boundary, catalog, { containment: { profile: denyProfile, backend } });
  const outcome = await runner.run({ command_id: "never-started" });
  assert.equal(outcome.outcome, "policy-denied");
  assert.match(outcome.error ?? "", /backend refused profile/u);
});
