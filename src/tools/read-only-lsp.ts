import type { RepositoryBoundary } from "../repository/boundary.js";
import { AgentError } from "../shared/errors.js";
import { stableJson } from "../shared/crypto.js";

export const READ_ONLY_LSP_OPERATIONS = ["hover", "definition", "references", "document_symbols"] as const;
export type ReadOnlyLspOperation = (typeof READ_ONLY_LSP_OPERATIONS)[number];

export interface ReadOnlyLspQuery {
  readonly operation: ReadOnlyLspOperation;
  readonly path: string;
  readonly line?: number;
  readonly character?: number;
  readonly includeDeclaration?: boolean;
  readonly maxResults: number;
}

export interface ReadOnlyLspItem {
  readonly path: string;
  readonly startLine: number;
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
  readonly name?: string;
  readonly kind?: string;
  readonly detail?: string;
  readonly contents?: string;
}

export interface ReadOnlyLspBackend {
  /** Static allowlist advertised by the configured backend; never inferred from server responses. */
  readonly capabilities: readonly ReadOnlyLspOperation[];
  query(
    request: ReadOnlyLspQuery & { readonly absolutePath: string },
    signal: AbortSignal,
  ): Promise<readonly ReadOnlyLspItem[]>;
}

export interface ReadOnlyLspServiceOptions {
  readonly defaultTimeoutMs?: number;
  readonly maximumTimeoutMs?: number;
  readonly defaultMaxBytes?: number;
  readonly maximumMaxBytes?: number;
}

export interface ReadOnlyLspResult {
  readonly operation: ReadOnlyLspOperation;
  readonly path: string;
  readonly items: readonly ReadOnlyLspItem[];
  readonly truncated: boolean;
  readonly outputBytes: number;
}

/**
 * A fail-closed boundary around an LSP adapter. It exposes no mutation,
 * workspace-command, configuration, or dynamic-capability channel.
 */
export class ReadOnlyLspService {
  public constructor(
    private readonly boundary: RepositoryBoundary,
    private readonly backend: ReadOnlyLspBackend,
    private readonly options: ReadOnlyLspServiceOptions = {},
  ) {}

  public async query(
    request: ReadOnlyLspQuery & { readonly timeoutMs?: number; readonly maxBytes?: number },
    callerSignal?: AbortSignal,
  ): Promise<ReadOnlyLspResult> {
    if (!this.backend.capabilities.includes(request.operation)) {
      throw new AgentError("POLICY_DENIED", `LSP operation '${request.operation}' is not enabled by the backend capability grant`);
    }
    validatePosition(request);
    const resolved = await this.boundary.resolveExistingFile(request.path);
    const timeoutMs = boundedPositive(request.timeoutMs ?? this.options.defaultTimeoutMs ?? 5_000, this.options.maximumTimeoutMs ?? 30_000, "timeout_ms");
    const maxBytes = boundedInteger(request.maxBytes ?? this.options.defaultMaxBytes ?? 128 * 1024, 4_096, this.options.maximumMaxBytes ?? 256 * 1024, "max_bytes");
    const maxResults = boundedInteger(request.maxResults, 1, 500, "max_results");
    const normalizedRequest = { ...request, path: resolved.relativePath, maxResults };
    if (Buffer.byteLength(stableJson({ operation: request.operation, path: resolved.relativePath, items: [] })) > maxBytes) {
      throw new AgentError("BUDGET_EXCEEDED", "LSP result envelope exceeds max_bytes before any items are included");
    }
    const controller = new AbortController();
    let rejectCancellation: ((reason: AgentError) => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    const cancel = (): void => {
      controller.abort(callerSignal?.reason);
      rejectCancellation?.(new AgentError("COMMAND_CANCELLED", "LSP query was cancelled"));
    };
    if (callerSignal?.aborted === true) throw new AgentError("COMMAND_CANCELLED", "LSP query was cancelled");
    callerSignal?.addEventListener("abort", cancel, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort("LSP query timed out");
        reject(new AgentError("COMMAND_TIMEOUT", `LSP query exceeded ${String(timeoutMs)} ms`));
      }, timeoutMs);
    });
    try {
      const backendResult = this.backend.query({ ...normalizedRequest, absolutePath: resolved.absolutePath }, controller.signal);
      // Keep late backend rejection observed after timeout/cancellation.
      void backendResult.catch(() => undefined);
      const rawItems = await Promise.race([backendResult, timeout, cancellation]);
      return await this.normalize(normalizedRequest, rawItems, maxBytes);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", cancel);
    }
  }

  private async normalize(request: ReadOnlyLspQuery, raw: readonly ReadOnlyLspItem[], maxBytes: number): Promise<ReadOnlyLspResult> {
    if (!Array.isArray(raw)) throw new AgentError("PROTOCOL_INVALID", "LSP backend returned a non-array result");
    const items: ReadOnlyLspItem[] = [];
    let truncated = raw.length > request.maxResults;
    for (const item of raw.slice(0, request.maxResults)) {
      validateItem(item);
      const resolved = await this.boundary.resolveExistingFile(item.path);
      const normalized = { ...item, path: resolved.relativePath };
      const candidate = [...items, normalized];
      if (Buffer.byteLength(stableJson({ operation: request.operation, path: request.path, items: candidate })) > maxBytes) {
        truncated = true;
        break;
      }
      items.push(normalized);
    }
    const outputBytes = Buffer.byteLength(stableJson({ operation: request.operation, path: request.path, items }));
    return { operation: request.operation, path: request.path, items, truncated, outputBytes };
  }
}

