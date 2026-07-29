# Developer Mode Slice 2 implementation plan

Status: executable implementation plan

Implementation base: `7f2118fb74051b12a1e21bf349cf615d6764cba2`

Target: workspace effects and completion freshness only

## Outcome

Slice 2 replaces Slice 1's placeholder terminal observations with bounded,
operation-scoped repository observations. Every terminal process outcome is reported
independently from the project effects observed during its execution window.

After this slice:

- success, nonzero exit, timeout, cancellation, and OS spawn failure all retain
  truthful process facts;
- every launched operation has a full pre-observation and either a full
  post-observation or an explicit non-clean observation;
- created, updated, deleted, conservatively renamed, binary, staged, unstaged,
  index, HEAD, and branch effects are attributed to the operation window;
- session-start user work remains separately identified;
- terminal mutations, validation staleness, and changed-file/line budgets are
  applied exactly once;
- unknown, protected, hidden, nested-repository, or post-result drift blocks
  completion;
- terminal-capable sessions can complete after attributed local Git transitions;
- old sessions and sessions without terminal authority retain the current frozen
  branch/HEAD behavior;
- terminal-mutated paths appear in session diffs or produce an explicit unavailable
  evidence result; and
- catalog-backed `run_command` remains unchanged and remains the only named
  validation mechanism.

Slice 2 does not enable terminal authority for normal users. Config v2, product
posture, onboarding, grants, and release documentation remain Slice 3 work.
Receipt-absence prelaunch refund is available only on directory-fsync-capable hosts
in this slice; Windows conservatively pauses when that absence cannot be proven.

## Planning decisions

This plan resolves the independent Codex and Fable plans using an exact-base Claude
Opus comparison. The following decisions are frozen before implementation.

### 1. Completion authority is persisted and capability-seeded

Add an optional session field:

```ts
completionAuthority?: "frozen" | "observed";
```

Rules:

- absent means `frozen`;
- a new session is seeded from the hash-pinned effective grant:
  `terminal_exec` present means `observed`, otherwise `frozen`;
- mode names are never used as a proxy;
- resume never recomputes the field from current policy, config, preference, or
  mode;
- an existing session may move from `frozen` to `observed` only in the same durable
  transaction that expands its effective grant to add `terminal_exec`;
- the field never downgrades during a session; and
- old config, grants, sessions, fixtures, and recovery records therefore remain
  frozen.

This combines capability as the source of truth with a creation-time durable
compatibility decision. Presence of session-start branch/HEAD facts cannot be the
discriminator because every current session records them.

Slice 2 keeps `createDefaultSessionGrant` unchanged, so ordinary/default sessions
seed `frozen`. `observed` is reachable only through explicit test/manual
terminal-capable grants until Slice 3 adds the product grant path.

### 2. Add a durable launch receipt, but do not invent resume-time attribution

Slice 2 makes the interval between request persistence and process launch materially
larger by inserting Git inspection and bounded before-image capture. Add a
`terminal-launch-receipt` artifact after the full pre-observation succeeds and
immediately before the OS spawn attempt.

Recovery truth is:

| Durable evidence | Recovery action |
| --- | --- |
| no request artifact | retain Slice 1's indeterminate pause; absence of a launch receipt alone is not enough to refund |
| request evidence, with or without a complete pre-observation, no launch receipt, and the host/store proves durable receipt absence | mark the existing journal record failed with a source-free prelaunch reason, refund the command reservation, clear the durable pending operation, and never claim a process ran |
| request evidence, with or without a complete pre-observation, no launch receipt, but durable receipt absence is not provable on this host/store | pause indeterminate and never rerun |
| partial, corrupt, or manifest-mismatched launch receipt | `RECOVERY_REQUIRED`; never treat corrupt evidence as absence |
| launch receipt, no exit receipt | pause indeterminate, never rerun |
| exit receipt, no complete result | mark/persist an indeterminate journal record with a source-free reconciliation summary, never rerun |
| complete matching result, no applied effects | promote the journal, apply effects exactly once, and replay |
| complete result and applied effects | replay only; no effect or budget changes |

