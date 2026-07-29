# Threat model

## Security objective

Cope's primary target is a powerful local developer agent, not a portable application sandbox.

Cope 0.1.9 does not yet implement developer mode; current limits are recorded
in [LIMITATIONS.md](LIMITATIONS.md).

In developer mode, security means:

- the user knowingly selects the workspace and grants local coding authority;
- the browser-hosted model cannot silently expand that authority;
- Cope protects its own state and browser authentication from ordinary coding tools;
- consequential actions have durable identity and truthful outcomes;
- observed project changes are attributable and recoverable where practical;
- uncertainty is reported instead of being converted into false success or blind replay.

The objective is informed user control and reliable local state, not containment of every effect an arbitrary command could produce.

Hardened mode may impose stronger command catalogs, path restrictions, network declarations, and organization policy. Those controls are optional deployment profiles rather than the baseline product architecture.

## Scope

This model covers:

- the local Cope process;
- the selected workspace and configured additional roots;
- local terminal and child processes started by Cope;
- repository tools, patches, checkpoints, Git state, and completion evidence;
- local session, operation, audit, disclosure, and recovery records;
- the dedicated Edge or Chrome profile;
- the visible Microsoft 365 Copilot Chat exchange.

It does not model Microsoft service internals, a malicious administrator, a compromised operating system, physical compromise, or complete containment of a malicious executable launched with the user's authority.

## Assets

Important assets include:

- project source, configuration, history, and pre-existing work;
- credentials and sensitive data available to the user or present in files and command output;
- integrity and availability of the working tree;
- user grants and policy configuration;
- checkpoints, operation records, audit data, and completion evidence;
- the authenticated dedicated browser profile;
- Copilot task and conversation correlation;
- workstation compute, disk, network, and child processes.

## Actors and untrusted inputs

Actors include the authorized developer, Microsoft 365 Copilot Chat, repository contributors, dependencies, local tools, and attackers who can influence model output, repository content, command output, browser UI content, or unprivileged local files.

Model output, repository text, filenames, diffs, logs, command output, browser content, configuration, and replay fixtures are untrusted data until the receiving component validates the structure and authority relevant to that boundary.

Untrusted does not mean unusable. Copilot is expected to reason over untrusted project data and to invoke broadly useful developer tools within the active grant.

## Required assumptions

Developer mode assumes:

- the user intends to give a coding agent broad authority inside the selected workspace;
- the user accepts ordinary local-agent risk from shell commands and installed developer tools;
- the operating system, current user account, Node runtime, browser, and installed tools are trustworthy enough for local development;
- the approved Microsoft account and tenant may receive the disclosed project content;
- the selected workspace is the intended target;
- command exit codes and test results may be wrong or insufficient and still require interpretation;
- checkpoints are local recovery aids, not backups or isolation boundaries.

Cope does not assume:

- Copilot always follows instructions;
- repository content is benign;
- browser delivery is exactly once;
- the Copilot UI is stable;
- a command stays inside the workspace merely because its working directory starts there;
- declared network behavior is enforceable without an OS control;
- secret scanning is perfect;
- a model completion claim is true.

## Mandatory trust boundaries

### User grant

The user chooses the project and approves the initial mode and authority. The model cannot alter the grant through repository text or chat prose. Capability expansion is explicit and session-bound.

### Browser transport

Cope binds the approved host, visible identity signals, conversation, submission marker, and expected response. An uncertain send is not blindly retried. Authentication and security interstitials remain manual.

### Local execution

Every tool request is structurally validated and receives a harness-owned operation identity. Cope records the exact request and observed outcome. Shell text is executable only through an explicitly requested terminal tool, never because it appeared in ordinary prose, source code, logs, or documentation.

### Workspace and private state

Repository tools default to the selected workspace. Additional roots require explicit authority. Cope's private state, checkpoints, machine configuration, and browser profile are not exposed as normal project roots.

### Completion

The model proposes completion. Cope checks local operation, repository, validation, and transport facts before accepting it.

## Threat and control matrix

