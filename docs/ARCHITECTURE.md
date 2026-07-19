# Architecture

## Host portability boundary

One host adapter is selected at startup and injected through preflight, state/path resolution, onboarding, runtime composition, and process execution. Windows retains its `%LOCALAPPDATA%`, integrity-label, Edge/Git discovery, and `taskkill.exe` behavior. Darwin adds exact-tuple preview eligibility, Aqua verification, private Application Support storage, actual-volume case/Unicode identity, and a parent-death POSIX process-group supervisor. The browser adapter, `ModelTransport`, protocol, agent loop, policy meanings, and visible/headful/manual-authentication constraints are shared and unchanged. See [MACOS-TARGET.md](MACOS-TARGET.md); this boundary is implementation evidence, not live certification.

## Governing invariant

Microsoft 365 Copilot Chat is the only reasoning engine. The harness is a deterministic control plane: it moves explicit state, validates a versioned protocol, evaluates facts against policy, executes a requested typed operation, and reports observed outcomes. It must never infer a different tool call from malformed prose, invent repository facts, choose an implementation, reinterpret a failed command as success, or accept Copilot's completion claim on trust.

That boundary makes the browser replaceable and keeps the local runtime testable without Edge.

## Component boundaries

| Component | Owns | Must not own |
| --- | --- | --- |
| CLI (`src/cli`) | argument parsing, grant presentation, operator input, persisted status, pause/abort control, rollback, audit verification, review-package export, fresh terminal handoff | policy decisions, DOM details, repository mutation logic |
| Orchestrator (`src/orchestrator`) | state-machine progression, turn correlation, budgets, pending operations, recovery routing, completion checks | software-engineering judgment, direct filesystem or DOM access |
| Protocol (`src/protocol`) | `cba/1` schemas, strict fence extraction, correlation and semantic validation, bootstrap and result serialization | tool execution, policy, browser interaction |
| Policy (`src/policy`) | organization/repository/session precedence, allow/ask/deny, budget and capability decisions | executing a denied action, modifying its own inputs |
| Repository/security/tools (`src/repository`, `src/security`, `src/tools`) | path boundary, bounded reads/search, Git inspection, content controls, atomic changes, checkpoints, command catalog/process limits | browser selectors, model reasoning, arbitrary shell |
| Transport (`src/transport`) | submit/resolve/receive correlation and exactly-once status contract; offline fixture/replay implementations | repository or policy knowledge |
| Browser adapter (`src/browser`) | visible Edge lifecycle, dedicated profile, host/identity/protection assertions, semantic locators, submission/response association, page-state classification | local tools, policy decisions, source mutation |
| Session/audit (`src/session`, `src/audit`) | durable local truth, workspace lock, operation journal, artifacts, integrity records | treating the chat transcript as authoritative state |

Dependency direction is inward through contracts:

```text
CLI
 |
 v
AgentRuntime --> ProtocolAdapter
 |      |-----> RuntimePolicy --> PolicyEngine
 |      |-----> ToolExecutor --> repository/security/process services
 |      |-----> ModelTransport <---- fixture | replay | Edge adapter
 |      `-----> SessionStore / OperationJournal / AuditLog
 `------------> UserInteraction
```

The tool layer cannot import Copilot DOM assumptions. The browser adapter cannot read or modify a repository. A future supported model transport can replace Edge without changing policy or tools.

## Authoritative control flow

