/**
 * Versioned cba/1 operation identifier contract.
 *
 * Operation identifiers become journal filenames on Windows, so the contract
 * intentionally excludes dots, colons, path separators, whitespace, and
 * device-name punctuation. Unrelated protocol identifiers use their own,
 * broader grammar.
 */
export const OPERATION_ID_MIN_LENGTH = 3 as const;
export const OPERATION_ID_MAX_LENGTH = 128 as const;
export const OPERATION_ID_PATTERN_SOURCE = "^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$" as const;

const OPERATION_ID_PATTERN = new RegExp(OPERATION_ID_PATTERN_SOURCE, "u");

export function isOperationId(value: unknown): value is string {
  return typeof value === "string" && OPERATION_ID_PATTERN.test(value);
}
