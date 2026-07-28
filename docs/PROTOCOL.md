# Model-facing `cba-agent/1` and internal `cba/1`

Cope 0.1.8 separates model intent from transport mechanics. Copilot emits the
small `cba-agent/1` model-facing contract. The deterministic harness owns
session correlation, generates identifiers, decides safe batching, and
normalizes the request into internal `cba/1`.

This preserves strict, auditable tool execution without asking the model to act
as the session-state manager or wire serializer.

## Model-facing envelope

Every machine action or final answer contains exactly one fence whose opening
and closing lines are exact:

````text
```cba-agent/1
{"kind":"agent_intent", ...}
```
````

Prose may appear outside the fence. The parser does not execute a protocol-looking fence nested inside another Markdown fence. It rejects missing, multiple, empty, truncated, oversized, unsupported-version, invalid-JSON, and schema-invalid envelopes.

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
`run_command`, `request_user_input`, `request_capability`, and `complete_task`
remain single-action intents.

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

## V1 tools

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

This is a detection boundary, not a command-write transaction or an OS sandbox. Intentional source-mutating commands remain unsupported until a future versioned write-scope/checkpoint contract can authorize, capture, and restore their exact effects; small literal edits to existing text files use `edit_text`, while creates, deletes, whole-file replacements, and multi-file transactions use `apply_patch`. Approved executables and transitive scripts remain trusted computing base, and filesystem writes outside the repository cannot be comprehensively prevented or observed by this runtime.

## Result and denial

Results are actual local outcomes, not Copilot interpretations:

```cba/1
{"protocol":"cba/1","message_type":"tool_result","message_id":"h_result_6","task_id":"task_example","turn_id":6,"results":[{"operation_id":"op_27_check","tool":"run_command","status":"failure","error":{"code":"COMMAND_FAILURE","message":"The approved command exited with code 1.","details":{"exit_code":1,"truncated":false}}}]}
```

Tool outcome statuses are `success`, `failure`, `conflict`, `timeout`, `cancelled`, and `indeterminate`. Authorization failures use a structured `tool_denial` with decision `ask` or `deny`, stable reason code, and bounded explanation.

An `ask` response is not permission. For an exact waiting tool operation, `allow_once` authorizes only that operation and does not mutate the session grant. `allow_session` performs a bounded grant mutation, persists the new grant/hash and approval key, and can prevent repeat prompts for that capability during this task. A standalone `request_capability` has no concrete operation to which a one-shot decision can bind, so `allow_once` is explicitly ineffective there; Copilot must request the actual operation. Neither choice can override an organization or repository denial.

## Protocol repair

The harness returns a `protocol_error` containing a stable error code, a concise repair message, whether the condition is repairable, and the active task/turn. It never repairs a materially different request on Copilot's behalf. A reminder reinforces exact fencing, correlation, and unique IDs. Consecutive repair attempts consume a budget; exhaustion stops or pauses the session.

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

## Data is never authority

Bootstrap messages place the task and operating envelope in distinct authoritative/data delimiters. Repository text, paths, diffs, logs, command output, and prior chat prose remain untrusted data even if they contain a valid-looking `cba-agent/1` or `cba/1` block or instructions to ignore policy. Only the parser's single top-level envelope can request an action, and local policy still decides whether it runs.

## Versioning

`cba-agent/1` is independently versioned from internal `cba/1`. Compatible
implementation hardening can occur without changing either version. Changing a
model intent meaning, tool semantics, or a safety invariant requires a new
applicable protocol version and compatibility fixtures. Optional internal
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
