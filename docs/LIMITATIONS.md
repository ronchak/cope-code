# Limitations and compatibility

## Read this first

Cope's target architecture is the developer mode described in [ARCHITECTURE.md](ARCHITECTURE.md) and [DEVELOPER-MODE-TARGET.md](DEVELOPER-MODE-TARGET.md).

The current 0.1.9 release is a hardened precursor. It proves important browser, protocol, repository, recovery, and verification foundations, but it does not yet provide the broad terminal capability required for the intended Claude Code-like experience.

This document separates current implementation limits from limitations that remain part of the target product.

## Current 0.1.9 implementation limits

### Terminal capability

Cope 0.1.9 does not expose a general terminal.

- `run_command` can invoke only commands defined in the repository command catalog.
- Shells and platform command-script shims are rejected.
- Standard setup discovers only selected npm validation scripts such as `test`, `check`, `build`, `typecheck`, and `lint`.
- Commands receive typed predeclared parameters rather than arbitrary arguments.
- Standard input is unavailable.
- Output is returned after process completion rather than streamed through a persistent process handle.
- There is no PTY, REPL, watch-mode, development-server, debugger, or interactive installer workflow.

These are current implementation constraints, not the target developer-mode design.

### Command-generated source changes

The current command boundary permits ordinary ignored build artifacts from side-effecting validation commands, but rejects changes to Git-visible project state. That means normal formatters, codemods, generators, package installation, lockfile updates, migrations, and scaffolding commands cannot be used as intended.

Developer mode will replace this prohibition with pre/post observation, mutation attribution, checkpoint integration, and truthful recovery state.

### Network

The default current policy denies command network access. Application policy is not an operating-system egress sandbox, so the current declaration should not be confused with enforceable network containment.

Developer mode will permit normal network-dependent development commands after the initial task grant. Hardened deployments may retain explicit network restrictions.

### Files and repositories

The current release operates inside one Git repository and supports bounded regular text files. It conservatively rejects or excludes binary files, archives, databases, executables, certificates, keys, submodules, nested Git worktrees, symbolic links, junctions, hard-linked files, and some generated or ignored paths.

Atomic patching and rollback also depend on host filesystem capabilities. These constraints protect the current transaction implementation. They should be revisited individually rather than treated as permanent product requirements.

### Git and delivery

The current tool surface can inspect status and bounded diffs, but it cannot stage files, create local commits, push, open pull requests, merge, deploy, publish packages, or release software.

The developer-mode target permits local Git operations and leaves remote publication or destructive actions separately authorizable.

### Browser and platform status

Microsoft 365 Copilot Chat is accessed through its user-facing web UI rather than a supported function-calling API. Tool reliability therefore depends on a textual protocol and on browser UI behavior that may change outside Cope's release cycle.

Edge remains the established compatibility target. Chrome and the documented macOS tuples remain preview candidates until their separate live acceptance gates pass. Offline and synthetic success do not constitute live certification.

## Target limitations that remain

### Browser transport is inherently brittle

The approved host, account presentation, selectors, response widgets, streaming signals, throttling behavior, and conversation UI can change. Cope can version its UI contract, correlate submissions, and fail safely, but it cannot make a public web interface as stable as a supported tool-calling API.

### Developer mode is not a sandbox

General shell and executable access runs with the current user's authority. A command may read accessible files, contact the network, consume resources, start child processes, and modify state outside the selected workspace.

Cope can provide a clear grant, project-relative defaults, process supervision, timeouts, output limits, checkpoints, post-run change inspection, and confirmations for known high-consequence actions. Portable application code cannot guarantee containment of an arbitrary host process.

Users requiring stronger isolation should use hardened mode or run Cope inside a disposable VM, container, worktree, or platform sandbox.

### Recovery cannot reverse every effect

Checkpoints can restore observed project files. They cannot reliably undo remote API calls, package publication, pushed commits, database changes, messages, payments, cloud-resource changes, or effects outside the captured workspace.

Unknown outcomes for consequential actions require reconciliation. Cope must not blindly repeat them.

### Secret detection is imperfect

Pattern-based secret scanning and redaction can produce false positives and false negatives. A repository classification is a policy assertion, not automatic enterprise DLP. Microsoft service-side retention, residency, audit, and eDiscovery remain outside the local runtime.

### Completion is evidence, not proof

Cope can verify the working tree, operation state, browser delivery state, required command results, validation freshness, and report structure. It cannot prove semantic correctness, security, performance, adequacy of tests, or satisfaction of unstated requirements.

### Single-user local operation

The current product is a local single-user CLI. There is no daemon, remote control plane, multi-agent coordinator, fleet policy service, GUI, or autonomous updater. One active session per canonical workspace remains a reasonable default until process and recovery semantics support more.

## Authentication and browser boundaries

Authentication remains manual. Cope does not automate credentials, MFA, CAPTCHA, consent, security interstitials, cookie extraction, token replay, or private Microsoft endpoints.

The dedicated Edge or Chrome profile contains credential-equivalent state. Cope keeps it separate from ordinary browser profiles and does not expose it as a coding workspace. Host encryption, access control, backup, incident response, and secure deletion remain endpoint responsibilities.

Generic browser navigation or arbitrary browser control is not part of the coding-agent target.

## Process and resource limits

Cope can impose timeouts, output bounds, cancellation, and process-tree termination. These do not provide kernel-enforced CPU, RAM, disk, handle, child-count, or network quotas. Windows process-tree termination remains best effort. POSIX supervision improves cleanup but cannot contain hostile executables.

## Compatibility direction

The current catalog command path should remain available for hardened mode and for deterministic required validation. Developer-mode terminal tools require a versioned protocol and configuration change rather than silently widening current `run_command` semantics.

Historical release notes continue to describe the behavior of their released versions. Target documents describe where the product is going; they do not retroactively change 0.1.9 or any earlier release.

## When Cope must still stop

Even developer mode must stop or ask when it cannot establish the selected workspace, active user grant, browser host/account/conversation, submission outcome, operation identity, local mutation outcome, or recovery state.

It should not stop merely because an ordinary approved developer command changes project files, requires the network, uses a shell, or was not prewritten into a command catalog. Those are normal capabilities of the target product.
