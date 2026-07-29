# PRD: Cope 0.1.9 protocol-ingestion reliability

Status: implementation complete in the PR; independent review and Windows live
acceptance pending

Target: Cope 0.1.9

Primary incident: a live Windows task on Cope 0.1.8 exhausted all four
protocol-repair attempts with `PROTOCOL_INVALID`

## Executive decision

Cope 0.1.9 should repair the live browser capture boundary for
`cba-agent/1`, preserve exact protocol and capture diagnostics end to end, and
prove the complete M365-shaped DOM-to-normalized-action path in real Chromium.

The release must not replace the exact protocol-label provenance check with
JSON-shape guessing. A fence-free transport would change the authority and
prompt-injection threat model and is explicitly deferred to a separate design.

## Implementation status

The 0.1.9 candidate implements a versioned `response-capture/v2` contract,
two-dialect host reconstruction, exact fence/body parity, 0.1.8 baseline
compatibility, capture-aware repair routing, crash-safe source-free evidence,
and installed-Chromium seam tests. Incomplete streaming widgets use the normal
stability quorum; ambiguous ownership and capture failures preserve the
session without spending model-repair budget; model-authored JSON, version,
multiplicity, and dialect errors remain bounded repairs.

`cope doctor` also runs a fixed, source-free fixture through the same
host-side normalizer. It never opens, reads, or mutates a live conversation.
The remaining release evidence is a fresh authenticated Windows positive task
and quoted-protocol negative task. Those gates block a release tag, not review
of the candidate implementation.

## Incident evidence and confidence

The reported terminal sequence was:

1. Copilot returned a response.
2. Cope printed `Copilot response needs protocol repair` four times.
3. Cope printed `Copilot response failed protocol validation`.
4. The task failed because Copilot exhausted the protocol-repair budget.
5. The structured error was `INVALID_MESSAGE` at
   `model_response_normalization`, with `No CBA protocol envelope was found.`

The accompanying Copilot review reported that the chat visibly contained a
`cba-agent/1` code block. That rules out schema and semantic validation as the
observed failure stage, but rendered UI alone cannot prove the exact source
Markdown that the service generated.

The repository establishes the following facts:

- `src/protocol/bootstrap.ts` instructs Copilot to emit an exact
  `cba-agent/1` fence.
- `src/protocol/parser.ts` recognizes both `cba-agent/1` and legacy `cba/1`
  fences in captured text.
- `src/browser/playwright-semantic-page.ts` reconstructs fences removed by
  M365 only when the code-block banner is exactly the legacy `cba/1` banner,
  the JSON contains `protocol: "cba/1"`, and the reconstructed fence is
  `cba/1`.
- A model-facing `cba-agent/1` body intentionally has no `protocol` field, so
  it cannot satisfy that legacy reconstruction predicate.
- `docs/URGENT-WINDOWS-IDENTITY-READINESS.md` records the earlier live finding
  that M365's code-editor rendering removes the Markdown backticks from
  `innerText()`.
- `src/session/types.ts` configures four protocol repairs. The progress
  behavior in `src/orchestrator/agent-runtime.ts` and `src/cli/commands.ts`
  exactly matches four repair messages followed by one failed-validation
  message.

Therefore:

- The v0.1.8 browser-capture incompatibility with a correctly rendered
  `cba-agent/1` widget is proven from source.
- That incompatibility is the root cause of this exact production run with
  high confidence, but not certainty. The current source-free diagnostics
  collapse several capture and formatting failures into the same
  `MISSING_ENVELOPE` outcome. Closing that evidence gap is a v0.1.9 P0
  requirement.

## Root-cause analysis

### RC-1: protocol dialect drift across an untested boundary

PR #36 correctly introduced `cba-agent/1` parsing and normalization, but the
M365-specific DOM reconstruction remained coupled to legacy `cba/1` in three
places:

1. exact unsupported-language banner;
2. JSON discriminator; and
3. emitted fence label.

