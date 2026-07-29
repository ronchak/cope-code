# Developer-mode MVP implementation plan

Status: implementation plan

Planning base: Cope `0.1.9`, main commit `4950fb1f4d14cbce800da2fa6f3d775286845807`

First target release: `0.1.10`

## Outcome

The first developer-mode milestone adds one broad, one-shot local tool:

- additive `terminal_exec` inside the current `cba-agent/1` envelope;
- required tool contract `terminal-exec/1`;
- direct executable-plus-argv and explicit shell modes;
- a useful inherited developer environment;
- live local stdout/stderr with separately bounded model-visible output;
- durable request, exit, observation, and result evidence;
- exact result replay without rerunning a possibly executed command;
- lightweight pre-command and post-command project observation;
- truthful attribution and post-hoc accounting of command-generated changes;
- completion freshness after those changes;
- explicit opt-in through the new developer posture;
- unchanged catalog-backed `run_command`.

This milestone should make install, build, lint, test, formatter, generator, migration,
and local Git workflows possible through the visible-browser agent loop. It is not a
shell sandbox. A child process runs with the current user's operating-system authority
and can reach resources that portable Node.js checks cannot contain.

## Non-negotiable design calls

1. Keep model-facing `cba-agent/1` and internal `cba/1`. Version the new authority at
   the tool contract.
2. Keep `run_command` catalog-only. Its catalog resolution, minimal environment,
   repository no-mutation bracket, and role as named completion validation do not
   change.
3. Keep persisted runtime modes `inspect`, `edit`, and `auto`. Present newly granted
   `auto` sessions as Developer mode; use “hardened” for a policy posture, not a new
   enum value.
4. Do not silently widen old repository config, organization policy, preferences,
   grants, sessions, fixtures, or recovery records.
5. Reuse the current strict model-facing schema and bounded `SCHEMA_INVALID` repair
   path. A wrong contract, mixed shell/argv form, unknown field, or bad bound is a
   format error, not a separate terminal rejection channel.
6. Mark `terminal_exec` non-read-only. Existing operation-journal recovery therefore
   treats interrupted execution conservatively and never blindly replays it.
7. Use the existing `OperationJournal` states and `AgentRuntime` transaction order.
   Do not add a terminal-only operation state machine or move execution recovery into
   the CLI preflight assessor.
8. Extend or factor the current `ProcessRunner`, process supervisor, and
   `HostPlatform` seams. Do not create a second process lifecycle that loses current
   parent-death and process-tree cleanup guarantees.
9. Treat command outcome and observed mutation outcome as independent facts. A failed,
   timed-out, cancelled, or nonzero command may still change the project.
10. Meter terminal changes after execution. Once a command has run, a budget overrun
    cannot retroactively deny or erase its effects; persist the facts, then pause later
    work.
11. Use project-relative `cwd` validation as an authority and usability boundary. Do
    not describe it as containment of the child process.
12. Do not promise atomic rollback for arbitrary commands whose write set was unknown
    before launch. Existing typed patch tools keep their stronger checkpoints and
    rollback behavior.

## Current seams to preserve

The implementation should compose with these existing owners rather than bypass them:

| Concern | Current seam |
| --- | --- |
| Tool registry and arguments | `src/protocol/types.ts`, `src/protocol/schemas.ts` |
| Model-facing parsing and repair | `src/protocol/model-facing.ts`, `src/orchestrator/agent-runtime.ts` |
| Bootstrap and result rendering | `src/protocol/bootstrap.ts`, `src/orchestrator/cba-protocol-adapter.ts` |
| Authorization and disclosure reservation | `src/orchestrator/runtime-policy.ts`, `src/orchestrator/disclosure-budget.ts` |
| Tool dispatch and command integrity | `src/tools/tool-host.ts` |
| Process lifecycle | `src/tools/process-runner.ts`, `src/tools/process-supervisor.ts`, `src/platform/*` |
| Durable operation truth | `src/session/operation-journal.ts`, `src/session/artifact-store.ts` |
| Session recovery | `AgentRuntime` startup/replay paths; CLI recovery remains a source-free assessor |
| Workspace truth | `src/repository/git.ts`, `src/repository/snapshot-diff.ts`, repository boundary |
| Mutation and validation freshness | `AgentRuntime.recordToolEffects`, `src/orchestrator/completion.ts` |
| Modes, grants, and setup | `src/policy/*`, `src/config/*`, `src/cli/*` |

