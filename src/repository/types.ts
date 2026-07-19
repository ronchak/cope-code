export const REPOSITORY_CONTRACT_VERSION = "repository.v1" as const;

export interface FileState {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly modifiedAtMs: number;
}

export interface RepositoryFile {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly sizeBytes?: number;
}

export interface ListFilesRequest {
  readonly path?: string;
  readonly maxDepth?: number;
  readonly maxResults?: number;
}

export interface ListFilesResult {
  readonly contractVersion: typeof REPOSITORY_CONTRACT_VERSION;
  readonly root: string;
  readonly entries: readonly RepositoryFile[];
  readonly truncated: boolean;
  readonly excludedCount: number;
}

export interface SearchTextRequest {
  readonly query: string;
  readonly path?: string;
  readonly filePatterns?: readonly string[];
  readonly maxResults?: number;
  readonly maxOutputBytes?: number;
  readonly contextLines?: number;
  readonly operationId?: string;
}

export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly excerpt: string;
  readonly state: FileState;
  readonly redactionCount: number;
}

export interface SearchTextResult {
  readonly contractVersion: typeof REPOSITORY_CONTRACT_VERSION;
  readonly matches: readonly SearchMatch[];
  readonly truncated: boolean;
  readonly filteredCount: number;
  readonly outputBytes: number;
}

export interface ReadFileRequest {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly maxBytes?: number;
  readonly operationId?: string;
}

export interface ReadFileResult {
  readonly contractVersion: typeof REPOSITORY_CONTRACT_VERSION;
  readonly path: string;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly state: FileState;
  readonly truncated: boolean;
  readonly redactionCount: number;
}

export interface ContentProcessingInput {
  readonly operationId: string;
  readonly source: "repository-file" | "repository-search" | "command-output" | "tool-result";
  readonly content: string;
  readonly path?: string;
}

export interface ContentProcessingResult {
  readonly content: string;
  readonly redactionCount: number;
}

/** Implemented by the security layer. Repository tools depend only on this contract. */
export interface ContentProcessor {
  process(input: ContentProcessingInput): Promise<ContentProcessingResult>;
}
