# `cope-events/1` operational event stream

Cope exposes a stable, source-free JSON Lines stream for runtime progress. When a task is run or resumed with `--json`, stdout retains the existing single final-result JSON object for compatibility. Runtime events are written to stderr as one compact JSON object per line.

The normative event shape is published as [`cope-events-v1.schema.json`](cope-events-v1.schema.json).

The first stderr event is `stream.started`. It declares the schema version and capability flags. Later events use monotonically increasing `sequence` values:

```json
{"schema_version":"cope-events/1","sequence":1,"timestamp":"2026-07-21T12:00:00.000Z","event":"stream.started","capabilities":{"runtime_progress":true,"source_free":true,"ordered_sequence":true,"stdout_legacy_result":true,"interactive_requests":false},"data":{}}
{"schema_version":"cope-events/1","sequence":2,"timestamp":"2026-07-21T12:00:01.000Z","event":"runtime.progress","data":{"kind":"tool","status":"running","turn_id":"turn_0001","operation_id":"op_status","tool":"git_status","outcome":"success"}}
```

## Stream guarantees

- Every event is a complete UTF-8 JSON object terminated by `\n`.
- `schema_version` is exactly `cope-events/1`; incompatible changes require a new version.
- `sequence` starts at 1 for each CLI invocation and increases by one.
- Events contain operational metadata only. Source text, model text, tool output, diffs, objectives, user answers, capability reasons, and filesystem contents are not admitted to the event projection.
- A progress-rendering failure is observational and cannot change agent execution.
- Unknown event names and unknown capability flags must be ignored by forward-compatible consumers.

## stdout and stderr

| Mode | stdout | stderr |
| --- | --- | --- |
| normal terminal mode | existing human presentation | errors and diagnostics |
| `--json` run/resume | existing final-result JSON object | `cope-events/1` runtime JSONL; interactive prompts or emergency diagnostics may also appear because `interactive_requests` is `false` |
| other `--json` commands | existing command-specific JSON object | errors and diagnostics |

Consumers needing unattended operation must preapprove the initial grant and treat `interactive_requests: false` as a signal that a human interaction cannot yet be represented on this event stream. They should parse only stderr lines whose `schema_version` is `cope-events/1`; stdout remains the compatibility result channel and is not part of this event schema.

## `runtime.progress` data

The `kind` discriminator is one of `state`, `model`, `tool`, or `completion`. Common fields are the current source-free session `status` and optional opaque `turn_id` / `operation_id`. Each kind exposes only bounded metadata:

- `state`: `from`, `to`, and `has_reason` (never the reason text)
- `model`: response status and byte count, never model content
- `tool`: tool name and outcome, never arguments or output
- `completion`: acceptance and aggregate file/command/rejection counts, never summaries or diffs