Do not take a resume-time post-observation and call it operation-scoped. Unrelated
editor or user activity may have happened during the gap, and a later cleanup could
even erase the command's effects. Such an observation cannot prove either `none` or
`observed`.

The receipt is trusted for an absence-based retry decision only when the host/store
can prove the directory entry durable. On hosts where
`HostPlatform.supportsDirectoryFsync` is true, pre-create the first-write receipt-kind
directory and sync the artifact root, then write/fsync/rename the receipt and sync
the kind directory before spawn. Both directory syncs must succeed. If the host
cannot provide that guarantee, receipt absence remains indeterminate; this is the
conservative Windows fallback. Existing file-flush plus atomic-replace semantics
still receive ordinary process-crash coverage on every supported host, but they do
not justify refund or retry from absence alone. Do not claim sudden-power-loss
durability where Node cannot provide it.

A live prelaunch observation refusal follows the ordinary journal `markFailed` path
and returns the existing non-persisted typed failure outcome. It does not manufacture
a `terminal-result` artifact, because that schema requires a bound exit receipt.

### 3. Preserve the repository fingerprint definition

`repositoryFingerprint` remains exactly
`GitInspector.status().snapshotSha256`. The workspace observer must obtain this value
through the existing inspector rather than define a parallel digest.

Expose component fingerprints additively for index, policy-hidden state, protected
worktree state, normal Git transitions, and non-transition Git control state.
Existing `snapshotSha256`, `excludedStateSha256`, validation records, session-start
facts, and completion comparisons remain byte-compatible.

### 4. Record only meaningful or non-clean terminal mutations

- `observed` with nonempty changes: append one terminal mutation and increment
  `mutationSequence`.
- `unknown` or `protected_or_hidden_changed`: append one explicit non-clean terminal
  mutation without an invented repository fingerprint and increment
  `mutationSequence`.
- verified `none`: append no mutation and do not increment `mutationSequence`.

A full Slice 2 result clears a matching interim pending effect ID, if one was
durably created before interruption, only in the same atomic session update that
records the final attribution/accounting state. A legacy placeholder result never
clears its marker. A non-clean record still blocks completion explicitly under both
frozen and observed authority. A verified no-op must not make an informational
`kind: "answer"` completion impossible merely because a mutation record exists.

The durable applied-once key is the operation's entry in `pendingOperations`, not the
presence of a mutation record. That key exists for every executing terminal
operation, including a verified no-op. Effect application removes it and adds the
operation to the unreturned-result set in the same session persist that records
output accounting, any command refund, any mutation, its sequence increment, and
changed-file/line accounting. A later artifact replay therefore cannot apply effects
again even when the verified mutation outcome was `none`.

### 5. Keep observation bounded without rejecting large clean repositories

Do not persist a complete index manifest and do not persist post-images.

For before-state reconstruction:

- untracked paths retain bounded bytes, unless their blob already exists in the
  object database;
- tracked paths whose worktree differs from the index retain bounded bytes or an
  existing blob identity;
- staged and dirty porcelain-v2 entries retain their HEAD/index blob identities;
- a clean tracked path absent from pre-status is reconstructed from the persisted
  pre-observation HEAD;
- persist an index identity hash, not the full clean inventory; and
- missing or ambiguous evidence yields `unknown`, never an invented baseline.

Initial bounds:

- at most 200 retained source-image entries;
- at most 1 MiB per retained image;
- at most 3 MiB raw retained source bytes;
- at most 2 MiB index-identity input;
- at most 1 MiB porcelain-status input; and
- at most 6 MiB serialized observation artifact bytes after base64 expansion.

Exceeding required prelaunch evidence refuses launch with a bounded recovery action.
Post-launch overflow produces an explicit `unknown` observation while preserving
process truth.

Freeze a measured pre/post observation deadline and record observation duration in
source-free diagnostics. The single race retry is a complete re-observation and must
remain inside the documented total bound; no unbounded Git/control-state walk may
silently extend terminal latency.

### 6. Session diff is part of Slice 2

