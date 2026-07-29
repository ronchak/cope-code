# Architecture

## Product intent

Cope turns Microsoft 365 Copilot Chat into a local coding agent through a visible supported browser. Copilot supplies software-engineering judgment. The local CLI supplies repository access, terminal execution, file editing, process control, Git operations, recovery, and verification.

The target user experience is intentionally close to Claude Code: open a project, describe a task, watch the agent inspect and modify the codebase, run the tools it needs, answer only genuinely necessary questions, and receive a grounded completion report.

Developer usefulness is the primary product objective. Security controls exist to preserve informed user authority, reduce accidental cross-workspace effects, protect Cope's browser transport and local records from ordinary tool access, and make observed local effects truthful and recoverable. They are not intended to reduce the agent to a fixed validation-command catalog or to imply that arbitrary host commands are sandboxed.

## Status

This document describes the target architecture. Cope 0.1.9 implements the browser transport, state machine, strict protocol, repository tools, atomic patching, command catalog, recovery, and completion foundations, but it does not yet implement the full developer-mode terminal surface described here.

The current implementation gap is summarized in [LIMITATIONS.md](LIMITATIONS.md). The minimum viable developer-mode target is defined in [DEVELOPER-MODE-TARGET.md](DEVELOPER-MODE-TARGET.md).

## Governing model

Microsoft 365 Copilot Chat is the reasoning engine. Cope is the local agent runtime.

Copilot may inspect evidence, choose an implementation, request tools, react to results, and decide when the task appears complete. Cope owns transport correlation, user authority, operation identity, local execution, durable state, observed outcomes, recovery, and final verification.

The harness must never fabricate a tool result, silently reinterpret malformed prose as an action, treat an uncertain browser submission as safely retryable, or accept a completion claim without checking local state. It may expose broad developer capabilities once the user has granted them. Deterministic execution is a correctness boundary, not a reason to make the tool weak.

## Design priorities

The architecture is ordered around these priorities:

1. A genuinely useful coding-agent workflow.
2. Low-friction autonomy for normal work in the selected project.
3. Accurate observation and attribution of local effects.
4. Truthful recovery after interruption or uncertain mutation.
5. Clear escalation for materially new or consequential authority.
6. Optional hardened deployment controls without making them the default product.

When a stronger security guarantee conflicts with the developer-mode experience, the product must state the residual risk honestly instead of pretending that application-level checks provide an operating-system sandbox.

## Component boundaries

| Component | Owns | Must not own |
| --- | --- | --- |
| CLI (`src/cli`) | project selection, task entry, grant presentation, live progress, user decisions, pause/abort/resume, final handoff | model reasoning, DOM selectors, hidden policy changes |
| Orchestrator (`src/orchestrator`) | agent-loop progression, turn correlation, operation scheduling, budgets, recovery routing, completion checks | software-engineering judgment, browser DOM logic |
| Protocol (`src/protocol`) | model-facing intents and results, tool schemas, deterministic identity, semantic validation, compact bootstrap and repairs | tool execution, policy decisions, browser interaction |
| Policy (`src/policy`) | modes, typed-tool workspace roots, allow/ask/deny decisions, capability expansion, high-consequence escalation | executing actions, inventing local facts, claiming OS containment |
| Repository (`src/repository`) | project discovery, bounded reads/search, file identity, diffs, checkpoints, patch transactions, observed change inventory | browser assumptions, model reasoning |
| Terminal and process services (`src/tools`) | direct argv and shell execution, live output, cancellation, environment and working-directory handling, later PTY/process handles | deciding what command solves the task |
| Git services (`src/repository`, `src/tools`) | status, diff, branch facts, local Git operations, attribution of command-generated changes | remote publication without applicable authority |
| Transport (`src/transport`) | submit/resolve/receive correlation and exactly-once delivery classification | repository or policy knowledge |
| Browser adapter (`src/browser`) | visible supported-browser lifecycle, dedicated profile, host/account checks, semantic locators, response association | local tools, source mutation, generic web automation |
| Session and audit (`src/session`, `src/audit`) | durable local truth, workspace lock, operation journal, artifacts, mutation records, integrity evidence | treating the chat transcript as authoritative state |

Dependency direction remains inward through contracts:

```text
CLI
 |
 v
AgentRuntime --> ProtocolAdapter
 |      |-----> RuntimePolicy --> PolicyEngine
 |      |-----> ToolExecutor --> repository / terminal / process / Git services
 |      |-----> ModelTransport <---- fixture | replay | browser adapter
 |      `-----> SessionStore / OperationJournal / AuditLog
 `------------> UserInteraction
```

The browser remains a replaceable transport. Terminal and repository services must not import Copilot DOM assumptions. The browser adapter must not read or modify project files.

## Runtime modes

### Inspect

Inspect mode is read-only. It permits repository inspection, safe diagnostics, and informational answers. It is the narrow mode for review or orientation.

### Developer