M365 renders a fenced response as a read-only code editor. The general
`innerText()` fallback no longer contains literal Markdown fences. The live
pipeline is consequently:

```text
valid cba-agent/1 response
  -> M365 code-editor widget
  -> legacy-only reconstruction declines the widget
  -> fence-free rendered text
  -> extractCbaEnvelope()
  -> MISSING_ENVELOPE
```

Protocol-repair prompts cannot change a deterministic capture transformation,
so all four attempts repeat the same failure.

### RC-2: the specific parser code is collapsed

`extractCbaEnvelope()` raises `MISSING_ENVELOPE`. The runtime then sends the
invented code `INVALID_ENVELOPE`, which is not a member of
`PROTOCOL_ERROR_CODES`. The protocol adapter maps that value to
`INVALID_MESSAGE`. Only the error prose survives, and the final repair-budget
error drops the underlying protocol code and capture facts entirely.

This explains why the Copilot-side review saw `INVALID_MESSAGE` rather than
`MISSING_ENVELOPE`.

### RC-3: deterministic capture faults are treated as model-repairable

All repairable `ProtocolParseError` instances currently enter the same budgeted
model-repair path. The runtime has no typed evidence to distinguish:

- a model that omitted or malformed a fence;
- a recognized M365 protocol widget that Cope failed to reconstruct;
- a response-capture exception swallowed into an empty string;
- an exact-fence mismatch such as indentation or trailing characters; or
- a response-correlation selection defect.

Only the first category is reasonably repairable by prompting the model.

### RC-4: tests validate the halves, not the live seam

PR #36 added direct parser, normalizer, fixture, and offline loop coverage.
The real-Chromium M365-shaped reconstruction test remained legacy-only. It
asserts the reconstructed string but does not pass that string through
`CbaProtocolAdapter.parseModelTurn()`. Its legacy fixture also uses a body that
is not a complete valid internal wire message.

The suite therefore proves string parsing and legacy DOM reconstruction
separately, but not capture-to-normalization for either protocol dialect.

## Alternative hypotheses and source-free discrimination

The source defect is sufficient to cause the incident, but the current
diagnostic cannot exclude other failures that converge on
`MISSING_ENVELOPE`. The implementation and acceptance work must be able to
distinguish them without logging response content.

| Hypothesis | Source-free discriminator |
| --- | --- |
| Response capture threw and `safeString()` or a candidate catch converted the failure to empty text | capture exception enum, capture-attempt count, and captured byte length |
| The model emitted an indented fence or a fence with trailing characters instead of the exact token | booleans for any fence line, protocol token, indentation, and trailing characters |
| Response correlation selected the wrong assistant envelope from the rolling window | response count, selected index, and correlation-alignment branch |
| The read-only editor mounted before its protocol banner | per-sample editor/banner predicate booleans and the normal stability quorum |
| The model emitted a code block but not an exact supported protocol label | editor count plus exact-banner-match enum |
| The model emitted no protocol block | no editor, no exact banner, and no exact fence evidence |

A schema violation inside a correctly captured `cba-agent/1` envelope is
already excluded for the reported failure: it would reach
`model_intent_validation` and produce `SCHEMA_INVALID`, not
`MISSING_ENVELOPE`.

## User and product impact

- Correct Copilot output can fail before any requested project operation runs.
- Every failed repair consumes latency, budget, and another live M365 turn.
- The terminal blames exhausted protocol repair rather than identifying a
  browser-capture compatibility fault.
- Inspect-only and edit-capable tasks are both affected because the failure is
  before policy or tool execution.
- Offline tests can remain green while the supported visible-browser path is
  unusable.

## Goals

1. Correctly ingest exact `cba-agent/1` protocol widgets from the certified
   M365 response DOM.
2. Preserve legacy `cba/1` migration behavior without weakening its existing
   live-response correlation gates.
3. Preserve the distinction between executable protocol and inert quoted
   repository/chat content.
