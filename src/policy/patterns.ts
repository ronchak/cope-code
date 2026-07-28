import { minimatch } from "minimatch";

const WINDOWS_ABSOLUTE_OR_ROOTED = /^(?:[A-Za-z]:|[\\/])/u;

export function normalizeRepositoryPath(candidate: string): string | undefined {
  if (
    candidate.length === 0 ||
    candidate.includes("\0") ||
    candidate.includes(":") ||
    WINDOWS_ABSOLUTE_OR_ROOTED.test(candidate)
  ) {
    return undefined;
  }
  const replaced = candidate.replaceAll("\\", "/");
  const segments = replaced.split("/");
  if (segments.some((segment) => segment === "..")) return undefined;
  const normalized = segments.filter((segment) => segment.length > 0 && segment !== ".").join("/");
  return normalized.length === 0 ? "." : normalized;
}

export function isSafePolicyPattern(pattern: string): boolean {
  if (
    pattern.length === 0 ||
    pattern.includes("\0") ||
    pattern.includes(":") ||
    WINDOWS_ABSOLUTE_OR_ROOTED.test(pattern)
  ) {
    return false;
  }
  return !pattern.replaceAll("\\", "/").split("/").includes("..");
}

export function matchPolicyPattern(value: string, pattern: string, caseSensitive = false): boolean {
  const normalizedValue = normalizeMatchValue(value);
  const normalizedPattern = normalizeMatchPattern(pattern);
  if (
    normalizedValue === "." &&
    (normalizedPattern === "**" || normalizedPattern === "**/*")
  ) {
    return true;
  }
  if (normalizedPattern.endsWith("/**") && normalizedValue === normalizedPattern.slice(0, -3)) return true;
  return minimatch(normalizedValue, normalizedPattern, {
    dot: true,
    nocase: !caseSensitive,
    nonegate: true,
    nocomment: true,
    windowsPathsNoEscape: true,
  });
}

function normalizeMatchValue(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/u, "");
  return normalized.length === 0 ? "." : normalized;
}

function normalizeMatchPattern(pattern: string): string {
  return pattern.replaceAll("\\", "/").replace(/^\.\/+/u, "");
}

export function matchAnyPolicyPattern(value: string, patterns: readonly string[] | undefined): boolean {
  return patterns?.some((pattern) => matchPolicyPattern(value, pattern)) === true;
}
