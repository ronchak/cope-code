# Policy and configuration

## Purpose

Policy exists to communicate and enforce the authority the user actually intends to grant. It should not turn normal developer work into a stream of avoidable prompts or imply stronger containment than the host provides.

Cope's target has two practical policy profiles:

- developer mode, optimized for broad local capability and low friction;
- hardened mode, optimized for managed restrictions and reviewed command surfaces.

Inspect mode remains a read-only option.

Cope 0.1.10 implements the first Developer-mode policy vertical on the existing
layered organization, repository, and session policy system. New quick setups
are Developer-ready. Existing valid configurations and managed policies keep
their exact meaning and are not automatically migrated.

## Policy precedence

Organization, repository, and session rules may still combine using the most restrictive applicable decision. That model is useful for managed deployments.

For the personal-developer default, the generated organization and repository policies should not contain broad denials that make the initial developer grant ineffective. A strict higher layer should be deliberate and visible rather than silently inherited from a hardened template.

Changing a persisted policy during an active session must not silently expand authority. Resume should either use the durable approved grant or require the user to begin a new session when the policy meaning changed.

`cope doctor` reports Developer-terminal availability without changing policy.
After parsing the concrete repository config, it short-circuits on a v1 schema,
a disabled v2 `developer_terminal.enabled` bit, or a non-`allow` embedded
repository decision; those branches mark the machine policy `not_read`. Only a
v2-enabled repository whose embedded policy allows `terminal_exec` causes doctor
to read the exact organization-policy path for the terminal decision. JSON
output records the repository file/schema/enable bit, evaluated provenance, and
machine status; machine policy identity, revision, field, and decision appear
only after a valid machine policy was read by that check. The separate required
Browser setup check still validates overall machine configuration. Doctor never
changes grants or policy files.

## Runtime modes

### Inspect

Inspect mode authorizes project-local reads and safe diagnostics. It denies file mutation and terminal execution that may have side effects.

### Developer

Developer mode is the recommended new-project profile. Its initial session grant authorizes:

- read, create, update, delete, move, and rename through typed repository tools inside the selected workspace;
- direct argv and shell execution as the current user;
- the selected project as the default working directory;
- ordinary command-generated project changes;
- normal network-dependent developer commands;
- local Git reads and writes;
- bounded command output, diffs, and mutation records;
- all normal repository and lifecycle tools.

The grant is task-scoped and presented once in a concise human-readable
summary. It states that general child processes run as the current user and are
not sandboxed to the selected project.

### Hardened

Hardened mode retains explicit command catalogs, path allowlists, network host declarations, lower budgets, and stricter mutation mechanisms. It may deny shell execution, command-generated source mutation, remote actions, or additional roots.

Hardened mode is opt-in unless an organization policy requires it.

## Non-negotiable floors

Even developer mode does not permit Cope itself to:

- request or automate administrator, root, UAC, or other privilege elevation;
- automate Microsoft credentials, MFA, CAPTCHA, consent, cookie extraction, or token replay;
- expose Cope's private state, checkpoints, machine configuration, or dedicated browser profiles as typed repository roots;
- silently add another typed-tool filesystem root;
- blindly replay an operation whose outcome is unknown;
- treat a model assertion as a local result.

These are application-authority rules. They do not make an arbitrary shell process technically unable to reach files or services available to the current user. Stronger prevention requires an operating-system sandbox, restricted account, container, VM, firewall, or comparable external control.

## Ask boundaries

Developer mode should ask only for materially new or high-consequence authority that Cope can identify. Typical ask boundaries are:

- access to an additional typed-tool filesystem root;
- an explicit operation outside the selected project grant;
- known remote destructive or publishing actions;
- production deployment or release activation;
- known destructive cloud or database operations;
- a resource, output, or time limit substantially above the active grant;
- a hardened-policy exception.

The model should not be asked again for permission already included in the active grant. Session approvals should survive resume and should be represented compactly in later model turns.

An arbitrary command or script may conceal external effects. Developer mode cannot promise complete intent detection for remote or out-of-workspace actions executed inside general shell code.

## Filesystem configuration

The selected project root is the default typed-tool workspace and terminal working directory. Repository tools use project-relative paths. Developer mode may add named roots for sibling packages, generated clients, shared configuration, or user-selected standalone files.

A future configuration shape may distinguish:

```json
{
  "workspace_roots": [
    { "id": "project", "path": ".", "access": "read-write" },
    { "id": "shared-types", "path": "../shared-types", "access": "read-write" }
  ]
}
```

The exact schema is not implemented in 0.1.9. Additional roots must be canonicalized, shown to the user, and bound to the session grant.

Cope state and browser profile roots are always excluded from typed workspace configuration. A general terminal process still has the current user's operating-system access unless external isolation is present.

## Terminal policy

The current command catalog remains valid for hardened commands and deterministic required validation.

Developer mode uses the separate `terminal_exec` capability with required
contract `terminal-exec/1`. It is additive to the established model-facing
envelope and does not widen `run_command`.

The current one-shot terminal policy authorizes:

- direct argv execution;
- explicit shell execution;
- a default project working directory and bounded requested cwd;
- environment inheritance rules;
- network use;
- maximum runtime and model-visible output;
- local output streaming;
- bounded process lifetime and output; and
- local Git and ordinary network-dependent behavior through the approved
  current-user command.

The policy authorizes the terminal capability class rather than requiring
every exact command to be predeclared. The runtime still records each exact
command and result. PTYs, stdin, persistent processes, additional roots, and
typed remote-action classification remain later work.

