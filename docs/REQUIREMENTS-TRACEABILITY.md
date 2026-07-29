# Requirements traceability

## Purpose

This matrix separates the target developer-mode requirements from the current 0.1.9 implementation. It is planning and traceability evidence, not a release or live-certification claim.

Platform-specific implementation and live evidence remain in [WINDOWS-TARGET.md](WINDOWS-TARGET.md), [MACOS-TARGET.md](MACOS-TARGET.md), and [LIVE-PILOT-ACCEPTANCE.md](LIVE-PILOT-ACCEPTANCE.md).

Status values are:

- `implemented`: present in the current codebase;
- `partial`: useful foundation exists but does not satisfy the target;
- `planned`: target requirement with no complete implementation;
- `retained`: current control should remain through the pivot.

A base status may include a short scope qualifier when only a named subsystem
implements it or the work belongs after the MVP.

## Product and experience

| ID | Requirement | Status | Current evidence or gap |
| --- | --- | --- | --- |
| DM-001 | Cope presents a local coding-agent experience through a visible Microsoft 365 Copilot Chat session. | implemented | Browser transport, CLI, agent loop, and typed model intents exist. |
| DM-002 | Developer mode is the recommended default for ordinary project work. | planned | Current modes and generated policies remain hardened and catalog-oriented. |
| DM-003 | One concise initial grant authorizes normal project work and accurately states that shell commands are not sandboxed. | partial | Initial grants exist, but current command and network authority is narrow and developer-mode risk presentation is absent. |
| DM-004 | The agent should ask only for genuinely missing information or materially new authority. | partial | User and capability requests exist; current policy creates avoidable denials for normal developer actions. |
| DM-005 | Progress and completion distinguish model claims from observed local facts. | implemented | Runtime progress, operation results, completion verification, and handoff records exist. |

## Repository capability

| ID | Requirement | Status | Current evidence or gap |
| --- | --- | --- | --- |
| DM-010 | Read, list, and search project files. | implemented | `list_files`, `search_text`, and `read_file` exist with bounded results. |
| DM-011 | Inspect working-tree status and diffs. | implemented | `git_status` and bounded `git_diff` exist. |
| DM-012 | Create, update, and delete regular project text files. | implemented | `edit_text` and `apply_patch` use hash guards and checkpoints. |
| DM-013 | Move and rename files as first-class typed mutations. | planned | Not exposed as a dedicated tool. |
| DM-014 | Permit explicit additional typed-tool workspace roots. | planned | Current model is one canonical repository. |
| DM-015 | Preserve and report pre-existing user changes separately. | implemented | Baseline and final handoff distinguish pre-existing and task-attributed state. |
| DM-016 | Support the host filesystem where recovery is reliable rather than imposing universal Windows-safe restrictions. | partial | Host identity support exists, but path and file constraints remain deliberately conservative. |

## Terminal and process capability

| ID | Requirement | Status | Current evidence or gap |
| --- | --- | --- | --- |
| DM-020 | Execute ordinary developer commands through explicit shell mode. | planned | Shells and command shims are currently prohibited. |
| DM-021 | Execute commands through direct executable and argv mode. | partial | `ProcessRunner` supports direct execution, but only through cataloged definitions and typed parameters. |
| DM-022 | Use the selected project as the default working directory. | implemented foundation | Catalog commands support validated repository working directories. |
| DM-023 | Stream command output locally while bounding the result sent to Copilot. | planned | Current output is buffered until process completion. |
| DM-024 | Support stdin and PTY-backed interactive processes. | planned after MVP | Current child stdin is ignored and no PTY exists. |
| DM-025 | Start, inspect, write to, and stop persistent processes. | planned after MVP | Current runner supports only one-shot process lifetime. |
| DM-026 | Cancel child process trees on pause and abort. | partial | Process-tree cancellation and macOS supervision exist; persistent process recovery is not implemented. |
| DM-027 | Permit normal network-dependent developer commands. | planned | Default policy denies network. |
| DM-028 | Preserve timeouts, output limits, and truthful exit or signal state. | retained | Current process runner provides these controls. |
| DM-029 | Inherit a usable developer environment without copying Cope-internal control state. | planned | Current runner inherits a small hardened environment that omits many normal developer variables. |

## Command-generated mutations

| ID | Requirement | Status | Current evidence or gap |
| --- | --- | --- | --- |
| DM-030 | Commands may intentionally create, update, delete, and rename project files. | planned | Current command boundary converts Git-visible mutation into recovery-required state. |
| DM-031 | Capture project state before and after a command. | partial | Current command boundary captures integrity state, but uses it to prohibit source changes. |
| DM-032 | Attribute observed command-generated changes to the operation. | planned | No mutation record is produced for command effects. |
| DM-033 | Integrate observed command changes with session diffs, mutation sequence, and completion freshness. | planned | Current mutation accounting covers patch tools only. |
| DM-034 | Record command outcome separately from mutation outcome. | planned | Current result does not model a failed command that also changed project files as two independent facts. |
| DM-035 | Preserve recovery truth after timeout, cancellation, crash, or partial mutation without blindly replaying the command. | partial | Durable operations exist, but intentional command mutation reconciliation and durable terminal results do not. |
| DM-036 | Keep automatic rollback guarantees scoped to operations whose before-images were actually captured. | partial | Patch tools satisfy this; arbitrary command rollback must not be implied. |

## Git and remote work

| ID | Requirement | Status | Current evidence or gap |
| --- | --- | --- | --- |
| DM-040 | Permit local Git inspection. | implemented | Status and diff tools exist. |
| DM-041 | Permit local Git mutation in developer mode. | planned | Staging, restoration, branch creation, and local commits are unavailable through typed tools. |
| DM-042 | Keep known remote writes and publication separately authorizable where Cope can classify them. | planned | No target action classes or tools exist, and arbitrary shell scripts can conceal effects. |
| DM-043 | Never blindly replay an uncertain remote action. | retained | Existing exactly-once and indeterminate-state principles should extend to remote tools. |

