# Model-facing `cba-agent/1` and internal `cba/1`

Cope 0.1.10 separates model intent from transport mechanics. Copilot emits the
small `cba-agent/1` model-facing contract. The deterministic harness owns
session correlation, generates identifiers, decides safe batching, and
normalizes the request into internal `cba/1`.

This preserves strict, auditable tool execution without asking the model to act
as the session-state manager or wire serializer.

The established envelopes remain version 1. Tool authority evolves through
strict additive contracts and the durable session grant; 0.1.10 adds
`terminal_exec` without an envelope-wide migration.

## Model-facing envelope

Every machine action or final answer contains exactly one fence whose opening
and closing lines are exact:

````text
```cba-agent/1
{"kind":"agent_intent", ...}
```
````

Prose may appear outside the fence. The parser does not execute a protocol-looking fence nested inside another Markdown fence. It rejects missing, multiple, empty, truncated, oversized, unsupported-version, invalid-JSON, and schema-invalid envelopes.

### Visible-browser capture

M365 may render a fenced response as a read-only code-editor widget whose
`innerText()` omits the Markdown fence. Cope reconstructs that presentation
only when the correlated assistant response owns exactly one supported
protocol widget whose single block-owned information banner carries exactly one
boundary-safe `cba-agent/1` or legacy `cba/1` protocol label, plus one eligible
editor. Provenance is the protocol label and its block ownership. Microsoft's
explanatory sentence around that label is mutable UI prose: it is recorded as
evidence, never enforced, so wording, punctuation, whitespace, capitalization,
and localization changes do not make a well-formed response non-executable. A
banner carrying more than one protocol label is ambiguous and stays inert. Page evaluation returns bounded structural
facts; trusted host code validates numeric contiguous line indices, sorts them
by index (from either zero or one), rejects ambiguity and standalone lines that
could collide with the outer protocol wrapper, requires the fence label and
body dialect to agree, constructs the wrapper, and verifies the exact version
and body bytes before protocol parsing. Triple backticks inside a valid JSON
string remain ordinary data and are preserved. A
partially mounted editor/banner/line set remains pending until the normal
streaming and response-stability quorum completes.

JSON shape is never capture authority. JSON, plain-text, unlabeled,
wrong-version, multiple-editor, multiple-block, malformed-line, or otherwise
ambiguous widgets remain inert. An exact protocol fence quoted inside an
ordinary code editor or rendered prose is rejected before parser entry.
Model-authored wrong-version, invalid-JSON, multiple-envelope, empty-body,
dialect, and quoted-but-unowned-fence errors receive bounded protocol repair;
unsafe ownership, capture, banner-contract, and response-selection conditions
produce a source-free, non-repairable browser-capture diagnostic without
consuming that budget.

The `response-capture/v2` evidence contains only stable enums, versions,
counts, line count, byte length, and bounded banner provenance: the banner
classification, its protocol-label count, whether the surrounding prose still
matches the recorded baseline wording, and a 32-bit identifier of the
label-masked, case- and whitespace-folded banner. That identifier makes a future
Microsoft wording change visible in evidence and audit without recording any
response content. It follows a completed response through
audit and integrity-checked crash recovery. Separate correlation text
reproduces the exact 0.1.8 legacy trimming and editor-order predicate so old
response baselines do not silently rebind when normalized protocol content has
a different display representation. `cope doctor` runs the same host
normalizer against fixed source-free fixtures, covering reconstruction and the
fail-closed banner branches; it does not read or mutate a live conversation. It
does not open a browser or render DOM, so it cannot attest live M365 widget or
banner compatibility — that seam is covered only by the installed-Chromium
capture tests.

The model-facing root is one of:

| `kind` | Purpose |
| --- | --- |
| `agent_intent` | request one typed tool action, or an `observe` set of independent reads |
| `agent_answer` | return a Markdown informational answer with evidence basis and limitations |
| `agent_blocked` | report a precise blocker, needed input/capability, and recoverability |
| `agent_progress` | report bounded non-terminal progress |

The model never supplies `task_id`, `turn_id`, `message_id`, or `operation_id`.
Those fields are generated deterministically from the active task/turn and the
validated intent. Replaying the same captured response produces the same
internal identities; a new turn produces different identities.

