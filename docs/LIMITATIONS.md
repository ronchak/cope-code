# Limitations and compatibility

## Read this first

Cope's target architecture is the developer mode described in [ARCHITECTURE.md](ARCHITECTURE.md) and [DEVELOPER-MODE-TARGET.md](DEVELOPER-MODE-TARGET.md).

The current 0.1.10 release ships the first complete Developer-mode terminal
vertical on the hardened browser, protocol, repository, recovery, and
verification foundations.

This document separates current implementation limits from limitations that remain part of the target product.

## Current 0.1.10 implementation limits

### Terminal capability

Developer sessions may use additive `terminal_exec` in explicit shell or argv
mode. Output streams locally while a bounded result is retained for Copilot
and recovery. The selected project is a validated starting directory, not an
OS sandbox.

- Terminal authority requires a new Developer session, config v2 enabled, and
  an allow decision from every policy layer.
- `run_command` remains a separate catalog-backed tool for hardened commands
  and named completion validation.
- Standard input is unavailable.
- There is no PTY, REPL, watch-mode, development-server, debugger, or interactive installer workflow.
- There are no durable persistent process handles.

Existing config-v1 projects, durable grants, and denying managed policies
remain terminal-free.

### Command-generated source changes

Developer terminal commands may intentionally change Git-visible project
state. Cope records bounded pre/post observations, attributes known in-scope
effects, preserves pre-existing work separately, meters actual changes, and
invalidates stale completion evidence.

Observation is not an atomic command-write transaction. Before-images are
captured where supported, but arbitrary command effects are not guaranteed to
be reversible and external effects may be unobservable.

### Network

Developer terminal commands may use the current user's ordinary network access
after the initial task grant. Application policy is not an operating-system
egress sandbox and does not classify every connection. Hardened deployments
may retain a terminal denial and catalog network restrictions.

### Files and repositories

The current release operates inside one Git repository and supports bounded regular text files. It conservatively rejects or excludes binary files, archives, databases, executables, certificates, keys, submodules, nested Git worktrees, symbolic links, junctions, hard-linked files, and some generated or ignored paths.

Atomic patching and rollback also depend on host filesystem capabilities. These constraints protect the current transaction implementation. They should be revisited individually rather than treated as permanent product requirements.

### Git and delivery

Developer terminal commands can perform local Git operations. Cope observes
the resulting local repository facts; it does not yet expose typed Git
mutation tools. Arbitrary shell code may also perform remote writes that Cope
cannot reliably classify in advance. Push, merge, deploy, publication, and
release activation have no dedicated typed authorization surface in this MVP.

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

The catalog command path remains available for hardened mode and deterministic
required validation. Developer terminal authority uses its own versioned tool
contract and config-v2 bit rather than silently widening `run_command` or old
configuration.

Historical release notes continue to describe the behavior of their released
versions. Target documents describe remaining work; they do not retroactively
change 0.1.9 or any earlier release.

## When Cope must still stop

Even developer mode must stop or ask when it cannot establish the selected workspace, active user grant, browser host/account/conversation, submission outcome, operation identity, local mutation outcome, or recovery state.

It should not stop merely because an ordinary approved developer command changes project files, requires the network, uses a shell, or was not prewritten into a command catalog. Those are normal capabilities of the target product.
