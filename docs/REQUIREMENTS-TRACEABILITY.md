# Requirements traceability

## Purpose

This matrix separates remaining target requirements from the current 0.1.10
implementation. It is code/release traceability, not live-certification
evidence.

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
| DM-002 | Developer mode is the recommended default for ordinary project work. | partial | Quick setup recommends and enables the Developer profile; session mode still requires an explicit Developer/`--auto` selection. |
| DM-003 | One concise initial grant authorizes normal project work and accurately states that shell commands are not sandboxed. | implemented | The Developer access screen states current-user execution, project starting directory, ordinary environment/network and local Git authority, observation, and bounded results. |
| DM-004 | The agent should ask only for genuinely missing information or materially new authority. | implemented for MVP | A Developer terminal grant authorizes ordinary one-shot commands once; higher-layer denies and genuinely new typed authority still stop or ask. |
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
| DM-020 | Execute ordinary developer commands through explicit shell mode. | implemented | `terminal_exec` supports strict `terminal-exec/1` shell requests. |
| DM-021 | Execute commands through direct executable and argv mode. | implemented | `terminal_exec` supports a separate strict executable/argument-vector variant. |
| DM-022 | Use the selected project as the default working directory. | implemented | Terminal cwd defaults to the selected project and accepts only validated project-relative directories. |
| DM-023 | Stream command output locally while bounding the result sent to Copilot. | implemented | Output streams through the local progress sink while retained/model-visible head/tail results are bounded and scanned. |
| DM-024 | Support stdin and PTY-backed interactive processes. | planned after MVP | Current child stdin is ignored and no PTY exists. |
| DM-025 | Start, inspect, write to, and stop persistent processes. | planned after MVP | Current runner supports only one-shot process lifetime. |
| DM-026 | Cancel child process trees on pause and abort. | implemented for one-shot processes | Pause, abort, timeout, and `cancelAll` supervise the active process tree; persistent processes remain later work. |
| DM-027 | Permit normal network-dependent developer commands. | implemented | Developer terminal children use ordinary current-user network access; the UI explicitly says Cope is not an egress firewall. |
| DM-028 | Preserve timeouts, output limits, and truthful exit or signal state. | retained | Current process runner provides these controls. |
| DM-029 | Inherit a usable developer environment without copying Cope-internal control state. | implemented | Developer terminal inherits the ordinary environment after removing Cope control/malformed entries; catalog commands remain hardened. |

## Command-generated mutations

| ID | Requirement | Status | Current evidence or gap |
| --- | --- | --- | --- |
| DM-030 | Commands may intentionally create, update, delete, and rename project files. | implemented | Developer terminal observations represent and attribute these effects without converting known in-scope change into a catalog integrity violation. |
| DM-031 | Capture project state before and after a command. | implemented | Bounded observations are persisted on both sides of every launched terminal command. |
| DM-032 | Attribute observed command-generated changes to the operation. | implemented | One idempotent terminal mutation record binds verified effects to the operation ID. |
| DM-033 | Integrate observed command changes with session diffs, mutation sequence, and completion freshness. | implemented | Terminal before-images, mutation records, accounting, session diff, and completion authority share the same verified effect. |
| DM-034 | Record command outcome separately from mutation outcome. | implemented | `terminal-exec-result/1` has independent process and mutation outcomes. |
| DM-035 | Preserve recovery truth after timeout, cancellation, crash, or partial mutation without blindly replaying the command. | implemented | Ordered integrity artifacts, receipts, result promotion, and indeterminate reconciliation prohibit blind relaunch. |
| DM-036 | Keep automatic rollback guarantees scoped to operations whose before-images were actually captured. | implemented | Terminal result/diff evidence identifies unavailable baselines and does not claim arbitrary-command atomic rollback. |

## Git and remote work

| ID | Requirement | Status | Current evidence or gap |
| --- | --- | --- | --- |
| DM-040 | Permit local Git inspection. | implemented | Status and diff tools exist. |
| DM-041 | Permit local Git mutation in developer mode. | implemented through terminal | Developer terminal authorizes local Git and records observed branch/HEAD/index/worktree effects; typed Git mutation tools remain later work. |
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
| DM-056 | Add terminal capability without making an envelope-wide response-capture migration a prerequisite. | implemented | `terminal-exec/1` is additive inside the established `cba-agent/1` envelope and capture path. |

## Protocol and context

