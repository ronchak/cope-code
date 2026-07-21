# Limitations and compatibility

## Current disposition

The repository contains an offline-testable runtime and a shared visible Edge/Chrome Copilot adapter design. Edge remains the established compatibility target; Chrome is a **preview candidate / offline evidence only**. Neither label is, by itself, authorization or evidence for a production/live real-repository deployment. The supplied environment data lacks the exact tenant URL, identity, protection indicator, UI selector certification, license/terms decision, repository eligibility, profile approval, and complete target-machine live results.

No live tuple is certified by this source tree. Windows x64 remains the primary blocking candidate. The two exact Mac candidates are experimental home-test preview lanes only: MacBook Air `Mac14,2`/M2/macOS `26.4.1`, and MacBook Pro `MacBookPro16,3`/Intel/macOS `15.7.7`. Hosted/offline success is not a live claim. See [MACOS-TARGET.md](MACOS-TARGET.md) and use the [live-pilot acceptance matrix](LIVE-PILOT-ACCEPTANCE.md) on each exact machine.

| Tier | Scope | Current evidence |
| --- | --- | --- |
| Primary | Exact Windows x64 candidate in `WINDOWS-TARGET.md` | Offline implementation; target/live and performance gates pending |
| Preview candidate | Exact M2 arm64 tuple in `MACOS-TARGET.md` | Offline implementation; owner-approved live evidence pending |
| Preview candidate | Exact Intel x64 tuple in `MACOS-TARGET.md` | Offline implementation; SSH/Aqua and owner-approved live evidence pending |

## Model transport

- Microsoft 365 Copilot Chat is reached through its user-facing web UI, not a supported function-calling API.
- Tool reliability depends on Copilot following a textual protocol over sustained turns.
- The UI, locators, account/protection presentation, throttling, and response behavior can change without this project's release cycle.
- The adapter supports one task conversation and one active Copilot page/profile at a time.
- It cannot always determine whether a browser activation reached the service. Ambiguity pauses instead of risking a duplicate.
- Conversation reconstruction is limited to persisted task/outbox/response facts; it cannot recreate hidden service state.
- No guarantee is made for all future Edge, Chrome, or Copilot versions, tenants, licenses, languages, accessibility layouts, experiments, or Conditional Access flows. Chromium similarity does not transfer live certification between products.

## Authentication and browser

- Cope recognizes Microsoft Edge and Google Chrome only through Stable bundle identities/installation locations. Known Beta/Dev/Canary/SxS locations, portable/lookalike paths, Brave, Arc, Chromium, embedded runtimes, and other derivatives are rejected even if they can launch a Chromium page.
- Identity verification proves that the approved Stable location/bundle plus platform product metadata/signature, canonical path/stat identity, version, and SHA-256 matched the requested product during configuration/launch. On Windows, this is not independent release-channel attestation and cannot defeat a privileged replacement by another vendor-signed binary. Exact binary/channel approval remains a certification responsibility; future binaries, endpoint integrity, tenant eligibility, UI compatibility, and live certification are not proved.
- Cope uses a separate product-marked persistent profile. Edge and Chrome never share it, and neither ordinary profile is eligible. Profile checks are application controls, not a sandbox against a malicious browser or privileged endpoint attacker.
- Sign-in, MFA, consent, reauthentication, bot controls, and security interstitials are manual.
- The profile contains credential-equivalent authentication state and is not encrypted or lifecycle-managed by this application.
- The baseline UI contract is not tenant-certified. Visible identity text can be ambiguous unless the deployment selects a unique approved signal.
- Screenshots, traces, DOM dumps, accessibility captures, and private network recordings are not part of normal diagnostics because they may contain source or credentials.
- Downloads are disabled; arbitrary browser navigation/control is not exposed.

## Repository and editing

- V1 supports bounded text files; not binary/media/archive/database/executable/certificate/key content, permission-only changes, links/junctions, devices, or submodules. Repositories containing an index gitlink or any descendant `.git` file/directory are rejected before tools start, and path resolution rechecks this boundary before access.
- Search is deterministic local text search, not semantic/AST indexing.
- Bounded `git_diff` supports working-tree, staged, one-checkpoint, and whole-agent-session baselines. It is not arbitrary Git history traversal, and checkpoint/session scopes cover only integrity-verified checkpoint inventory that remains allowed by current read policy.
- Ignore/generated/vendor/minified/lock/oversized handling is conservative and may hide content needed for a task until policy is changed.
- Hash-guarded atomic changes prevent stale overwrite, but external editors can still race between observations and cause a conflict/stop.
- The workspace lock prevents two agent sessions, not all other developer or IDE activity.
- Checkpoints are local path snapshots, not commits, backups, or disaster recovery.
- Rollback cannot undo a remote action; V1 intentionally exposes no push/deploy/publish action.

## Commands and isolation