| Threat or failure | Developer-mode control | Accepted residual risk |
| --- | --- | --- |
| Model invents local facts | typed tools and authoritative local results | model may still reason poorly |
| Repository prompt injection changes authority | task and policy delimiters, typed action envelope, local grant checks | injection may influence choices that are already permitted |
| Malformed or ambiguous model action | strict versioned envelope and schemas | repeated protocol drift may block a task |
| Duplicate browser submission | durable outbox, unique marker, resolve-before-retry | UI may not expose decisive evidence |
| Wrong host, account, or conversation | approved host and identity signals, dedicated profile, conversation binding | visible UI signals can change or collide |
| Stale or duplicate file mutation | file identity where available, operation journal, checkpoints, post-state inspection | concurrent editors can still conflict |
| Command changes project files | pre/post state capture, mutation attribution, session diff, validation freshness | broad commands may create large or difficult-to-reverse changes |
| Command affects external state | clear grant, current-user execution, confirmation for known high-consequence actions | unrestricted host processes can have effects Cope cannot observe or undo |
| Command hangs or floods output | timeout, cancellation, process-tree supervision, bounded output | no kernel CPU, RAM, disk, or child-count quotas |
| Command uses network unexpectedly | user-visible developer grant and optional hardened policy | no enforceable egress control without OS support |
| Secret reaches Copilot | excluded private roots, scanning, redaction, final outbound check | false negatives remain possible |
| False completion | local verification of state, pending work, validation, and report evidence | passing tests may be inadequate |
| Recovery record corruption | hashes, strict parsing, fail-closed recovery | local hashes do not defeat a privileged rewrite |
| Browser profile theft | dedicated profile and no coding-tool access | malware or an administrator can still steal it |

## Shell and terminal risk

Shell support is required for the target product. It enables pipes, redirects, chained commands, platform-native scripts, package managers, build systems, formatters, codemods, and other normal developer workflows.

The terminal boundary must distinguish executable requests from data. It should preserve exact command text, working directory, environment choices, process identity, output, exit state, and observed workspace changes. It should not attempt to prove that an arbitrary command had no external effect.

Developer mode may allow shell execution after the initial grant. Hardened mode may require reviewed executable and argument definitions.

## Command-generated mutations

A command that changes project files is not automatically a security incident. It is an ordinary mutation source.

Cope should record the before state, run the command, capture the after state, attribute observed in-scope changes, preserve pre-existing changes separately, and integrate recoverable files with checkpoints and the session mutation history.

A failed, timed-out, or cancelled command may still have changed files. Outcome and mutation state must be recorded independently.

Changes outside the workspace should stop the task when observed. Developer mode accepts that portable Node-level inspection cannot reliably detect all external writes.

## Network and remote actions

Normal developer-mode commands may use the network. Cope should not present application metadata as a firewall.

Known high-consequence remote actions should remain separately visible or authorizable, including force-push, production deployment, package publication, release activation, destructive cloud changes, and destructive database operations. Detection will be incomplete in the MVP, especially when those actions are hidden inside arbitrary scripts.

Stronger guarantees require an isolated environment, restricted credentials, egress policy, or service-specific tools.

## Filesystem behavior

The selected workspace is the default scope, not a security sandbox. Project-relative paths reduce accidents and make results understandable. Additional roots should be explicit.

Current restrictions on links, devices, nested repositories, hard links, binary files, and cross-volume operations may remain temporarily where recovery is not implemented. They are compatibility limits, not the primary threat model for developer mode.

## Browser abuse cases that remain prohibited

The browser adapter must not:

- automate credentials, MFA, CAPTCHA, consent, or security interstitials;
- export cookies, tokens, storage state, headers, or private network captures;
- submit to an unapproved host or uncertain conversation;
- choose among ambiguous Copilot pages heuristically;
- retry an uncertain send without evidence;
- expose generic browser navigation or arbitrary browser control to the model.

These prohibitions protect the model transport without constraining local coding capability.

## Hardened mode

Hardened mode can retain or strengthen:

- reviewed command catalogs;
- direct argv only;
- explicit path allowlists;
- declared network hosts;
- lower budgets;
- no command-driven source mutation;
- disposable worktrees or isolated execution;
- organization-managed policy and audit controls.

The product should state which mode is active. Hardened controls must not silently define developer mode.

## Security testing priorities

Developer-mode testing should emphasize:

- exact workspace selection and additional-root grants;
- shell and argv serialization across Windows and macOS;
- command quoting, newline, NUL, environment, cwd, timeout, output flood, and cancellation behavior;
- process-tree cleanup and parent death;
- command-generated create, update, delete, rename, and partial-failure attribution;
- concurrent editor conflicts and preservation of pre-existing changes;
- package installation, formatter, codemod, generator, test, build, and development-server workflows;
- browser wrong-account, wrong-host, duplicate-send, UI-change, throttle, and recovery behavior;
- secret scanning and outbound truncation boundaries;
- crash recovery at every durable intent and completion point.

Live tests should use accounts and repositories approved for the intended mode.

## Residual-risk decision

The decisive risk choice is deliberate: Cope will accept ordinary local coding-agent risk in developer mode to become useful.

The project will keep strong browser correlation, explicit workspace authority, protected private state, durable operation identity, truthful outcomes, recovery, and completion verification. It will not preserve arbitrary shell and source-mutation prohibitions merely to support a containment claim the host application cannot fully enforce anyway.
