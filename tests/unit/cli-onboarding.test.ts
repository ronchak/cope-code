import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { writeRepositoryConfiguration } from "../../src/cli/onboarding.js";

test("guided project setup detects useful package scripts and chooses one completion check", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-onboarding-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const fakeNpmCli = path.join(root, "npm-cli.js");
  await writeFile(fakeNpmCli, "// test fixture\n", "utf8");
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    scripts: {
      test: "node --test",
      build: "tsc -p tsconfig.json",
      lint: "eslint .",
    },
  }), "utf8");

  const previous = process.env.npm_execpath;
  process.env.npm_execpath = fakeNpmCli;
  context.after(() => {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
  });

  const result = await writeRepositoryConfiguration({ repositoryRoot: root, profile: "standard", force: true });
  assert.equal(result.profile, "standard");
  assert.equal(result.commandCount, 3);

  const config = JSON.parse(await readFile(result.filename, "utf8")) as {
    grant_defaults: { writable_paths: string[] };
    commands: Array<{ id: string; executable: string; fixedArguments: string[] }>;
    completion: { required_command_ids: string[]; require_validation_after_last_mutation: boolean };
  };
  assert.deepEqual(config.grant_defaults.writable_paths, ["**"]);
  assert.deepEqual(config.commands.map((command) => command.id), ["npm.test", "npm.build", "npm.lint"]);
  assert.ok(config.commands.every((command) => command.executable === process.execPath));
  assert.ok(config.commands.every((command) => command.fixedArguments[0] === fakeNpmCli));
  assert.deepEqual(config.completion.required_command_ids, ["npm.test"]);
  assert.equal(config.completion.require_validation_after_last_mutation, true);
});

test("placeholder npm tests are ignored and inspect setup stays read-only", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cope-onboarding-inspect-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const fakeNpmCli = path.join(root, "npm-cli.js");
  await writeFile(fakeNpmCli, "// test fixture\n", "utf8");
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    scripts: { test: "echo Error: no test specified && exit 1" },
  }), "utf8");
  const previous = process.env.npm_execpath;
  process.env.npm_execpath = fakeNpmCli;
  context.after(() => {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
  });

  const result = await writeRepositoryConfiguration({ repositoryRoot: root, profile: "inspect", force: true });
  const config = JSON.parse(await readFile(result.filename, "utf8")) as {
    grant_defaults: { writable_paths: string[] };
    commands: unknown[];
    completion: { required_command_ids: string[] };
  };
  assert.deepEqual(config.grant_defaults.writable_paths, []);
  assert.deepEqual(config.commands, []);
  assert.deepEqual(config.completion.required_command_ids, []);
});