4. Surface source-free, stage-specific capture and parser diagnostics.
5. Spend model-repair budget only on conditions a new model response can
   plausibly fix.
6. Prove the full live-shaped path with zero-skip real-Chromium tests.
7. Complete a fresh authenticated Windows inspect task with zero protocol
   repairs before release.

## Non-goals

- Removing protocol labels or accepting arbitrary JSON that resembles an
  intent.
- Adding task, turn, message, or operation IDs back to the model-facing
  contract.
- Changing internal `cba/1` tool or policy semantics.
- Relaxing task-marker, response-baseline, assistant-envelope ownership, or
  nested-fence protections.
- Shipping a fence-free transport in v0.1.9.

## Product requirements

### P0 functional requirements

#### FR-019-01: dialect-aware protocol widget capture

The response capture layer must recognize exactly the supported protocol
dialects:

- `cba-agent/1`; and
- legacy `cba/1`.

For each dialect, the exact block-owned M365 language banner, body
discriminator, and reconstructed fence version must agree. A model-facing body
must never be wrapped in a legacy fence, and a legacy body must never be
wrapped in a model-facing fence.

#### FR-019-02: host-side reconstruction verification

The page evaluation may collect bounded structured widget facts, but the Node
host must construct and verify the executable envelope. It must prove:

- the assistant response owns the code block;
- the code block owns exactly one eligible read-only editor;
- exactly one supported, exact language banner belongs to that block;
- the body is bounded;
- line indices are unique, numeric, contiguous, and assembled in numeric order;
- no raw fence delimiter can escape the reconstructed wrapper;
- the reconstructed envelope has exactly one expected version; and
- the bytes inside the host-verified envelope exactly equal the captured editor
  bytes.

Full schema and semantic validation remains in the existing protocol layer.

#### FR-019-03: correlation identity remains stable across normalization

Response-sequence correlation must be derived from stable rendered-envelope
identity, not from a normalized string whose representation changes between
releases. The response snapshot should expose separate values for:

- correlation identity; and
- normalized protocol content.

Existing v0.1.8 response-baseline markers must either compare using their
original rendered-text semantics or fail with an explicit versioned recovery
diagnostic. Cope must never silently rebind a mismatched baseline.

#### FR-019-04: end-to-end diagnostic identity

Every protocol failure must preserve its actual `ProtocolParseError.protocolCode`
through:

- the audit event;
- the harness protocol-error payload when repairable;
- progress reporting;
- repair-budget state; and
- the terminal failure if recovery fails.

`MISSING_ENVELOPE` must not become `INVALID_ENVELOPE` or `INVALID_MESSAGE`.

#### FR-019-05: capture-aware repair routing

Cope must distinguish at least:

- rendered text with no owned protocol widget (parser-level model omission);
- `model_protocol_malformed`;
- `protocol_reconstructed`;
- `protocol_widget_incomplete`;
- `protocol_widget_ambiguous`;
- `protocol_widget_capture_failed`;
- `response_selection_ambiguous`; and
- `unsupported_capture_contract`.

A model-authored formatting error may use the bounded repair budget. A
recognized widget that cannot be safely captured, ambiguous widget ownership,
response-selection ambiguity, or capture-contract mismatch must stop or pause
on the first occurrence with an actionable browser/UI diagnostic and no
protocol-repair budget consumption.

#### FR-019-06: source-free observability

Capture diagnostics may record only bounded facts such as:

- enum reason and stage;
- response and chosen-envelope counts;
- code-block, editor, banner, and line counts;
- booleans for exact predicates;
- byte lengths;
- capture contract version; and
- cryptographic digests where correlation requires them.

They must never record URLs, prompt or response content, JSON fragments,
repository content, identity values, or banner text.

### P0 security requirements

#### SR-019-01: provenance is mandatory