The current composition silently drops terminal mutations when building session
diffs. Slice 2 must widen the diff record to a patch/terminal union and use a narrow,
reference-verifying terminal before-image resolver. A terminal-mutated path is
included using the earliest trustworthy session baseline or produces explicit
unavailable evidence. It is never silently omitted.

### 7. Do not extend strict journal result metadata

Keep `terminal-journal-result/1` byte-compatible. Its validator is exact-keyed and
existing Slice 1 records must keep replaying. Full effect facts remain in the
integrity-bound terminal result and observation artifacts, which effect, diff, and
handoff consumers load through one validating persistence owner.

## Architecture

### Workspace observer

Add `src/repository/workspace-observer.ts`, exported by the repository package and
constructed by `RepositoryContext`.

The repository layer owns:

```ts
interface WorkspaceObserver {
  capturePre(signal?: AbortSignal): Promise<WorkspaceObservation>;
  capturePost(pre: WorkspaceObservation): Promise<WorkspaceObservation>;
  compare(
    pre: WorkspaceObservation,
    post: WorkspaceObservation,
    sessionBaseline: SessionPreExistingBaseline,
  ): Promise<WorkspaceEffect>;
}
```

The implementation has no browser, model, session-store, or runtime imports. It uses
direct Git argv, NUL-delimited porcelain v2, the existing repository boundary and
path identity, and bounded reads. It never invokes hooks, filters, aliases, a pager,
or a shell.

`capturePost` owns a short observation deadline. It must not reuse an already-aborted
process signal after timeout or cancellation. It starts only after process-tree
termination has returned.

Each observation is race-checked:

1. capture status, branch, HEAD, index identity, and component fingerprints;
2. retain the required bounded before-images;
3. recapture the cheap boundary facts;
4. accept only if both boundary samples match;
5. retry the complete observation once for ordinary concurrent churn; and
6. reject prelaunch or return an explicit non-clean post-state after the retry.

### Observation artifact

Keep the current placeholder codec as a byte-exact legacy branch. Add a strict union
member such as `terminal-workspace-observation/1` with:

- `phase: "pre" | "post"`;
- observation timestamp;
- the unchanged repository fingerprint;
- branch and HEAD facts;
- index identity;
- bounded porcelain-v2 entries with rename origins and HEAD/index blob identities;
- state fingerprints for visible paths;
- policy-hidden, protected, Git-transition, and Git-control component fingerprints;
- bounded pre-worktree image records with existence, mode, size, binary status,
  SHA-256, and either retained bytes or a reconstructible blob identity;
- bounded ignored summary with count, aggregate, and truncation flag;
- nested-repository result;
- `complete`, `protected_or_hidden_changed`, or `unknown` state; and
- bounded, source-free limitation codes.

The existing artifact envelope binds kind, operation ID, request hash, phase, body
hash, and reference. Do not add a third phase such as `post_recovered`.

### Effect comparison

Compare the exact persisted pre/post observations. Effects describe what was
observed during the operation window, not proven child causation.

Produce the existing frozen terminal result fields:

- created, updated, deleted, and conservatively verified renamed paths;
- pre-existing-touched paths, defined against the session-start
  `preExistingChanges` baseline;
- changed file and line counts;
- binary and bounded ignored summaries;
- mutation outcome; and
- final repository fingerprint only when state is known.

Rename classification requires a usable Git rename origin plus matching pre-state
identity. Ambiguous or unverifiable cases degrade to create/delete. Use
`RepositoryBoundary.pathKey` for identity and preserve display spelling, including
case-only renames.

Changed lines use deterministic before/post content while the post-state is current.
Binary paths are counted separately and excluded from line counts. Do not read a
later worktree to recompute a persisted terminal result.

An identical complete pre/post fingerprint yields `none`.
Protected/hidden/Git-control/nested-repository drift yields
`protected_or_hidden_changed`. Post-observation failure or insufficient evidence
yields `unknown`.

An OS spawn failure is still post-observed. If pre and post are identical, its
mutation is `none`; if they differ, use `unknown`, because a process that never
launched cannot truthfully be credited with concurrent changes.

