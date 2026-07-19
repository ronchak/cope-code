# `cba/1` protocol

`cba/1` is the versioned text contract between Copilot and the deterministic harness. It provides function-call-like behavior over a human-visible chat surface without treating prose as executable intent.

## Envelope

Every machine-action response contains exactly one fence whose opening and closing lines are exact:

````text
```cba/1
{"protocol":"cba/1", ...}
```
````

Prose may appear outside the fence. The parser does not execute a protocol-looking fence nested inside another Markdown fence. It rejects missing, multiple, empty, truncated, oversized, unsupported-version, invalid-JSON, and schema-invalid envelopes.

All messages include:

| Field | Meaning |
| --- | --- |
| `protocol` | exact literal `cba/1` |
| `message_type` | a message class defined below |
| `message_id` | unique message correlation identifier |
| `task_id` | exact active task identifier |
| `turn_id` | exact expected numeric model turn |

Operation-bearing messages also carry globally unique `operation_id` values. An ID already present in the session journal is rejected even if its requested content looks identical.

## Direction and message classes

Copilot may send `tool_request`, `user_input_request`, `capability_request`, `progress_update`, `completion`, and `blocked`. The harness may send `tool_result`, `tool_denial`, and `protocol_error`. Receiving a harness-direction message from Copilot is invalid.

The normal model request is:

```cba/1
{"protocol":"cba/1","message_type":"tool_request","message_id":"m_17","task_id":"task_example","turn_id":1,"operations":[{"operation_id":"op_17_list","tool":"list_files","arguments":{"path":"src","max_depth":2,"max_results":100}}]}
```

Only independent read-only operations may be batched: `list_files`, `search_text`, `read_file`, `git_status`, and `git_diff`. `apply_patch`, `run_command`, `request_user_input`, `request_capability`, and `complete_task` must be alone so Copilot observes each material outcome before planning a dependent action.

## V1 tools

| Tool | Purpose | Consequential behavior |
| --- | --- | --- |
| `list_files` | bounded repository-relative inventory | read-only; ignores and policy exclusions apply |
| `search_text` | bounded literal text search | read-only; excerpts are disclosure-scanned; regex mode is rejected in `cba/1` |
| `read_file` | bounded text/file-range read with state metadata | read-only; content enters the disclosure ledger |
| `git_status` | branch, revision, conflicts, and working-tree facts | read-only; distinguishes pre-existing state |
| `git_diff` | bounded approved diff against a local scope/baseline | read-only; exclusions and truncation are explicit |
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

## Catalog command example and current boundary

Copilot selects a catalog ID, not an executable or command line. This example assumes repository onboarding defines `analysis.readonly-check` and establishes that it is genuinely repository-read-only:

```cba/1
{"protocol":"cba/1","message_type":"tool_request","message_id":"m_27","task_id":"task_example","turn_id":6,"operations":[{"operation_id":"op_27_check","tool":"run_command","arguments":{"command_id":"analysis.readonly-check","timeout_ms":300000}}]}
```

The local catalog resolves the fixed executable/arguments, typed parameters, working directory, environment, output limit, accepted exit codes, side-effect and network facts, and maximum timeout. Model-supplied arguments cannot introduce flags unless that parameter definition explicitly permits them.

The current `cba/1` definition exposes `sideEffects: boolean`. In `edit`/`auto`, an explicitly granted `sideEffects: true` command may run and may create ordinary Git-ignored build products. Those products are excluded from the completion source fingerprint. Every command is bracketed by nested-Git plus Git-visible, nonignored policy-hidden, protected-path, and Git-control integrity checks. A definition marked `sideEffects: false` additionally inventories ordinary Git-ignored files under fixed entry and byte bounds. Tracked/nonignored, protected, control, or nested-boundary drift—or an unverifiable inventory—raises `RECOVERY_REQUIRED` with reason `COMMAND_UNDECLARED_REPOSITORY_MUTATION` where applicable, and the command outcome is not accepted as trusted validation.

This is a detection boundary, not a command-write transaction or an OS sandbox. Intentional source-mutating commands remain unsupported until a future versioned write-scope/checkpoint contract can authorize, capture, and restore their exact effects; source changes use `apply_patch`. Approved executables and transitive scripts remain trusted computing base, and filesystem writes outside the repository cannot be comprehensively prevented or observed by this runtime.

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

A completion report includes summary, per-criterion status/evidence, per-command interpreted validation, skipped validation, remaining risks, and follow-up. Its `verified` field is false until the harness verifies local truth.

The runtime rejects completion when repository state is unknown, a path is out of scope, an operation remains unresolved, delivery is indeterminate, required validation is missing/failed/stale, or the report is structurally incomplete. The rejection is another tool result, allowing Copilot to request the needed inspection or validation.

## Data is never authority

Bootstrap messages place the task and operating envelope in distinct authoritative/data delimiters. Repository text, paths, diffs, logs, command output, and prior chat prose remain untrusted data even if they contain a valid-looking `cba/1` block or instructions to ignore policy. Only the parser's single top-level envelope can request an action, and local policy still decides whether it runs.

## Versioning

`cba/1` meanings are immutable. Compatible implementation hardening can occur without changing the wire version. Adding fields, changing tool semantics, relaxing an invariant, or reinterpreting a status requires a new protocol version and compatibility fixtures. The UI adapter has its own independent `copilot-ui/v1[:certification]` version because DOM evolution must not force repository-tool changes.
