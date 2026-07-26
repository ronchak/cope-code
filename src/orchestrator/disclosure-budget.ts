import { AgentError } from "../shared/errors.js";

/**
 * Fixed room for the tool-result protocol envelope, safe metadata, and
 * disclosure-guard replacements. Source-bearing text is reserved separately
 * at JSON's worst-case six-byte escape expansion.
 */
export const TOOL_RESULT_ENVELOPE_RESERVE_BYTES = 64 * 1024;
/** Maximum serialized data object returned by list_files. */
export const LIST_FILES_RESULT_BYTES = 128 * 1024;
/** Maximum serialized data object returned by git_status. */
export const GIT_STATUS_RESULT_BYTES = 64 * 1024;

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
