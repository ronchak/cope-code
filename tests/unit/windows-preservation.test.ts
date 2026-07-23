import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const WINDOWS_BASELINE_HASHES = {
  "scripts/install-windows.ps1": "08a965a240840082270a65b6d13947a07a25d3385b15db79ae7533118285001b",
  "scripts/uninstall-windows.ps1": "16b6d9eafb74ac06a2900d9f31f98018e49ec25b78742019b5ad830fb1796a50",
  "install.cmd": "8d56b5ac60e1f4365993927d1bc5d40ac11963208c7588954888fc3b62ce474c",
  "install-cope.cmd": "3ab30bf64882799b88f9e95883be507b7be325072d2a66f701a44b79f2a14794",
  "uninstall.cmd": "79af0b5fbb73ef97274737f367b456006f3dff9b33785a76698ee3620bb5abbb",
  "uninstall-cope.cmd": "28ef4abdc66216ea2ddb02f730e084f21179d7842a42a391ceb60d6468d02fdc",
} as const;

test("frozen Windows install and uninstall surfaces remain canonically byte-identical", async () => {
  for (const [filename, expected] of Object.entries(WINDOWS_BASELINE_HASHES)) {
    const bytes = await canonicalTextBytes(filename);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, filename);
  }
});

test("host capability branches are confined to the platform layer", async () => {
  const hits: string[] = [];
  for (const filename of await sourceFiles(path.resolve("src"))) {
    if (filename.includes(`${path.sep}platform${path.sep}`)) continue;
    const content = await readFile(filename, "utf8");
    if (content.includes("process.platform")) hits.push(path.relative(process.cwd(), filename).replaceAll(path.sep, "/"));
  }
  assert.deepEqual(hits.sort(), ["src/cli/demo.ts", "src/cli/presentation.ts"]);
});

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(filename));
    else if (entry.isFile() && filename.endsWith(".ts")) files.push(filename);
  }
  return files;
}

async function canonicalTextBytes(filename: string): Promise<Buffer> {
  const content = await readFile(path.resolve(filename), "utf8");
  return Buffer.from(content.replaceAll("\r\n", "\n"), "utf8");
}