- The command catalog blocks arbitrary shell construction, but approved executables and their repository scripts remain trusted computing base.
- The current `cba/1` catalog declares only `sideEffects: boolean`; it has no versioned bounded write-path/checkpoint contract for intentional command-driven source mutation. Explicitly granted `sideEffects: true` validation may run in `edit`/`auto` and may create ordinary Git-ignored artifacts, but source-mutating commands remain unsupported; source changes must use `apply_patch` until that future contract exists.
- Every command is bracketed by nested-Git plus Git-visible/nonignored, keyed policy-hidden protected-path, and Git-control integrity checks. Commands declared side-effect-free additionally inventory ordinary Git-ignored files under explicit entry/byte bounds. Tracked/nonignored, protected, control, or nested-boundary drift—or unverifiable state—becomes recovery-required and cannot count as trusted validation. Ordinary ignored artifacts created by a side-effecting command are excluded from the completion source fingerprint.
- These checks are detection, not an OS filesystem/network/resource sandbox. Approved executables and transitive scripts are trusted computing base, and external writes cannot be comprehensively prevented or observed. Endpoint containment, egress/resource controls, and command/script review therefore remain live-pilot and release gates; this residual risk does not block the deterministic offline autonomous-loop demonstration.
- There are timeout, output, environment, working-directory, cancellation, and process-tree controls; there are no kernel-enforced CPU, RAM, disk, handle, or child-count quotas.
- Declared network policy is not network sandboxing. A malicious/miscataloged binary may make network calls unless endpoint controls prevent it.
- Process-tree termination on Windows is best effort through `taskkill.exe`; hostile processes may evade ordinary user-level control.
- npm scripts can invoke transitive tools, mutate generated files, read environment, or access network. Review them before cataloging.
- The target machine lacks several language toolchains and `rg`; repositories requiring them need separately installed/certified tools and catalogs.

## Content security

- Secret scanning is deterministic pattern detection and can have false positives and false negatives.
- A repository classification label is a policy assertion, not automatic content classification or enterprise DLP.
- Redaction can reduce utility and does not make all sensitive context safe.
- Hashes and filenames/paths may themselves be sensitive metadata; storage and reports require governance.
- Copilot/Microsoft retention, data residency, audit, eDiscovery, and service-side handling are outside the local runtime.

## Audit, storage, and deletion

- Hash chains are tamper-evident relative to the retained local chain; they are not signatures, trusted timestamps, immutable storage, or proof against a privileged full rewrite.
- File modes are best-effort across platforms and do not configure Windows ACLs, BitLocker, backup, endpoint DLP, or secure erase.
- Exact outbox, model response, and user-decision recovery artifacts can exist locally during recovery windows. Decision artifacts may contain free-form sensitive text. Verified completion clears the transient artifact directory unless retention is explicitly enabled; pause/failure/interruption may leave it for recovery.
- Checkpoints, the per-session HMAC fingerprint key, and the redacted completion handoff are separate sensitive records and are not removed by transient-artifact cleanup. The handoff can contain task prose and repository paths even after secret redaction. Once a session has a durable repository baseline, a missing or malformed fingerprint key makes recovery fail closed rather than generating a replacement.
- Ordinary delete is not assured physical erasure on SSDs.
- No cloud telemetry is intentionally added, but Copilot interaction itself is a cloud disclosure.
- `export-review` is implemented and emits a source-free metadata package after verifying session, audit, and disclosure evidence. The package still contains potentially sensitive hashes, timings, budgets, counts, validation/mutation metadata, and redaction fingerprints. Its internal SHA-256 digest is not a signature, trusted timestamp, immutable-store receipt, or proof of origin.

## Completion and correctness

- Local completion verification establishes scope, pending state, command records, validation freshness, and report structure. It cannot prove semantic correctness, security, performance, adequacy of tests, or satisfaction of unstated requirements.
- Copilot may choose a poor implementation while staying within policy.
- Passing commands can be insufficient or nondeterministic.
- Final human review and the repository's ordinary delivery controls remain mandatory.

## CLI and operations

- The initial CLI is local and single-user; there is no daemon, remote control plane, multi-agent coordination, or GUI.
- `run` defaults to the configured live visible-browser transport and edit mode; offline fixture/replay and inspect mode must be selected explicitly. Missing live configuration still fails closed. The persisted value `edge` remains an internal live-transport compatibility discriminator, not a browser-product selection.
- The built-in initial approval view emits the complete versioned `cba-effective-grant/1` envelope. Preapproval is safe only as a controlled acknowledgement of that exact previously reviewed envelope; it does not alter policy.
- `status` is an integrity-checked view of persisted session/grant/disclosure/handoff facts, not a fresh Git observation. A fresh consistency-checked final status/diff exists only in the immediate successful `run`/`resume` completion handoff; use trusted Git tooling for later repository truth.
- One active session is permitted per canonical repository.
- `pause`, `Ctrl+C`, and `SIGTERM` cooperatively cancel the active runtime/transport and persist a resumable paused state; they are not transparent suspension at an arbitrary CPU instruction. A consequential operation interrupted at an uncertain boundary still requires reconciliation.
- `abort` is terminal. An active-owner pause/abort request waits up to 15 seconds for acknowledgement; timeout means the request was queued but must not be assumed effective.
- Successful explicit rollback makes the session terminal `rolled_back` and invalidates any prior completion; it is not resumable continuation.
- Recovery deliberately requires human reconciliation for uncertain mutation, corrupt state, identity ambiguity, and incompatible UI.
- There is no autonomous update, central policy distribution, code signing, adapter fleet kill switch, telemetry dashboard, or service desk integration in this source tree. Deployments must supply those operational controls or limit scope accordingly.

## Out of scope

No credentials/MFA automation, CAPTCHA bypass, private endpoint use, token extraction/replay, network interception, arbitrary shell/Git/filesystem/browser tool, elevation, hidden/background agent, multi-repository task, binary edit, local commit tool, push, pull request, merge, deployment, release, package publishing, or cross-user profile sharing is supported in v1.

## When to stop

Stop rather than work around the control when the host, account, protection indicator, conversation, selector state, repository root, path type, secret scan, policy/grant integrity, submission delivery, mutation outcome, audit/checkpoint integrity, or completion facts cannot be established. Use fixture/replay or manual development until the failed boundary is restored.
