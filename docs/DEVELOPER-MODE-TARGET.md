# Developer mode target

## Decision

Developer mode is Cope's primary product target.

The intended experience is a local coding agent that feels materially similar to Claude Code while using Microsoft 365 Copilot Chat through a visible browser as the reasoning backend. Cope should maximize useful repository and terminal capability, minimize repeated permission friction, and preserve only the guardrails needed to keep the user in control of the selected workspace and to recover from ordinary failures.

Cope 0.1.10 ships the first complete Developer-mode terminal vertical on the
hardened foundation. It satisfies the one-shot terminal, project-effect,
completion, and compatible-grant milestone; the later capabilities named
below remain target work.

## MVP outcome

A developer should be able to:

1. Run `cope` in or against a project.
2. Approve one concise project-scoped grant.
3. Describe a coding task in plain English.
4. Let Copilot inspect files, search the project, edit code, run terminal commands, install dependencies, execute tests, use formatters and generators, and inspect the resulting diff.
5. Interact only when information is genuinely missing or an action materially exceeds the initial grant.
6. Pause, resume, or abort without duplicating browser submissions or local mutations.
7. Receive a final report grounded in observed files, command results, validation, and the actual working tree.

The MVP does not need to reproduce every Claude Code feature. It does need to remove the fixed-command-catalog ceiling that currently prevents normal terminal-driven development.

## Default grant

The default developer-mode grant should authorize ordinary work inside one selected project:

- read, create, edit, delete, move, and rename project files;
- run direct executables and shell commands as the current user;
- use repository-relative working directories;
- create generated and ignored artifacts;
- use the network through developer commands;
- inspect and modify local Git state;
- retain bounded command output and project diffs for the active session.

The initial grant should fit in a small terminal view. It should not expose implementation-level policy detail or make the user approve every tool independently.

## Mandatory guardrails

Developer mode keeps a small non-negotiable floor.

### Workspace clarity

Cope always identifies the selected workspace before starting. Additional filesystem roots for typed repository operations require an explicit expansion. Cope does not silently reinterpret the user's home directory or another broad folder as the project.

This is a product-authority boundary, not an operating-system sandbox. A shell command still runs with the current user's authority and can reach files outside the selected workspace.

### No elevation

Cope does not request or automate administrator, root, or UAC elevation. Commands run with the current user's existing authority.

### Protected Cope and browser state

Typed repository tools never expose Cope's private state, operation journal, checkpoints, machine policy, or dedicated browser profiles as normal workspace roots. Authentication remains manual and browser-owned.

The terminal contract instructs and authorizes the agent not to target those locations. Without an OS sandbox, Cope cannot guarantee that an arbitrary child process is technically unable to read or modify every file available to the current user. The product must not claim otherwise.

### Consequential external actions

Remote destructive or publishing actions remain separately authorizable where Cope can identify them. Examples include force-push, deleting remote resources, production deployment, package publication, release activation, and destructive cloud or database operations.

The MVP may conservatively ask for known remote writes until the policy and result contracts can distinguish them reliably. An arbitrary shell script can conceal external effects, so this is not complete service-level enforcement.

### Durable intent and no blind replay

Browser submissions, source mutations, and externally consequential operations record intent before execution. Unknown outcomes are reconciled rather than blindly repeated.

### Observable completion

Cope never reports a command, test, edit, or completion as successful without local evidence.

## Accepted developer-mode risks

Developer mode is not a sandbox.

A shell command can read files available to the user, contact the network, start child processes, consume resources, and modify state outside the project. Cope can reduce accidental harm through a clear workspace, process supervision, output limits, change inspection, durable operation records, and confirmations for known high-consequence actions. It cannot reliably contain a malicious or badly behaved executable through portable Node.js checks alone.

That residual risk is accepted for the MVP. The product must state it directly. Users seeking stronger containment should use hardened mode or run Cope inside a disposable VM, container, worktree, or other managed environment.

## MVP tool contract

### Existing tools retained

The current repository and lifecycle tools remain useful:

- `list_files`
- `search_text`
- `read_file`
- `git_status`
- `git_diff`
- `edit_text`
- `apply_patch`
- `request_user_input`
- `request_capability`
- `complete_task`

### New one-shot terminal tool

Cope 0.1.10 adds one broad `terminal_exec` operation under the existing
`cba-agent/1` envelope. The authority is versioned through required tool
contract `terminal-exec/1`; catalog-only `run_command` semantics remain
unchanged.

A representative request shape is:

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

Direct argv mode is also supported:

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

Keeping the established envelope avoids coupling the first terminal milestone to browser response-capture and session-protocol migration. An envelope-wide successor remains available when top-level message, correlation, or batching semantics actually need to change.

### Output behavior

One-shot terminal execution streams stdout and stderr to the local terminal
while the process runs. Copilot receives a bounded result and concise head/tail
excerpts with exact truncation and disclosure state.

The complete bounded result becomes durable before the operation journal marks
the tool complete. Crash recovery resends the same verified result rather than
rerunning the command.

### Process sessions

PTY-backed persistent processes are important for parity but should follow the first one-shot terminal milestone. The eventual surface should support:

- start process;
- read incremental output;
- write input;
- inspect status;
- stop process and descendants.

This unlocks development servers, watch modes, interactive installers, REPLs, debuggers, and tools that prompt.

### Git operations

