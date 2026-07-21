# Policy and configuration

## Fail-closed loading

Live sessions require three explicit inputs: an organization policy, a repository configuration with embedded repository policy, and a browser/UI configuration. Each JSON object has a version discriminator and rejects unknown fields, including nested command, browser-host, UI-contract, signal-group, locator, and text-pattern fields. Configuration bytes are bounded, UTF-8 BOMs are refused, schemas are validated, policy patterns are safety-checked, duplicate rules are rejected, and file hashes are persisted with the session.

Changing a policy file does not silently expand a running session. Resume requires the persisted organization/repository/browser hashes and grant hash to match; a change is refused and requires a new session/grant.

Default Windows locations:

```text
%LOCALAPPDATA%\CopilotBrowserAgent\config\organization-policy.json
%LOCALAPPDATA%\CopilotBrowserAgent\config\browser.json
<canonical repository root>\.cba\repository.json
```

Experimental macOS preview candidate locations (same schemas and policy meanings):

```text
~/Library/Application Support/CopilotBrowserAgent/config/organization-policy.json
~/Library/Application Support/CopilotBrowserAgent/config/browser.json
<canonical repository root>/.cba/repository.json
~/Library/Application Support/CopilotBrowserAgentEdgeProfile
~/Library/Application Support/CopilotBrowserAgentChromeProfile
```

The macOS state tree and Cope-owned profile files are ownership/mode verified on every startup; wrong or unverifiable storage fails closed. Location parity does not imply a certified live tuple.

The files in `config/examples` are nondeployable review templates. The policies contain placeholder IDs/revisions, and the browser file uses reserved `.invalid` hosts plus identity/profile placeholders. Copying them is neither authorization nor certification.

## Three policy layers

Each operation is evaluated independently against:

1. `organization`: enterprise-wide, non-overridable constraints;
2. `repository`: data-owner scope, protected content, catalog, and task limits; and
3. `session`: one user's approval for one task, repository, branch, mode, paths, commands, disclosure classes, and budgets.

The effective result is the most restrictive: `deny > ask > allow`. An allow in a lower layer cannot weaken a higher-layer ask or deny. Effective numeric budgets are the minimum values supplied by the three layers. Missing rules resolve to that layer's `default_decision`; production policies should use explicit rules and a deny default.

Policy decisions are:

- `allow`: execute and audit without another prompt;
- `ask`: pause for one specific capability expansion;
- `deny`: do not execute; return a structured reason to Copilot.

High-confidence secret or credential disclosure is a non-overridable v1 denial.

## Autonomy modes

| Mode | Read/search/Git | Source mutation | Commands |
| --- | --- | --- | --- |
| `inspect` | within grant | denied | granted, genuinely side-effect-free commands only |
| `edit` | within grant | within writable/create/delete grant | explicitly granted catalog commands; `sideEffects: true` validation is allowed within the integrity boundary |
| `auto` | within grant | within full approved envelope | same command integrity boundary; mode does not broaden the catalog or grant |

The mode is an additional restriction, not a replacement for policy. `auto` does not grant a path, command, network, disclosure, or change class by itself.

## `cba-policy/1`

A policy document has `policy_id`, `revision`, `layer`, `default_decision`, and `capabilities`. `policy_id` identifies one governed policy lineage; increment/change `revision` whenever its meaning changes, and persist the installed-file hash with approval evidence. The strict schema intentionally has no `owner` or free-form approval field. Record accountable owner, approvers, evidence, validity, policy ID/revision, and hash in the external governance system rather than adding an unknown JSON key.

### Tools

`tools` is a rule set over the ten exact `cba/1` tool names. Unknown tools are always denied. Removing a tool from repository policy removes it from effective use without changing the semantics of remaining tools.

### Paths

`paths.read`, `write`, `create`, and `delete` are repository-relative glob rule sets. `excluded` paths cannot be read, disclosed, or changed. `protected` paths may be readable only if another rule permits, but cannot be mutated.

Patterns must be relative, bounded, and safe. Resolution also canonicalizes filesystem state and rejects absolute paths, drive/UNC paths, `..`, alternate streams, links, devices, and other escapes. A glob allow is never the only path control.

