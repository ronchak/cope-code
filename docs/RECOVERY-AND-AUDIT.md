# Recovery, checkpoints, and audit

## Recovery objective

Recovery preserves safety and local truth; it does not maximize automatic continuation. After a crash the runtime may retry only an action proven side-effect-free or not submitted. Uncertain browser sends and mutations are not replayed.

## Local records

The Windows default state root is `%LOCALAPPDATA%\CopilotBrowserAgent`. The experimental macOS preview candidate root is `~/Library/Application Support/CopilotBrowserAgent`, with exact user ownership, `0700` directories, `0600` files, no links, and no device transitions verified at startup. A session directory contains or references:

| Record | Content | Sensitivity |
| --- | --- | --- |
| `session.json` | state, objective/criteria, repository root/baseline, policy hashes, budgets, pending IDs, mutations, validations, submission phase | sensitive task/path metadata; no file bodies by design |
| `grant.json` | exact task-scoped session grant and session approvals | sensitive repository/path/authority metadata |
| `runtime.json` | transport kind, pinned offline-source path/hash or browser config hash | sensitive local path/config metadata |
| audit JSONL | hash-chained event metadata/outcomes | no raw file bodies by design; may contain paths/reasons |
| disclosure JSONL | hash-chained classification, byte/hash/path/redaction metadata | no disclosed content; paths/findings are sensitive |
| operation journal | request hash, lifecycle, safe outcome metadata | no raw file bodies by design; operationally sensitive |
| `artifacts/outbox` | exact pending message needed for send recovery | source/model/task-bearing |
| `artifacts/response` | exact received model response needed for parse recovery | source/model/task-bearing |
| `artifacts/decision` | exact user input or capability decision needed for replay | may contain free-form source/task-sensitive text |
| `fingerprint.key` | per-session 256-bit HMAC key for stable secret fingerprints | secret local key; never prompt/export content |
| completion handoff | bounded redacted model claim plus verifier facts | durable task prose and repository paths; not source-free |
| checkpoints | prior bytes/modes for paths in a mutation | source-bearing |
| `review-package.json` | optional source-free derived counts/hashes/budgets/findings | sensitive metadata; digest is not a signature |
| `control/request.json` | one versioned local pause or abort request for an active owner | operational metadata |

Exact filenames beyond the public CLI contract are implementation details; use CLI status/verify/rollback rather than editing records. State and recovery roots must remain outside repositories.

Every row requires an explicit handling decision; “no raw file bodies” does not mean public. Verified completion clears the transient `artifacts` directory—including outbox, response, and decision files—unless `retain_source_artifacts_on_completion` is true. Pause, failure, interruption, and some recovery states can retain those files. Checkpoints, `fingerprint.key`, completion handoff, ledgers, audit, and review exports are outside that cleanup switch and remain subject to their own approved retention/deletion procedures. Each product-specific dedicated browser profile is credential-equivalent and requires the strongest handling.

## Commit points

### Browser exchange

1. Store exact outbound bytes and integrity manifest.
2. Persist queued turn and `prepared` submission intent.
3. Ask the transport to submit once.
4. Resolve marker/page evidence into submitted, not-submitted, or indeterminate.
5. Persist conversation binding and submitted state.
6. Receive the correlated response.
7. Store response bytes and integrity before parsing.
8. Mark the submission answered; remove outbox when safe.
9. Parse/execute and then remove the response artifact.

If the process stops at any boundary, persisted state and artifacts determine the only legal next action.

### Mutation

1. Validate protocol and policy facts.
2. Journal accepted request hash and pending operation.
3. Re-resolve repository paths and current bytes.
4. Create and integrity-protect a checkpoint outside the repository.
5. Stage the all-file transaction.
6. Install changes and verify inventory/resulting hashes.
7. Journal actual outcome, mutation sequence, paths, lines, checkpoint, and repository fingerprint.
8. Clear pending state.

If execution began but final state is unavailable, the operation becomes indeterminate.

### Operator control

`pause` and `abort` first try to acquire the workspace lock. If the active owner holds it, the control CLI atomically writes a session-bound request under the session directory. The active process polls at 250 ms, verifies the request schema/session identity, and invokes pause or emergency stop. The requesting CLI waits up to 15 seconds for the persisted state transition. Abort has priority and cannot be overwritten by a later pause.

`Ctrl+C` and `SIGTERM` on the active CLI use the same safe-pause intent. Pause cancels the active runtime/transport and persists `paused`; it is resumable after normal integrity/recovery checks. Abort persists terminal `aborted` and cannot be resumed.

### User decisions and grant expansion