JSON shape alone is never authority. `json`, plain-text, unlabeled,
wrong-language, repository-quoted, and nested protocol-looking blocks remain
inert even when they contain otherwise valid `cba-agent/1` or `cba/1` JSON.

#### SR-019-02: ambiguity fails closed

The following conditions must not produce an executable envelope:

- more than one eligible editor in a code block;
- duplicate, missing, negative, nonnumeric, or noncontiguous line indices;
- changed or ambiguously owned protocol banners;
- a body that exceeds its bound;
- a standalone captured line that could close or open the reconstructed
  protocol wrapper; or
- a page/candidate capture exception.

Capture ambiguity is not a model formatting repair and must not consume the
protocol-repair budget. Model-authored multiplicity, unsupported versions,
invalid JSON, dialect mismatch, and quoted-but-unowned protocol fences remain
inert but may consume the bounded formatting-repair budget.

#### SR-019-03: no authority crosses DOM ownership boundaries

Reconstruction runs only for the response signal and only inside the
correlated assistant envelope selected by the browser adapter. It cannot scan
the full document, user messages, the composer, identity controls, tool output,
or repository content for executable JSON.

### P1 operability requirements

#### OR-019-01: typed capture probe

Provide a read-only diagnostic path in `cope doctor` that exercises the
host-side capture lattice with a fixed, source-free synthetic fixture. It must
not open or read a live conversation, submit a prompt, mutate conversation
state, or disclose content.

#### OR-019-02: actionable terminal output

Terminal output for a non-repairable capture failure must state:

- that Cope could not safely read the protocol widget;
- the stable diagnostic code and stage;
- whether the session is preserved;
- whether retrying the same turn can help; and
- the exact operator next step.

The generic `Copilot exhausted the protocol-repair budget` message is
insufficient when the last cause is known.

## Implementation plan

### Slice 1: write the failing live-seam regressions

Before changing capture behavior:

1. Add a real-Chromium M365-shaped `cba-agent/1` response widget.
2. Assert that v0.1.8-style capture fails to reach
   `CbaProtocolAdapter.parseModelTurn()`.
3. Replace the existing legacy widget body with a valid internal `cba/1`
   message and assert capture-to-parse success.
4. Add the inert and ambiguous cases in the acceptance matrix below.
5. Update the Chromium safety inventory and expected test count so the new
   cases cannot skip silently.

### Slice 2: introduce a versioned response-capture contract

Refactor response snapshotting so page evaluation returns a bounded structured
result rather than directly deciding the executable string. Define one shared
Node-side dialect registry containing:

- version;
- exact expected M365 banner;
- bounded discriminator rule; and
- allowed model-facing root kinds where applicable.

Pass only the minimum immutable descriptor data into page evaluation. Assemble
the editor body by validated numeric line index. Build the fence and re-check
the envelope on the host. Keep rendered text separately for response-sequence
identity and compatibility with existing baselines.

Do not add fuzzy banner matching. A changed M365 banner is a UI contract change
that must produce a typed recertification diagnostic.

### Slice 3: propagate typed capture and parser failures

1. Add a source-free capture-evidence type to the response observation and
   completed transport result.
2. Stop using `safeString()` and the broad candidate catch as silent failure
   sinks for response capture. Convert response-specific failures to a stable
   enum while preserving fail-closed behavior for other semantic groups.
3. Carry the evidence into protocol normalization.
4. Pass the actual `ProtocolParseError.protocolCode` to
   `renderProtocolError()`.
5. Persist the last protocol code, stage, and source-free capture reason across
   repair attempts so budget exhaustion retains the causal failure.
6. Render capture faults distinctly from model-formatting faults in the CLI.

### Slice 4: correct repair policy

Use a small, explicit classification table:

