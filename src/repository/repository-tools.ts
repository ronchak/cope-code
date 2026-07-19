import { opendir, stat } from "node:fs/promises";

import { minimatch } from "minimatch";

import { AgentError } from "../shared/errors.js";
import type { RepositoryBoundary } from "./boundary.js";
import { RepositoryIgnore } from "./ignore.js";
import { readTextFile } from "./text-file.js";
import {
  REPOSITORY_CONTRACT_VERSION,
  type ContentProcessor,
  type ListFilesRequest,
  type ListFilesResult,
  type ReadFileRequest,
  type ReadFileResult,
  type RepositoryFile,
  type SearchMatch,
  type SearchTextRequest,
  type SearchTextResult,
} from "./types.js";

export interface RepositoryToolsOptions {
  readonly ignore?: RepositoryIgnore;
  readonly contentProcessor?: ContentProcessor;
  /**
   * Exact-path disclosure gate supplied by the orchestration layer. It is
   * evaluated for every path that could be returned or read; repository
   * traversal itself remains deterministic and contains no policy logic.
   */
  readonly isPathReadable?: (
    repositoryRelativePath: string,
    operation: RepositoryReadOperation,
  ) => boolean;
  readonly extraIgnorePatterns?: readonly string[];
  readonly defaultExclusionOverrides?: readonly string[];
  readonly maxListDepth?: number;
  readonly maxListResults?: number;
  readonly maxSearchFiles?: number;
  readonly maxSearchResults?: number;
  readonly maxSearchOutputBytes?: number;
  readonly maxFileBytes?: number;
  readonly maxReadBytes?: number;
  readonly maxTraversalEntries?: number;
}

export type RepositoryReadOperation =
  | "list_files"
  | "search_text"
  | "read_file"
  | "git_status"
  | "git_diff";

export class RepositoryTools {
  private readonly ignore: RepositoryIgnore;
  private readonly contentProcessor: ContentProcessor | undefined;
  private readonly isPathReadable: (
    repositoryRelativePath: string,
    operation: RepositoryReadOperation,
  ) => boolean;
  private readonly maxListDepth: number;
  private readonly maxListResults: number;
  private readonly maxSearchFiles: number;
  private readonly maxSearchResults: number;
  private readonly maxSearchOutputBytes: number;
  private readonly maxFileBytes: number;
  private readonly maxReadBytes: number;
  private readonly maxTraversalEntries: number;

  private constructor(
    public readonly boundary: RepositoryBoundary,
    ignore: RepositoryIgnore,
    options: RepositoryToolsOptions,
  ) {
    this.ignore = ignore;
    this.contentProcessor = options.contentProcessor;
    this.isPathReadable = options.isPathReadable ?? (() => true);
    this.maxListDepth = options.maxListDepth ?? 6;
    this.maxListResults = options.maxListResults ?? 500;
    this.maxSearchFiles = options.maxSearchFiles ?? 2_000;
    this.maxSearchResults = options.maxSearchResults ?? 100;
    this.maxSearchOutputBytes = options.maxSearchOutputBytes ?? 128 * 1024;
    this.maxFileBytes = options.maxFileBytes ?? 1024 * 1024;
    this.maxReadBytes = options.maxReadBytes ?? 128 * 1024;
    this.maxTraversalEntries = options.maxTraversalEntries ?? 10_000;
  }

  public static async create(
    boundary: RepositoryBoundary,
    options: RepositoryToolsOptions = {},
  ): Promise<RepositoryTools> {
    const ignore =
      options.ignore ??
      (await RepositoryIgnore.load(
        boundary,
        options.extraIgnorePatterns,
        options.defaultExclusionOverrides,
      ));
    return new RepositoryTools(boundary, ignore, options);
  }