Two current behaviors need explicit terminal branches:

- `LayeredRuntimePolicy.buildOperation` must reserve terminal result disclosure from the
  locally clamped `max_output_bytes`. Falling through reserves only the fixed control
  envelope and no source allowance, so serialization can fail after the command has
  already run.
- `ToolHost` must not reuse `run_command`'s before/after no-mutation assertion.
  `terminal_exec` records ordinary project changes instead of converting them into
  `RECOVERY_REQUIRED`.

Adding a local registry member also makes existing exhaustive switches and default
`TOOL_NAMES` projections significant. The shared-contract gate must compile with a
source-free ToolHost denial stub and must explicitly deny `terminal_exec` in default
organization, repository, and session tool rules. A pre-terminal allowlist is not
enough because the current upper layers have `default_decision: "allow"` and unmatched
tools fall through to that decision. Registration alone never grants or advertises the
new authority.

## Additive contract

Register `terminal_exec` as local, non-read-only, and non-batchable. Its registry
`required_context` is intentionally empty: catalog `command`, declarative `network`,
and predeclared `change` facts do not truthfully describe an arbitrary terminal
command. The runtime policy supplies terminal-specific authority and bounds.

Shell form:

```json
{
  "contract": "terminal-exec/1",
  "mode": "shell",
  "command": "npm install && npm test",
  "cwd": ".",
  "timeout_ms": 900000,
  "max_output_bytes": 1048576
}
```

Argv form:

```json
{
  "contract": "terminal-exec/1",
  "mode": "argv",
  "executable": "node",
  "arguments": ["scripts/check.mjs"],
  "cwd": ".",
  "timeout_ms": 300000,
  "max_output_bytes": 524288
}
```

Contract rules:

- `contract` and `mode` are required.
- Shell mode requires `command` and rejects argv fields.
- Argv mode requires `executable` and `arguments` and rejects `command`.
- `cwd` defaults to `.` and must resolve to an existing directory under the selected
  project.
- Command, executable, cwd, and arguments are nonempty where required and NUL-free.
- Argv count, per-string size, timeout, and output requests have deterministic bounds.
- Runtime policy clamps requested timeout and output bytes to locally authorized
  ceilings.
- The model cannot supply environment variables in this contract version.
- `terminal_exec` cannot appear in an `observe` batch.

The strict `oneOf` schema remains the only model-facing validator. Bootstrap includes
the tool only when the durable session grant contains it.

## Terminal result

Persist and return `terminal-exec-result/1`. The exact field names freeze in the
shared-contract commit, but the result must contain:

- normalized invocation facts: contract, mode, relative cwd, selected shell or
  executable and argv;
- process outcome: `completed`, `completed_nonzero`, `spawn_failed`, `timed_out`,
  `cancelled`, `persistence_failed`, or `indeterminate`;
- exit code, signal when known, start/end timestamps, duration, and timeout/cancel
  attribution;
- per-stream byte totals, bounded head/tail excerpts, truncation flags, redaction
  count, disclosure state, and stable artifact references;
- mutation outcome: `none`, `observed`, `protected_or_hidden_changed`, or `unknown`;
- bounded created, updated, deleted, renamed, and pre-existing-touched path facts;
- actual changed file/line counts, binary/ignored summaries, and final repository
  fingerprint;
- a `replayed` flag.

`completed_nonzero` means the terminal operation produced a definite, durable result
but the command exited unsuccessfully. `persistence_failed` means the process may have
finished but Cope cannot claim a replayable result. The outer tool outcome and the
result must not discard mutation facts for either case.

If the outbound content scanner rejects stdout or stderr, retain process and mutation
truth, replace the excerpt with a source-free omission marker, and set disclosure to
denied. Never relabel an already executed process as a policy denial.

## Process and environment behavior

### Argv mode

- Resolve cwd through the repository boundary.
- Spawn executable plus the exact argument vector with `shell: false`.
- Support PATH lookup and repository-local executables such as project scripts and
  `node_modules/.bin`; do not inherit the catalog rule that forbids
  repository-writable executables.
- On Windows, reject direct `.bat` or `.cmd` argv execution with clear guidance to use
  shell mode. Do not silently reinterpret argv through a shell.

### Shell mode

- macOS/POSIX: run the configured current-user shell, falling back to `/bin/sh`, with
  the documented command switch selected during contract review.
