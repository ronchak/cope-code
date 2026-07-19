import type { CopilotPageObservation, CopilotSignal, CopilotUiContract } from "./contracts.js";
import type { PageClassification } from "./classifier.js";

export interface MinimalBrowserDiagnostic {
  readonly uiContractVersion: string;
  readonly state: PageClassification["state"];
  readonly diagnosticCode: string;
  readonly locatorQuorum: Readonly<Record<CopilotSignal, boolean>>;
}

/** Never includes URL, page text, prompt/response content, or identity values. */
export function minimalBrowserDiagnostic(
  observation: CopilotPageObservation,
  contract: CopilotUiContract,
  classification: PageClassification,
): MinimalBrowserDiagnostic {
  const entries = Object.entries(contract.groups).map(([signal, group]) => [
    signal,
    observation[group.signal].matchedCandidates >= group.minimumCandidateMatches &&
      observation[group.signal].visibleElements > 0,
  ]);
  return {
    uiContractVersion: contract.version,
    state: classification.state,
    diagnosticCode: classification.diagnosticCode,
    locatorQuorum: Object.fromEntries(entries) as Readonly<Record<CopilotSignal, boolean>>,
  };
}