  public async listFiles(request: ListFilesRequest = {}): Promise<ListFilesResult> {
    const start = await this.boundary.resolveExistingDirectory(request.path ?? ".");
    if (start.relativePath !== "" && this.ignore.isIgnored(start.relativePath, true)) {
      throw new AgentError("UNSUPPORTED_FILE", "Directory is excluded by repository policy", {
        path: start.relativePath,
      });
    }
    const maxDepth = boundedPositiveInteger(request.maxDepth, this.maxListDepth, "maxDepth", true);
    const maxResults = boundedPositiveInteger(
      request.maxResults,
      this.maxListResults,
      "maxResults",
    );
    const entries: RepositoryFile[] = [];
    let excludedCount = 0;
    let truncated = false;
    let traversedEntries = 0;
    const queue: Array<{ readonly path: string; readonly absolutePath: string; readonly depth: number }> = [
      { path: start.relativePath, absolutePath: start.absolutePath, depth: 0 },
    ];

    while (
      queue.length > 0 &&
      entries.length < maxResults &&
      traversedEntries < this.maxTraversalEntries
    ) {
      const directory = queue.shift();
      if (directory === undefined) {
        break;
      }
      const handle = await opendir(directory.absolutePath);
      const children = [];
      for await (const child of handle) {
        if (traversedEntries >= this.maxTraversalEntries) {
          truncated = true;
          break;
        }
        traversedEntries += 1;
        children.push(child);
      }
      children.sort((left, right) => left.name.localeCompare(right.name));

      for (const child of children) {
        const relativePath =
          directory.path === "" ? child.name : `${directory.path}/${child.name}`;
        if (child.isSymbolicLink()) {
          excludedCount += 1;
          continue;
        }
        const isDirectory = child.isDirectory();
        if (this.ignore.isIgnored(relativePath, isDirectory)) {
          excludedCount += 1;
          continue;
        }
        if (!isDirectory && !child.isFile()) {
          excludedCount += 1;
          continue;
        }
        if (isDirectory) {
          const readable = this.isPathAllowed(relativePath, "list_files", true);
          if (readable) {
            if (entries.length >= maxResults) {
              truncated = true;
              break;
            }
            entries.push({ path: relativePath, type: "directory" });
          } else {
            excludedCount += 1;
          }
          if (directory.depth < maxDepth) {
            const resolved = await this.boundary.resolveExistingDirectory(relativePath);
            queue.push({
              path: relativePath,
              absolutePath: resolved.absolutePath,
              depth: directory.depth + 1,
            });
          } else {
            truncated = true;
          }
        } else {
          if (!this.isPathAllowed(relativePath, "list_files")) {
            excludedCount += 1;
            continue;
          }
          if (entries.length >= maxResults) {
            truncated = true;
            break;
          }
          const resolved = await this.boundary.resolveExistingFile(relativePath);
          const childStat = await stat(resolved.absolutePath);
          if (childStat.size > this.maxFileBytes || childStat.nlink > 1) {
            excludedCount += 1;
            continue;
          }
          entries.push({ path: relativePath, type: "file", sizeBytes: childStat.size });
        }
      }
    }

    truncated ||= queue.length > 0;
    return {
      contractVersion: REPOSITORY_CONTRACT_VERSION,
      root: start.relativePath,
      entries,
      truncated,
      excludedCount,
    };
  }

  public async readFile(request: ReadFileRequest): Promise<ReadFileResult> {
    const resolved = await this.boundary.resolveExistingFile(request.path);
    if (this.ignore.isIgnored(resolved.relativePath)) {
      throw new AgentError("UNSUPPORTED_FILE", "File is excluded by repository policy", {
        path: resolved.relativePath,
      });
    }
    if (!this.isPathAllowed(resolved.relativePath, "read_file")) {
      throw new AgentError("POLICY_DENIED", "File is outside the effective read grant", {
        path: resolved.relativePath,
      });
    }
    const snapshot = await readTextFile(
      resolved.absolutePath,
      resolved.relativePath,
      this.maxFileBytes,
    );
    const lines = snapshot.content.split(/\r?\n/u);
    const startLine = request.startLine ?? 1;
    const requestedEndLine = request.endLine ?? lines.length;
    if (
      !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(requestedEndLine) ||
      startLine < 1 ||
      requestedEndLine < startLine
    ) {
      throw new AgentError("PROTOCOL_INVALID", "Invalid line range", {
        startLine,
        endLine: requestedEndLine,
      });
    }
    if (startLine > lines.length) {
      throw new AgentError("PROTOCOL_INVALID", "Start line is beyond the end of the file", {
        path: resolved.relativePath,
        startLine,
        totalLines: lines.length,
      });
    }
    const maxBytes = boundedPositiveInteger(request.maxBytes, this.maxReadBytes, "maxBytes");
    const selected: string[] = [];
    let usedBytes = 0;
    let actualEndLine = Math.min(requestedEndLine, lines.length);
    let truncated = startLine > 1 || requestedEndLine < lines.length;
    for (let lineNumber = startLine; lineNumber <= actualEndLine; lineNumber += 1) {
      const line = lines[lineNumber - 1];
      if (line === undefined) {
        actualEndLine = Math.max(startLine - 1, lines.length);
        break;
      }
      const delimiterBytes = selected.length === 0 ? 0 : 1;
      const lineBytes = Buffer.byteLength(line);
      if (usedBytes + delimiterBytes + lineBytes > maxBytes) {
        actualEndLine = lineNumber - 1;
        truncated = true;
        break;
      }
      selected.push(line);
      usedBytes += delimiterBytes + lineBytes;
    }

    const processed = await this.processContent({
      operationId: request.operationId ?? "read_file",
      source: "repository-file",
      content: selected.join("\n"),
      path: resolved.relativePath,
    });
    const boundedContent = truncateUtf8(processed.content, maxBytes);
    truncated ||= boundedContent.truncated;

    return {
      contractVersion: REPOSITORY_CONTRACT_VERSION,
      path: resolved.relativePath,
      content: boundedContent.value,
      startLine,
      endLine: actualEndLine,
      totalLines: lines.length,
      state: snapshot.state,
      truncated,
      redactionCount: processed.redactionCount,
    };
  }