### Terminal executor ordering

Preserve Slice 1's process, output, and artifact machinery. Replace placeholders in
this order:

1. prepare authorized cwd, environment, and normalized launch facts;
2. persist request evidence;
3. capture and persist the full pre-observation;
4. on insufficient pre-evidence, persist a typed prelaunch failure and refund
   `commands`;
5. persist the launch receipt;
6. spawn and supervise, retaining current output and cancellation behavior;
7. persist the source-free exit receipt;
8. wait for process-tree termination after timeout/cancellation;
9. capture and persist the full post-observation using its own deadline;
10. compare observations;
11. scan and bound output;
12. persist the complete result with independent process and mutation facts; and
13. return to `AgentRuntime`.

Post-observation trouble after launch does not erase a definite process result.
Artifact/result persistence failure retains Slice 1's conservative
`persistence_failed`/indeterminate behavior.

### Exactly-once effect transaction

Create one idempotent effect applicator keyed by operation ID and sourced only from a
verified terminal result artifact. Invoke it from:

1. live journal completion;
2. replay of a completed result whose session operation is still pending;
3. startup promotion of an executing journal record with a verified result; and
4. startup reconciliation of a session-pending operation whose journal record is
   already completed with a verified result.

The current startup path must not stop after journal promotion or skip an already
completed record merely because it no longer needs promotion. Both states apply the
same effects before recovery continues.

The sole apply condition is a matching durable `pendingOperations` entry. An
operation already in the unreturned/completed sets is a verified no-op; an operation
in neither state is `RECOVERY_REQUIRED`. One in-memory state update followed by one
atomic session persist performs:

- terminal mutation insertion when required;
- `mutationSequence` increment when required;
- changed-file/line post-hoc accounting;
- `commandOutputBytes` accounting;
- the one-time `commands` refund when verified evidence proves no process launched;
- pending terminal effect ID removal when one exists;
- removal from `pendingOperations`;
- insertion into the unreturned-result set; and
- durable pause facts for any budget overrun.

Implementation ordering is mandatory:

1. load and verify all artifacts and compute the complete effect without mutating
   session state;
2. construct the complete next session state from a clone;
3. apply mutation, sequence, budgets, marker cleanup, pending removal, and
   unreturned insertion to that clone;
4. persist the complete clone atomically;
5. publish it as the runtime state only after persistence succeeds; and
6. emit idempotent/deduplicated audit facts after durable state.

Terminal effect application therefore runs before the live path's existing
`clearPending` and `markOperationAwaitingReturn` calls; those calls move inside this
transaction. If artifact preparation or validation throws after journal completion,
the `operationWasCommitted` catch path must retain the pending entry, must not mark
the result unreturned, and must not persist any partial accounting. If session
persistence fails, restore the prior in-memory state and stop; the durable old state
still contains the pending operation for startup recovery.

If the persist succeeds, the pending entry and every charge/refund change together;
replay sees an unreturned result but no pending entry and performs disclosure only.
If a matching terminal mutation already exists while the operation remains pending,
verify its source-free facts before repairing state; a mismatch is
`RECOVERY_REQUIRED`.

Prelaunch recovery without a result artifact is a separate, source-free transaction:
after durable-absence proof, `OperationJournal.markFailed` records the prelaunch
reason and one session persist refunds `commands`, removes the pending operation,
and marks its failure awaiting return. It never enters the result-backed effect
applicator.

### Post-hoc budgets

Add a non-throwing terminal/post-hoc budget API. It:

- validates bounded nonnegative input;
- applies safe, saturating arithmetic without throwing before state is updated;
- records the actual known changed-file/line usage once;
- returns all exceeded dimensions and effective one-time/persisted limits; and
- allows the runtime to persist truth before entering the existing budget-recovery
  pause.

`commands` remains charged once at the launch boundary and refunded only when no
process launched. `commandOutputBytes` remains charged once from the durable result.
Recovery and replay never charge any counter twice.

### Terminal mutation and compatibility

