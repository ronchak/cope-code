export const COPILOT_UI_CONTRACT_VERSION = "copilot-ui/v1" as const;

export interface TextPattern {
  readonly source: string;
  readonly flags?: "i" | "u" | "iu";
}

export type SemanticLocator =
  | {
      readonly kind: "role";
      readonly role: string;
      readonly name?: string | TextPattern;
      readonly exact?: boolean;
    }
  | { readonly kind: "label"; readonly label: string | TextPattern; readonly exact?: boolean }
  | {
      readonly kind: "placeholder";
      readonly placeholder: string | TextPattern;
      readonly exact?: boolean;
    }
  | { readonly kind: "test-id"; readonly testId: string | TextPattern }
  | { readonly kind: "text"; readonly text: string | TextPattern; readonly exact?: boolean }
  | {
      /** Versioned adapter fallback. XPath and script locators are intentionally unsupported. */
      readonly kind: "css";
      readonly selector: string;
    };

export type CopilotSignal =
  | "shell"
  | "conversation"
  | "composer"
  | "send"
  | "responses"
  | "user-messages"
  | "streaming"
  | "identity"
  | "protection"
  | "signed-out"
  | "mfa"
  | "consent"
  | "throttled"
  | "service-error"
  | "modal";

export interface LocatorGroup {
  readonly signal: CopilotSignal;
  readonly candidates: readonly SemanticLocator[];
  /** Number of independent candidate strategies that must match. */
  readonly minimumCandidateMatches: number;
  readonly maximumElements: number;
  readonly capture: "presence" | "text" | "value-and-text";
}

export interface CopilotUiContract {
  readonly version: string;
  readonly certifiedSurface: string;
  /** Explicitly certified submission behavior; the adapter never guesses. */
  readonly submissionStrategy: "send-control";
  readonly groups: Readonly<Record<CopilotSignal, LocatorGroup>>;
}

export interface ElementSnapshot {
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly text: string;
  readonly value: string;
  readonly accessibleLabel: string;
}

export interface GroupSnapshot {
  readonly signal: CopilotSignal;
  readonly matchedCandidates: number;
  readonly visibleElements: number;
  readonly enabledElements: number;
  /** Content is kept in memory for operation only and must not enter diagnostics. */
  readonly elements: readonly ElementSnapshot[];
}

/** Synchronous fail-closed check run at the final browser-dispatch boundary. */
export type SemanticActionGuard = () => void;

/** Closing evidence for a semantic observation that may span concurrent reads. */
export interface SemanticObservationCompletion {
  readonly nativeDialogDetected: boolean;
}

/** Minimal page surface used by the adapter and implemented by Playwright or tests. */
export interface SemanticPage {
  /** Starts one observation whose snapshots share the configured action deadline. */
  currentUrl(): Promise<string>;
  snapshot(group: LocatorGroup): Promise<GroupSnapshot>;
  /**
   * Revalidate page ownership after all snapshots. Context-aware implementations
   * use this to reject navigation, replacement-page, popup, and dialog races.
   */
  completeObservation?(): Promise<SemanticObservationCompletion>;
  fill(group: LocatorGroup, value: string, guard: SemanticActionGuard): Promise<void>;
  click(group: LocatorGroup, guard: SemanticActionGuard): Promise<void>;
}

export type CopilotPageObservation = Readonly<Record<CopilotSignal, GroupSnapshot>> & {
  readonly url: string;
};

export function pattern(source: string, flags: TextPattern["flags"] = "iu"): TextPattern {
  return { source, flags };
}

export function toRegExp(value: TextPattern): RegExp {
  return new RegExp(value.source, value.flags ?? "u");
}

export function matchesText(patternValue: string | TextPattern, value: string): boolean {
  return typeof patternValue === "string"
    ? value.trim() === patternValue.trim()
    : toRegExp(patternValue).test(value);
}
