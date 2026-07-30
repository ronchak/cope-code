# Operator guide

## Before every live session

Do not use a real repository until the [live-pilot acceptance matrix](LIVE-PILOT-ACCEPTANCE.md) has an accountable approval.

The supplied historical Windows/Edge machine map is not a certified compatibility tuple. In particular, it reports Git `2.55.0.windows.3` but names conflicting executable locations and records a failed `where.exe` lookup. Resolve and hash the exact Edge, Node, npm, and Git executables on that managed Windows target before treating its checklist as satisfied. A proposed Chrome tuple requires a separate record and cannot inherit this Edge evidence.

Confirm:

- the repository and its current classification are eligible for Copilot Chat disclosure;
- organization/repository configuration revisions are approved;
- the task is narrow enough for the selected paths, commands, and budgets;
- pre-existing working-tree changes are understood and backed up;
- the exact Copilot URL, work identity, protection indicator, and UI contract are certified;
- the dedicated profile is local/nonshared, outside repository and state roots, protected by approved ACLs, and certified;
- the selected Edge/Chrome product, Node, npm, Git, OS/architecture, and dependency versions are within that product's recorded compatibility tuple;
- the session is running as a standard user;
- checkpoints and state storage have sufficient local space and approved ACL/retention;
- no other process is using the selected product's dedicated browser profile or repository workspace; and
- the operator knows the emergency stop and manual fallback procedures.

Use a synthetic repository first after any upgrade or configuration change.

## Choose the smallest mode

- Use `inspect` for orientation, diagnosis, and read-only smoke tests.
- Use `edit` for bounded source/test changes and approved validation.
- Use Developer (internal `auto`) when current-user shell/argv execution,
  ordinary child network access, local Git effects, and the complete displayed
  grant are appropriate.

Do not widen paths or add commands preemptively. A bounded capability can be granted later if organization and repository policy permit it.

## Start a session

The normal live command is:

```powershell
cope -C C:\work\eligible-repo "Fix the parser regression and add a focused test" `
  --accept "The regression test passes" `
  --accept "The approved validation suite passes"
```

Running `cope` without a task opens the guided interface. Use `/mode` to choose
Inspect, Edit, or Developer, and `/help` for the short interactive command
list. `cope --auto` selects the same internal Developer mode. The complete
operational command set remains under `cope help advanced`.

Before work begins, review the compact task-access screen and explicitly
approve it. It summarizes the repository, effective mode, allowed paths,
commands, disclosure classes, and network setting. For Developer, it also
states that commands run as the current user, start in the project without an
OS sandbox, may use the ordinary environment/network and local Git, and have
bounded observed results. The underlying persisted grant still contains the
complete versioned policy envelope. `--approve-grant` is suitable only when
that exact computed envelope has already been reviewed through a controlled
wrapper or scripted pilot procedure. It does not bypass policy.

Catalog-backed `run_command` retains its established boundary. In
`edit`/Developer, entries marked `sideEffects: true`—including example
`npm.test`/`npm.build` definitions—may run when the combined policy and session
grant explicitly allow them. Catalog validation still treats tracked,
nonignored, protected, control, nested, or unverifiable drift as recovery
required and does not satisfy validation from that run.

Developer-only `terminal_exec` is the intentional command-mutation path. It
runs one shell or argv request, observes the project before and after,
attributes known in-scope changes even after nonzero/timeout/cancellation,
meters actual effects, and makes prior validation stale. Named required
validation still uses `run_command`; a terminal invocation does not satisfy a
configured command ID.

Command checks are not an OS filesystem, network, or resource sandbox.
Developer child processes have the current user's ordinary authority, and
external writes or connections cannot be comprehensively prevented or
observed. Do not start a live pilot until the endpoint owner accepts that
authority or supplies the required external application-control, egress,
filesystem, and resource containment.

Record the session ID. The CLI acquires one canonical-workspace lock, records Git/pre-existing state, creates an append-only audit chain, and binds the session to policy hashes and one transport.

For offline operation use `--transport fixture --fixture <file>` or `--transport replay --transcript <file>`. Offline source files are canonicalized and hash-pinned in the runtime manifest; replacing a source file is not a valid resume strategy.

## Visible browser readiness

The selected browser opens headfully with its product-specific dedicated profile. Complete sign-in, MFA, Conditional Access, consent, and reauthentication manually. The agent never clicks or types into those controls.

Before a submission, the adapter must classify the page `ready`, which requires:

- an approved HTTPS host and the expected conversation surface;
- exactly the intended task conversation;
- the configured organizational identity signal;
- the configured protection signal when required;
- an actionable composer/send strategy;
- no signed-out, MFA, consent, throttling, service error, or unexpected modal state; and
- the certified semantic locator contract.

An authentication redirect may remain visible while the user acts, but is never an approved submission host. An unknown account, host, modal, or selector state is a stop/pause condition, not a prompt to weaken the configuration.