## Browser transport

| ID | Requirement | Status | Current evidence or gap |
| --- | --- | --- | --- |
| DM-050 | Use a visible supported browser and manual authentication. | implemented | Edge and Chrome product model, dedicated profiles, and manual sign-in exist. |
| DM-051 | Correlate task, turn, submission, conversation, and response. | implemented | Durable markers, conversation identity, and response association exist. |
| DM-052 | Distinguish submitted, not submitted, and indeterminate delivery. | implemented | Transport contract and recovery logic exist. |
| DM-053 | Resolve before retrying an uncertain browser submission. | implemented | Runtime performs resolution before permitted retry. |
| DM-054 | Do not expose generic browser automation to the coding model. | retained | Browser remains a model transport rather than a general tool. |
| DM-055 | Keep browser product and UI contracts independently versioned. | implemented | Browser configuration and UI contract versions exist. |
| DM-056 | Add terminal capability without making an envelope-wide response-capture migration a prerequisite. | planned | The first terminal tool should remain inside the established `cba-agent/1` envelope. |

## Protocol and context

| ID | Requirement | Status | Current evidence or gap |
| --- | --- | --- | --- |
| DM-060 | Copilot emits small typed intents while Cope owns transport identity. | implemented | `cba-agent/1` normalizes into internal `cba/1`. |
| DM-061 | Stable contract and schemas are not repeated unnecessarily. | partial | Bootstrap exists, but every harness result currently carries a protocol reminder. |
| DM-062 | Active authority is presented as a compact capability manifest. | planned | Current policy summaries expose more hardened detail than the target needs. |
| DM-063 | Independent observations may be batched. | implemented | `observe` supports bounded read-only batches. |
| DM-064 | Deterministic operation sequences may be batched when no intermediate reasoning is required. | planned after MVP | Current non-read operations are one-per-turn. |
| DM-065 | `terminal_exec` uses a required independently versioned tool contract while existing `run_command` meaning remains unchanged. | planned | Current tool surface is catalog-only. |
| DM-066 | Large output and diffs can be paged or summarized without losing truthful truncation state. | partial | Bounded truncation exists; general paging and terminal output references do not. |
| DM-067 | A complete bounded terminal result or stable artifact reference becomes durable before journal completion. | planned | Current completed-operation replay stores only safe metadata, not full terminal output. |

## Policy and safety

| ID | Requirement | Status | Current evidence or gap |
| --- | --- | --- | --- |
| DM-070 | Developer mode permits broad local capability after one grant. | planned | Current generated policy denies network and limits commands to configured IDs. |
| DM-071 | Inspect mode remains read-only. | implemented | Mode checks deny mutation and side-effecting commands. |
| DM-072 | Hardened command catalogs remain an optional profile. | partial | Catalog implementation exists; profile separation does not. |
| DM-073 | Cope never automates privilege elevation. | retained | Current live preflight refuses elevated operation. |
| DM-074 | Cope private state and browser profiles remain excluded from typed workspace tools. | retained | State and profile roots are separate; arbitrary child-process containment is explicitly not claimed. |
| DM-075 | Additional typed-tool filesystem roots require explicit authority. | planned | Capability model supports paths, but external-root architecture is absent. |
| DM-076 | Known destructive remote or publishing actions require separate authority where identifiable. | planned | No such action classification is implemented. |
| DM-077 | Cope does not claim sandbox, egress, rollback, or resource enforcement it does not provide. | partial | Current limitations acknowledge residual risk; developer-mode messaging must be updated in code and CLI. |
| DM-078 | Secret scanning and final outbound inspection remain active. | implemented | Content security and disclosure ledger exist. |

## State, recovery, and completion

| ID | Requirement | Status | Current evidence or gap |
| --- | --- | --- | --- |
| DM-080 | Record durable intent before consequential local or browser actions. | implemented | Outbox, operation journal, session state, and audit events exist. |
| DM-081 | Completed operations are not executed twice. | implemented | Operation identity and journal replay exist. |
| DM-082 | Unknown mutation outcomes require reconciliation rather than blind replay. | implemented for patch tools | General terminal mutation reconciliation remains planned. |
| DM-083 | Pause, resume, and abort preserve truthful state. | implemented | Cooperative cancellation and persisted lifecycle states exist. |
| DM-084 | Completion requires known local and transport state. | implemented | Completion verifier checks repository, pending operations, submission state, and validation. |
| DM-085 | Required validation must occur after the latest relevant mutation. | implemented for recorded mutations | Command-generated mutation integration remains planned. |
| DM-086 | The final handoff distinguishes task changes, pre-existing changes, terminal results, skipped validation, and risks. | partial | Most categories exist; general terminal and command-mutation categories do not. |

## MVP release gate

The first developer-mode release is not complete until DM-020, DM-023, DM-027, DM-029 through DM-036, DM-056, DM-065 through DM-067, and DM-070 are implemented and covered by offline end-to-end tests.

The highest-value functional proof is a real fixture and live pilot in which Cope starts from a normal repository with no hand-authored command catalog, runs a shell command that intentionally changes tracked files, streams bounded output locally, captures and attributes those changes, validates the result, survives an interruption test without replaying the command, and completes with an accurate final diff and report.

## Existing platform traceability

Windows and macOS host portability, browser identity, private storage, filesystem identity, process-tree supervision, packaging, and live acceptance requirements remain applicable. The developer-mode pivot changes local authority and terminal semantics; it does not remove the need to verify the visible-browser transport on each supported host tuple.
