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
/** Reserved for durable harness-generated decisions; model actions may not use it. */
export const INTERNAL_OPERATION_ID_PREFIX = "_cope_internal_" as const;

const OPERATION_ID_PATTERN = new RegExp(OPERATION_ID_PATTERN_SOURCE, "u");
const WINDOWS_RESERVED_DEVICE_NAME_PATTERN =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;
const INTERNAL_OPERATION_ID_PATTERN = new RegExp(
  `^${INTERNAL_OPERATION_ID_PREFIX}[A-Za-z0-9_-]+$`,
  "u",
);

export function isOperationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    OPERATION_ID_PATTERN.test(value) &&
    !WINDOWS_RESERVED_DEVICE_NAME_PATTERN.test(value)
  );
}

export function isInternalOperationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= OPERATION_ID_MAX_LENGTH &&
    INTERNAL_OPERATION_ID_PATTERN.test(value)
  );
}

export function isJournalOperationId(value: unknown): value is string {
  return isOperationId(value) || isInternalOperationId(value);
}