Before a user answer or capability decision can be replayed after a crash, the runtime stores its exact bytes plus an integrity manifest and binds the journal record to a decision hash. For an exact policy-waiting operation, `allow_once` is consumed only by that operation and leaves `grant.json` unchanged. `allow_session` updates the bounded grant, appends an approval key/timestamp, persists the new grant hash in state, and audits the expansion. A standalone capability request cannot safely bind `allow_once`, so that choice is returned as ineffective rather than becoming unscoped authority.

## Startup recovery decisions

| Persisted fact | Safe decision |
| --- | --- |
| queued outbound, no submission intent | submit the stored exact bytes once |
| prepared/submitted browser intent | call `resolveSubmission` before any retry |
| response cached and marked answered | parse the stored exact response |
| browser proves `not-submitted` | retry same submission ID and exact bytes |
| browser delivery indeterminate | pause; never blindly send again |
| completed operation journal record | return/reuse recorded result metadata, do not execute |
| interrupted read-only operation | retry only under current policy and budget |
| command changed tracked/nonignored, protected, Git-control, or nested-repository state, or a declared-side-effect-free command changed ordinary ignored state | stop with recovery required; the outcome is not trusted validation and the repository must be reconciled before any new session |
| accepted but never executing mutation | may reconcile as not started according to journal evidence |
| executing/indeterminate mutation | pause for repository reconciliation or rollback |
| existing durable repository baseline but missing/malformed 32-byte `fingerprint.key` | stop with recovery required; never generate a replacement key for that session |
| corrupt/partial state, audit, grant, runtime manifest, artifact, ledger, checkpoint, or review evidence | stop with recovery required |

## Repository reconciliation

Before resume:

1. Run `status` and `verify-audit`. Treat `status` as the persisted session/grant/disclosure/handoff snapshot, not current Git evidence.
2. Inspect Git status/diff using trusted local tooling.
3. Compare current paths with pre-existing changes and the session's mutation inventory.
4. Identify the intended checkpoint; the rollback command will verify it before restoration.
5. Determine whether each pending mutation fully happened, did not happen, or cannot be proven.
6. Do not edit session JSON or operation records to force a desired conclusion.

When uncertain, preserve the repository and state directory, mark the session non-resumable, and start a new task only after the repository owner resolves current changes.

During an active session, model-callable `git_diff` supports bounded checkpoint and whole-agent-session comparisons using integrity-verified before-images and current read policy. This is not a standalone operator recovery command; after interruption, use trusted local Git tooling plus verified checkpoint inventory.

## Rollback

Use the CLI:

```powershell
node dist\src\cli\main.js rollback <session-id>
node dist\src\cli\main.js rollback <session-id> --checkpoint <checkpoint-id>
node dist\src\cli\main.js rollback <session-id> --force
```

The default is the checkpoint recorded in state. If a hard crash occurred before state linkage, fallback is allowed only when exactly one mutating operation remains pending, and only to the newest integrity-verified checkpoint carrying that exact operation ID. Ambiguity or absence is an error and requires an explicitly inspected `--checkpoint`. Rollback requires the exclusive workspace lock, loads repository configuration for recovery bounds, verifies the audit chain, and then verifies checkpoint ID, manifest integrity, entry/blob sizes and SHA-256 values, and repository boundaries. Sealed checkpoints compare the current files with the recorded agent post-state and reject divergence, preserving later user edits. An unsealed interrupted checkpoint has no trustworthy post-state and therefore also refuses rollback unless `--force` is supplied after manual reconciliation. `--force` is the explicit destructive override. The rollback transaction captures the immediate pre-rollback state and attempts to restore it if rollback fails partway.

After success, rollback appends `checkpoint.rolled_back` and sets the terminal status to `rolled_back`, invalidating any earlier completion. The command reports both checkpoint summary and resulting session status.

Rollback is path-scoped, not `git reset`. It must not erase unrelated pre-existing files. Still inspect the checkpoint path list before acting: an agent update to a file that already had user changes may checkpoint those exact pre-mutation user bytes, and restoring them is correct only for that operation boundary.

Do not delete or edit a checkpoint manifest/blob. A corrupt checkpoint is a stop condition.

## Audit integrity

Audit events use monotonically increasing sequence numbers, session identity, timestamp, previous hash, safe event data, and SHA-256 of canonical event JSON. `verify-audit` checks the entire audit chain, rejects a partial final line, blank records, sequence/identity/hash mismatch, or modified events. It also verifies the disclosure-ledger chain when that file exists and returns the audit event count, final event hash, and disclosure validity.

The disclosure ledger uses an independent hash chain. It records content hash and byte counts, not content; secret findings are represented by safe rule/type/location metadata. `verify-audit` does not verify checkpoints, session artifacts, or repository contents; those are checked when their specific recovery operation loads them.

Hash chaining provides local tamper evidence only. An attacker who can rewrite all files and trusted reference points may create a new chain. Production evidence requires approved filesystem ACLs, encryption at rest, endpoint monitoring, retention, and—if required—external signed/append-only anchoring.