- Windows: run `COMSPEC`, falling back to `cmd.exe`, with `/d /s /c`.
- Spawn the chosen shell explicitly with `shell: false`.
- Persist the selected shell executable and switches as normalized execution facts.

### Environment

Start from the ordinary current process environment so installed toolchains, SDKs,
credential helpers, proxies, and version managers work. Remove:

- exact Cope/CBA internal control namespaces;
- enumerated handoff variables that could change Cope's own behavior;
- malformed names containing NUL or `=` before supervisor serialization.

Record inherited and removed key names or hashes, never values. Do not copy secret
values into audit or browser messages. Keep the current catalog `run_command`
allowlist byte-for-byte compatible.

### Supervision

Reuse current launch cancellation, parent-death supervision, timeout, grace period,
process-tree termination, active-child tracking, and `cancelAll`.

- Preserve actual exit versus signal truth through the POSIX supervisor; do not map
  child signals or supervisor failures onto ambiguous ordinary exit codes.
- Bound the interval between child `exit` and stdio `close`. After a short flush grace,
  finalize without allowing a descendant holding inherited pipes to hang the
  operation indefinitely.
- Windows termination continues through `taskkill /T /F`; no graceful-signal claim is
  made.
- No host uses Node's `shell: true`, requests elevation, or adds stdin/PTY support.

## Output path

Add a local terminal output sink:

```text
onTerminalOutput(operationId, stream, chunk, cumulativeBytes)
```

Runtime composition connects it only to the local CLI:

- normal mode renders labelled stdout/stderr chunks;
- machine-readable mode emits structured terminal events on stderr and preserves the
  final JSON result channel;
- no live chunk is sent through browser transport.

Capture raw stream bytes while producing UTF-8-safe model excerpts. Use separate
bounds for:

1. local live rendering, to prevent terminal floods;
2. retained source-bearing output/artifacts;
3. the combined model-visible result.

Align retained artifact size with the artifact store's real per-artifact limit.
Head/tail truncation emits one explicit marker and uses saturating safe-integer byte
accounting. stdout/stderr remain separate; no false total-order claim is made.

## Durable ordering and recovery

Reuse the current journal status machine. Add artifact kinds for terminal request,
pre/post observation, exit receipt, and terminal result. Artifact writes remain
integrity-manifested, bounded, atomic, and private.

Normal order:

1. Journal accepts the exact normalized call hash.
2. Runtime policy authorizes the durable terminal capability and clamps bounds.
3. Mark the existing journal record `executing`.
4. Persist pending session state as executing.
5. Inside the terminal executor, persist normalized request, resolved execution facts,
   environment key evidence, and the pre-observation.
6. Launch and supervise the child while streaming locally.
7. On child exit, persist a small source-free exit receipt containing process truth.
8. Capture the post-observation even after nonzero exit, timeout, or cancellation.
9. Build and scan the bounded terminal result.
10. Persist the complete terminal result and its observation references before the
    terminal executor returns to `AgentRuntime`.
11. Mark the existing journal record complete with only a validated result artifact
    reference and source-free accounting metadata.
12. Idempotently record mutation, budget, validation-freshness, and audit effects.
13. Queue the exact result through the existing outbox/unreturned-operation
    transaction.

The executing-before-evidence order matches the current `AgentRuntime` tool
transaction. A crash after step 4 but before launch is conservatively indeterminate;
the command is not replayed. Avoid adding a second pre-execution transaction solely
to distinguish that harmless window.

`AgentRuntime.findUncertainMutation` checks for a matching complete result artifact
while the journal record is still `executing`, before `OperationJournal.register`
would convert it to indeterminate. Restart state does not retain the original
`NormalizedToolCall.arguments`, so it calls an additive
`ToolExecutor.recoverCompleted({ operationId, tool, requestHash })` seam. That seam
loads the terminal-request artifact, verifies its operation ID and exact request hash,
then verifies the bound result artifact. Runtime marks the existing executing record
complete and uses normal replay. Recovery after re-registration is too late because
the current journal correctly refuses to complete an indeterminate record.

