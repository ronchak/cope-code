import { AgentError } from "../shared/errors.js";

/**
 * Fixed room for the tool-result protocol envelope, safe metadata, and
 * disclosure-guard replacements. Source-bearing text is reserved separately
 * at JSON's worst-case six-byte escape expansion.
 */
export const TOOL_RESULT_ENVELOPE_RESERVE_BYTES = 64 * 1024;
/**
 * Cumulative disclosure headroom reserved for source-free denials, decisions,
 * repairs, and a durable budget-exhaustion notice.
 */
export const CONTROL_PLANE_RESERVE_BYTES = 64 * 1024;
/**
 * Last-resort slice unavailable to ordinary decisions and repairs. It is
 * sufficient for one source-free cba/1 exhaustion notice after any normal
 * outbound path reaches its ceiling.
 */
export const EMERGENCY_NOTICE_RESERVE_BYTES = 8 * 1024;
/** Maximum serialized data object returned by list_files. */
export const LIST_FILES_RESULT_BYTES = 128 * 1024;
/** Conservative serialized path/type/size allowance for one list entry. */
export const LIST_FILES_ENTRY_BYTES = 2 * 1024;
/** Maximum serialized data object returned by git_status. */
export const GIT_STATUS_RESULT_BYTES = 64 * 1024;

export function projectedListFilesResultBytes(maxResults: number): number {
  if (!Number.isSafeInteger(maxResults) || maxResults < 1) {
    throw new AgentError("PROTOCOL_INVALID", "list_files result count is invalid", {
      maxResults,
    });
  }
  return Math.min(maxResults * LIST_FILES_ENTRY_BYTES, LIST_FILES_RESULT_BYTES);
}

export function plannedToolResultDisclosureBytes(
  sourceBytes = 0,
  pathBytes = 0,
): number {
  if (
    !Number.isSafeInteger(sourceBytes) ||
    sourceBytes < 0 ||
    !Number.isSafeInteger(pathBytes) ||
    pathBytes < 0
  ) {
    throw new AgentError("PROTOCOL_INVALID", "Tool-result disclosure size is invalid", {
      sourceBytes,
      pathBytes,
    });
  }
  const planned = TOOL_RESULT_ENVELOPE_RESERVE_BYTES + (sourceBytes * 6) + (pathBytes * 6);
  if (!Number.isSafeInteger(planned)) {
    throw new AgentError("BUDGET_EXCEEDED", "Tool-result disclosure reservation is too large", {
      sourceBytes,
      pathBytes,
    });
  }
  return planned;
}
