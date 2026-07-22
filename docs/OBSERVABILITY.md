# Source-free OpenTelemetry observability

Cope can optionally mirror bounded operational telemetry to an OpenTelemetry SDK or OTLP adapter. This channel is disabled unless a caller supplies an `ObservabilityExporter` during runtime composition. It is an operational convenience only: the local hash-chained audit log remains authoritative and is always initialized independently.

## Safety contract

The reporter uses a closed projection. It does not serialize arbitrary runtime objects. Exported attributes are limited to fixed enums for runtime kind, session state, model response state, tool name, tool outcome, and completion acceptance. Exported measurements are non-negative aggregate byte/file/command/rejection counts.

The following are never exported:

- source, diffs, file contents, paths, filenames, or tool output;
- task objectives, acceptance criteria, model text, summaries, reasons, user answers, or permission rationale;
- prompts, secrets, environment variables, command arguments, repository identity, session/task/turn/operation IDs, or audit records.

Unknown strings are dropped instead of being treated as attributes. This prevents a future or malformed producer from smuggling text through a nominal tool/status field.

## OpenTelemetry mapping

`ObservabilityRecord` maps directly to an OpenTelemetry log event or metric point:

| Record signal | Suggested OpenTelemetry mapping |
| --- | --- |
| `event` | log record/event with `name`, timestamp, and attributes |
| `counter` | monotonic counter addition with `value` and attributes |
| `histogram` | histogram recording with `value` and attributes |

Names use the `cope.*` namespace. Timestamps are Unix nanoseconds encoded as decimal strings, matching OTLP's 64-bit timestamp representation. Adapters should translate these records into their installed OpenTelemetry SDK; Cope deliberately does not add an SDK or network dependency.

```ts
const exporter: ObservabilityExporter = {
  async export(records, signal) {
    // Translate records to the organization's configured OTel SDK/OTLP exporter.
    // Honor signal cancellation and do not enrich with source-bearing context.
  },
};

await composeRuntime({ ...options, observabilityExporter: exporter });
```

## Bounds and failure behavior

Defaults are a 256-record queue, 32-record batches, and a one-second export deadline. Callers may reduce them within the supported bounds. A full queue drops new telemetry. Rejection, exception, or timeout drops the affected batch. Export and shutdown failures are counted in local in-memory reporter statistics but never fail, pause, authorize, or change an agent operation.

`flush()` and `shutdown()` are safe lifecycle conveniences and resolve even when the exporter fails. The exporter receives an abort signal on deadline. Because JavaScript cannot forcibly terminate arbitrary exporter code, production adapters must honor that signal and must not perform synchronous blocking work.

Observability never replaces, modifies, forwards, or weakens `audit.jsonl`. Operators should retain and verify the local audit according to the recovery and incident procedures even when external telemetry is enabled.