The normal model request is:

```cba-agent/1
{"kind":"agent_intent","intent":"list_files","arguments":{"path":"src","max_depth":2,"max_results":20},"reason":"Need a bounded source outline."}
```

Independent reads can be expressed without model-authored batching metadata:

```cba-agent/1
{"kind":"agent_intent","intent":"observe","observations":[{"tool":"git_status","arguments":{}},{"tool":"read_file","arguments":{"path":"README.md","max_bytes":12000}}],"reason":"Need independent repository state and project context."}
```

The harness accepts `observe` only for `list_files`, `search_text`,
`read_file`, `git_status`, and `git_diff`. It rejects dependent, mutating, or
command intents in an observation set. `edit_text`, `apply_patch`,
`run_command`, `terminal_exec`, `request_user_input`, `request_capability`, and
`complete_task` remain single-action intents.

Harness results are authoritative `cba-agent/1` data blocks with stable
`operation_ref` values. Denials include retryability and whether a capability
request could help. Protocol diagnostics identify their stage, structured
details, repairability, and suggested action.

## Internal `cba/1`

The harness normalizes model-facing messages into the existing strict `cba/1`
wire types: `tool_request`, `user_input_request`, `capability_request`,
`progress_update`, `completion`, and `blocked`. Internal messages contain the
canonical task, numeric turn, message, and operation identifiers and pass the
same schema, policy, duplicate-ID, direction, and semantic validation as before.

Historical model-authored `cba/1` envelopes remain accepted during migration.
Stale correlation may be rebound only for a fresh visible-browser response
whose task marker and response baseline were already proven. Rebinding is
audited as `protocol.normalized`; offline fixtures and cached recovery replay
remain strict and reject stale task or turn identity.

`list_files.max_results` defaults to 20 when omitted; the bootstrap example states
that bound explicitly. Policy may impose a lower per-operation file ceiling.
Oversized disclosure denials name the exact byte/file dimension, limit, and
requested amount so Copilot can retry a smaller operation instead of confusing
the hard per-operation ceiling with the cumulative disclosure budget.
The repository-wide read pattern `**` includes the repository root (`.`), so the
bootstrap inventory call does not require a redundant path approval.

## Current tools

| Tool | Purpose | Consequential behavior |
| --- | --- | --- |
| `list_files` | bounded repository-relative inventory | read-only; ignores and policy exclusions apply |
| `search_text` | bounded literal text search | read-only; excerpts are disclosure-scanned; regex mode is rejected in `cba/1` |
| `read_file` | bounded text/file-range read with state metadata | read-only; content enters the disclosure ledger |
| `git_status` | branch, revision, conflicts, and working-tree facts | read-only; distinguishes pre-existing state |
| `git_diff` | bounded approved diff against a local scope/baseline | read-only; exclusions and truncation are explicit |
| `edit_text` | exact old-to-new replacement in one existing text file | base hash, occurrence count, policy, checkpoint, rollback, and post-state verification |
| `apply_patch` | one atomic create/update/delete transaction | exact hashes, policy, checkpoint, rollback, and post-state verification |
| `run_command` | invoke one catalog ID with typed parameters | no shell; controlled cwd, environment, time, output, cancellation; repository integrity is checked before and after every command |
| `terminal_exec` | run one `terminal-exec/1` shell or argv invocation | Developer grant only; current-user process, project-relative cwd, live local output, durable bounded result, pre/post effect observation, and no blind replay |
| `request_user_input` | ask for unavailable information or judgment | pauses; not routine confirmation |
| `request_capability` | request a bounded session-grant expansion | organization/repository denies remain non-overridable |
| `complete_task` | submit an advisory completion report | local verifier decides acceptance |

The bootstrap contains the authoritative JSON Schemas. The summary below highlights safety semantics; it is not a substitute for those schemas.

### `git_diff` scopes

`git_diff` accepts an optional repository-relative `paths` filter and bounded `max_bytes`. Its scopes are deterministic:

| Scope | Baseline |
| --- | --- |
| `working_tree` | unstaged worktree changes; an explicit `baseline: "HEAD"` includes the complete HEAD-to-worktree delta |
| `staged` | index changes; no explicit revision is accepted |
| `checkpoint` | one integrity-verified checkpoint before-image; `baseline` is a checkpoint ID, or omission selects the session's current checkpoint |
| `session` | for every agent-mutated path, the before-image from the earliest checkpoint that captured that path |