| Durable evidence | Recovery action |
| --- | --- |
| accepted, never executing | Existing retry-safe path; launch boundary was not crossed |
| executing plus valid matching terminal result | Promote/resolve the record completed, apply effects idempotently, and replay exact data |
| completed plus valid matching terminal result | Replay exact data; only `replayed` may differ |
| exit receipt but no complete result | Process truth is known, mutation/result truth is incomplete; pause indeterminate and never rerun |
| executing without result | Mark indeterminate, expose bounded evidence, and never rerun |
| corrupt, partial, mismatched, or missing referenced artifact | `RECOVERY_REQUIRED`; never infer success |

PID liveness or death is not proof that a command did or did not execute. Source output
does not enter `OperationRecord.safeResult`. Journal schema-1 read compatibility
remains intact; old operations without terminal references retain their current replay
semantics.

Replace the current synchronous `outcomeFromRecord` terminal path with an async,
artifact-backed replay helper. It preserves timeout/cancelled/nonzero status instead
of collapsing every non-success record to generic failure, verifies operation and
request binding, and changes only `replayed` in the returned terminal result.

Terminal artifact retention must be explicit. Terminal cleanup may remove source
artifacts after a verified terminal session only when the completion handoff contains
the durable source-free facts it needs and configured retention allows removal.

## Workspace observation and mutation attribution

Add a browser-independent repository observer that captures one lightweight
pre-command state and one post-command state:

- branch and HEAD;
- index identities;
- porcelain status including rename origins;
- visible tracked, staged, untracked, and pre-existing dirty state;
- bounded before-images only where Git cannot reconstruct them;
- policy-hidden/protected integrity fingerprint;
- stable repository observation fingerprint.

Clean tracked files can use pre-index blob identities as recoverable before-images.
Already-dirty and untracked user work needs bounded before-images before launch. If
required evidence exceeds the pre-observation bound, fail before launch with a
recovery action.

Compare pre/post facts to report:

- created, updated, deleted, and conservatively verified renamed paths;
- pre-existing user paths touched during the operation;
- index, HEAD, or branch changes;
- actual changed files and changed lines;
- binary and bounded ignored summaries;
- final repository fingerprint.

This is observation, not perfect causation. Changes concurrent with the process are
reported as observed during the operation. Do not claim exhaustive ignored,
out-of-project, remote, or service-side effects.

Protected/hidden drift, nested repository ambiguity, unreadable post-state, or
over-bound evidence becomes `protected_or_hidden_changed` or `unknown` and pauses
truthfully. Do not reconstruct the current catalog command's universal no-mutation
proof under a new name.

## Post-hoc accounting and completion

Extend mutation records additively:

- `kind: "patch" | "terminal"`; missing legacy kind means patch;
- checkpoint ID remains optional and typed-patch-only;
- pre/post observation and terminal result references;
- created, updated, deleted, rename endpoints, and pre-existing-touched paths;
- actual file/line counts, timestamp, observation outcome, and repository fingerprint
  when known.

Update both `src/session/types.ts` and the top-level session-key and mutation-record
validators in `src/session/store.ts`. Legacy six-key patch records remain valid. A
terminal record with unknown repository state stores an explicit non-clean observation
outcome and no invented hash; completion rejects that outcome before selecting an
expected fingerprint.

For a terminal result with known nonempty changes, regardless of process outcome:

1. record one mutation by operation ID;
2. increment `mutationSequence`;
3. consume actual changed-file and changed-line usage once;
4. on post-hoc overrun, preserve the record/result and durably pause later work;
5. never double-account during recovery or result replay.

`terminal_exec` consumes the existing `commands` counter once at the launch boundary
and the actual retained/model output against `commandOutputBytes` once when its durable
result is recorded. A request denied or rejected before launch does not consume a
command; recovery and replay do not consume either counter again.

Terminal runs do not become named `ValidationRecord`s. Only catalog-backed
`run_command` satisfies configured `required_command_ids`. A normal task therefore
uses terminal commands to mutate, then a named validation command to establish fresh
completion evidence.

Slice 1 also persists `pendingTerminalEffectOperationIds` in session state. If its
placeholder observation reports changed or unknown state, the operation ID is added
and completion rejects while it remains pending. Slice 2 replaces that marker
idempotently with a full terminal mutation record, accounts the effects, and removes
the marker. This enforced gate prevents a post-terminal catalog validation from
masking an unattributed command mutation during the interim slice.

For newly granted Developer sessions:

- completion chooses expected repository, branch, HEAD, and index facts from the
  latest recorded tool effect rather than always pinning them to session start;
- terminal changes make earlier validations stale through `mutationSequence`;
- required validation must pass after the latest mutation with the current
  fingerprint;
