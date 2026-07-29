# Cope 0.1.9

Cope 0.1.9 fixes the live Microsoft 365 capture incompatibility that could
turn a visibly valid `cba-agent/1` response into `MISSING_ENVELOPE`, spend all
four protocol-repair attempts, and terminate with the less specific
`INVALID_MESSAGE`.

## Reliable protocol-widget ingestion

- The M365 response adapter recognizes the exact supported `cba-agent/1` and
  legacy `cba/1` code-widget banners instead of reconstructing only legacy
  envelopes.
- Browser-page evaluation returns bounded structural evidence. Trusted host
  code validates assistant ownership, one banner, one editor, numeric
  contiguous line indices, body bounds, and fence safety before reconstructing
  and re-verifying an executable envelope.
- JSON shape alone remains inert. Unlabeled JSON, plain text, unsupported
  versions, multiple blocks or editors, malformed line indices, and fence
  collisions fail closed.
- Exact protocol fences quoted in ordinary code editors or rendered prose are
  rejected before parser entry and routed through bounded formatting repair.
  Triple backticks inside a valid JSON string remain ordinary data. Partial
  streaming widgets wait for the normal stability quorum instead of failing on
  their first incomplete sample.
- Banner and body dialect must agree. Contiguous zero- and one-based editor
  line indices are supported; a changed protocol-family banner produces a
  recertification diagnostic rather than falling back to fence-free text.
- Response capture preserves separate correlation and normalized-content
  identities so response baselines recorded by 0.1.8 remain compatible.

## Actionable diagnostics and repair policy

- `ProtocolParseError.protocolCode` now survives progress reporting, audit,
  model repair payloads, and final repair-budget exhaustion.
- A real `MISSING_ENVELOPE` is no longer rewritten through the invented
  `INVALID_ENVELOPE` value into `INVALID_MESSAGE`.
- Recognized-but-ambiguous protocol widgets and capture exceptions return
  typed, source-free `browser_response_capture` diagnostics. They are
  non-repairable and do not spend model protocol-repair budget.
- Model-authored wrong-version, multiple-envelope, invalid-JSON, empty-body,
  and fence/body mismatch failures remain bounded protocol repairs without
  executing rendered widget content.
- Source-free capture evidence is limited to contract version, stable enums,
  protocol version, counts, line count, and byte length.
- That evidence follows completed responses into audit and integrity-checked
  recovery artifacts, so a crash cannot erase the capture classification.
- `cope doctor` exercises the host normalizer with a fixed source-free fixture
  without opening or reading a live Copilot conversation.

## Dependency security

- The production lock refreshes `brace-expansion` to 5.0.8, which fixes
  CVE-2026-14257, and `fast-uri` to 3.1.4, which fixes CVE-2026-16221.
- `npm audit --omit=dev` reports zero known vulnerabilities for the release
  dependency graph.

## Regression coverage

- The real-Chromium M365-shaped test now reconstructs `cba-agent/1`, passes it
  through `CbaProtocolAdapter.parseModelTurn()`, and also parses a valid legacy
  `cba/1` widget whose DOM lines are intentionally out of order.
- Chromium negatives cover inert JSON and unlabeled blocks, unsupported
  versions, multiple editors, multiple protocol blocks, orphaned or changed
  banners, dialect mismatch, quoted fences, virtualized line suffixes, late
  editor mount, page-evaluation failure, inline backtick preservation, and
  standalone fence collision.
- Runtime tests prove `MISSING_ENVELOPE` identity through repair, progress,
  audit, terminal exhaustion, persistence, and recovery.
- Browser-adapter tests prove capture failures are non-repairable and verify
  the exact 0.1.8 response-baseline compatibility path plus a rolling-window
  capture-to-parse flow.

## Release boundary

The offline and installed-Chrome safety gates exercise the implementation.
Fresh Windows positive and quoted-protocol negative live acceptance remain the
final environment-specific gates before tagging or publishing 0.1.9.