Checkpoint and session comparisons are implemented in the repository layer and do not invoke or depend on the browser transport. Every concrete path is checked again against the current exact read policy after the baseline inventory is resolved. Denied descendants are omitted and represented only by `excludedCount`; their names and bytes are never returned. Output and compared input are bounded, binary changes use content-free markers, and the normal disclosure guard still scans the complete diff result before it is submitted to Copilot.

## Hash-guarded mutation example

An update supplies the SHA-256 of the exact bytes returned by the prior read:

```cba/1
{"protocol":"cba/1","message_type":"tool_request","message_id":"m_22","task_id":"task_example","turn_id":4,"operations":[{"operation_id":"op_22_patch","tool":"apply_patch","arguments":{"changes":[{"kind":"update","path":"src/parser.ts","base_sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","content":"export function parse(value: string): string {\n  return value.trim();\n}\n"}]}}]}
```

The request conflicts if the file changed after it was read. A transaction cannot contain two changes whose normalized paths collide.

For a small replacement, prefer `edit_text`. It treats `old_text` literally and succeeds only when both the exact byte hash and the number of non-overlapping occurrences match. It uses the same atomic `PatchEngine` checkpoint, rollback, budget, and post-state verification path as `apply_patch`:

```cba/1
{"protocol":"cba/1","message_type":"tool_request","message_id":"m_21","task_id":"task_example","turn_id":3,"operations":[{"operation_id":"op_21_edit","tool":"edit_text","arguments":{"path":"src/parser.ts","base_sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","old_text":"return value;","new_text":"return value.trim();","expected_occurrences":1}}]}
```

## Catalog command example and current boundary

Copilot selects a catalog ID, not an executable or command line. This example assumes repository onboarding defines `analysis.readonly-check` and establishes that it is genuinely repository-read-only:

```cba/1
{"protocol":"cba/1","message_type":"tool_request","message_id":"m_27","task_id":"task_example","turn_id":6,"operations":[{"operation_id":"op_27_check","tool":"run_command","arguments":{"command_id":"analysis.readonly-check","timeout_ms":300000}}]}
```

The local catalog resolves the fixed executable/arguments, typed parameters, working directory, environment, output limit, accepted exit codes, side-effect and network facts, and maximum timeout. Model-supplied arguments cannot introduce flags unless that parameter definition explicitly permits them.

The current `cba/1` definition exposes `sideEffects: boolean`. In `edit`/`auto`, an explicitly granted `sideEffects: true` command may run and may create ordinary Git-ignored build products. Those products are excluded from the completion source fingerprint. Every command is bracketed by nested-Git plus Git-visible, nonignored policy-hidden, protected-path, and Git-control integrity checks. A definition marked `sideEffects: false` additionally inventories ordinary Git-ignored files under fixed entry and byte bounds. Tracked/nonignored, protected, control, or nested-boundary drift—or an unverifiable inventory—raises `RECOVERY_REQUIRED` with reason `COMMAND_UNDECLARED_REPOSITORY_MUTATION` where applicable, and the command outcome is not accepted as trusted validation.

This is a detection boundary, not a command-write transaction or an OS
sandbox. Intentional source mutation remains unsupported through
`run_command`; use `terminal_exec` in an authorized Developer session, or use
`edit_text`/`apply_patch` for stronger typed checkpoint and rollback
guarantees. Approved executables and transitive scripts remain trusted
computing base, and filesystem writes outside the repository cannot be
comprehensively prevented or observed by this runtime.

## Result and denial

Results are actual local outcomes, not Copilot interpretations:

```cba/1
{"protocol":"cba/1","message_type":"tool_result","message_id":"h_result_6","task_id":"task_example","turn_id":6,"results":[{"operation_id":"op_27_check","tool":"run_command","status":"failure","error":{"code":"COMMAND_FAILURE","message":"The approved command exited with code 1.","details":{"exit_code":1,"truncated":false}}}]}
```

Tool outcome statuses are `success`, `failure`, `conflict`, `timeout`, `cancelled`, and `indeterminate`. Authorization failures use a structured `tool_denial` with decision `ask` or `deny`, stable reason code, and bounded explanation.

