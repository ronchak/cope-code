export const TERMINAL_EXEC_CONTRACT = "terminal-exec/1" as const;
export const TERMINAL_EXEC_RESULT_CONTRACT = "terminal-exec-result/1" as const;

export const TERMINAL_EXEC_MAX_ARGUMENTS = 1_024;
export const TERMINAL_EXEC_MAX_ARGUMENT_BYTES = 32_768;
export const TERMINAL_EXEC_MAX_TOTAL_ARGUMENT_BYTES = 256 * 1_024;
export const TERMINAL_EXEC_MAX_COMMAND_BYTES = 256 * 1_024;
export const TERMINAL_EXEC_MAX_EXECUTABLE_BYTES = 32_768;
export const TERMINAL_EXEC_MAX_TIMEOUT_MS = 3_600_000;
/**
 * Retained process-output ceiling. Runtime policy separately clamps the
 * model-visible excerpt. The value leaves room inside the 8 MiB artifact cap
 * for the versioned result envelope and integrity metadata.
 */
export const TERMINAL_EXEC_MAX_OUTPUT_BYTES = 7 * 1_024 * 1_024;

export type TerminalExecProcessOutcome =
  | "completed"
  | "completed_nonzero"
  | "spawn_failed"
  | "timed_out"
  | "cancelled"
  | "persistence_failed"
  | "indeterminate";

export type TerminalExecMutationOutcome =
  | "none"
  | "observed"
  | "protected_or_hidden_changed"
  | "unknown";

export type TerminalArtifactKind =
  | "terminal-request"
  | "terminal-pre-observation"
  | "terminal-exit-receipt"
  | "terminal-post-observation"
  | "terminal-result";

export interface TerminalArtifactReference {
  readonly kind: TerminalArtifactKind;
  readonly id: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface TerminalExecStreamResult {
  readonly bytes: number;
  readonly head: string;
  readonly tail: string;
  readonly truncated: boolean;
  readonly artifact?: TerminalArtifactReference;
}

export interface TerminalExecRename {
  readonly from: string;
  readonly to: string;
}

export interface TerminalExecMutationResult {
  readonly outcome: TerminalExecMutationOutcome;
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly deleted: readonly string[];
  readonly renamed: readonly TerminalExecRename[];
  readonly pre_existing_touched: readonly string[];
  readonly changed_files: number;
  readonly changed_lines: number;
  readonly binary_files: number;
  readonly ignored_summary: string;
  readonly repository_fingerprint?: string;
}

export interface TerminalExecResult {
  readonly contract: typeof TERMINAL_EXEC_RESULT_CONTRACT;
  readonly operation_id: string;
  readonly invocation:
    | {
        readonly contract: typeof TERMINAL_EXEC_CONTRACT;
        readonly mode: "shell";
        readonly command: string;
        readonly cwd: string;
      }
    | {
        readonly contract: typeof TERMINAL_EXEC_CONTRACT;
        readonly mode: "argv";
        readonly executable: string;
        readonly arguments: readonly string[];
        readonly cwd: string;
      };
  readonly outcome: TerminalExecProcessOutcome;
  readonly exit_code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly started_at: string;
  readonly completed_at: string;
  readonly duration_ms: number;
  readonly timeout_attributed: boolean;
  readonly cancellation_attributed: boolean;
  readonly stdout: TerminalExecStreamResult;
  readonly stderr: TerminalExecStreamResult;
  readonly redaction_count: number;
  readonly disclosure: "complete" | "truncated" | "withheld";
  readonly mutation: TerminalExecMutationResult;
  readonly replayed: boolean;
}