The MVP uses the terminal for Git writes. Typed local Git tools can follow
where they improve recovery and presentation. Remote Git actions should remain
separately visible and authorizable where practical.

## Command mutation handling

Developer terminal commands are allowed to change Git-visible project state;
catalog-backed `run_command` retains its established validation boundary.

A developer-mode command operation should:

1. Capture a pre-command Git and workspace snapshot.
2. Execute the command under durable operation identity.
3. Capture the post-command state.
4. Record created, updated, deleted, and renamed project paths as the operation's observed mutation set.
5. Preserve pre-existing user changes as a separate category.
6. Return the exit result and a bounded change summary to Copilot.
7. Require later validation after the command mutation when completion policy calls for it.

A successful exit code and an acceptable mutation set are separate facts. A failed command may still have changed files, and those changes must remain visible and reconcilable.

The first terminal MVP should not promise atomic rollback for arbitrary commands whose target paths were unknown before launch. Existing patch tools retain their stronger checkpoint and rollback guarantees. Later isolated-worktree or sandbox modes may restore stronger command rollback semantics.

## Context budget

The browser model's context should be spent on the task, repository evidence, command output, and implementation decisions rather than repeated policy prose.

The target protocol should:

- send the stable contract once per conversation;
- present a compact active capability manifest;
- omit policy dimensions that cannot affect the next action;
- avoid repeating full tool schemas after bootstrap;
- batch independent observations;
- allow deterministic command sequences where no intermediate reasoning is required;
- summarize or page large command output and diffs;
- send repair reminders only after actual protocol failure.

A developer-mode pivot that merely adds many verbose tool schemas without reducing repeated contract text would recover capability while wasting context. Both concerns must be addressed together.

## Performance targets

Developer mode should reduce end-to-end task latency for normal work even if individual command operations become more expensive.

Expected improvements:

- fewer browser turns because one terminal command can perform several mechanical steps;
- fewer capability denials and permission-repair loops;
- faster repository understanding through native project tools such as tests, linters, compilers, and search utilities;
- less model output spent constructing whole-file patches for changes better handled by formatters, codemods, or generators;
- better validation fidelity;
- less repository scanning devoted solely to proving that an approved command changed nothing.

Expected costs:

- process startup and command runtime;
- larger output and diff payloads;
- pre/post mutation observation;
- more complex recovery for interrupted commands;
- possible context pressure if outputs are not summarized aggressively.

The implementation should measure browser turns, elapsed task time, model-visible bytes, command runtime, changed-file scan time, and recovery frequency. The target is lower total task time and higher task completion, not lower latency for every individual operation.

The implementation should replace the current no-mutation proof with one lightweight pre-command and one post-command workspace observation. Keeping all existing integrity scans and then adding full command snapshots would create an avoidable regression.

## Implementation sequence

### Phase 1: one-shot developer terminal

- add `terminal_exec` with a required `terminal-exec/1` contract under `cba-agent/1`;
- permit shell and argv execution from the selected workspace;
- stream live output locally while bounding the model payload;
- persist terminal results before journal completion;
- revise policy and initial grants for developer mode;
- replace the command-mutation prohibition with observed mutation attribution;
- meter actual changed files and lines after execution rather than requiring exact predeclared counts;
- keep timeouts, output bounds, cancellation, and process-tree cleanup;
- update bootstrap, results, tests, recovery, and completion accounting;
- retain the existing catalog command path for hardened validation.

This phase delivers the largest practical capability gain.

### Phase 2: process handles and PTY

- add persistent process records;
- stream incremental output through durable pages;
- support stdin and terminal resize where relevant;
- preserve process ownership across pause, resume, abort, and parent death where possible;
- expose concise process status to Copilot.

### Phase 3: broader workspace and Git ergonomics

- approve additional typed-tool roots;
- support move and rename as first-class mutations;
- add typed local Git actions;
- improve monorepo and multi-root behavior;
- add explicit remote-action classes.

### Phase 4: optional isolation

- add disposable worktree, container, VM, or OS-sandbox execution profiles;
- import approved resulting changes into the primary workspace;
- provide enforceable egress or resource controls only where the host actually supports them.

This phase is optional for the personal-developer MVP.

## MVP acceptance criteria

Developer mode is viable when all of the following are true:

- a standard project can complete a real task without manually authoring a command catalog;
- Copilot can run ordinary shell and argv commands after one initial grant;
- formatters, codemods, package managers, generators, and test tools may intentionally change project files;
- command-generated changes are attributed, diffable, and included in recovery and completion state;
- command failure, timeout, cancellation, and interruption preserve truthful outcomes;
- normal network-dependent developer commands can run;
- the model is not prompted again for authority already present in the grant;
- browser delivery ambiguity still cannot cause a blind duplicate submission;
- completion still depends on observed local state rather than model assertion;
- the complete offline loop remains testable without Copilot or an installed browser.

## Explicit non-goals for the first pivot

The first developer-mode release does not need:

- generic browser automation;
- automated Microsoft authentication, MFA, CAPTCHA, or consent;
- administrator or root elevation;
- perfect containment of arbitrary host commands;
- PTY-backed interactive sessions;
- automatic rollback for unknown-path arbitrary command effects;
- multi-agent coordination;
- hidden background operation;
- production deployment automation;
- a complete IDE or graphical interface;
- universal binary-file editing;
- enterprise policy distribution or fleet management.

These exclusions keep the MVP focused without weakening the core coding-agent experience.