Use the existing terminal mutation shape. Add only source-free facts that completion
or handoff cannot otherwise obtain cheaply, at most an optional `processOutcome`.
Do not duplicate full result facts in session state.

Update strict validators additively:

- legacy six-key patch records remain valid;
- optional `kind: "patch"` records remain valid;
- current Slice 1 terminal records and sessions remain readable;
- new terminal records require exact operation/result/observation binding;
- terminal records never receive a patch checkpoint ID or update
  `lastCheckpointId`; and
- non-clean records contain no invented fingerprint.

Legacy placeholder results replay exact process/output truth, retain or restore their
pending effect ID, and block completion with an actionable reconcile/new-session
message. They are never retroactively attributed from the current worktree.

### Session diff and handoff

Widen `SessionMutationDiffRecord` to a patch/terminal union. The diff engine receives
a narrow callback returning verified checkpoint-snapshot-shaped before facts; it
does not import the terminal artifact store.

For each task-mutated path, choose the earliest verified baseline across typed patch
checkpoints and terminal pre-observations. Include both rename endpoints. Missing,
placeholder, bounded-out, or unknown terminal evidence produces a per-path
`unavailable` marker and increments a bounded unavailable count while retaining
healthy path diffs. Integrity violations remain whole-diff
`RECOVERY_REQUIRED`; ordinary missing evidence for one path must not discard every
healthy patch or terminal baseline. This degradation applies only to terminal
baselines; a missing typed-patch checkpoint entry retains the current whole-diff
`CHECKPOINT_CORRUPT` behavior.

The final handoff separately reports:

- session-start pre-existing work;
- pre-existing paths touched during terminal windows;
- task-attributed patch and terminal paths;
- terminal process outcomes;
- non-clean observation limitations;
- named validation outcomes; and
- skipped checks.

The review package stays source-free. For exit-receipt-without-result recovery, add a
strict read seam that validates the incomplete evidence chain and derives a bounded
advisory. Persist that advisory in the indeterminate `OperationRecord.safeResult`,
which survives source-artifact and failed-handoff cleanup. Artifact cleanup may
remove source evidence later, but must not erase this journal summary for blocked,
aborted, or failed terminal sessions.

### Completion

Before authority-specific checks, completion rejects:

- every unresolved terminal pending effect;
- every terminal mutation with outcome `unknown` or
  `protected_or_hidden_changed`; and
- a latest terminal mutation that lacks an authoritative repository fingerprint.

These gates are authority-independent. They prevent a non-clean record from falling
back to `repositoryFingerprintAtStart` and becoming completable merely because the
live worktree happens to match session start.

`frozen` authority otherwise preserves current behavior verbatim, including
session-start branch, HEAD, and excluded-state checks.

`observed` authority:

1. rejects unresolved journal operations;
2. rejects legacy pending terminal effect IDs;
3. skips the session-start branch, HEAD, and excluded-state freeze after a
   trustworthy attributed effect;
4. selects the existing repository fingerprint from the latest trustworthy effect
   or validation;
5. allows a later catalog validation to become authoritative only at the current
   `mutationSequence` and exact current repository fingerprint;
6. requires the live completion snapshot to equal the selected facts;
7. rejects post-result editor/process drift; and
8. requires every configured named `run_command` validation to succeed after the
   latest mutation.

`terminal_exec` never creates a `ValidationRecord` and never satisfies a required
command ID.

No separate branch/HEAD/index fields are needed in `TerminalMutationRecord` for
completion. The unchanged `GitInspector.status().snapshotSha256` already binds
branch, HEAD, and every visible index/worktree entry. Component fingerprints support
effect classification and diagnostics, not a second completion identity.

## Shared contract gate

Land `S2-C0` as one exact-reviewed primary commit before specialist implementation.
It contains types, validators, compile-only seams, and compatibility tests, not live
attribution.

Required contract decisions:

1. unchanged `GitInspector.status().snapshotSha256` identity;
2. persisted, capability-seeded, monotonic `completionAuthority`;
3. `terminal-launch-receipt` added to every exact artifact-kind/reference validator,
   with durable-absence recovery gated by
   `HostPlatform.supportsDirectoryFsync`, artifact-root sync, and receipt-kind
   directory sync before spawn;
