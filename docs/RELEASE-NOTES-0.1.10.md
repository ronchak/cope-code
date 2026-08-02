# Cope 0.1.10

Cope 0.1.10 ships the first complete Developer-mode terminal vertical while
preserving the exact authority of existing configurations and sessions.

## Developer terminal

- `terminal_exec` is additive to `cba-agent/1` and keeps catalog-backed
  `run_command` unchanged.
- Shell and direct executable/argument-vector requests run as the current user
  from a validated project-relative working directory.
- Developer processes inherit a useful ordinary environment after Cope control
  variables and malformed entries are removed. Catalog commands retain their
  hardened environment behavior.
- Output streams locally while a bounded, disclosure-scanned head/tail result
  is retained for Copilot and durable recovery.
- Timeout, cancellation, process-tree supervision, exact exit/signal state,
  and the existing operator emergency stop remain active.

## Durable execution and project effects

- Terminal intent, pre-observation, launch/exit receipts, post-observation, and
  the final result are integrity-protected in crash order.
- A completed durable result may be replayed to Copilot; an uncertain command
  is never blindly executed again.
- Every launched terminal command is bracketed by bounded project observation.
  Created, updated, deleted, renamed, binary, ignored, staged, branch, HEAD,
  index, protected/hidden, and pre-existing-touched facts are represented
  without inventing unavailable evidence.
- Process outcome and mutation outcome remain independent, including nonzero,
  timed-out, cancelled, and interrupted commands.
- Observed changes are attributed once, advance mutation freshness once, and
  consume actual changed-file/line budget once. Post-hoc overruns preserve the
  truth and pause later work instead of denying effects that already happened.
- Session diffs and final handoffs use captured terminal before-images where
  available and distinguish pre-existing work from agent-attributed effects.
- Developer completion follows the latest observed branch, HEAD, index, and
  workspace facts. Unknown/protected effects, unresolved operations, drift, or
  stale required validation reject completion.

## Grants, setup, and compatibility

- Strict `cba-repository-config/2` adds exactly
  `developer_terminal: { "enabled": boolean }`.
- Config v1 remains strictly readable and normalizes to terminal disabled
  without changing its raw hash. Existing valid or managed policy documents
  are never rewritten or reinterpreted.
- Fresh machine setup writes a Developer-capable organization ceiling. Quick
  project setup writes a Developer-ready config and repository ceiling;
  inspect/manual setup remains terminal-disabled.
- A new grant includes `terminal_exec` only for internal `auto` mode (presented
  as Developer), config v2 enabled, and an allow decision from every effective
  policy layer. Any denial falls back to the terminal-free grant.
- Existing durable grants, config-v1 projects, inspect/edit sessions, and
  denying managed policies remain terminal-free. Resume keeps exact config,
  policy, and grant hashes and never widens authority.
- The one-time access screen states that terminal work runs as the current
  user, starts in the project but is not OS-sandboxed, may use ordinary
  environment/network access and local Git, and has bounded observed results.
- `cope doctor` reports the repository schema and Developer enable bit while
  reminding operators that managed policy still applies.

## Protocol-widget provenance and ownership

- Executable capture now depends on exactly one response-block-owned banner
  carrying exactly one boundary-safe `cba-agent/1` or `cba/1` label. The
  surrounding Microsoft explanatory prose is recorded as drift evidence, not
  treated as execution authority.
- Capture evidence records `bannerContract`, `bannerTokenCount`,
  `bannerMatchesBaseline`, and `bannerVariant`. A banner containing multiple
  protocol labels now fails closed as
  `PROTOCOL_WIDGET_BANNER_LABEL_AMBIGUOUS`; the former
  `PROTOCOL_WIDGET_BANNER_CONTRACT_CHANGED` reason is retired.
- The protocol adapter independently enforces owned, reconstructed capture
  evidence before parsing, so acceptance no longer depends only on runtime call
  order. Capture-evidence sanitization is shared across this boundary and review
  export, while ordinary rendered-prose repair behavior remains available.

## Developer-terminal diagnosis

- `cope doctor` now identifies the first layer that prevents an unconditional
  `terminal_exec` grant. It reports the concrete file, field, decision, policy
  ID, and revision for repository and machine-policy decisions.
- The diagnostic distinguishes absent, unreadable, and malformed machine policy
  from explicit `ask` or `deny` decisions. It is read-only and does not change
  configuration, policy, or session authority.

## Acceptance operations and review evidence

- A Windows/Edge live-acceptance runbook now defines the operator procedure and
  bounded evidence record. Adding the runbook is not live acceptance: current
  M365 banner wording and live Windows/Edge behavior remain unverified.
- `cope export-review` now emits `body.capture` containing the newest strictly
  sanitized capture evidence, or an explicit `not_recorded` state. Response
  content, prompts, credentials, and identity data are not added to the review
  package by this field.

## Deliberate limits

The Developer terminal is one-shot only. It has no stdin, PTY, persistent
process handle, watch/server lifecycle, typed Git mutation tools, additional
workspace roots, kernel resource quotas, OS filesystem sandbox, or enforceable
egress control. Arbitrary commands may have effects outside the project that
portable application-level observation cannot see or undo.

Edge remains the established live compatibility target. Chrome and documented
macOS tuples remain preview candidates until their separate live acceptance
gates pass.
