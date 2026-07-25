import { AgentError } from "../shared/errors.js";

export interface ExactTextEditInput {
  readonly path: string;
  readonly baseSha256: string;
  readonly oldText: string;
  readonly newText: string;
  readonly expectedOccurrences: number;
}

export interface ExactTextEditSource {
  readonly content: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface ExactTextEditPlan {
  readonly content: string;
  readonly occurrences: number;
  readonly resultBytes: number;
  readonly changedLines: number;
}

/**
 * Plans an edit without allocating the expanded result until its exact UTF-8
 * size has been checked. Both policy authorization and repository execution
 * use this function so occurrence, hash, byte, and line accounting cannot
 * diverge.
 */
export function planExactTextEdit(
  source: ExactTextEditSource,
  input: ExactTextEditInput,
  maxResultBytes: number,
): ExactTextEditPlan {
  assertScalarText(input.oldText, "old_text");
  assertScalarText(input.newText, "new_text");
  if (input.oldText.length === 0) {
    throw new AgentError("PROTOCOL_INVALID", "edit_text old_text must not be empty");
  }
  if (input.oldText === input.newText) {
    throw new AgentError("PROTOCOL_INVALID", "edit_text old_text and new_text must differ");
  }
  if (
    !Number.isSafeInteger(input.expectedOccurrences) ||
    input.expectedOccurrences < 1 ||
    input.expectedOccurrences > 10_000
  ) {
    throw new AgentError(
      "PROTOCOL_INVALID",
      "edit_text expected_occurrences must be an integer from 1 through 10000",
    );
  }
  if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes < 0) {
    throw new AgentError("CONFIG_INVALID", "Edit result byte limit must be a non-negative safe integer");
  }
  if (!/^[0-9a-f]{64}$/iu.test(input.baseSha256) || input.baseSha256.toLowerCase() !== source.sha256) {
    throw new AgentError("STALE_STATE", "Edit base hash does not match current file state", {
      path: input.path,
      expectedSha256: input.baseSha256,
      actualSha256: source.sha256,
    });
  }

  const occurrences = countOccurrences(source.content, input.oldText);
  if (occurrences !== input.expectedOccurrences) {
    throw new AgentError("STALE_STATE", "Edit occurrence count does not match current file state", {
      path: input.path,
      expectedOccurrences: input.expectedOccurrences,
      actualOccurrences: occurrences,
    });
  }

  const oldBytes = Buffer.byteLength(input.oldText, "utf8");
  const newBytes = Buffer.byteLength(input.newText, "utf8");
  const resultBytes = source.bytes.byteLength + occurrences * (newBytes - oldBytes);
  if (!Number.isSafeInteger(resultBytes) || resultBytes < 0 || resultBytes > maxResultBytes) {
    throw new AgentError("BUDGET_EXCEEDED", "Resulting file exceeds the mutation size limit", {
      path: input.path,
      sizeBytes: Number.isSafeInteger(resultBytes) ? resultBytes : "unsafe",
      maxBytes: maxResultBytes,
    });
  }

  const content = source.content.split(input.oldText).join(input.newText);
  if (Buffer.byteLength(content, "utf8") !== resultBytes) {
    throw new AgentError("INTERNAL_ERROR", "Exact text edit byte accounting diverged");
  }
  return {
    content,
    occurrences,
    resultBytes,
    changedLines: countChangedLines(source.content, content),
  };
}

export function countOccurrences(content: string, search: string): number {
  if (search.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(search, offset)) !== -1) {
    count += 1;
    offset += search.length;
  }
  return count;
}

/**
 * Counts the unmatched before and after line records, retaining the exact
 * terminator in each record so LF/CRLF-only changes are never treated as a
 * no-op.
 */
export function countChangedLines(before: string, after: string): number {
  const beforeLines = lineRecords(before);
  const afterLines = lineRecords(after);
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - suffix - 1] === afterLines[afterLines.length - suffix - 1]
  ) {
    suffix += 1;
  }
  return beforeLines.length - prefix - suffix + (afterLines.length - prefix - suffix);
}

function lineRecords(content: string): readonly string[] {
  return content === "" ? [] : content.match(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)?.filter((entry) => entry !== "") ?? [];
}

function assertScalarText(value: string, field: string): void {
  if (typeof value !== "string") {
    throw new AgentError("PROTOCOL_INVALID", `edit_text ${field} must be a string`);
  }
  if (value.includes("\0") || Buffer.from(value, "utf8").toString("utf8") !== value) {
    throw new AgentError(
      "PROTOCOL_INVALID",
      `edit_text ${field} must be NUL-free Unicode scalar text`,
    );
  }
}