4. non-throwing post-hoc budget API;
5. strict legacy/full observation union with only pre/post phases;
6. no journal metadata key additions;
7. bounded before-images without a full index manifest or post-images;
8. mixed patch/terminal session-diff resolver with per-path unavailable evidence;
9. `completionAuthority` added to the exact top-level session-key validator while
   remaining optional for legacy sessions;
10. a strict incomplete-terminal-evidence reader that distinguishes absent,
    partial/corrupt, launch-receipt-only, and exit-receipt-without-result states; and
11. `pendingOperations` to unreturned/completed state as the durable exactly-once
    application transition for every terminal result, including `none`; and
12. use-site artifact-reference validators that allow a launch receipt only in its
    receipt position and do not widen stdout/stderr stream references to arbitrary
    `terminal-*` kinds.

Expected contract files:

- `src/repository/workspace-observer.ts`;
- additive types in `src/repository/git.ts`;
- `src/session/terminal-artifacts.ts`;
- `src/session/artifact-store.ts`;
- `src/session/types.ts`;
- `src/session/store.ts`;
- `src/session/budgets.ts`;
- `src/repository/snapshot-diff.ts`;
- `src/cli/commands.ts` for creation-time authority seeding; and
- compile-only completion/runtime wiring.

The contract gate must include byte-compatible Slice 1 artifact, journal, session,
patch-record, validation, and config-v1 fixtures.

## Worktree ownership

All tracks branch from the exact reviewed `S2-C0` SHA.

| Track | Exclusive production ownership | Focused tests |
| --- | --- | --- |
| A — repository observation | `workspace-observer.ts`; observation-only additions to `git.ts`, `context.ts`, repository exports | observer and Git fixtures |
| B — persistence/evidence | `terminal-artifacts.ts`, `artifact-store.ts`, observation/session validators | artifact binding, compatibility, durability |
| C — session diff | `snapshot-diff.ts` and narrow terminal resolver | mixed patch/terminal diff |
| P — primary serialized integration | `terminal-executor.ts`, `tool-host.ts`, `agent-runtime.ts`, `budgets.ts`, `completion.ts`, `runtime-composition.ts`, `cli/commands.ts`, handoff/review package | executor, runtime, accounting, completion, end-to-end, reliability |

No two worktrees edit an integration file concurrently. The primary owns all
contract changes after `S2-C0`, all conflict resolution, every push, and every merge.
Executor and runtime integration are deliberately serialized.

## Pull request and integration sequence

Use five reviewable PRs:

1. **S2-C0 — shared contracts.** Types, codecs, validators, compatibility fixtures,
   compile-only seams. Exact Opus review `R2-0`.
2. **S2-A+B — observer and bound persistence.** Integrate observer capture/compare
   with the strict artifact owner. Exact Opus review `R2-1`.
3. **S2-C — session diff.** Land mixed patch/terminal baselines against the reviewed
   observation reader.
4. **S2-P1+P2 — executor and effects.** Replace placeholders, add the launch
   receipt, preserve process ordering, implement startup/live/replay effect
   application and post-hoc accounting. Exact Opus review `R2-2`.
5. **S2-P3 — completion and acceptance.** Persist/consume completion authority,
   integrate freshness, handoff/review facts, cross-layer tests, and hosted evidence.
   Exact final-head Opus review `R2-3`.

Every pushed commit receives the standing exact-SHA Codex review. Each PR rebases or
merges onto the exact previous integration head before its final review. Only the
primary pushes and merges.

## Test matrix

### Observer