## Observe the autonomous loop

Normal progress alternates between model response, protocol parse, local policy, local tool execution, scanned result submission, and the next model response. Routine reads, edits, tests, failures, and corrections should proceed without per-operation confirmation when already granted.

The operator should watch for:

- unexpected repository paths or unusually broad reads;
- repeated protocol repair;
- unexplained capability requests;
- commands, output volume, or elapsed time approaching budget;
- identity/protection changes or page navigation;
- service throttling or selector incompatibility;
- changes to pre-existing user files; and
- completion without current required validation.

Use `status <session-id>` from a separate terminal for persisted state. It reports session/task identity, repository baseline, complete stored session-grant capabilities, mode, budget limits/usage, status, turn/mutation/validation/pending counts, latest checkpoint, disclosure summary, persisted completion handoff, pause reason, and failure. It does not acquire the workspace lock or inspect current Git state. `--json` provides structured output for approved monitoring. Do not parse browser UI or audit files to issue new operations.

## Escalations

A legitimate escalation states the exact capability, affected resource, expected operation, risk, and applicable policy result.

Choose:

- `deny` when unnecessary, unclear, or outside intended task scope;
- `allow_once` for exactly one already-waiting operation; or
- `allow_session` for a repeated capability that is appropriate for the rest of this task.

`allow_once` is bound to that pending operation, is recorded crash-safely, and does not change `grant.json`. It is intentionally ineffective for a standalone `request_capability`, because no concrete operation exists to bind. `allow_session` persists a canonical capability approval and new grant hash for this task only. A higher-layer deny remains absolute; a higher-layer ask requires the user's explicit scoped session approval. Never approve a generic path, command family, disclosure class, network boundary, or budget when a narrower target is sufficient. To change higher policy, abort the session and use the separate governed configuration process.

## Pause and stop controls

In the active terminal, `Ctrl+C` or `SIGTERM` requests a safe, resumable pause.
The runtime stops new actions, cancels its current wait/tool—including the
active terminal process tree—stops the browser transport, persists all
available command/effect truth, and then persists `paused`. A run that ends
paused returns exit code 2. Confirm the CLI reports `paused` before closing the
terminal.

From another terminal, request a resumable pause:

```powershell
cope pause <session-id> --reason "review requested"
```

If the workspace owner is active, the second CLI writes a versioned local control request and waits up to 15 seconds for acknowledgement. An acknowledged pause returns exit code 0; an unacknowledged request returns 2 and must not be assumed effective. If no active owner holds the workspace, the command acquires the lock and transitions a pausable state directly. Repeating pause on an already paused session succeeds without changing it.

To make the session terminal, use explicit abort:

```powershell
cope abort <session-id> --reason "operator stop"
```

Abort is the emergency kill switch. It uses the same active-owner control
channel, stops new terminal requests, cancels the active process tree, and
cannot be downgraded by a later pause request. An inactive nonterminal session
is moved directly to `aborted`; an existing terminal state is not altered. It
reads session state directly and does not require valid browser or project
configuration, so it remains available when those files are missing or stale.

Run `cope sessions --all` before recovery. A `*` identifies a resume candidate whose static browser pins still match. A `!` identifies a blocked session and includes the reason plus an exact abort or reconciliation instruction. `cope abort --all` is deliberately rejected: bulk abort could erase the distinction between a clean startup interruption and a session with pending or recorded mutation evidence. If the process is unresponsive and the request is not acknowledged, follow the incident procedure: isolate the endpoint if necessary, terminate the known agent/child/agent-owned browser processes through approved endpoint tooling, preserve non-source evidence, and reconcile repository/session state before any resume.

Never delete a lock merely because work appears slow. Stale local locks are removed only after the owner PID is proven dead; a corrupt or remote-host lock requires investigation.

## Completion review

`completed` means the deterministic verifier accepted required local facts. It does not mean the code is correct, reviewed, committed, pushed, or ready for production.

Review:

- objective and per-criterion evidence;
- actual changed paths, agent-recorded paths, and pre-existing paths;
- final diff and Git status;
- every command outcome, truncation, redaction, and freshness after last mutation;
- skipped validation and remaining risks;
- latest checkpoint and rollback availability;
- disclosure classifications, byte counts, paths, and redaction counts; and
- any policy denial, escalation, protocol repair, browser recovery, or indeterminate event.

Perform normal human code review and delivery using standard repository
tooling. The typed tool surface does not provide push, merge, deploy, publish,
or release operations. Developer shell code can conceal such remote effects,
so the operator must not assume Cope classified or separately approved every
remote action.

The final status/diff printed by an immediately successful `run` or `resume` is a fresh, workspace-locked, consistency-checked handoff whose fingerprint matches the verifier snapshot. A later standalone `status` is only the integrity-checked persisted snapshot; use trusted Git tooling for current repository truth.

