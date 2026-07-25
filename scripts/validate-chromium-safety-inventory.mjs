#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { init, parse } from "es-module-lexer";
import {
  createScanner,
  LanguageVariant,
  SyntaxKind,
} from "typescript/unstable/ast";

await init;

function namedImportsRuntimeChromium(clause) {
  const openBrace = clause.findIndex((token) => token.kind === SyntaxKind.OpenBraceToken);
  const closeBrace = clause.findIndex((token) => token.kind === SyntaxKind.CloseBraceToken);
  if (openBrace === -1 || closeBrace < openBrace) return false;
  let specifier = [];
  for (const token of clause.slice(openBrace + 1, closeBrace + 1)) {
    if (
      token.kind !== SyntaxKind.CommaToken &&
      token.kind !== SyntaxKind.CloseBraceToken
    ) {
      specifier.push(token);
      continue;
    }
    const typeOnly = specifier[0]?.kind === SyntaxKind.TypeKeyword &&
      specifier[1]?.kind === SyntaxKind.Identifier;
    const imported = typeOnly ? undefined : specifier[0];
    if (
      (imported?.kind === SyntaxKind.Identifier && imported.text === "chromium") ||
      (imported?.kind === SyntaxKind.StringLiteral && imported.value === "chromium")
    ) {
      return true;
    }
    specifier = [];
  }
  return false;
}

function staticImportUsesRuntimeChromium(statement) {
  const scanner = createScanner(
    true,
    LanguageVariant.Standard,
    statement,
  );
  if (scanner.scan() !== SyntaxKind.ImportKeyword) return false;
  const clause = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.FromKeyword) break;
    clause.push({
      kind,
      text: scanner.getTokenText(),
      value: scanner.getTokenValue(),
    });
  }
  if (clause[0]?.kind === SyntaxKind.StringLiteral) return true;
  if (clause[0]?.kind === SyntaxKind.TypeKeyword && clause.length > 1) return false;
  if (clause[0]?.kind === SyntaxKind.Identifier) return true;
  if (clause.some((token) => token.kind === SyntaxKind.AsteriskToken)) return true;
  return namedImportsRuntimeChromium(clause);
}

function importsRuntimeChromium(source, sourcePath) {
  let imports;
  try {
    [imports] = parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to classify imports in ${sourcePath}: ${message}`);
  }
  for (const record of imports) {
    if (record.d >= 0 && record.n === undefined) {
      throw new Error(
        `Chromium inventory cannot classify a non-literal dynamic import in ${sourcePath}; ` +
        "use a static string or no-substitution template specifier",
      );
    }
    if (record.n !== "playwright-core") continue;
    if (record.d >= 0) return true;
    if (
      record.d === -1 &&
      staticImportUsesRuntimeChromium(source.slice(record.ss, record.se))
    ) {
      return true;
    }
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
    const relative = path.relative(rootDirectory, absolute).split(path.sep).join("/");
    const source = await readFile(absolute, "utf8");
    if (importsRuntimeChromium(source, relative)) {
      discovered.push(relative);
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