## Review package export

`export-review` acquires exclusive workspace ownership, reloads the persisted session, verifies the complete audit chain and disclosure ledger, and atomically emits `cba-review-package/1`. It excludes repository root, objectives/criterion text, changed/disclosure paths, model content, diffs, command output, raw audit events, and file bodies. It retains source-free but potentially sensitive timestamps, hashes, policy/grant identifiers, budgets, counts, mutation/validation metadata, and HMAC-derived redaction findings.

The writer requests a private `0600`-style mode for its temporary file and atomically replaces the destination. That mode is meaningful on POSIX filesystems but does not provision or verify Windows ACLs; the destination directory and resulting file need an approved Windows ACL. The package's SHA-256 body digest supports deterministic integrity verification only. It is not signed, externally anchored, timestamped, encrypted, or proof of who created it. If those properties are required, apply the approved signing/records pipeline after export and retain its external evidence.

The default output is inside the session directory. A custom parent must already exist outside the repository and protected state storage, and the command refuses links/special targets and state-control overwrite. Custom copies are not automatically deleted and inherit the records/access obligations of their destination.

## Retention and deletion

Define separate periods for:

- operational metadata/audit;
- disclosure metadata;
- transient outbox/response/decision artifacts;
- checkpoints;
- the per-session fingerprint key;
- completion handoffs;
- exported review packages and any external signatures/receipts;
- dedicated Edge and Chrome profile/authentication state; and
- redacted support diagnostics.

Use the shortest period compatible with recovery, incident handling, and records obligations. This code uses restrictive creation modes and best-effort deletion, but does not provide cryptographic secure erase, BitLocker management, enterprise backup exclusion, or eDiscovery integration. SSD/file-system deletion semantics require the organization's endpoint policy.

For a managed-policy failure, do not delete both managed files to obtain local fallback. Verify the installed bundle/trust hashes against the deployment record, inspect the source-free diagnostic, and have the policy owner atomically deliver a newly signed, fresh bundle or corrected trust pair. An active signed kill switch is intentionally non-recoverable from repository/session policy. Emergency re-enable requires a valid current bundle through the governed endpoint channel.

Never include state directories, checkpoints, dedicated browser profiles, or raw diagnostics in Git, support tickets, chat, email, or test fixtures.

## Browser configuration and product recovery

The persisted runtime-manifest value `edge` identifies the legacy live visible-browser transport for compatibility; the browser configuration hash pins the actual Edge/Chrome choice. Recovery never infers a product switch from that manifest value. Newly created live manifests also pin the verified canonical executable path, product, version, and SHA-256 in a separate `browser_identity_sha256`; resume requires both pins to match. Older manifests without that optional identity pin remain readable and still require exact configuration bytes, profile, hosts, and UI contract, but they cannot retroactively attest identity evidence absent from a legacy v1 browser file. After any suspected browser change, rerun setup and start a new session rather than resuming such an older session.

`cba-browser-config/1` is interpreted only as legacy Edge. A valid legacy file and its authenticated profile remain usable without a rewrite. A deliberate product change writes version 2 only after explicit confirmation and visible manual readiness, under an exclusive configuration lock and compare-and-swap transaction. Setup refuses the change while a resumable live-browser session exists. Concurrent edits, corrupt session manifests, product/executable mismatch, stale identity/version/hash, wrong-product profile markers, and tampering fail closed with recovery guidance; Cope does not guess, merge, or fall back to another browser.

After an interrupted setup, inspect `cope doctor --json`, the browser config hash, executable identity evidence, and dedicated-profile marker before retrying. Do not delete or repoint an authenticated profile to force recovery. If a browser update changes its version/hash, rerun guided setup and the applicable product/tuple certification gates. If profile material may have been exposed, stop live use and follow the identity-provider session-revocation and credential incident plan.

## Incident procedure

1. Stop the active agent and child processes; disable the browser adapter centrally if UI/identity integrity is in question.
2. Isolate the endpoint when unauthorized disclosure, credential/profile compromise, or malicious execution is suspected.
3. Preserve non-source evidence first. Preserve source-bearing artifacts only when approved and necessary.
4. Record session ID, safe timestamps, policy revisions/hashes, diagnostic codes, affected repository/path classifications, and operator actions.
5. Verify audit/disclosure/checkpoint integrity without modifying originals.
6. Reconcile repository and remote delivery state. V1 should have no autonomous push/deploy/publish.
7. Rotate/revoke browser sessions and credentials according to the identity incident plan if profile material may be exposed.
8. Notify repository data owner, security/privacy, service owner, and records owner as applicable.
9. Do not resume until the cause and trust boundary are restored; recertify the adapter after any UI incident.