The CLI runtime has mandatory floors in addition to configured policy. Repository discovery/read/search always applies conservative non-negatable exclusions for Git/agent control data, dependency/vendor/build/coverage trees, lock/minified/binary/archive/database/media content, environment files, and key/certificate material. Mutation always applies built-in protection for `.git`, `.cba`, `.copilot-agent`, environment/key material, and CI workflow controls. The live composition API does not expose the library's default-exclusion override. Organization/repository `excluded` and `protected` lists add restrictions; they cannot remove these runtime floors.

Onboarded policy should still list the applicable mandatory patterns explicitly so owners can review the intended boundary, and it must add repository-specific credentials, generated output, deployment, code-owner, signing, release, and other sensitive controls. Index mode-`160000` gitlinks and every descendant `.git` file/directory are rejected as unsupported repository boundaries irrespective of glob policy; the invariant runs in preflight/composition and is rechecked during path access and completion.

### Commands

Policy can constrain command `ids`, `categories`, `risks`, `side_effects`, and `max_timeout_ms`. All constraints apply to metadata resolved from the local catalog, not to model prose.

### Disclosure

`disclosure.classifications` governs content labels. `secrets` must be `deny`. Per-operation byte/file limits are applied before browser submission, and total disclosed bytes consume the session budget. The final serialized outbound message is scanned after tool output is inserted.

Classification is an onboarding assertion, not automatic data-loss-prevention certification. The repository data owner must choose it and decide whether Copilot Chat is an approved destination.

### Network

`network.access` and optional host rules evaluate catalog metadata. A command marked `networkRequired: true` must name its target hosts and obtain all applicable policy permission.

This is an application authorization control, not technical egress containment. The process runner does not provide a Windows filtering platform rule, container, or VM. A binary marked `networkRequired: false` could still open a socket if it is malicious or miscataloged. Catalog only trusted executables and use managed OS/network controls when isolation is required.

### Changes

Policy separately controls file creation, deletion, dependency-manifest changes, local commits, files per operation, changed lines per operation, and limit behavior. V1 has no model-callable Git commit tool; a `local_commits` rule does not create that capability.

### Budgets

Supported metrics are:

| JSON metric | Meaning |
| --- | --- |
| `elapsed_ms` | wall-clock session duration |
| `turns` | model exchanges |
| `operations` | accepted tool operations |
| `read_files` | disclosed file reads |
| `changed_files` | distinct/charged mutations |
| `changed_lines` | deterministic changed-line estimate |
| `disclosed_bytes` | bytes sent through the disclosure boundary |
| `commands` | catalog command executions |
| `command_output_bytes` | retained command output |
| `protocol_repairs` | malformed-model-response repairs |

`budget_exceeded` is `ask` or `deny`. A permitted session expansion remains bounded by organization and repository maximums.

## `cba-repository-config/1`

The repository document contains:

- `classification`: the repository's approved disclosure label;
- `policy`: a complete `cba-policy/1` with layer `repository`;
- `grant_defaults`: readable/writable patterns and disclosure labels proposed at session creation;
- `commands`: the only model-selectable local command definitions;
- `completion.required_command_ids`: validations that must have succeeded;
- `completion.require_validation_after_last_mutation`: rejects stale validation;
- bounded file/read/search/diff/checkpoint/patch byte limits; and
- transient recovery-artifact retention preference.

Every required completion command must exist in the catalog.

The `git_diff` tool implements bounded `working_tree`, `staged`, `checkpoint`, and `session` scopes. Checkpoint scope compares against one integrity-verified before-image. Session scope uses the earliest checkpoint before-image for each agent-mutated path. Both reapply exact current read policy and report only an excluded count for denied paths.

### Command catalog

Each definition makes security-relevant facts explicit:

```json
{
  "id": "npm.test",
  "category": "test",
  "risk": "low",
  "sideEffects": true,
  "networkRequired": false,
  "executable": "C:\\Program Files\\nodejs\\node.exe",
  "fixedArguments": [
    "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    "run",
    "test"
  ],
  "workingDirectory": ".",
  "timeoutMs": 300000,
  "maxTimeoutMs": 600000,
  "maxOutputBytes": 524288,
  "successExitCodes": [0]
}
```

The target machine exposes npm primarily through `.ps1`/`.cmd` shims. Do not catalog those. Shells and `.cmd`, `.bat`, or `.ps1` executable paths are rejected. Invoke `node.exe` directly with the installed `npm-cli.js` as a fixed argument.

Optional parameters are typed as string, repository path, enum, integer, boolean flag, or bounded string list. Each has a name and may have a fixed flag, regex, enumeration, size/range, existence requirement, and leading-dash rule. Unknown parameters fail. Arguments are passed with `shell: false`; no joined command string is constructed.