| Failure class | Example | Repair turn? | Runtime action |
| --- | --- | --- | --- |
| model formatting | exact supported fence with invalid JSON or schema | yes | bounded protocol repair |
| model omission | no protocol widget or fence evidence | yes | bounded protocol repair |
| capture contract | exact supported banner but unsafe/failed reconstruction | no | pause/fail with UI diagnostic |
| ambiguity | multiple widgets, editors, or response alignments | no | fail closed and preserve evidence |
| correlation/resource | task/turn mismatch or oversized input | no | existing non-repairable path |

Do not infer or rewrite a materially different intent on the model's behalf.

### Slice 5: documentation and live release proof

1. Update `docs/PROTOCOL.md` with the two-dialect live capture rule and the
   separation between correlation identity and normalized content.
2. Update `docs/URGENT-WINDOWS-IDENTITY-READINESS.md`, whose current
   reconstruction requirement is legacy-only.
3. Add Cope 0.1.9 release notes and synchronize candidate version surfaces in
   the PR. Do not tag or publish the release until the live gates pass.
4. Run the complete offline, coverage, and zero-skip Chromium suites.
5. Run fresh authenticated Windows acceptance with an inspect-only task and
   zero protocol repairs.
6. Run the negative quoted-protocol test before tagging.

## Verification matrix

### Real Chromium

1. Exact `cba-agent/1` banner plus valid `agent_intent` body:
   capture, reconstruct, normalize, and return the expected operation.
2. Exact legacy `cba/1` banner plus valid wire body:
   capture, reconstruct, and parse through the live migration gate.
3. `json`, plain-text, unlabeled, absent-banner, and wrong-language widgets
   containing valid model-facing JSON remain inert.
4. Two protocol blocks in one assistant envelope fail with a typed ambiguity
   code and consume zero repair budget.
5. One protocol block with two eligible editors remains inert.
6. Reordered line nodes are sorted by validated indices; duplicate or gapped
   indices fail closed.
7. A late-mounted banner is not accepted on an earlier incomplete sample. The
   completed reconstruction must satisfy the normal response-stability quorum.
8. An injected page-evaluation failure produces a typed capture failure rather
   than an empty string.
9. A standalone wrapper-closing/opening fence line in captured editor content
   is rejected, while a triple-backtick sequence inside a valid JSON string is
   preserved and parses.
10. A four-envelope rolling window plus one new protocol response selects,
    reconstructs, and parses only the correlated final envelope.

### Unit and offline integration

11. Every documented `cba-agent/1` example parses and normalizes as written.
12. Indented, trailing-space, CRLF, truncated, nested, and multiple fences
    retain distinct expected parser codes.
13. `MISSING_ENVELOPE` survives runtime rendering, audit, repair, and terminal
    exhaustion without code remapping.
14. Capture-class failures are non-repairable and do not change
    `budgetUsage.protocolRepairs`.
15. Model-formatting failures remain bounded and repairable.
16. v0.1.8 response baselines have an explicit tested compatibility path under
    the new capture contract.
17. Scripted transcript replay covers a visually valid protocol widget that
    was previously normalized as fence-free rendered text.
18. The Chromium safety manifest includes every runtime Chromium test, and the
    zero-skip command proves all of them executed.

### Live release gates

19. A fresh Windows inspect task completes on the first parsed response with
    `protocolRepairs == 0`.
20. A second fresh task exercises at least one local read result and a final
    `agent_answer` or completion without a capture repair.
21. Quoted repository content containing a valid-looking `cba-agent/1` block
    does not execute.
22. No prompt, response, repository content, URL, or identity value appears in
    capture diagnostics, logs, audit events, or terminal output.
23. Full `npm run check`, coverage gates, release-version verification, and
    the installed-browser zero-skip suite pass.

## Acceptance checklist

- [x] `cba-agent/1` M365 widget reaches `parseModelTurn()` and normalizes.
- [x] Valid legacy `cba/1` widget reaches `parseModelTurn()`.
- [x] Fence version and body dialect cannot disagree.
- [x] Inert JSON/plain/unlabeled/quoted blocks never execute.
- [x] Ownership, multiplicity, line-index, size, and delimiter ambiguity fail
      closed.