## Resume

First inspect status and audit integrity:

```powershell
cope status <session-id>
cope verify-audit <session-id>
cope resume <session-id>
```

Resume first performs the same static recovery assessment used by setup, sessions, and doctor. Missing, invalid, or changed browser configuration therefore produces a Cope recovery diagnostic and exact next action instead of a raw file-system error. Passing that preflight only means the session is a resume candidate; the existing runtime integrity, repository, ownership, and live-browser checks below still apply.

By default resume uses the recorded transport and, for offline sessions, the recorded canonical fixture/transcript path. An explicit `--transport fixture --fixture <same-file>` or replay equivalent is accepted only when it matches the recorded transport, canonical path, and SHA-256. Transport switching and replacement/modified offline sources are refused. Organization, repository, browser, or grant hash changes require a new session and grant; resume never silently reconciles them.

Resume is safe only when:

- audit/session/grant/runtime/artifact integrity passes;
- the existing session's 32-byte fingerprint key exists and is well formed; missing or malformed durable key state fails closed instead of silently generating a replacement;
- repository root, branch, fingerprint, and pre-existing state are reconciled;
- no other session owns the workspace;
- the same selected-browser task conversation can be proven, or an approved recovery path is used;
- pending read-only operations are safe to retry; and
- every pending mutation is proven completed/not executed or is rolled back/reconciled manually.

An indeterminate mutation must not be retried. See [Recovery, checkpoints, and audit](RECOVERY-AND-AUDIT.md).

## Audit verification and rollback

`verify-audit` validates the complete audit hash chain and, when present, the disclosure-ledger hash chain. Its JSON result includes the event count, final audit hash, and disclosure-ledger validity. It does not validate checkpoints or source-bearing artifacts; those are validated when their recovery path loads them.

```powershell
cope verify-audit <session-id> --json
cope export-review <session-id>
cope export-review <session-id> --output C:\approved\review.json
cope rollback <session-id>
cope rollback <session-id> --checkpoint <checkpoint-id>
cope rollback <session-id> --force
```

`export-review` first obtains exclusive workspace ownership and verifies the session, complete audit chain, and disclosure-ledger chain. It then atomically writes a source-free metadata package and requests mode `0600` for its temporary file. POSIX modes do not provision or verify a Windows ACL; approve the destination directory ACL separately. The artifact excludes objectives, criterion text, repository and changed paths, model content, diffs, source, command output, and raw audit data, but its hashes, timings, counts, budgets, validation/mutation metadata, and redaction fingerprints remain sensitive. Its SHA-256 body digest detects change relative to the file; it is not a signature, trusted timestamp, immutable-store receipt, or proof of origin. The default is `review-package.json` in the session data directory; a custom output parent must already exist outside the repository and protected state storage and is not covered by automatic session cleanup.

Rollback requires exclusive workspace ownership, reloads the current non-browser configuration, verifies the audit chain, and then verifies/restores the selected checkpoint. The default is `lastCheckpointId`. In a hard-crash window, fallback is permitted only when exactly one mutating operation remains pending and an integrity-verified checkpoint carries that exact operation ID; ambiguity or absence requires an explicitly inspected `--checkpoint`. A sealed checkpoint rejects files changed after the agent mutation. An unsealed interrupted checkpoint cannot prove whether current bytes are partial agent output or later user work and therefore requires `--force`. Use `--force` only after reviewing and accepting that it can overwrite those edits. A successful rollback appends an audit event and makes the session terminal `rolled_back`, invalidating any previous completion. Rollback is a repository-state recovery action, not a way to resume an earlier model turn.

## Common browser states

| State | Operator response |
| --- | --- |
| Signed out / MFA / consent | Complete manually in the visible selected browser, then allow bounded readiness polling |
| Wrong or unverifiable identity | Stop; do not edit selectors mid-session |
| Protection indicator absent | Stop; confirm tenant/license/surface with service owner |
| Unapproved host | Stop unless it is an explicitly configured manual-auth redirect during readiness |
| Throttled | Pause and follow approved retry-rate guidance; do not hammer refresh/send |
| Service error | Pause; preserve safe diagnostic code and use manual fallback if needed |
| Unexpected modal | Stop and inspect manually; never add a broad modal-dismiss action |
| Changed selector / multiple Copilot pages | Disable live transport and recertify the UI contract |
| Submission unresolved | Do not resend until marker/page evidence proves non-submission |
| Conversation mismatch | Stop; do not continue in a different chat with stale task state |

## Manual fallback

When the adapter is disabled or Copilot is unavailable, stop the autonomous session. Keep local changes/checkpoints, verify repository state, and continue with the organization's normal editor/test/review workflow. Do not manually paste source-bearing recovery artifacts into another chat unless that new disclosure is separately authorized and recorded.