1. The CLI resolves the canonical Git repository, rejects index gitlinks and descendant Git boundaries, loads versioned configuration, records policy-visible pre-existing changes plus a keyed aggregate of hidden state, performs host preflight, and acquires the per-workspace lock.
2. The user approves one task-scoped session grant. No repository content is sent before the applicable disclosure capability exists.
3. The runtime serializes the objective, acceptance criteria, active tools, scope, and budgets into the `cba/1` bootstrap contract.
4. The disclosure guard scans the final serialized outbound message.
5. The transport submits it to the correlated conversation and returns a delivery status: `submitted`, `not-submitted`, or `indeterminate`.
6. The model response is accepted only when transport correlation and completion signals succeed.
7. The protocol adapter extracts exactly one `cba/1` envelope, validates its schema, task, turn, message direction, operation IDs, and batching semantics.
8. The runtime evaluates each requested operation against organization policy, repository policy, and the session grant.
9. The tool host revalidates local facts, executes the operation, records actual results, and places source-bearing output through the disclosure guard. For `run_command`, explicitly granted `sideEffects: true` validation may run in `edit`/`auto` and may create ordinary Git-ignored artifacts. Every command is bracketed by nested-Git plus Git-visible/nonignored, keyed policy-hidden protected, and Git-control integrity checks; `sideEffects: false` additionally binds a bounded ordinary-ignored-file inventory. Disallowed or unverifiable drift becomes recovery-required and cannot be trusted as validation. Intentional source-mutating commands remain outside v1 until a versioned write-scope/checkpoint contract exists.
10. Results return through the same transport. The loop continues without per-step approval while every operation remains in the existing grant and budget.
11. `complete_task` triggers local verification. A failed check becomes a structured result for Copilot to act on; only a successful local check makes the session `completed`.

## State machine

The persisted state uses schema version `1` and protocol version `cba/1`. Terminal states are `completed`, `rolled_back`, `blocked`, `aborted`, and `failed`. `rolled_back` means an explicit checkpoint restoration succeeded and any prior completion is no longer authoritative.

```text
created -> preflight -> grant_pending -> transport_starting
                                            |
                                            v
                                    initializing_model
                                            |
                                            v
                                      awaiting_model
                                       /    |     \
                                      v     v      v
                              executing  awaiting  validating
                                tools      user    completion
                                  |         |         |
                                  v         |         +--> completed
                              returning <---+         |
                               results <--------------+
                                  |
                                  `------> awaiting_model