function boundedPositive(value: number, maximum: number, name: string): number {
  return boundedInteger(value, 1, maximum, name);
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new AgentError("PROTOCOL_INVALID", `${name} must be an integer between ${String(minimum)} and ${String(maximum)}`);
  }
  return value;
}

function validatePosition(request: ReadOnlyLspQuery): void {
  const needsPosition = request.operation !== "document_symbols";
  if (needsPosition && (!Number.isSafeInteger(request.line) || !Number.isSafeInteger(request.character))) {
    throw new AgentError("PROTOCOL_INVALID", `${request.operation} requires zero-based line and character positions`);
  }
  if ((request.line ?? 0) < 0 || (request.character ?? 0) < 0) {
    throw new AgentError("PROTOCOL_INVALID", "LSP positions must be non-negative");
  }
}

function validateItem(item: ReadOnlyLspItem): void {
  if (item === null || typeof item !== "object" || Array.isArray(item)) throw new AgentError("PROTOCOL_INVALID", "LSP backend returned an invalid item");
  const allowed = new Set(["path", "startLine", "startCharacter", "endLine", "endCharacter", "name", "kind", "detail", "contents"]);
  if (Object.keys(item).some((key) => !allowed.has(key))) throw new AgentError("PROTOCOL_INVALID", "LSP backend returned an item with unknown fields");
  for (const value of [item.startLine, item.startCharacter, item.endLine, item.endCharacter]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new AgentError("PROTOCOL_INVALID", "LSP backend returned an invalid range");
  }
  if (typeof item.path !== "string") throw new AgentError("PROTOCOL_INVALID", "LSP backend returned an invalid path");
  if (item.endLine < item.startLine || (item.endLine === item.startLine && item.endCharacter < item.startCharacter)) {
    throw new AgentError("PROTOCOL_INVALID", "LSP backend returned an inverted range");
  }
  for (const value of [item.name, item.kind, item.detail, item.contents]) {
    if (value !== undefined && (typeof value !== "string" || Buffer.byteLength(value) > 64 * 1024)) {
      throw new AgentError("PROTOCOL_INVALID", "LSP backend returned an invalid text field");
    }
  }
}