| ID | Requirement | Status | Current evidence or gap |
| --- | --- | --- | --- |
| DM-060 | Copilot emits small typed intents while Cope owns transport identity. | implemented | `cba-agent/1` normalizes into internal `cba/1`. |
| DM-061 | Stable contract and schemas are not repeated unnecessarily. | implemented for bootstrap refresh | Full schemas are delivered on bootstrap; later refreshes omit argument schemas and repairs remain event-driven. |
| DM-062 | Active authority is presented as a compact capability manifest. | implemented for terminal MVP | The grant-filtered bootstrap and effective summary include compact terminal, network, Git, observation, and bound facts. |
| DM-063 | Independent observations may be batched. | implemented | `observe` supports bounded read-only batches. |
| DM-064 | Deterministic operation sequences may be batched when no intermediate reasoning is required. | planned after MVP | Current non-read operations are one-per-turn. |
| DM-065 | `terminal_exec` uses a required independently versioned tool contract while existing `run_command` meaning remains unchanged. | implemented | Strict `terminal-exec/1` is additive; catalog `run_command` semantics and required-validation role are unchanged. |
| DM-066 | Large output and diffs can be paged or summarized without losing truthful truncation state. | partial | Terminal head/tail, retained byte counts, disclosure state, and truncation are truthful; general paging remains later work. |
| DM-067 | A complete bounded terminal result or stable artifact reference becomes durable before journal completion. | implemented | The integrity-verified terminal result is persisted before journal completion and is replayable without execution. |

## Policy and safety

| ID | Requirement | Status | Current evidence or gap |
| --- | --- | --- | --- |
| DM-070 | Developer mode permits broad local capability after one grant. | implemented for one project/one-shot terminal | Fresh Developer-capable ceilings plus config-v2 opt-in allow arbitrary shell/argv and local Git/network authority after one grant. |
| DM-071 | Inspect mode remains read-only. | implemented | Mode checks deny mutation and side-effecting commands. |
| DM-072 | Hardened command catalogs remain an optional profile. | partial | Catalog implementation exists; profile separation does not. |
| DM-073 | Cope never automates privilege elevation. | retained | Current live preflight refuses elevated operation. |
| DM-074 | Cope private state and browser profiles remain excluded from typed workspace tools. | retained | State and profile roots are separate; arbitrary child-process containment is explicitly not claimed. |
| DM-075 | Additional typed-tool filesystem roots require explicit authority. | planned | Capability model supports paths, but external-root architecture is absent. |
| DM-076 | Known destructive remote or publishing actions require separate authority where identifiable. | planned | No such action classification is implemented. |
| DM-077 | Cope does not claim sandbox, egress, rollback, or resource enforcement it does not provide. | implemented | CLI grant, doctor, bootstrap projection, release notes, limitations, and operator docs state the current-user and observation boundary. |
| DM-078 | Secret scanning and final outbound inspection remain active. | implemented | Content security and disclosure ledger exist. |

## State, recovery, and completion

| ID | Requirement | Status | Current evidence or gap |
| --- | --- | --- | --- |
| DM-080 | Record durable intent before consequential local or browser actions. | implemented | Outbox, operation journal, session state, and audit events exist. |
| DM-081 | Completed operations are not executed twice. | implemented | Operation identity and journal replay exist. |
| DM-082 | Unknown mutation outcomes require reconciliation rather than blind replay. | implemented | Patch and terminal recovery both fail closed; launched terminal commands are never blindly relaunched. |
| DM-083 | Pause, resume, and abort preserve truthful state. | implemented | Cooperative cancellation and persisted lifecycle states exist. |
| DM-084 | Completion requires known local and transport state. | implemented | Completion verifier checks repository, pending operations, submission state, and validation. |
| DM-085 | Required validation must occur after the latest relevant mutation. | implemented | Verified terminal effects advance mutation sequence; required catalog validation must be fresh at the current fingerprint. |
| DM-086 | The final handoff distinguishes task changes, pre-existing changes, terminal results, skipped validation, and risks. | implemented | Completion and review packages bind verified terminal effect/result provenance and preserve pre-existing/evidence limitations. |

## MVP release gate

The 0.1.10 code implements the one-shot MVP requirements DM-020, DM-023,
DM-027, DM-029 through DM-036, DM-056, DM-065 through DM-067, and DM-070 with
deterministic unit, end-to-end, recovery, and reliability coverage. Platform
live-certification remains a separate release-evidence gate.

The highest-value functional proof is a real fixture and live pilot in which Cope starts from a normal repository with no hand-authored command catalog, runs a shell command that intentionally changes tracked files, streams bounded output locally, captures and attributes those changes, validates the result, survives an interruption test without replaying the command, and completes with an accurate final diff and report.

## Existing platform traceability

Windows and macOS host portability, browser identity, private storage, filesystem identity, process-tree supervision, packaging, and live acceptance requirements remain applicable. The developer-mode pivot changes local authority and terminal semantics; it does not remove the need to verify the visible-browser transport on each supported host tuple.