- unknown/protected mutation, unresolved terminal operation, or post-result drift
  rejects completion;
- final handoff separates pre-existing work, terminal-observed effects, process
  outcome, validation evidence, and observation limitations.

Old and hardened-compatible sessions keep their current branch/HEAD freeze. Session
diffs source before-images from either typed patch checkpoints or terminal observation
artifacts; missing evidence is `unknown`, never silently omitted.

## Modes, grants, and compatibility

Introduce `cba-repository-config/2` in the product-enablement slice with an explicit,
bounded `developer_terminal` block. The loader:

- accepts config v1 unchanged and normalizes terminal authority to disabled;
- strictly validates config v2;
- never infers terminal authority from writable paths, command catalogs, or an old
  `auto` preference;
- hashes the original document for resume pinning as it does today.

Grant behavior:

| State | Terminal behavior |
| --- | --- |
| `inspect` | never granted |
| `edit` | omitted by default; current typed edits and catalog commands remain |
| new `auto` + config v2 enabled + every policy layer allows | presented as Developer and granted once at task start |
| config v1, old preference, old grant/session, or denying managed policy | terminal absent; hardened-compatible behavior retained |

Grant creation passes a filtered tool list rather than blindly using the expanded
`TOOL_NAMES`. New quick setup writes config v2 and new organization, repository, and
session projections that explicitly allow `terminal_exec` and remove the C0 default
deny at those new v2 layers. A lower-layer allow never overrides an inherited
organization or repository deny. Existing config-v1 policies and live sessions are
never rewritten automatically.

The one concise Developer grant states:

- shell/argv run as the current user;
- the selected project is the starting scope, not an OS sandbox;
- ordinary child environment and network access may be used;
- local Git changes may occur and will be observed;
- output and results are bounded and retained according to local policy.

Arbitrary shell code can conceal network or remote-write effects. The MVP records the
authority and observed local truth but does not claim portable service-level egress or
remote-write enforcement.

## Delivery sequence

Deliver three stacked vertical PRs. Every pushed commit gets a GitHub Codex review
request; every final head gets an exact-head Codex review and a focused Claude
checkpoint.

### Shared contract commit C0

C0 is the first commit of Slice 1 and the branching gate for dependent work:

- `src/protocol/types.ts`: registry entry and arguments;
- `src/protocol/schemas.ts`: strict shell/argv schema;
- new `src/protocol/terminal-exec.ts`: types and status/result taxonomy only;
- `src/orchestrator/contracts.ts`: additive `recoverCompleted` and terminal execution
  context interfaces needed by dependent tracks;
- `src/session/artifact-store.ts`: artifact-kind and artifact-reference surface;
- `src/session/types.ts` and `src/session/store.ts`: additive terminal mutation and
  pending-attribution fields plus legacy-compatible validation;
- `src/tools/process-runner.ts`: public terminal request/outcome/output-sink signatures.
- `src/tools/tool-host.ts`: an exhaustive, source-free terminal denial stub so the
  registry addition compiles without execution authority;
- `src/policy/defaults.ts`: explicit `terminal_exec` deny rules for default
  organization, repository, and session policy projections; pre-terminal allowlists
  alone are not authoritative denial.

C0 contains no process execution logic. Its checks audit every `ToolName`-keyed schema,
switch, bootstrap projection, policy list, and test fixture. The explicit denies
ensure that no new inspect, edit, or auto session grants or advertises the tool before
Slice 3, even when an upper layer's unmatched default is allow. Claude reviews its
exact SHA before specialist branches start. After review, contract changes are
stop-the-line integration changes.

### Slice 1 PR — terminal execution and exact recovery

Outcome: an explicitly/manual-granted one-shot terminal works end to end on a clean
workspace; ordinary product configs still disable it.

Production surface:

- protocol schema/bootstrap/adapter wiring;
- terminal-specific runtime policy including disclosure reservation;
- current process runner/supervisor/platform extension;
- new `src/tools/terminal-executor.ts` as the single coordinator for request evidence,
  process execution, exit receipt, observations, result assembly, and artifact writes;
- ToolHost artifact/recovery dependency and runtime-composition wiring;
- shell and argv execution, PATH/repository-local executables, developer environment;
- local output sink and bounded/scanned model result;
- request, exit, observation placeholder, and result artifacts;
- result-before-journal-completion ordering and recovery promotion;
- ToolHost dispatch and AgentRuntime replay/accounting plumbing;
- terminal command and retained-output metering through the existing `commands` and
  `commandOutputBytes` budgets;