An `ask` response is not permission. For an exact waiting tool operation, `allow_once` authorizes only that operation and does not mutate the session grant. `allow_session` performs a bounded grant mutation, persists the new grant/hash and approval key, and can prevent repeat prompts for that capability during this task. A standalone `request_capability` has no concrete operation to which a one-shot decision can bind, so `allow_once` is explicitly ineffective there; Copilot must request the actual operation. Neither choice can override an organization or repository denial.

## Protocol repair

The harness returns a `protocol_error` containing the parser's exact stable
error code, a concise repair message, whether the condition is repairable, and
the active task/turn. The same code appears in progress, audit, repair, and
terminal exhaustion diagnostics. It never repairs a materially different
request on Copilot's behalf. A reminder reinforces exact fencing, correlation,
and unique IDs. Consecutive model-formatting repair attempts consume a budget;
browser capture and response-selection failures stop or pause without charging
that budget.

Important errors include:

- `MISSING_ENVELOPE`, `MULTIPLE_ENVELOPES`, `TRUNCATED_ENVELOPE`;
- `UNSUPPORTED_VERSION`, `INVALID_JSON`, `SCHEMA_INVALID`;
- `TASK_MISMATCH`, `TURN_MISMATCH`;
- `UNKNOWN_MESSAGE_TYPE`, `UNKNOWN_TOOL`;
- `DUPLICATE_OPERATION_ID`, `INVALID_BATCH`; and
- `INPUT_TOO_LARGE`.

Task/turn mismatch and oversized input are not silently retried as ordinary formatting mistakes because correlation or resource integrity is uncertain.

## User input and authority requests

`request_user_input` names the question, why repository tools cannot answer it, optional structured choices, and whether free-form text is allowed.

`request_capability` names exactly one target category:

- repository path plus read/write/create/delete access;
- command catalog identifiers;
- disclosure classifications;
- network host(s);
- create/delete/dependency-manifest/local-commit change class;
- one budget metric and requested limit; or
- tool name(s).

It also states the expected operation and risk. The request cannot alter configuration, the audit trail, protected paths, credential controls, or a higher-layer deny.

User-input and capability decisions are integrity-protected as local recovery artifacts before their effects are replayable after a crash. They may contain sensitive free-form text and never become policy authority beyond the exact one-shot binding or persisted session expansion described above.

## Completion

A work completion report includes summary, per-criterion status/evidence,
per-command interpreted validation, skipped validation, remaining risks, and
follow-up. Its internal `verified` field is false until the harness verifies
local truth. `agent_answer` uses the same local verifier with `kind: answer`,
and is accepted only when the task has not mutated project files.

The runtime rejects completion when repository state is unknown, a path is out of scope, an operation remains unresolved, delivery is indeterminate, required validation is missing/failed/stale, or the report is structurally incomplete. The rejection is another tool result, allowing Copilot to request the needed inspection or validation.

## Developer mode: additive terminal contract

Cope 0.1.10 keeps the proven `cba-agent/1` envelope, browser response capture,
task correlation, and repair behavior and adds `terminal_exec` with required,
independently versioned discriminator `terminal-exec/1`.

The addition does not reinterpret catalog-backed `run_command` and does not
require `cba-agent/2`. A terminal request is executable only when it appears in
the strict top-level intent and the durable session grant contains the tool.
Existing sessions gain nothing merely because the installed binary knows the
schema.

Representative shell request:

```cba-agent/1
{"kind":"agent_intent","intent":"terminal_exec","arguments":{"contract":"terminal-exec/1","mode":"shell","command":"npm install && npm test","cwd":".","timeout_ms":900000,"max_output_bytes":1048576},"reason":"Install declared dependencies and run the project test suite."}
```

Representative direct-argument request:

```cba-agent/1
{"kind":"agent_intent","intent":"terminal_exec","arguments":{"contract":"terminal-exec/1","mode":"argv","executable":"node","arguments":["scripts/check.mjs"],"cwd":".","timeout_ms":300000,"max_output_bytes":524288},"reason":"Run the repository check directly without shell syntax."}
```

