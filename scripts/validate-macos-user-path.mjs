import { constants } from "node:fs";
import { access, lstat, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const requested = process.argv[2];
const requireExisting = process.argv.includes("--require-existing");
const validateTree = process.argv.includes("--validate-tree");
if (process.argv.slice(3).some((argument) => argument !== "--require-existing" && argument !== "--validate-tree")) {
  fail("Unknown path-validator option.");
}
if (validateTree && !requireExisting) fail("Tree validation requires an existing path.");
if (process.platform !== "darwin") fail("This path validator is for macOS only.");
if (process.getuid?.() === 0) fail("Root execution is refused.");
if (requested === undefined || !path.isAbsolute(requested)) fail("Path must be absolute.");

const homeLexical = path.resolve(process.env.HOME ?? os.homedir());
const homeState = await lstat(homeLexical).catch(() => fail("HOME is unavailable."));
if (homeState.isSymbolicLink() || !homeState.isDirectory() || homeState.uid !== process.getuid()) {
  fail("HOME must be a real directory owned by the current user.");
}
const home = await realpath(homeLexical);
const requestedLexical = path.resolve(requested);
const lexicalRelative = path.relative(homeLexical, requestedLexical);
const realRelative = path.relative(home, requestedLexical);
const lexicalContained = isStrictDescendant(lexicalRelative);
const realContained = isStrictDescendant(realRelative);
if (!lexicalContained && !realContained) {
  fail("The user installation path must be a strict descendant of HOME.");
}
const traversalHome = lexicalContained ? homeLexical : home;
const relative = lexicalContained ? lexicalRelative : realRelative;
const resolved = path.join(home, relative);

const homeDevice = (await stat(home)).dev;
let cursor = traversalHome;
for (const component of relative.split(path.sep)) {
  cursor = path.join(cursor, component);
  let entry;
  try { entry = await lstat(cursor); } catch (error) {
    if (error?.code === "ENOENT") break;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) fail(`Path component is not a real directory: ${cursor}`);
  if (entry.uid !== process.getuid()) fail(`Path component is not owned by the current user: ${cursor}`);
  if (entry.dev !== homeDevice) fail(`Path crosses away from the HOME filesystem: ${cursor}`);
}

if (requireExisting) {
  const target = await lstat(resolved).catch(() => fail("Required path does not exist."));
  if (target.isSymbolicLink() || !target.isDirectory() || target.uid !== process.getuid() || target.dev !== homeDevice) {
    fail("Required path is not a local, real, user-owned directory.");
  }
}

if (validateTree) await verifyTree(resolved, homeDevice, process.getuid());

let writable = resolved;
for (;;) {
  try { await lstat(writable); break; } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const parent = path.dirname(writable);
    if (parent === writable) fail("No existing writable ancestor was found.");
    writable = parent;
  }
}
await access(writable, constants.W_OK).catch(() => fail(`Path ancestor is not writable: ${writable}`));
process.stdout.write(`${resolved}\n`);

function isStrictDescendant(relative) {
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function verifyTree(root, expectedDevice, expectedUid) {
  const pending = [{ directory: root, depth: 0 }];
  let entries = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current.depth > 256) fail(`Removal tree is too deep: ${current.directory}`);
    const names = await readdir(current.directory);
    for (const name of names) {
      entries += 1;
      if (entries > 1_000_000) fail("Removal tree exceeds the bounded entry limit.");
      const entryPath = path.join(current.directory, name);
      const entry = await lstat(entryPath);
      // Chromium uses SingletonLock/Cookie/Socket symlinks. rm -rf unlinks these
      // entries and does not follow them, so validate ownership and never descend.
      if (entry.isSymbolicLink()) {
        if (entry.uid !== expectedUid) fail(`Removal tree contains an entry not owned by the current user: ${entryPath}`);
        continue;
      }
      if (entry.uid !== expectedUid) fail(`Removal tree contains an entry not owned by the current user: ${entryPath}`);
      if (entry.dev !== expectedDevice) fail(`Removal tree crosses away from the HOME filesystem: ${entryPath}`);
      if (entry.isDirectory()) {
        pending.push({ directory: entryPath, depth: current.depth + 1 });
      } else if (!entry.isFile()) {
        fail(`Removal tree contains an unsupported entry type: ${entryPath}`);
      }
    }
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