- persisted pending-attribution markers and a hard completion rejection for any
  changed/unknown placeholder;
- no change to `run_command`.

Acceptance:

- both forms parse and execute on macOS and Windows;
- invalid forms use current repair behavior;
- live output remains local;
- excerpts and artifacts respect actual bounds;
- result persistence failure never becomes false completion;
- executing-without-result never reruns;
- persisted result replays byte-equivalent data;
- supervisor signal/exit and descendant cleanup are truthful;
- existing `run_command`, protocol capture, recovery, and offline fixtures stay green.

Enforced interim limit: project effects are reported as an observation placeholder,
and any changed/unknown placeholder is stored as pending attribution. Completion
rejects until Slice 2 converts it into a full mutation record. Slice 1 tests prove that
a later successful catalog validation cannot bypass this gate.

### Slice 2 PR — workspace effects and completion freshness

Outcome: formatter, generator, installer, migration, and local Git effects become
attributed, budgeted, diffable, recoverable, and compatible with final verification.

Production surface:

- new repository workspace observer and bounded evidence;
- persisted pre/post observations around every terminal launch;
- independent command/mutation result;
- terminal mutation records and idempotent effect recording;
- post-hoc changed-file/line accounting and durable overrun pause;
- failed/timed-out/cancelled mutation handling;
- session diff integration;
- new Developer-session branch/HEAD/index completion semantics;
- catalog validation freshness after terminal mutation;
- protected/unknown observation recovery.

Acceptance:

- create/update/delete/rename/binary/pre-existing-touch cases;
- staged, unstaged, index, HEAD, and branch effects;
- nonzero, timeout, cancellation, and crash after side effect;
- post-hoc overrun truth with no double accounting;
- external post-result drift rejects completion;
- named validation before mutation is stale and after mutation is fresh;
- old/hardened completion behavior remains unchanged.

### Slice 3 PR — product grant, onboarding, hosts, and release

Outcome: new users can select Developer mode once and complete ordinary terminal-based
tasks, while old installations and managed hardened configurations retain current
authority.

Production surface:

- config v2 and strict compatibility loader;
- explicit v2 organization/repository/session policy capability that replaces the C0
  deny only for new Developer grants, plus a filtered tool list;
- setup, preference, CLI, presentation, and doctor behavior;
- compact active terminal capability projection;
- reduced repeated terminal schema prose after bootstrap;
- ordinary network-dependent command and local Git authority presentation;
- Windows and macOS acceptance/characterization;
- README, quickstart, operator, protocol, recovery, limitations, policy, threat,
  traceability, release notes, and release-evidence updates.

Acceptance:

- one concise Developer grant enables the full loop;
- inspect denies; edit/config-v1/old sessions remain terminal-free;
- no resume-time authority widening;
- a kill switch disables new terminal requests without corrupting in-flight recovery;
- Windows standard-user and macOS process-tree/live-output smoke tests pass;
- documentation states what ships and what remains target work;
- exact final head passes full tests, check, release verification, and hosted matrix
  with no unexpected skips.

## Parallel work and ownership

After C0 is reviewed, use separate GPT-5.6 Sol/high Codex worktrees with exclusive
ownership:

| Track | Exclusive specialist files | Integration point |
| --- | --- | --- |
| Process/host | process runner, supervisor, platform modules, output capture tests | Slice 1 |
| Persistence/recovery | artifact store implementation, session store validators, journal-compatible resolution helpers, crash fixtures | Slice 1 |
| Repository attribution | new observer, Git/snapshot helpers and tests | Slice 2 |
| Product/config | config/policy defaults, onboarding/preferences/presentation/docs fixtures | Slice 3 |

The primary Codex orchestrator exclusively integrates:

- `src/protocol/model-facing.ts`, `bootstrap.ts`, and protocol adapter;
- `src/orchestrator/agent-runtime.ts`, `runtime-policy.ts`, `contracts.ts`, completion;
- `src/tools/tool-host.ts` and new `src/tools/terminal-executor.ts`;
- `src/cli/runtime-composition.ts` and `commands.ts`.

Those integration files are never edited concurrently. Repository attribution may
begin after C0 but lands after Slice 1. Product/config work may prepare in parallel but
does not enable terminal authority until Slice 2 is truthful.