  public async searchText(request: SearchTextRequest): Promise<SearchTextResult> {
    if (typeof request.query !== "string" || request.query.length === 0 || request.query.length > 8_192) {
      throw new AgentError("PROTOCOL_INVALID", "Search query must contain 1 to 8192 characters");
    }
    const maxResults = boundedPositiveInteger(
      request.maxResults,
      this.maxSearchResults,
      "maxResults",
    );
    const maxOutputBytes = boundedPositiveInteger(
      request.maxOutputBytes,
      this.maxSearchOutputBytes,
      "maxOutputBytes",
    );
    const contextLines = boundedPositiveInteger(request.contextLines, 5, "contextLines", true);
    const files = await this.collectSearchFiles(request.path ?? ".");
    const matches: SearchMatch[] = [];
    let outputBytes = 0;
    let filteredCount = files.filteredCount;
    let truncated = files.truncated;

    outer: for (const filePath of files.paths) {
      if (!matchesPatterns(filePath, request.filePatterns, this.boundary.filesystemIdentity)) {
        continue;
      }
      let snapshot;
      try {
        const resolved = await this.boundary.resolveExistingFile(filePath);
        snapshot = await readTextFile(resolved.absolutePath, filePath, this.maxFileBytes);
      } catch (error) {
        if (
          error instanceof AgentError &&
          (error.code === "UNSUPPORTED_FILE" || error.code === "BUDGET_EXCEEDED")
        ) {
          filteredCount += 1;
          continue;
        }
        throw error;
      }
      const lines = snapshot.content.split(/\r?\n/u);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        if (line === undefined) {
          continue;
        }
        let columnIndex = line.indexOf(request.query);
        while (columnIndex >= 0) {
          const excerptStart = Math.max(0, lineIndex - contextLines);
          const excerptEnd = Math.min(lines.length, lineIndex + contextLines + 1);
          const rawExcerpt = lines.slice(excerptStart, excerptEnd).join("\n");
          const processed = await this.processContent({
            operationId: request.operationId ?? "search_text",
            source: "repository-search",
            content: rawExcerpt,
            path: filePath,
          });
          const nextBytes = Buffer.byteLength(processed.content);
          if (matches.length >= maxResults || outputBytes + nextBytes > maxOutputBytes) {
            truncated = true;
            break outer;
          }
          matches.push({
            path: filePath,
            line: lineIndex + 1,
            column: columnIndex + 1,
            excerpt: processed.content,
            state: snapshot.state,
            redactionCount: processed.redactionCount,
          });
          outputBytes += nextBytes;
          columnIndex = line.indexOf(request.query, columnIndex + Math.max(1, request.query.length));
        }
      }
    }