- [x] Page output is re-verified by the host before it becomes executable.
- [x] Response correlation identity does not silently change because the
      display representation was normalized.
- [x] Capture diagnostics are typed, source-free, persisted, and actionable.
- [x] Actual parser codes survive end to end.
- [x] Capture faults consume zero model-repair budget.
- [x] Model-formatting faults retain bounded repair behavior.
- [x] Repair exhaustion retains the last underlying failure.
- [x] Transcript replay preserves production-shaped capture evidence.
- [x] All new Chromium tests are in the zero-skip manifest and execute.
- [ ] Fresh Windows live acceptance completes with zero protocol repairs.
- [ ] Negative quoted-protocol live acceptance remains inert.
- [x] Protocol, incident, and release documentation are synchronized.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Broader dialect matching promotes inert content | exact block-owned banner, assistant ownership, one editor, host verification, negative live gate |
| M365 changes banner or code-editor DOM again | typed capture contract and probe; fail closed with recertification guidance |
| New normalized text invalidates persisted response baselines | separate correlation identity from normalized content; version and test compatibility |
| Diagnostics leak chat or repository data | enums, counts, booleans, lengths, and digests only |
| Repair policy becomes too strict for model mistakes | distinguish absent protocol evidence from recognized-but-uncapturable widgets |
| Chromium regressions skip in CI | manifest inventory validation plus zero-skip execution |

## Deferred design: fence-free or structured transport

Removing Markdown fences may ultimately reduce presentation-layer fragility,
but it is not a parser convenience. Today the exact block-owned language
provenance separates executable model intent from quoted repository or chat
data. A fence-free design must provide an equivalent authenticated turn-bound
signal, likely a harness-issued per-turn challenge echoed by the model and
verified against the correlated assistant envelope.

That work requires its own PRD, protocol versioning decision, threat-model
update, compatibility fixtures, and negative prompt-injection review. It is
not a v0.1.9 scope item.

## Adversarial review record

Claude Code ran a read-only adversarial review with the Opus alias, confirmed
by its result metadata as `claude-opus-5`, using `--effort xhigh`. It rated the
source-level browser-capture incompatibility as proven and its attribution to
the reported run as strongly supported. The review required the following
changes to the initial plan:

- move typed capture diagnostics and repair routing into P0 alongside the
  reconstruction fix;
- require fence/body dialect parity across all three legacy couplings;
- parse the real-Chromium reconstructed payload instead of asserting only its
  string;
- repair the invalid legacy Chromium fixture;
- validate editor line indices and host-side bytes;
- make response-baseline compatibility an explicit release requirement; and
- defer fence-free ingestion as a separate security-contract change.

The first implementation checkpoint was then reviewed again by
`claude-opus-5` at extra-high effort and published on PR #37. Its
`CHANGES REQUIRED` findings drove these additional candidate changes:

- reject protocol fences quoted in ordinary editors or rendered prose before
  parser entry;
- treat partial widgets as pending until the normal streaming/stability quorum;
- detect changed and unsupported protocol-family banners structurally;
- carry source-free evidence through completed transport, audit, artifacts,
  crash recovery, and transcript replay;
- route model-authored version, multiplicity, JSON, and dialect errors through
  bounded repair without parsing rendered widget text;
- retry transient capture failures and fail closed only after the bounded
  response window;
- reproduce exact v0.1.8 legacy correlation trim/order semantics;
- accept contiguous zero- or one-based editor line indices; and
- add a read-only fixture probe to `cope doctor`.

## Immediate next steps

1. Complete full offline, coverage, release, and installed-browser verification.
2. Obtain explicit green reviews from Claude Opus 5 and the GitHub Codex
   reviewer on the immutable PR head.
3. Run Windows live positive and negative acceptance.
4. Merge the reviewed candidate only after both reviewer greens.
5. Tag or publish Cope 0.1.9 only after the Windows evidence is attached.