- clean no-op;
- create, update, delete;
- staged-only, unstaged-only, and mixed state;
- command cleans a previously dirty path;
- command edits a previously untracked path;
- conservative rename, ambiguous rename degradation, and case-only rename;
- empty file, executable-bit-only, LF/CRLF-only, and binary effects;
- commit, branch creation/switch, detached HEAD, and index-only effects;
- ignored summary without an exhaustive claim;
- hidden/protected path, hook/config/control drift, and nested repository;
- unreadable or over-bound post-state;
- required pre-image overrun refuses launch;
- one concurrent-churn retry, then explicit unknown;
- spaces, Unicode, leading dash, and host-specific path spelling; and
- observer fingerprint equals an independent
  `GitInspector.status().snapshotSha256`.

### Executor and artifacts

- full observation and result reference binding;
- legacy placeholder branch remains byte-compatible;
- post-observation after success, nonzero, timeout, cancellation, and OS spawn
  failure;
- post-observation starts after tree termination and ignores the caller's aborted
  signal;
- prelaunch refusal launches nothing and refunds;
- post-observation failure persists process truth with mutation `unknown`;
- output scanning denial preserves mutation truth;
- artifact/result persistence failure stays indeterminate; and
- cleanup preserves source-free reconcile facts.

### Crash and recovery

Inject crashes:

- after request;
- after pre-observation;
- after launch receipt;
- after the child side effect;
- after exit receipt;
- after post-observation;
- after full result;
- after journal completion;
- after journal completion with effect preparation/validation throwing;
- with a completed journal record and a still-pending session operation at startup;
- after effect application;
- after budget persistence;
- after pending-ID clearing; and
- after outbox queueing.

Every row proves zero duplicate launches. No receipt becomes a failed/refundable
prelaunch outcome only when the host/store proves durable absence; otherwise it
pauses. A partial or corrupt receipt requires recovery. Receipt without exit pauses.
Exit without result persists an indeterminate journal advisory. Complete result
promotes, consumes the durable pending-operation application key, accounts output
and any refund once, and becomes unreturned without applying effects twice.
Effect preparation failure after journal completion preserves the pending operation
and zero partial accounting.

### Accounting and session state

- observed nonempty effect records once, increments once, charges once, and clears
  the pending operation once;
- verified none records no mutation and no sequence increment, but still consumes
  its durable pending-operation key and accounts output once;
- unknown/protected records a non-clean effect, increments the sequence, clears the
  interim marker, and still blocks completion;
- nonzero, timeout, and cancellation use identical effect accounting;
- live, replay, startup promotion, and repeated recovery remain idempotent;
- startup applies effects for both executing-promoted and already-completed journal
  records that still have a session-pending operation;
- effect preparation/validation failure after journal completion retains pending
  state and cannot persist unreturned/partial accounting;
- mismatched duplicate facts require recovery;
- files-only, lines-only, and combined overruns persist actual usage before pausing;
- approved, denied, and unavailable budget raises;
- command and output counters remain exactly once; and
- old validation becomes stale after a terminal mutation.

### Diff, completion, and compatibility

- terminal-only, patch-then-terminal, terminal-then-patch, and repeated touches;
- earliest pre-existing user bytes remain the baseline;
- rename endpoints, per-path unavailable baseline behavior, and whole-diff integrity
  failure;
- no terminal-mutated path is silently omitted;
- observed authority is read only from the persisted field;
- default Slice 2 session creation seeds frozen while an explicit
  terminal-capable test/manual grant seeds observed;
- old `auto`, config v1, old grants, and absent-field sessions stay frozen;
- frozen branch/HEAD drift still rejects;
- non-clean terminal records reject under frozen and observed authority and never
  fall back to the session-start fingerprint;
- an attributed branch/HEAD/index transition completes only after fresh named
  validation;
- unknown/protected effects reject even after passing validation;
- post-result drift rejects;
- a no-op terminal command still permits informational completion;
- `run_command` remains the only named-validation satisfier;
- patch-only diffs and handoffs remain byte-compatible; and
- source-free review packages contain no commands, output, roots, or path names.

### Host behavior

Windows:

- direct Git argv and NUL-delimited parsing;
- case-insensitive `pathKey` identity with preserved display spelling;
- case-only rename and CRLF fixtures;
- `.cmd` shell-mode effects;
- `taskkill /T /F` completes before post-observation; and
- launch-receipt visibility across an ordinary hard process crash, with
  receipt-absence recovery remaining conservative when directory durability is not
  supported.