    return {
      contractVersion: REPOSITORY_CONTRACT_VERSION,
      matches,
      truncated,
      filteredCount,
      outputBytes,
    };
  }

  /** Safe metadata query used when Git needs to construct an approved pathspec. */
  public isExcludedPath(repositoryRelativePath: string, isDirectory = false): boolean {
    return this.ignore.isIgnored(repositoryRelativePath, isDirectory);
  }

  /** Safe metadata query used by repository adapters before disclosing a path. */
  public isPathAllowed(
    repositoryRelativePath: string,
    operation: RepositoryReadOperation,
    isDirectory = false,
  ): boolean {
    return !this.ignore.isIgnored(repositoryRelativePath, isDirectory) &&
      this.isPathReadable(repositoryRelativePath === "" ? "." : repositoryRelativePath, operation);
  }

  private async collectSearchFiles(
    startPath: string,
  ): Promise<{ readonly paths: readonly string[]; readonly filteredCount: number; readonly truncated: boolean }> {
    const start = await this.boundary.resolveExistingDirectory(startPath);
    if (start.relativePath !== "" && this.ignore.isIgnored(start.relativePath, true)) {
      throw new AgentError("UNSUPPORTED_FILE", "Directory is excluded by repository policy", {
        path: start.relativePath,
      });
    }
    const paths: string[] = [];
    let filteredCount = 0;
    let truncated = false;
    let traversedEntries = 0;
    const queue = [{ path: start.relativePath, absolutePath: start.absolutePath }];
    while (
      queue.length > 0 &&
      paths.length < this.maxSearchFiles &&
      traversedEntries < this.maxTraversalEntries
    ) {
      const directory = queue.shift();
      if (directory === undefined) {
        break;
      }
      const handle = await opendir(directory.absolutePath);
      const children = [];
      for await (const child of handle) {
        if (traversedEntries >= this.maxTraversalEntries) {
          truncated = true;
          break;
        }
        traversedEntries += 1;
        children.push(child);
      }
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        const relativePath =
          directory.path === "" ? child.name : `${directory.path}/${child.name}`;
        if (child.isSymbolicLink()) {
          filteredCount += 1;
          continue;
        }
        if (child.isDirectory()) {
          if (this.ignore.isIgnored(relativePath, true)) {
            filteredCount += 1;
            continue;
          }
          const resolved = await this.boundary.resolveExistingDirectory(relativePath);
          queue.push({ path: relativePath, absolutePath: resolved.absolutePath });
        } else if (child.isFile()) {
          if (this.ignore.isIgnored(relativePath)) {
            filteredCount += 1;
            continue;
          }
          if (!this.isPathAllowed(relativePath, "search_text")) {
            filteredCount += 1;
            continue;
          }
          if (paths.length >= this.maxSearchFiles) {
            truncated = true;
            break;
          }
          paths.push(relativePath);
        } else {
          filteredCount += 1;
        }
      }
    }
    truncated ||= queue.length > 0;
    return { paths, filteredCount, truncated };
  }

  private async processContent(
    input: Parameters<ContentProcessor["process"]>[0],
  ): Promise<{ readonly content: string; readonly redactionCount: number }> {
    return this.contentProcessor?.process(input) ?? { content: input.content, redactionCount: 0 };
  }
}

function boundedPositiveInteger(
  requested: number | undefined,
  configuredMaximum: number,
  name: string,
  allowZero = false,
): number {
  const value = requested ?? configuredMaximum;
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > configuredMaximum) {
    throw new AgentError("BUDGET_EXCEEDED", `${name} is outside the configured bound`, {
      requested: value,
      maximum: configuredMaximum,
    });
  }
  return value;
}

function matchesPatterns(
  path: string,
  patterns: readonly string[] | undefined,
  filesystemIdentity: RepositoryBoundary["filesystemIdentity"],
): boolean {
  if (patterns === undefined || patterns.length === 0) {
    return true;
  }
  return patterns.some((pattern) => {
    if (pattern.length === 0 || pattern.length > 1_024 || pattern.includes("\0")) {
      throw new AgentError("PROTOCOL_INVALID", "Search file pattern is invalid");
    }
    return minimatch(filesystemIdentity.normalize(path), filesystemIdentity.normalize(pattern), {
      dot: true,
      nocase: !filesystemIdentity.caseSensitive,
      matchBase: !pattern.includes("/"),
      nobrace: true,
      noext: true,
      nonegate: true,
      nocomment: true,
      windowsPathsNoEscape: true,
    });
  });
}

function truncateUtf8(value: string, maxBytes: number): { readonly value: string; readonly truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) {
    return { value, truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) {
    end -= 1;
  }
  return { value: bytes.subarray(0, end).toString("utf8"), truncated: true };
}