active states --> paused --> recovering --> safe resumable state
active states -----------------------------> blocked | aborted | failed
inactive lifecycle state -- explicit verified rollback --> rolled_back
```

Transitions are enumerated in code. Redundant or unlisted transitions are internal errors. Each mutation and browser exchange has persistent intent before its consequential action.

Operator control is also explicit. `Ctrl+C`/`SIGTERM` request a resumable pause. A separate CLI first attempts the workspace lock; when the owner is active, it writes one versioned, session-bound pause/abort request for the owner's 250 ms monitor. Pause cancels the active runtime/transport and persists `paused`; abort persists terminal `aborted`. Abort has priority over a later pause request.

## Exactly-once and crash ordering

### Browser submissions

Before submission, the runtime stores the complete outbox artifact, hashes it, and persists a `prepared` submission intent. The adapter appends a task/turn/submission marker, rechecks host, identity, protection, conversation, and actionable composer state immediately before activating send. It then classifies the outcome:

- `submitted`: page evidence proves the marker is associated with the conversation;
- `not-submitted`: evidence proves activation did not happen, so retry is permitted;
- `indeterminate`: delivery cannot be proven either way, so blind retry is prohibited.

On recovery, the runtime asks `resolveSubmission` first. It reuses the same submission ID and original bytes only when non-submission is known. The opaque hashed conversation identity is persisted and required on subsequent turns.

### Local operations

The operation journal stores request integrity and lifecycle state. Completed operations return the recorded outcome rather than executing again. Read-only operations can be retried after bounded uncertainty. An interrupted mutation is marked indeterminate and requires reconciliation or rollback; it is never blindly replayed.

### Atomic source changes

`apply_patch` is one multi-file transaction. Paths and exact current-byte SHA-256 values are checked, a checkpoint is created outside the repository, all changes are staged and installed, and the post-change inventory is verified. Failure invokes restoration. If restoration itself cannot be proven, the session stops in recovery-required state.

Checkpoint-backed diffs remain inside the same repository boundary. `checkpoint` scope compares current bytes with one verified before-image; `session` scope receives a narrow mutation/checkpoint inventory from authoritative session state and selects the earliest before-image for each agent-mutated path. The repository diff inspector owns byte comparison, bounds, and concrete-path filtering. Tool orchestration supplies scope only; transports and the Edge adapter have no checkpoint or filesystem knowledge.

## Trust boundaries

1. User to CLI/session grant.
2. Organization/repository configuration to effective policy.
3. Repository/process output to disclosure guard.
4. Copilot output to strict protocol parser.
5. Harness to child process.
6. Harness to visible Edge automation.
7. Dedicated Edge profile to authentication state.
8. Edge to the approved Microsoft 365 host.
9. Session process to local audit and recovery storage.

Every value crossing these boundaries is untrusted until the receiving layer validates it. Source comments, documentation, test fixtures, filenames, diffs, and command output cannot alter protocol or authority.

## Local truth and storage

On Windows, the default state root is `%LOCALAPPDATA%\CopilotBrowserAgent`. Sessions, checkpoints, workspace locks, policy hashes, operation records, audit events, disclosure metadata, and temporary recovery artifacts live outside the repository. `.cba\repository.json` is repository configuration, not runtime state.

Operational records are separated by sensitivity and recovery purpose:

- `artifacts` stores exact outbox, response, and user-decision/capability-decision bytes with integrity manifests. Free-form decisions can contain repository-sensitive text. Verified completion clears this directory unless repository retention explicitly opts in; paused, failed, or interrupted sessions can retain it for recovery.
- checkpoints store source-bearing before-images and remain after completion until the approved checkpoint retention process removes them.
- `fingerprint.key` is a per-session 256-bit HMAC key used to make secret fingerprints non-dictionary-guessable. It is created during initial composition, never sent to Copilot or included in review export, and remains sensitive local state. Once the session has a durable repository baseline, a missing or malformed key fails recovery closed instead of being silently replaced.
- the completion handoff is a bounded, secret-redacted, integrity-protected durable model claim plus verifier facts. It can still contain task prose and repository paths, is retained separately from transient artifacts, and is not a source-free review package.
- `review-package.json` is an optional source-free derivative containing hashes, counts, timestamps, budgets, validation/mutation metadata, and redaction findings. Its SHA-256 body digest detects change relative to the package; it is not a signature, trusted timestamp, or external attestation.

Edge profile storage remains outside both repository and agent-state roots and is credential-equivalent. All of these records require explicit ACL, encryption, retention, backup, incident-preservation, and deletion decisions; POSIX-style creation modes do not provision Windows ACLs.

The audit and disclosure ledgers are SHA-256 hash chains. This detects modification or truncation relative to the available chain; it is not a signature, trusted timestamp, or substitute for approved host storage and access controls.

## Completion boundary

The completion verifier checks deterministic facts:

- repository state is currently known;
- no changed path is outside the effective scope;
- no operation remains pending;
- no browser submission is indeterminate;
- every required command has a latest successful record;
- required validation occurred after the last mutation when configured;
- the completion summary is nonempty; and
- configured acceptance criteria are addressed.

The final report distinguishes all working-tree changes, agent-recorded changed paths, and pre-existing user paths. After the session reaches `completed`, the active `run`/`resume` command takes a consistency-checked fresh Git status/diff and requires its fingerprint to match the verifier's completion snapshot. If that fresh handoff cannot be established, the command fails even though persisted state records the earlier verified completion. The standalone `status` command reports persisted facts and deliberately does not recompute repository state. The runtime does not commit, push, merge, deploy, publish, or release.

## Design rules for extension

- Introduce a new model surface by implementing `ModelTransport`; do not add surface-specific conditionals to the runtime.
- Introduce a new tool by versioning its schema and protocol contract, implementing deterministic authorization facts, adding bounded output and audit behavior, and extending offline/adversarial tests.
- Never add a raw shell, arbitrary path, generic browser-control, credential, or policy-modification tool to `cba/1`.
- A wire semantic change requires a new protocol version; a compatible UI selector update requires a new certified UI contract suffix.
- Configuration must fail closed on unknown schema versions and fields at every validated nesting level, including command, browser-host, UI-contract, signal-group, locator, and text-pattern objects.
- Keep tests capable of executing the complete loop without network, Edge, or Copilot.
