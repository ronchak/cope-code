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
  /**
   * Stable rendered identity used only for assistant-envelope correlation.
   * Protocol normalization may change `text`, but must not silently change a
   * baseline captured by an earlier release.
   */
  readonly correlationText?: string;
  /** Source-free facts about response-widget normalization. */
  readonly responseCapture?: ResponseCaptureEvidence;
  readonly value: string;
  readonly accessibleLabel: string;
}

export const RESPONSE_CAPTURE_CONTRACT_VERSION = "response-capture/v2" as const;

export type ResponseCaptureStatus =
  | "rendered_text"
  | "protocol_reconstructed"
  | "model_protocol_malformed"
  | "protocol_widget_incomplete"
  | "protocol_widget_ambiguous"
  | "protocol_widget_capture_failed"
  | "unsupported_capture_contract";

export interface ResponseCaptureEvidence {
  readonly contractVersion: typeof RESPONSE_CAPTURE_CONTRACT_VERSION;
  readonly status: ResponseCaptureStatus;
  readonly protocolVersion?: string;
  readonly reasonCode?: string;
  readonly protocolErrorCode?: string;
  readonly codeBlockCount: number;
  readonly protocolBlockCount: number;
  readonly editorCount: number;
  readonly bannerCount: number;
  readonly lineCount: number;
  readonly contentBytes: number;
  /**
   * Source-free banner provenance, present when the response owns at least one
   * protocol widget. These distinguish a Microsoft banner-wording change from a
   * structural capture failure without recording any response content.
   */
  readonly bannerContract?: "supported" | "unsupported_version" | "ambiguous_protocol_labels";
  /** Boundary-safe protocol-family labels found in the owning banner. */
  readonly bannerTokenCount?: number;
  /** False once Microsoft's explanatory wording drifts from the 0.1.9 baseline. */
  readonly bannerMatchesBaseline?: boolean;
  /** Stable 32-bit identifier of label-masked banner chrome, excluding eligible editors. */
  readonly bannerVariant?: string;
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
