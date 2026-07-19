import { readFile } from "node:fs/promises";
import path from "node:path";

import { minimatch } from "minimatch";

import type { RepositoryBoundary } from "./boundary.js";
import type { FilesystemIdentity } from "../shared/filesystem-identity.js";

export const DEFAULT_REPOSITORY_EXCLUSIONS = [
  ".git",
  ".git/**",
  "**/.git/**",
  ".cba",
  ".cba/**",
  ".copilot-agent",
  ".copilot-agent/**",
  "node_modules",
  "node_modules/**",
  "**/node_modules/**",
  "dist/**",
  "**/dist/**",
  "build/**",
  "**/build/**",
  "coverage/**",
  "**/coverage/**",
  "vendor/**",
  "**/vendor/**",
  "*.min.js",
  "*.min.css",
  "*.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "*.pem",
  "*.key",
  "*.pfx",
  "*.p12",
  "*.exe",
  "*.dll",
  "*.com",
  "*.msi",
  "*.msix",
  "*.zip",
  "*.7z",
  "*.rar",
  "*.tar",
  "*.gz",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.webp",
  "*.mp3",
  "*.mp4",
  "*.mov",
  "*.pdf",
  "*.db",
  "*.sqlite",
  "*.sqlite3",
] as const;

interface IgnoreRule {
  readonly pattern: string;
  readonly negated: boolean;
}

export class RepositoryIgnore {
  private constructor(
    private readonly mandatoryRules: readonly IgnoreRule[],
    private readonly repositoryRules: readonly IgnoreRule[],
    private readonly filesystemIdentity: FilesystemIdentity,
  ) {}

  public static async load(
    boundary: RepositoryBoundary,
    extraPatterns: readonly string[] = [],
    defaultExclusionOverrides: readonly string[] = [],
  ): Promise<RepositoryIgnore> {
    let repositoryPatterns: string[] = [];
    try {
      const gitignore = await boundary.resolveExistingFile(".gitignore");
      const raw = await readFile(gitignore.absolutePath, { encoding: "utf8" });
      if (Buffer.byteLength(raw) <= 256 * 1024) {
        repositoryPatterns = raw.split(/\r?\n/u).slice(0, 4_096);
      }
    } catch {
      // A repository need not have a root .gitignore. Defaults still apply.
    }

    const overriddenDefaults = new Set(defaultExclusionOverrides);
    const mandatoryRules = [
      ...DEFAULT_REPOSITORY_EXCLUSIONS.filter((pattern) => !overriddenDefaults.has(pattern)),
      ...extraPatterns,
    ]
      .map(parseRule)
      .filter((rule): rule is IgnoreRule => rule !== undefined && !rule.negated);
    const repositoryRules = repositoryPatterns
      .map(parseRule)
      .filter((rule): rule is IgnoreRule => rule !== undefined);
    return new RepositoryIgnore(mandatoryRules, repositoryRules, boundary.filesystemIdentity);
  }

  public isIgnored(repositoryRelativePath: string, isDirectory = false): boolean {
    const candidate = repositoryRelativePath.replaceAll(path.sep, "/").replace(/^\.\//u, "");
    const candidateWithDirectoryMarker = isDirectory ? `${candidate}/` : candidate;
    if (
      this.mandatoryRules.some((rule) =>
        matches(candidate, candidateWithDirectoryMarker, rule.pattern, this.filesystemIdentity),
      )
    ) {
      return true;
    }
    let ignored = false;
    for (const rule of this.repositoryRules) {
      if (matches(candidate, candidateWithDirectoryMarker, rule.pattern, this.filesystemIdentity)) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  }
}

function parseRule(rawRule: string): IgnoreRule | undefined {
  if (rawRule.length > 1_024) {
    return undefined;
  }
  let rule = rawRule.trim();
  if (rule === "" || rule.startsWith("#")) {
    return undefined;
  }
  if (rule.startsWith("\\#")) {
    rule = rule.slice(1);
  }
  let negated = false;
  if (rule.startsWith("!") && !rule.startsWith("\\!")) {
    negated = true;
    rule = rule.slice(1);
  } else if (rule.startsWith("\\!")) {
    rule = rule.slice(1);
  }
  rule = rule.replaceAll("\\ ", " ").replace(/^\//u, "");
  if (rule === "") {
    return undefined;
  }
  if (rule.endsWith("/")) {
    rule = `${rule}**`;
  }
  return { pattern: rule, negated };
}

function matches(
  candidate: string,
  directoryCandidate: string,
  pattern: string,
  filesystemIdentity: FilesystemIdentity,
): boolean {
  const normalizedCandidate = filesystemIdentity.normalize(candidate);
  const normalizedDirectory = filesystemIdentity.normalize(directoryCandidate);
  const normalizedPattern = filesystemIdentity.normalize(pattern);
  const options = {
    dot: true,
    nocase: !filesystemIdentity.caseSensitive,
    matchBase: !normalizedPattern.includes("/"),
    nobrace: true,
    noext: true,
    nonegate: true,
    nocomment: true,
    windowsPathsNoEscape: true,
  } as const;
  return (
    minimatch(normalizedCandidate, normalizedPattern, options) ||
    minimatch(normalizedDirectory, normalizedPattern, options) ||
    (!normalizedPattern.includes("/") &&
      normalizedCandidate.split("/").some((segment) => minimatch(segment, normalizedPattern, options)))
  );
}