Shell mode may carry a higher risk label than direct argv mode, but it should not require a prompt for every invocation after the user has approved developer mode.

## Command-generated mutations

Developer policy permits terminal commands to create, update, delete, and
rename project files.

Authorization occurs against the active terminal capability before launch. The exact mutation set is observed after execution and added to session state. A command is not denied merely because its future changed paths cannot be enumerated perfectly in advance.

Changed-file and changed-line budgets for `terminal_exec` are metered from
observed post-command effects. They cannot be exact preconditions for launching
an arbitrary command. If actual usage exceeds the effective limit, Cope
records the effects truthfully and pauses later work rather than pretending the
command did not run.

The runtime should stop or ask when it observes an effect outside the intended project or against protected Cope state. It must acknowledge that an unrestricted host process can produce external effects that application-level inspection cannot detect.

Hardened mode may require declared write scopes, isolated worktrees, or no command-generated source mutation.

## Network policy

Developer mode permits normal network use by local developer commands after
the initial grant. This is conveyed as current-user process authority, not as a
claim that Cope can classify or firewall every child connection.

Application-level network metadata is authorization and reporting, not enforceable egress isolation. Exact host allowlists are suitable only when the command's behavior is actually predictable or when an external network control enforces them.

Hardened deployments may deny network, permit selected hosts, or run commands in an environment with real egress controls.

## Environment policy

Catalog validation retains the minimal hardened environment. Developer
terminal execution begins from the current user's ordinary process environment
and removes Cope-internal control variables and malformed entries. Durable
metadata records hashes and key names rather than secret values.

Secret environment values may be consumed by child processes. They must not be copied into browser messages unless the outbound content scanner explicitly permits the resulting text.

## Git and remote actions

Local Git operations are part of Developer authority through terminal
execution. Typed Git mutation tools remain later work.

Remote Git and publication actions should be separately visible where Cope can classify them. Suggested target classes are:

- local Git mutation;
- normal remote write;
- destructive remote write;
- deployment;
- publication or release.

The MVP may ask before known remote writes. It must not claim complete detection when arbitrary scripts can hide remote effects.

## Budgets

Budgets protect responsiveness and context, not authority for its own sake.

Developer-mode defaults should be high enough for real tasks and recoverable through a single session approval. Read, command, output, changed-file, and changed-line ceilings should not become hard organization limits in the default personal configuration.

Useful metrics include:

- elapsed time;
- browser turns;
- model-visible bytes;
- repository reads;
- terminal commands;
- terminal output bytes;
- changed files and lines;
- active processes;
- protocol repairs.

Per-operation model-visible output and file-size bounds remain useful. Large results should be streamed locally, paged, or summarized rather than rejected without a recovery path.

## Disclosure and secrets

Cope should continue scanning final outbound source and command output for likely credentials and sensitive material. Typed repository tools keep private roots excluded.

Secret detection is not perfect DLP. Developer-mode documentation and grant presentation should state that project content is being sent to Microsoft 365 Copilot Chat under the user's account and tenant configuration.

The model-facing bootstrap receives the active disclosure capability, not the complete local scanning configuration.

## Compact model projection

Policy is enforced locally. Copilot needs only the subset that changes what it can request.

The bootstrap policy projection should fit in a compact manifest such as:

```json
{
  "mode": "developer",
  "roots": [{ "id": "project", "access": "read-write" }],
  "terminal": {
    "contract": "terminal-exec/1",
    "shell": true,
    "argv": true,
    "network": true,
    "sandboxed": false
  },
  "git": { "local": true, "known_remote": "ask" },
  "protected_typed_roots": ["cope-state", "browser-profile"]
}
```

The exact format is versioned tool-contract work. Stable implementation details, long pattern lists, and policy checks that cannot affect the next action should remain local and out of the chat context.

## Current configuration compatibility

Cope 0.1.10 repository configuration includes:

- repository classification;
- embedded repository policy;
- default readable and writable paths;
- catalog command definitions;
- required completion commands;
- repository and patch limits;
- retention settings.

Strict `cba-repository-config/2` contains all of those fields plus exactly:

```json
{
  "developer_terminal": {
    "enabled": true
  }
}
```

The v2 bit is necessary but not sufficient: the session must be newly created
in internal `auto` mode and every policy layer must allow `terminal_exec`.

Strict `cba-repository-config/1` remains readable, normalizes to terminal
disabled in memory, and retains its raw document hash for resume pinning.
Existing documents and valid machine policies are not automatically rewritten
or widened. A resumed session keeps the original config, policy, and grant
hashes.

Quick setup writes config v2. Its standard profile enables Developer terminal
and writes a Developer-capable repository ceiling; inspect and manual profiles
write v2 with terminal disabled. Fresh machine setup writes a
Developer-capable organization ceiling. Existing machine policies continue to
win unchanged.

The existing internal `auto` session mode is presented as Developer for newly
created sessions. `edit`, `inspect`, old grants, and old persisted sessions
retain their current meaning. Catalog commands remain useful as named
completion checks even in Developer projects.

## Configuration principles

- Choose useful developer defaults for personal installations.
- Make hardened behavior explicit.
- Present grants in user language rather than schema language.
- Do not repeat prompts for authority already granted.
- Do not claim OS enforcement where only application checks exist.
- Version new terminal authority at the tool contract and preserve existing `run_command` semantics.
- Keep the current release and historical session behavior recoverable.
