export function sanitizedCaptureEvidence(
  evidence: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (
    evidence?.contractVersion !== "response-capture/v2" ||
    typeof evidence.status !== "string" ||
    ![
      "rendered_text",
      "protocol_reconstructed",
      "model_protocol_malformed",
      "protocol_widget_incomplete",
      "protocol_widget_ambiguous",
      "protocol_widget_capture_failed",
      "unsupported_capture_contract",
    ].includes(evidence.status)
  ) {
    return undefined;
  }
  const capture: Record<string, unknown> = {
    contractVersion: evidence.contractVersion,
    status: evidence.status,
  };
  if (
    typeof evidence.protocolVersion === "string" &&
    /^(?:cba|cba-agent)\/[A-Za-z0-9._-]{1,32}$/u.test(evidence.protocolVersion)
  ) {
    capture.protocolVersion = evidence.protocolVersion;
  }
  for (const key of ["reasonCode", "protocolErrorCode"] as const) {
    const value = evidence[key];
    if (typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value)) {
      capture[key] = value;
    }
  }
  if (
    evidence.status === "model_protocol_malformed" &&
    (
      capture.protocolErrorCode !== "MISSING_ENVELOPE" &&
      capture.protocolErrorCode !== "MULTIPLE_ENVELOPES" &&
      capture.protocolErrorCode !== "UNSUPPORTED_VERSION" &&
      capture.protocolErrorCode !== "EMPTY_ENVELOPE" &&
      capture.protocolErrorCode !== "INVALID_JSON" &&
      capture.protocolErrorCode !== "SCHEMA_INVALID"
    )
  ) {
    return undefined;
  }
  for (
    const key of [
      "codeBlockCount",
      "protocolBlockCount",
      "editorCount",
      "bannerCount",
      "lineCount",
      "contentBytes",
    ] as const
  ) {
    const value = evidence[key];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > Number.MAX_SAFE_INTEGER
    ) {
      return undefined;
    }
    capture[key] = value;
  }
  // Optional, bounded, source-free banner provenance. Absent on responses that
  // own no protocol widget; never fatal, so older evidence stays valid.
  if (
    evidence.bannerContract === "supported" ||
    evidence.bannerContract === "unsupported_version" ||
    evidence.bannerContract === "ambiguous_protocol_labels"
  ) {
    capture.bannerContract = evidence.bannerContract;
  }
  if (
    typeof evidence.bannerTokenCount === "number" &&
    Number.isSafeInteger(evidence.bannerTokenCount) &&
    evidence.bannerTokenCount >= 0
  ) {
    capture.bannerTokenCount = evidence.bannerTokenCount;
  }
  if (typeof evidence.bannerMatchesBaseline === "boolean") {
    capture.bannerMatchesBaseline = evidence.bannerMatchesBaseline;
  }
  if (
    typeof evidence.bannerVariant === "string" &&
    /^[0-9a-f]{8}$/u.test(evidence.bannerVariant)
  ) {
    capture.bannerVariant = evidence.bannerVariant;
  }
  return capture;
}