macOS:

- actual boundary case sensitivity, not an APFS assumption;
- executable-bit and UTF-8 filename effects;
- POSIX exit/signal and descendant cleanup truth;
- `/bin/sh` effects and cancellation followed by observation; and
- parent-directory sync after receipt rename.

Neither host claims child-process containment or exhaustive out-of-project effects.
Receipt-absence refund is a directory-fsync-capable POSIX/macOS behavior in Slice 2;
Windows acceptance requires a stable indeterminate pause with zero duplicate launch,
not a refundable retry.

## Review checkpoints

- **R2-0 — exact S2-C0 SHA:** fingerprint identity, authority persistence,
  receipt durability, observation union, bounds, non-throwing post-hoc accounting,
  strict compatibility, and specialist seam sufficiency.
- **R2-1 — exact S2-A+B SHA:** operation-scoped classification, before-image
  sufficiency, rename conservatism, base64 bound enforcement, protected/hidden
  taxonomy, and Windows path identity.
- **R2-2 — exact S2-P1+P2 SHA:** every crash window, process/effect independence,
  startup promotion, exactly-once mutation/sequence/budgets, and pause-after-persist
  ordering.
- **R2-3 — exact final Slice 2 SHA:** session-start work preservation, mixed session
  diff, non-widening resume behavior, validation freshness, handoff truth, host
  evidence, and full compatibility.

Duplicate execution, user-work loss, false completion, missing mutation after a
failed command, silent diff omission, unsupported-host breakage, or double
accounting is a merge blocker.

## Final acceptance

Slice 2 is mergeable only on one immutable exact head where:

1. every launched operation has a full pre-observation and full or explicit
   non-clean post-observation;
2. failed, timed-out, and cancelled commands preserve both process and effect truth;
3. all required project and Git effect classes have operation-scoped tests;
4. session-start user work remains separately identified and recoverable;
5. each result applies at most one mutation, sequence increment, and budget charge;
6. post-hoc overrun truth is durable before later work pauses;
7. the pending-operation application key clears only in the same persist as final
   output/refund/effect accounting, including for verified no-op;
8. unknown/protected effects reject under every completion authority and cannot be
   masked by validation or a session-start fingerprint fallback;
9. validation freshness matches the latest sequence and exact fingerprint;
10. observed sessions can complete after attributed Git transitions while old and
    frozen sessions retain their current restrictions;
11. external drift after the last recorded effect or validation rejects completion;
12. session diff contains terminal baselines or per-path unavailable evidence
    without discarding healthy paths;
13. handoff separates user work, terminal effects, process outcomes, validation, and
    limitations;
14. Windows and macOS hosted behavior is green without unexpected skips; and
15. existing terminal replay, process cleanup, browser/protocol, typed-patch,
    catalog command, old session/config, and offline fixture tests remain green; and
16. receipt-absence refund is proven only on directory-fsync-capable hosts; Windows
    uses a stable indeterminate pause with zero duplicate execution.

Run on the exact final SHA:

```text
npm run build
npm run test:unit
npm run test:e2e
npm run test:reliability
npm run check
```

Then run hosted Windows x64 standard-user and macOS arm64/x64 terminal observation
smokes before merge.

## Deferred work

Do not include:

- Slice 3 config v2, terminal grants, onboarding, product presentation, kill-switch
  UX, or release notes;
- PTY, stdin, interactive prompts, persistent/background processes, or watch mode;
- arbitrary-command rollback;
- filesystem watchers or kernel audit integration;
- worktree/container/VM/OS sandbox claims;
- exhaustive ignored, out-of-project, remote, network, or service-side attribution;
- multi-root workspaces;
- model-supplied environment variables;
- typed Git publication/push/release tools;
- paged observation artifacts;
- mode-enum renames; or
- enterprise tamper-resistance or new policy layers.

These are not Slice 2 blockers unless a concrete supported workflow would otherwise
duplicate execution, lose user work, or permit false completion.