Mark `sideEffects` truthfully. Build/test tools that create `dist`, coverage, caches, snapshots, or generated files are side-effecting even when they are not intended to edit source. In `edit`/`auto`, an explicitly granted `sideEffects: true` command may run and may create ordinary Git-ignored artifacts; those artifacts are excluded from the completion source fingerprint. The `npm.test` and `npm.build` definitions in the example repository file are therefore potential validation commands after repository-specific review and grant approval, although the example file remains nondeployable while its placeholders and repository facts are unresolved.

Every command is treated as untrusted and bracketed by nested-Git plus Git-visible/nonignored, keyed policy-hidden protected-path, and Git-control integrity checks. A command declared `sideEffects: false` additionally inventories ordinary Git-ignored files under explicit entry and byte bounds. Tracked/nonignored, protected, control, or nested-boundary drift—or an unverifiable inventory—becomes `RECOVERY_REQUIRED` (`COMMAND_UNDECLARED_REPOSITORY_MUTATION` where applicable) rather than an accepted command result. Catalog a command as side-effect-free only when the repository owner has established that it writes neither ordinary ignored output nor source/control data. Intentional command-driven source mutation remains unsupported until a future versioned write-scope/checkpoint contract; source changes use `apply_patch`. Mark `networkRequired` truthfully and list `networkHosts` whenever true.

The process receives a minimal allowlisted environment plus definition-specific fixed values, a repository-contained working directory, timeout, combined-output cap, cancellation, and process-tree termination. Do not put secrets in a command definition's environment: repository configuration is source-controlled and may be disclosed. These application controls are not an OS filesystem, network, or resource sandbox. Approved executables and transitive scripts are trusted computing base, and writes outside the repository cannot be comprehensively prevented or observed; live use requires approved endpoint, egress, resource, and command-review controls.

## `cba-session-grant/1`

The runtime creates a grant bound to one `grant_id`, `task_id`, canonical `repository_root`, optional branch, and mode. It includes the same capability dimensions plus `approved_capabilities` with timestamps.

Before transport startup, the built-in approval prompt emits the complete versioned `cba-effective-grant/1` operating envelope. It includes repository/branch/mode; read, write, create, and delete scope; mandatory and layer-added exclusions/protections; the rules and precedence by layer; granted command IDs/categories plus their resolved definitions and per-layer constraints; disclosure, network, and change constraints by layer; effective budgets; checkpoint/rollback and escalation semantics; and organization, repository, and grant hashes. `--approve-grant` is appropriate only when this exact computed envelope has already been reviewed and recorded through a controlled procedure; it suppresses the interactive question but does not broaden authority.

After creation, `status` reloads the exact persisted grant and reports its full capability object plus current stored budget limits/usage and mode. It is a persisted snapshot and does not recompute the working tree. Approval is once per session and does not authorize later changes to policy files.

An exact operation that evaluates to `ask` can use `allow_once` only for that already-waiting operation. The decision is stored in an integrity-checked decision artifact for crash-safe replay but does not mutate `grant.json` or authorize a later call. A standalone model `request_capability` has no exact operation to bind, so choosing `allow_once` is reported as ineffective and Copilot must request the concrete operation.

`allow_session` can mutate the task grant only after:

1. organization and repository rules permit the expansion;
2. the CLI explains target, operation, and risk;
3. the user chooses allow for this session; and
4. the decision and updated grant hash are persisted and audited.

The expansion appends a canonical capability key/timestamp to `approved_capabilities`. A higher-layer deny remains absolute; a higher-layer ask is satisfied only by the explicit, scoped session approval and never by inference or a broader lower-layer allow. User-input and capability-decision artifacts can contain sensitive free-form text; they share the transient recovery-artifact retention policy and must be protected accordingly.

## Browser configuration (`cba-browser-config/1` and `/2`)

Browser configuration is machine/tenant specific and must remain outside repositories. Required facts:

- exact product (`edge` or `chrome`) in version 2;
- independent browser contract version (`cope-visible-browser/v1`);
- exact HTTPS `entry_url`;
- exact `approved_hosts`, with subdomains permitted only deliberately;
- optional manual authentication redirect hosts;
- expected work-account display signal (never a credential);
- whether a protection indicator is mandatory;
- absolute, dedicated local profile directory outside repository and agent-state roots, with no UNC/device/shared path form;
- canonical verified browser executable, observed version, and SHA-256;
- response/message bounds and state-based waits; and
- a versioned semantic UI contract.