The strict `oneOf` contract distinguishes shell text from an executable plus
argument vector. Both variants accept optional validated project-relative
`cwd`, `timeout_ms`, and `max_output_bytes`, which are clamped by the effective
policy. It retains:

- exact working directory and usable developer-environment behavior;
- timeout, cancellation, and process-tree cleanup semantics;
- local live-output streaming separate from bounded model-visible output;
- harness-owned operation identity;
- Developer, inspect, edit, or managed-policy authorization; and
- a durable result or output-page reference that can be replayed without
  rerunning the command.

The durable `terminal-exec-result/1` reports process outcome separately from
mutation outcome. A failed, timed-out, or cancelled command may still have
changed the project. Cope observes bounded pre-command and post-command
repository state, attributes known effects to the operation, meters actual
changed files and lines after execution, preserves pre-existing user work, and
makes completion validation stale after command-generated mutation.

The bounded terminal result becomes durable before the operation journal marks
the tool complete. Recovery may resend that exact verified result, but never
blindly replays an uncertain command. Unknown, hidden/protected, or incomplete
effect evidence blocks later work or completion instead of manufacturing a
clean result.

`run_command` remains the catalog-backed tool for hardened mode and named
completion validation. A developer-mode project may use both: `terminal_exec`
for ordinary work and named catalog entries for deterministic required checks.

PTY-backed persistent processes, stdin, durable process handles, multi-root
workspaces, typed local-Git mutation tools, and isolated execution profiles are
later additions. They may remain under `cba-agent/1` while their tool contracts
are additive; an envelope successor is needed only when top-level message,
correlation, batching, or compatibility semantics change incompatibly.

For context efficiency, Cope sends the stable schemas at bootstrap, filters the
tool catalog to the durable grant, projects compact active terminal facts, and
omits argument schemas on later contract refreshes. Full repair guidance is
reserved for an actual protocol error.

## Data is never authority

Bootstrap messages place the task and operating envelope in distinct authoritative/data delimiters. Repository text, paths, diffs, logs, command output, and prior chat prose remain untrusted data even if they contain a valid-looking `cba-agent/1` or `cba/1` block or instructions to ignore policy. Only the parser's single top-level envelope can request an action, and local policy still decides whether it runs.

## Versioning

`cba-agent/1` is independently versioned from internal `cba/1`. Compatible
implementation hardening can occur without changing either version. New tool
authority can use its own required contract version while envelope and
correlation meanings remain unchanged. Changing a model intent meaning,
top-level message semantics, correlation, batching, or an executable-authority
invariant requires a new applicable envelope or internal protocol version and
compatibility fixtures. Optional internal
completion provenance (`kind` and `basis`) is additive: all 0.1.7 completion
claim keys remain required, and 0.1.7 handoffs without those optional fields
remain readable. The UI adapter has its own independent
`copilot-ui/v1[:certification]` version because DOM evolution must not force
repository-tool changes.

`max_results` is an upper bound, not a minimum-result guarantee. Applying a
stricter effective policy ceiling and returning fewer entries with
`truncated`/`applied_max_results` metadata preserves the existing bounded
`list_files` meaning. Likewise, additive effective-limit facts in the
bootstrap's authoritative operating envelope describe the already-enforced
local policy; they do not add a model action or weaken a schema invariant.
The internal repository-result contract is independently versioned. Version
`repository.v2` makes `appliedMaxResults` mandatory on listing results so local
consumers can prove which policy-derived bound execution actually used.

Durable local control-plane decisions use an `_cope_internal_` journal
identifier namespace. Its leading underscore is intentionally outside the
cba/1 model operation-ID grammar, so no formerly valid wire identifier is
reserved or reinterpreted. This prevents untrusted requests—including
case-folded names on Windows—from colliding with journaled recovery authority.

Browser product selection is deliberately outside this wire contract. Edge and Chrome use the same bootstrap, envelopes, tool meanings, submission correlation, response capture, classifier, and agent loop. Browser product, executable identity, dedicated profile, and browser/UI contract are local configuration/runtime concerns. The persisted runtime-manifest value `edge` remains a compatibility discriminator for the live visible-browser transport, including Chrome-backed sessions; it is not a product claim and is not emitted to the model or users. Adding Chrome therefore does not change `cba/1` semantics.
