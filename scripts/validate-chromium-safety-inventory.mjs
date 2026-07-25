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
  const tokens = [];
  const templateContexts = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile;) {
    if (
      kind === SyntaxKind.CloseBraceToken &&
      templateContexts.at(-1)?.braceDepth === 0
    ) {
      kind = scanner.reScanTemplateToken(false);
      tokens.push({
        kind,
        text: scanner.getTokenText(),
        value: scanner.getTokenValue(),
      });
      if (kind === SyntaxKind.TemplateTail) {
        templateContexts.pop();
      }
      kind = scanner.scan();
      continue;
    }
    tokens.push({
      kind,
      text: scanner.getTokenText(),
      value: scanner.getTokenValue(),
    });
    if (kind === SyntaxKind.TemplateHead) {
      templateContexts.push({ braceDepth: 0 });
    } else if (kind === SyntaxKind.OpenBraceToken && templateContexts.length > 0) {
      templateContexts[templateContexts.length - 1].braceDepth += 1;
    } else if (kind === SyntaxKind.CloseBraceToken && templateContexts.length > 0) {
      templateContexts[templateContexts.length - 1].braceDepth -= 1;
    }
    kind = scanner.scan();
  }

  for (let importIndex = 0; importIndex < tokens.length; importIndex += 1) {
    if (tokens[importIndex]?.kind !== SyntaxKind.ImportKeyword) continue;
    if (
      tokens[importIndex - 1]?.kind === SyntaxKind.DotToken ||
      tokens[importIndex - 1]?.kind === SyntaxKind.QuestionDotToken
    ) {
      continue;
    }

    const first = tokens[importIndex + 1];
    if (first?.kind === SyntaxKind.OpenParenToken) {
      if (
        tokens[importIndex + 2]?.kind === SyntaxKind.StringLiteral &&
        tokens[importIndex + 2]?.value === "playwright-core"
      ) {
        return true;
      }
      continue;
    }
    if (first?.kind === SyntaxKind.StringLiteral) {
      if (first.value === "playwright-core") return true;
      continue;
    }

    const clause = [];
    let moduleSpecifier;
    for (let tokenIndex = importIndex + 1; tokenIndex < tokens.length; tokenIndex += 1) {
      const token = tokens[tokenIndex];
      if (
        token?.kind === SyntaxKind.SemicolonToken ||
        token?.kind === SyntaxKind.ImportKeyword
      ) {
        break;
      }
      if (token?.kind === SyntaxKind.FromKeyword) {
        moduleSpecifier = tokens[tokenIndex + 1];
        break;
      }
      if (
        token?.kind === SyntaxKind.EqualsToken &&
        tokens[tokenIndex + 1]?.kind === SyntaxKind.Identifier &&
        tokens[tokenIndex + 1]?.text === "require" &&
        tokens[tokenIndex + 2]?.kind === SyntaxKind.OpenParenToken
      ) {
        moduleSpecifier = tokens[tokenIndex + 3];
        break;
      }
      clause.push(token);
    }
    if (
      moduleSpecifier?.kind !== SyntaxKind.StringLiteral ||
      moduleSpecifier.value !== "playwright-core"
    ) {
      continue;
    }
    if (clause[0]?.kind === SyntaxKind.TypeKeyword) continue;
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