Developer mode is the target default. One initial task grant authorizes ordinary work in the selected project, including reading and editing files, running shell or direct commands, using installed developer tools, creating generated artifacts, using the network, and performing local Git operations.

Developer mode should interrupt only when Cope can identify a material expansion or high-consequence action, such as selecting another typed-tool root, requesting elevation, explicitly targeting Cope's private state or browser profile, or performing a destructive remote or publishing action.

A shell command still runs with the current user's operating-system authority. The selected project is the intended scope and default working directory, not a kernel-enforced boundary around the child process.

### Hardened

Hardened mode is optional. It retains reviewed command catalogs, stricter path rules, declared network hosts, narrower mutation mechanisms, and organization-controlled ceilings. It is appropriate for managed deployments, not the baseline personal-developer experience.

The current `edit` and `auto` modes may be migrated or aliased during implementation, but the resulting user-facing distinction must be simple: read-only inspection, normal developer autonomy, or an explicitly managed hardened profile.

## Authority and grants

The user approves one visible task-scoped grant before repository content is sent to Copilot. In developer mode, that grant should be compact and understandable:

- selected project and any additional typed-tool roots;
- permission to read and modify project files;
- permission to run local developer commands as the current user;
- whether network and local Git operations are available;
- known actions that still require confirmation;
- an explicit statement that general commands are not sandboxed to the project.

The model should not be prompted for permissions it already has. A denied operation should explain the actual boundary and whether a capability request can expand it. Session approvals should persist for the session and survive resume.

No mode grants operating-system elevation. Cope runs with the user's existing authority and does not bypass platform security controls.

## Target tool surface

The model-facing tool surface should remain typed, but it must be broad enough to support normal development.

### Repository observation

- list files and directories;
- search text;
- read bounded file ranges;
- inspect Git status and diffs;
- inspect file metadata and project configuration.

### Repository mutation

- exact text edits;
- atomic create, update, delete, and multi-file patches;
- move or rename files;
- record observed command-generated changes in session history.

### Terminal and process control

- execute a one-shot command through direct argv or an explicit shell;
- select a repository-relative default working directory;
- stream stdout and stderr locally while bounding model-visible output;
- cancel process trees on pause or abort;
- later start, inspect, write to, and stop long-running or interactive processes.

### Git

- inspect status, diff, branch, and history needed for the task;
- stage or restore selected paths;
- create local commits when granted;
- keep known push, force-push, merge, release, deployment, and publication actions separately authorizable where practical.

### Interaction and lifecycle

- request missing user input;
- request a bounded capability expansion;
- report progress;
- claim completion for independent local verification.

## Terminal execution model

Terminal execution is a first-class capability, not a disguised validation command.

A one-shot execution request should support either:

```text
executable + argv
```

or:

```text
shell + command text
```

Direct argv remains preferable when the model does not need shell syntax. Shell mode is necessary for ordinary developer workflows involving pipes, redirects, command chaining, environment setup, globs, and platform-native scripts.

Commands run as the current user with an explicit working directory. The runtime records the exact request, start and end state, exit status, duration, bounded output, cancellation state, and observed project effects. The CLI may show live output while Copilot receives only bounded excerpts or durable page references.

The runtime must not describe this as sandboxed unless an actual platform sandbox is present. Application-level process supervision, timeouts, output limits, and post-run inspection improve usability and recovery but do not contain a malicious executable.

PTY-backed and persistent processes are a later capability. They are not required to deliver the first useful developer-mode release.

## Command-generated mutations

Commands are allowed to modify project files in developer mode. Treating every tracked change from a formatter, codemod, package manager, generator, migration, or build tool as a recovery incident would defeat the product.

The minimum viable flow is:

1. Record the pre-command Git and workspace state.
2. Persist the exact terminal request under a mutating operation identity.
3. Run the command.
4. Inspect the resulting project state.
5. Attribute observed in-project creates, updates, deletes, and renames to the command operation.
6. Preserve pre-existing user changes as a separate category.
7. Persist the bounded command result before marking the operation complete.
8. Add the observed changes to session mutation history.
9. Return the actual change summary and command result to Copilot.
10. Require relevant validation after the latest mutation before completion when configured.

Command outcome and mutation outcome are separate facts. A failed, timed-out, or cancelled command may still have changed files.

Unexpected effects outside the intended project should stop the task when Cope can observe them. Cope cannot guarantee detection of every external effect from an unrestricted host process. Developer mode accepts that residual risk and communicates it plainly.

The existing patch engine retains strong checkpoint and rollback guarantees for predeclared file operations. The first terminal MVP should promise truthful attribution and reconciliation, not automatic rollback for arbitrary commands whose target paths were unknown before launch.

A later hardened implementation may run commands in an isolated worktree, container, VM, or operating-system sandbox and import the resulting patch into the real workspace.

## Filesystem scope

The selected project is the default workspace and command working directory. Typed repository tools use project-relative paths. Developer mode may add explicit roots for monorepos, sibling packages, generated SDKs, or user-selected files.