Integration order:

```text
C0 review
  -> process/host + persistence/recovery in parallel
  -> Slice 1 integration and merge
  -> repository attribution + completion integration
  -> Slice 2 merge
  -> product/config/host acceptance/release
  -> Slice 3 merge
```

## Review checkpoints

Claude Opus 5/high is an independent reviewer, not an implementation owner:

- **R0 — C0 exact SHA:** registry contexts, schema strictness, result taxonomy,
  artifact additivity, exhaustive-switch compilation, default-deny grant projection,
  session-store compatibility, and shared-interface sufficiency.
- **R1 — Slice 1 exact head:** every crash window; artifact-before-journal ordering;
  recovery promotion before re-registration; replay binding and status preservation;
  disclosure reservation; repair preservation; pending-attribution completion gate;
  live-output isolation; environment split; signal/exit truth; artifact bounds.
- **R2 — Slice 2 exact head:** effects from every command outcome; pre-existing work;
  post-hoc accounting; mutation sequence; branch/HEAD relaxation scope; diff evidence;
  completion and replay idempotence.
- **R3 — Slice 3 exact head:** grant presentation against unchanged mode enum;
  config/session compatibility; macOS/Windows evidence; documentation and release
  truth.

Fix concrete duplicate-execution, data-loss, false-success, broken-agent-loop, or
supported-host blockers. Record nonblocking isolation or enterprise hardening ideas
without expanding the active milestone.

## Verification matrix

| Concern | Required evidence |
| --- | --- |
| Protocol | strict `oneOf`, wrong contract, mixed/unknown fields, observe-batch rejection, existing repair and capture fixtures |
| Compatibility | old config v1, policies, preferences, inspect/edit/auto grants, journal records, cached recovery, catalog commands |
| Execution | shell/argv quoting, PATH and project-local tools, NUL/size bounds, spawn failure, exit/nonzero/signal |
| Environment | ordinary developer keys work, internal/malformed keys removed, values absent from audit, `run_command` unchanged |
| Output | interleaved streams, binary/invalid UTF-8, head/tail bounds, scanner denial, local/model/artifact cap separation |
| Cancellation | timeout race, caller abort, parent death, descendant cleanup, close/exit flush bound |
| Durability | injected exits after accept, pre-evidence, executing, side effect, exit receipt, post-observation, result, journal completion, accounting, outbox |
| Observation | create/update/delete/rename, dirty user work, staged/index/HEAD/branch, binary/ignored, hidden/protected/unknown |
| Accounting | nonzero/timeout/cancelled mutations, post-hoc overrun pause, replay idempotence |
| Completion | stale/fresh named validation, post-result drift, pending/indeterminate rejection, source-free handoff |
| Hosts | hosted Linux unit coverage plus Windows x64, macOS arm64/x64 and standard-user/process-tree smoke |
| Release | build, unit, reliability, `npm run check`, release-version verification, audit, no unexpected skips |

## Deferred work

The following do not belong in this milestone:

- PTY allocation, stdin, resize, interactive prompts, REPLs, and persistent handles;
- background service adoption and watch-mode lifecycle;
- multiple typed workspace roots;
- atomic rollback for arbitrary commands;
- isolated worktrees, containers, VMs, or OS sandboxes;
- exhaustive ignored, out-of-project, network, remote-service, or remote-write
  attribution;
- model-supplied environment maps;
- typed Git mutation and remote publishing tools;
- output paging beyond stable bounded artifacts;
- internal mode-enum rename;
- enterprise tamper resistance or speculative policy expansion.

These become blockers only when a concrete supported workflow otherwise duplicates
execution, loses user work, claims false success, breaks the visible-browser tool loop,
or cannot recover truthfully.

## Definition of done

The MVP is complete only when a new Developer session can, after one informed grant:

1. inspect a dirty sample repository without losing pre-existing work;
2. run direct argv and shell commands with useful environment and live local output;
3. receive bounded, source-scanned, durable results;
4. report a failing command that changed files as both failure and observed mutation;
5. resume every injected crash boundary without duplicate execution;
6. run catalog-backed named validation after the latest terminal mutation;
7. complete only with a current repository fingerprint and fresh local evidence;
8. do the same on supported Windows and macOS hosts;
9. leave old sessions and hardened-compatible configuration behavior unchanged.
