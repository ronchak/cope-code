import type { SessionState, SessionStatus } from "./types.js";
import { isTerminal } from "./state-machine.js";

export interface TerminalCleanupDependencies {
  readonly status: SessionStatus;
  readonly retainSourceArtifacts: boolean;
  readonly artifacts?: { clear(): Promise<void> };
  readonly completionHandoffs?: { remove(): Promise<void> };
}

/**
 * Persists the retention decision with the terminal lifecycle commit. The
 * policy remains as an idempotent tombstone so a later load can retry cleanup
 * after transient filesystem failure or directory-entry resurrection.
 */
export function setTerminalCleanupPolicy(
  state: SessionState,
  retainSourceArtifacts: boolean,
): void {
  state.terminalCleanup = {
    sourceArtifacts: retainSourceArtifacts ? "retain" : "remove",
  };
}

/**
 * Applies the source-retention policy only after a terminal lifecycle state is
 * durable. Paused and otherwise nonterminal sessions remain recoverable.
 */
export async function cleanupTerminalRecoveryArtifacts(
  dependencies: TerminalCleanupDependencies,
): Promise<void> {
  if (!isTerminal(dependencies.status)) return;
  const cleanup: Promise<void>[] = [];
  if (!dependencies.retainSourceArtifacts && dependencies.artifacts !== undefined) {
    cleanup.push(dependencies.artifacts.clear());
  }
  if (dependencies.status !== "completed" && dependencies.completionHandoffs !== undefined) {
    cleanup.push(dependencies.completionHandoffs.remove());
  }
  await Promise.all(cleanup);
}
