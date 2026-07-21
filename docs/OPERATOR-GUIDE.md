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
- Use `auto` only after representative edit-mode tasks pass and the full grant is appropriate.

Do not widen paths or add commands preemptively. A bounded capability can be granted later if organization and repository policy permit it.

## Start a session

The normal live command is:

```powershell
cope -C C:\work\eligible-repo "Fix the parser regression and add a focused test" `
  --accept "The regression test passes" `
  --accept "The approved validation suite passes"
```

Running `cope` without a task opens the guided interface. Use `/mode` to choose inspect, edit, or auto, and `/help` for the short interactive command list. The complete operational command set remains under `cope help advanced`.

Before work begins, review the compact task-access screen and explicitly approve it. It summarizes the repository, mode, allowed paths, commands, disclosure classes, and network setting. The underlying persisted grant still contains the complete versioned policy envelope. `--approve-grant` is suitable only when that exact computed envelope has already been reviewed through a controlled wrapper or scripted pilot procedure. It does not bypass policy.

In `edit`/`auto`, commands marked `sideEffects: true`—including the example `npm.test`/`npm.build` entries—may run when the combined policy and session grant explicitly allow them. Every command is checked before and after for nested Git plus Git-visible/nonignored, keyed policy-hidden protected, and Git-control drift. A command marked `sideEffects: false` additionally inventories ordinary Git-ignored files under fixed entry/byte bounds; a side-effecting command may create ordinary ignored build artifacts, which are excluded from the completion source fingerprint. Tracked/nonignored, protected, control, nested, or unverifiable drift makes the session recovery-required and the command cannot satisfy validation. Intentional source-mutating commands remain unsupported until a future versioned write-scope/checkpoint contract; source changes use `apply_patch`.

Command checks are not an OS filesystem, network, or resource sandbox. Approved executables and their transitive scripts are trusted computing base, and external writes cannot be comprehensively prevented or observed. Do not start a live pilot until the endpoint owner approves the exact catalog/scripts and the required application-control, egress, filesystem, and resource containment; this live gate does not prevent fixture/replay autonomous-loop testing.

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

In the active terminal, `Ctrl+C` or `SIGTERM` requests a safe, resumable pause. The runtime stops new actions, cancels its current wait/tool through the runtime signal, stops the browser transport, and persists `paused`. A run that ends paused returns exit code 2. Confirm the CLI reports `paused` before closing the terminal.

From another terminal, request a resumable pause:

```powershell
cope pause <session-id> --reason "review requested"
```

If the workspace owner is active, the second CLI writes a versioned local control request and waits up to 15 seconds for acknowledgement. An acknowledged pause returns exit code 0; an unacknowledged request returns 2 and must not be assumed effective. If no active owner holds the workspace, the command acquires the lock and transitions a pausable state directly. Repeating pause on an already paused session succeeds without changing it.

To make the session terminal, use explicit abort:

```powershell
cope abort <session-id> --reason "operator stop"
```

Abort uses the same active-owner control channel and cannot be downgraded by a later pause request. An inactive nonterminal session is moved directly to `aborted`; an existing terminal state is not altered. If the process is unresponsive and the request is not acknowledged, follow the incident procedure: isolate the endpoint if necessary, terminate the known agent/child/agent-owned browser processes through approved endpoint tooling, preserve non-source evidence, and reconcile repository/session state before any resume.

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

Perform normal human code review and delivery using standard repository tooling. V1 does not push, merge, deploy, publish, or release.

The final status/diff printed by an immediately successful `run` or `resume` is a fresh, workspace-locked, consistency-checked handoff whose fingerprint matches the verifier snapshot. A later standalone `status` is only the integrity-checked persisted snapshot; use trusted Git tooling for current repository truth.

## Resume

First inspect status and audit integrity:

```powershell
cope status <session-id>
cope verify-audit <session-id>
cope resume <session-id>
```

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
