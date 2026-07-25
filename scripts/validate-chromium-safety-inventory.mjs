#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createScanner,
  LanguageVariant,
  SyntaxKind,
} from "typescript/unstable/ast";

function importsRuntimeChromium(source) {
  const scanner = createScanner(
    true,
    LanguageVariant.Standard,
    source,
  );
  let kind = scanner.scan();
  while (kind === SyntaxKind.ImportKeyword) {
    const tokens = [];
    let moduleSeen = false;
    for (;;) {
      kind = scanner.scan();
      const precededByLineBreak = scanner.hasPrecedingLineBreak();
      if (
        moduleSeen &&
        precededByLineBreak &&
        kind !== SyntaxKind.SemicolonToken &&
        kind !== SyntaxKind.WithKeyword &&
        kind !== SyntaxKind.AssertKeyword
      ) {
        break;
      }
      if (kind === SyntaxKind.EndOfFile) break;
      const previousKind = tokens.at(-1)?.kind;
      tokens.push({
        kind,
        text: scanner.getTokenText(),
        value: scanner.getTokenValue(),
      });
      if (
        kind === SyntaxKind.StringLiteral &&
        (tokens.length === 1 || previousKind === SyntaxKind.FromKeyword)
      ) {
        moduleSeen = true;
      }
      if (kind === SyntaxKind.SemicolonToken) {
        kind = scanner.scan();
        break;
      }
    }
    const first = tokens[0];
    if (first?.kind === SyntaxKind.OpenParenToken) {
      if (
        tokens[1]?.kind === SyntaxKind.StringLiteral &&
        tokens[1]?.value === "playwright-core"
      ) {
        return true;
      }
      continue;
    }

    let moduleIndex = 0;
    while (
      moduleIndex < tokens.length &&
      tokens[moduleIndex]?.kind !== SyntaxKind.StringLiteral &&
      tokens[moduleIndex]?.kind !== SyntaxKind.SemicolonToken
    ) {
      moduleIndex += 1;
    }
    if (tokens[moduleIndex]?.value !== "playwright-core") continue;
    if (moduleIndex === 0) return true;
    const clause = tokens.slice(0, moduleIndex);
    if (clause[0]?.kind === SyntaxKind.TypeKeyword) continue;
    if (clause[0]?.kind === SyntaxKind.StringLiteral) return true;
    if (clause.some((token) => token.kind === SyntaxKind.AsteriskToken)) return true;
    if (clause.some((token) =>
      token.kind === SyntaxKind.Identifier && token.text === "chromium")) {
      return true;
    }
    if (clause[0]?.kind === SyntaxKind.Identifier) return true;
  }
  return false;
}

async function discoverRuntimeChromiumTests(rootDirectory) {
  const testsDirectory = path.join(rootDirectory, "tests");
  const entries = await readdir(testsDirectory, { recursive: true, withFileTypes: true });
  const discovered = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".test.ts")) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const source = await readFile(absolute, "utf8");
    if (importsRuntimeChromium(source)) {
      discovered.push(path.relative(rootDirectory, absolute).split(path.sep).join("/"));
    }
  }
  return discovered.sort();
}

export async function validateChromiumSafetyManifest(
  manifestPath,
  rootDirectory = process.cwd(),
) {
  const root = path.resolve(rootDirectory);
  const resolvedManifest = path.resolve(root, manifestPath);
  const parsed = JSON.parse(await readFile(resolvedManifest, "utf8"));
  if (
    !Array.isArray(parsed.sourceFiles) ||
    parsed.sourceFiles.length === 0 ||
    !parsed.sourceFiles.every((value) =>
      typeof value === "string" &&
      path.posix.normalize(value) === value &&
      !value.includes("\\") &&
      value.startsWith("tests/") &&
      value.endsWith(".test.ts"))
  ) {
    throw new Error("Chromium safety manifest sourceFiles must be non-empty test source paths");
  }
  if (
    !Number.isSafeInteger(parsed.expectedTestCount) ||
    parsed.expectedTestCount < 1
  ) {
    throw new Error("Chromium safety manifest expectedTestCount must be a positive integer");
  }
  const sourceFiles = [...new Set(parsed.sourceFiles)].sort();
  if (sourceFiles.length !== parsed.sourceFiles.length) {
    throw new Error("Chromium safety manifest contains duplicate source files");
  }
  for (const source of sourceFiles) {
    await readFile(path.resolve(root, source), "utf8");
  }

  const discovered = await discoverRuntimeChromiumTests(root);
  const omitted = discovered.filter((source) => !sourceFiles.includes(source));
  const stale = sourceFiles.filter((source) => !discovered.includes(source));
  if (omitted.length > 0) {
    throw new Error(`Chromium safety manifest omits runtime Chromium test files: ${omitted.join(", ")}`);
  }
  if (stale.length > 0) {
    throw new Error(`Chromium safety manifest includes non-runtime test files: ${stale.join(", ")}`);
  }
  return {
    expectedTestCount: parsed.expectedTestCount,
    sourceFiles,
  };
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  const manifestPath = process.argv[2];
  const rootDirectory = process.argv[3] ?? process.cwd();
  if (manifestPath === undefined || process.argv.length > 4) {
    process.stderr.write(
      "Usage: validate-chromium-safety-inventory.mjs <manifest.json> [root-directory]\n",
    );
    process.exitCode = 2;
  } else {
    try {
      await validateChromiumSafetyManifest(manifestPath, rootDirectory);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  }
}
