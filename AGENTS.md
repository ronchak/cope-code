# Cope repository guidance

## Why this file exists

Cope has accumulated strong reliability and security machinery, but the product target is a useful local coding agent, not a security research project. Future agents must not infer the desired product from the current hardened implementation or from a release-specific PRD.

When implementation choices conflict, use this file to preserve the intended direction.

## Product north star

Cope should provide an experience materially similar to Claude Code while using Microsoft 365 Copilot Chat through a visible supported browser as the reasoning backend.

Copilot supplies software-engineering judgment. The local Cope CLI supplies the hands: repository inspection, file editing, terminal execution, local processes, Git operations, recovery, and verification.

The primary user is currently one local developer. Optimize first for making real coding tasks work reliably and with low friction. Do not design the default product around hypothetical enterprise, multi-tenant, hostile-administrator, or military-grade containment requirements.

The target architecture is defined in:

- `docs/ARCHITECTURE.md`
- `docs/DEVELOPER-MODE-TARGET.md`
- `docs/POLICY-AND-CONFIGURATION.md`
- `docs/PROTOCOL.md`

Release notes, incident PRDs, threat models, and the current code describe a particular implementation state. They do not override the product target above.

## Decision hierarchy

When documents or code appear to conflict, use this order:

1. The maintainer's explicit instruction for the current task.
2. This `AGENTS.md` product and implementation guidance.
3. The target architecture and developer-mode documents.
4. Accepted architecture decisions recorded in the repository.
5. Release-specific PRDs and release notes.
6. The current implementation.

Do not treat an existing restriction as intentional product policy merely because it is already implemented.

## Default engineering posture

Choose the smallest design that materially improves the end-to-end coding-agent experience.

Prefer:

- working functionality over speculative hardening;
- broad, useful developer capabilities over narrow predeclared command catalogs;
- one initial understandable grant over repeated prompts;
- truthful observation of effects over pretending arbitrary commands are contained;
- additive, compatible changes over unnecessary protocol-wide migrations;
- direct fixes to observed failures over large defensive frameworks;
- end-to-end tests of real task flows over exhaustive tests of isolated policy branches;
- concise model context over repeated control prose.

Avoid:

- adding permanent restrictions to simplify a security proof;
- expanding a narrow bug fix into unrelated hardening;
- claiming sandbox, rollback, egress, or containment guarantees the host does not provide;
- requiring exact future mutation paths for general terminal commands;
- blocking ordinary formatters, codemods, generators, package managers, test tools, or local Git operations;
- repeating stable protocol instructions after every successful turn;
- making a new envelope version a prerequisite when an independently versioned additive tool is sufficient;
- treating current implementation limits as product requirements.

## Developer mode

Developer mode is the intended default product mode.

After one concise task grant, it should permit normal work in the selected project:

- read, create, update, delete, move, and rename project files;
- run direct argv and shell commands as the current user;
- use normal developer environment variables and installed tools;
- use the network for ordinary development workflows;
- allow command-generated project changes;
- inspect and modify local Git state;
- run validation and report the actual resulting state.

The selected project is the intended scope and default working directory. It is not an operating-system sandbox around arbitrary child processes. State that residual risk honestly rather than adding brittle application checks that make the tool unusable.

Inspect mode remains read-only. The existing command-catalog design remains useful as an optional hardened profile and for named required validations.

## Minimum safety floor

Preserve controls that protect correctness and the user's direct authority:

- manual browser authentication, MFA, consent, and security interstitial handling;
- explicit supported browser, host, identity, and conversation correlation;
- durable browser outbox and resolve-before-retry behavior;
- no blind replay of uncertain mutations or external actions;
- harness-owned operation identity and durable operation records;
- truthful tool results and independent completion verification;
- no privilege elevation;
- no generic browser-control tool exposed to the model;
- no typed repository access to Cope private state or dedicated browser profiles;
- bounded process output, cancellation, and process-tree cleanup;
- preservation and clear reporting of pre-existing user changes.

A proposed control outside this floor must be justified by a concrete current failure mode, plausible data loss, duplicate consequential execution, authentication compromise, or direct obstruction of the core product. Otherwise, defer it.

## Merge-blocker standard

For MVP and release-fix work, distinguish functional blockers from hardening follow-ups.

A finding should normally block merge when it can plausibly:

- prevent the core browser-to-tool loop from completing;
- execute content that was not selected as an action;
- corrupt, overwrite, lose, or misattribute user work;
- duplicate a mutation, browser submission, or consequential external action;
- produce a false successful result or false completion;
- strand a normal task in an unrecoverable state;
- break supported host or browser behavior on the intended path.

A finding that only strengthens an already narrow threat model, adds enterprise governance, handles local artifact tampering by the same user, or proves a theoretical containment property should normally be recorded as follow-up work unless the maintainer explicitly elevates it.

Do not keep a PR in an indefinite adversarial-review loop after its concrete functional blockers are resolved. Freeze scope, record deferred hardening, validate the exact final head, and ship the useful increment.

## Protocol and context

The current model-facing envelope is `cba-agent/1`, normalized locally into internal `cba/1` identities.

Preserve existing meanings. Add new developer authority through separately versioned typed tools when top-level envelope and correlation semantics do not need to change. For the first developer terminal milestone, prefer an additive `terminal_exec` tool with a required contract such as `terminal-exec/1` over an envelope-wide migration.

Send the stable operating contract once at bootstrap. Successful turns should return concise authoritative results. Full reminders belong on actual repair paths, not every turn.

Model-visible output is scarce. Stream useful command output locally, send bounded excerpts and structured summaries to Copilot, and use durable page references for larger retained output.

## Command execution and mutations

General terminal execution is a first-class product capability.

The first milestone should support one-shot shell and argv execution. PTY-backed persistent processes may follow later.

For arbitrary commands:

1. Persist the exact request before execution.
2. Capture lightweight pre-command project state.
3. Run the command with cancellation and output bounds.
4. Capture post-command state.
5. Record command outcome separately from observed mutation outcome.
6. Attribute observed project changes to the operation.
7. Persist the bounded result before marking the journal operation complete.
8. Never rerun an uncertain mutating command automatically.

Do not promise atomic rollback for arbitrary commands whose target paths were unknown before launch. Existing typed patch operations retain their stronger checkpoint and rollback guarantees.

## Review and planning expectations

Every implementation plan or review should explicitly answer:

- How does this improve or protect the end-to-end coding-agent workflow?
- Does it add user friction, browser turns, protocol text, filesystem scans, or failure states?
- Is the restriction required for the current single-user product, or merely useful for a future hardened mode?
- Can the same goal be achieved with a smaller additive change?
- What exact user-visible failure does the proposed complexity prevent?

When reviewing security-related work, evaluate functionality regressions with equal or greater weight. A fail-closed path that repeatedly blocks valid Copilot output is still a product bug.

## Scope discipline

Keep release fixes focused. A transport-ingestion fix should make valid responses reach the existing agent loop reliably and preserve actionable diagnostics. It should not redefine the product's terminal, workspace, or policy architecture.

Keep architecture pivots separate from urgent release fixes when practical. Rebase and reconcile their documentation after the release fix lands rather than combining unrelated implementation risk.

## Definition of progress

Progress is measured by real tasks completed, browser turns avoided, useful commands available, truthful recovery, model-visible bytes reduced, and final results correctly validated.

More policy branches, more denial codes, more scanners, or more tests are not progress by themselves.