The adapter supports role, label, placeholder, test-id, text, and bounded CSS fallback locators. XPath and arbitrary page scripts are not supported. Every signal group names its expected signal, candidate strategies, minimum candidate quorum, maximum element count, and capture type.

Signals cover shell, conversation, composer, send control, assistant responses, user messages, streaming, identity, protection, signed-out, MFA, consent, throttling, service error, and modal state. The adapter refuses unknown/ambiguous states.

Version 1 is the exact legacy Edge-only schema with `edge_executable`. The strict compatibility parser treats it as `product: "edge"` and `cope-visible-browser/v1` in memory. A valid legacy document is not rewritten merely because setup runs, so its bytes, established Edge profile, authentication state, approved hosts, and optional UI settings remain intact. It cannot represent Chrome. Unknown, mixed v1/v2, corrupt, or ambiguous documents fail closed.

Version 2 replaces `edge_executable` with `product`, `browser_contract_version`, `browser_executable`, `browser_version`, and `browser_executable_sha256`. Changing products requires explicit confirmation and selects/creates the other product's dedicated profile. Setup serializes changes under a lock and compare-and-swap check, refuses live resumable browser sessions, launches the proposed browser for manual readiness before persistence, and does not silently switch an existing user.

`cope setup` is the primary interface. Detection is deterministic and bounded; one browser is preselected, two produce a keyboard choice (existing product first, otherwise Edge), and none produces Retry plus an advanced manual path. `cope setup --browser edge|chrome` and `--browser-executable` exist for managed automation. `COPE_BROWSER_EXECUTABLE` is the neutral override; `COPE_EDGE_EXECUTABLE` is retained only as an Edge compatibility alias. Every candidate and override undergoes the same identity verification. Installers remain browser-neutral and download no browser.

macOS evidence includes the exact Stable bundle identifier, expected signing team, valid code signature, reported version, canonical path/stat identity, and SHA-256. Windows evidence combines an exact approved machine-wide/user-local Stable executable location (derived from `Program Files`/`LOCALAPPDATA`, never an override or lookalike suffix) with exact product/company/original-filename metadata, Authenticode signer, version, canonical path/stat identity, and SHA-256. This rejects known Beta/Dev/Canary/SxS locations, portable/lookalike paths, product mismatch, and unsupported Chromium derivatives. It proves a vendor-signed requested product occupied the approved Stable location at check time; it does not defeat a privileged replacement with another vendor-signed binary or independently attest the release channel. Exact binary/channel approval remains part of tuple certification, along with Copilot UI behavior, account/tenant eligibility, Conditional Access, future browser updates, and endpoint integrity.

The shipped Edge and Chrome uncertified templates contain baselines, not tenant or browser certification. Their Copilot and authentication hosts are reserved `.invalid` names. Replace hosts, identity, profile, executable/version/hash placeholders and certify every locator against the exact managed Copilot surface. The profile path is canonicalized before launch; a prospective path is evaluated through its deepest existing parent so a symlink/junction cannot redirect it into the repository, `%LOCALAPPDATA%\CopilotBrowserAgent` state root, either ordinary browser profile, or the other product's Cope profile. If the tenant redirects to a different host, add only the precise approved host after governance review; do not set a wildcard or broad Microsoft parent domain.

## Review checklist

- External approval records name policy owners/repository data owner and bind them to exact installed-file hashes.
- Placeholder policy IDs/revisions are replaced, and revisions change whenever meaning changes.
- Defaults are deny and every allow is necessary.
- Exclusions and protected paths cover credentials, Git internals, agent state, CI/deployment, and repository-specific sensitive areas.
- Writable scope excludes pre-existing user work that should not be touched.
- Command metadata reflects actual side effects, network, risk, output, and timeout.
- Required validation commands exist, are truthfully classified, and can run within the integrity boundary; no required command intentionally mutates tracked/nonignored source or control state.
- Approved executables/transitive scripts and target endpoint, egress, filesystem, and resource containment have live-pilot owner approval.
- Browser URL, identity, protection, profile, and locators have recorded evidence.
- Retention settings and external procedures separately cover transient decision/outbox/response artifacts, checkpoints, fingerprint keys, completion handoffs, review packages, audit/disclosure metadata, and each product-specific dedicated browser profile.
- Fixture/replay and adversarial tests pass after the change.