Cope's private state, operation journal, checkpoints, dedicated browser profiles, authentication material, and machine configuration are never ordinary typed-tool roots. The terminal contract does not authorize targeting them, but an unrestricted child process may technically reach any location available to the current user. Stronger prevention requires operating-system isolation.

Symlink and cross-device behavior should be based on the actual host and configured typed-tool workspace, not rejected universally for portability. The MVP may remain conservative where repository-tool recovery is not yet reliable, but those constraints are implementation gaps rather than permanent product principles.

## Network and credentials

Developer mode permits normal network use by developer commands. Package installation, documentation retrieval, source control, schema generation, and cloud-development tools are legitimate work.

Cope should not claim host-level egress enforcement unless it actually installs or integrates one. Network policy in application configuration is authorization and reporting without an OS firewall or sandbox.

The browser adapter never extracts or replays Microsoft credentials, cookies, or tokens. Local commands inherit the environment chosen by the terminal runtime. Secret detection and redaction remain useful before sending source or command output to Copilot, but they are not presented as perfect data-loss prevention.

## Browser transport boundary

The visible browser remains the main architectural constraint. Cope uses the supported Microsoft 365 Copilot UI, manual authentication, a dedicated product-specific profile, and correlated task conversations.

The adapter must retain:

- explicit approved hosts;
- manual sign-in, MFA, consent, and bot-control handling;
- submission markers and conversation binding;
- `submitted`, `not-submitted`, and `indeterminate` delivery states;
- resolve-before-retry behavior;
- response association and completion detection;
- no generic browser-control tool exposed to the model.

These controls prevent duplicate or misdirected browser actions without restricting local developer capability.

## Protocol and context efficiency

The model-facing contract should consume as little chat context as practical.

The first turn sends a compact capability manifest and active tool schemas. Stable operating rules are not repeated on every successful turn. Later turns carry only the relevant result, changed capability, or concise repair reminder. Policy details that cannot affect the next model decision remain local.

The first terminal milestone should add a separately versioned `terminal_exec` tool under the established `cba-agent/1` envelope. The current `run_command` meaning remains catalog-only. An envelope-wide protocol successor is reserved for incompatible changes to top-level message, correlation, authority, or batching semantics.

The protocol may batch independent observations and later add deterministic command sequences that do not require model interpretation between steps. Dependent decisions still require a result round trip.

## State, recovery, and exactly-once behavior

The persisted state machine, operation journal, browser outbox, and recovery model remain core architecture.

Before a consequential action, Cope records durable intent. Completed operations return recorded outcomes instead of executing twice. Read-only work may be retried after bounded uncertainty. A terminal, mutation, or remote action with an unknown outcome requires reconciliation rather than blind replay.

The complete bounded terminal result or stable artifact reference must be persisted before journal completion so recovery can return the same outcome without rerunning the command.

Pause and abort cancel active transport and process work. Resume reconstructs the session from local state, not from assumptions about the chat transcript.

## Completion boundary

Copilot's completion claim is advisory. Cope verifies deterministic local facts:

- the current workspace state is known;
- no operation remains unresolved;
- no browser submission is indeterminate;
- observed project changes are attributed or explicitly reported;
- configured required validation has a latest successful result after the relevant mutation;
- the completion report addresses the task and acceptance criteria.

Completion verification does not prove semantic correctness. The final handoff must distinguish model claims, command results, observed diffs, pre-existing changes, skipped validation, and remaining risk.

## Extension rules

- Add a new model surface by implementing `ModelTransport`.
- Add a new local capability through a typed tool with an explicit contract version.
- Preserve the meaning of existing tools such as catalog-backed `run_command`.
- Prefer broad useful tools with clear observed effects over many narrowly predeclared commands.
- Keep browser automation transport-specific and local execution browser-agnostic.
- Never claim containment, egress control, rollback, or transactional guarantees that the host implementation does not provide.
- Preserve offline fixture and replay coverage for the full loop.
- Keep hardened policy as an optional profile rather than the only architecture.

## Current implementation gap

Cope 0.1.9 already provides a strong base: browser correlation, durable sessions, typed model intents, policy evaluation, bounded repository inspection, atomic patching, one-shot process execution, cancellation, checkpoints, audit records, and independent completion verification.

It remains materially short of the target because commands are catalog-only, shells are prohibited, standard setup discovers only a few npm validation scripts, command-generated source changes are rejected, network access is denied by default, output is buffered rather than presented as a developer terminal stream, process interaction is non-PTY, terminal results are not durable replay artifacts, and local Git writes are unavailable through typed tools.

The pivot is substantial but evolutionary. It does not require replacing the browser transport or agent loop. It requires broadening local execution, adding post-command mutation attribution and durable terminal results, adjusting recovery and completion accounting, and changing the trust posture from maximum application-level containment to explicit developer authority with observable effects.
