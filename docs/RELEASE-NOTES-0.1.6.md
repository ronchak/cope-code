# Cope 0.1.6

Cope 0.1.6 hardens recovery across rapid upgrades and interrupted
live-browser starts. It replaces status-only guesses with one shared static
assessment and gives operators an exact recovery action before setup launches
a browser.

## Session recovery

- Setup scans unfinished live-browser sessions before discovery, prompts, or
  launch. That early scan is ordered through the browser-configuration lock,
  and setup repeats the scan while holding the commit lock.
- New live sessions use that same lock to publish session state and its pinned
  runtime manifest as one configuration transaction. Concurrent setup either
  commits first, leaving no partial session, or waits behind a fully
  recoverable session; it cannot strand the state between those outcomes.
- `cope sessions --all` distinguishes resume candidates (`*`) from blocked
  recovery (`!`) and explains the reason and exact next command.
- `cope resume <session-id>` checks recovery inputs before loading browser
  configuration, replacing raw missing-file errors with a stable Cope
  diagnostic.
- `cope doctor` reports session recovery before browser setup, avoiding the
  previous loop in which setup asked for a session action that other commands
  could not clearly perform.
- Explicit `cope abort <session-id>` remains configuration-independent.
  `cope abort --all` is rejected because sessions with mutation evidence need
  individual reconciliation rather than bulk disposal.

## Recovery model

The shared assessment derives one of four dispositions from persisted session
state, runtime pins, browser-configuration integrity, and mutation evidence:
`terminal`, `resume_candidate`, `abort_required`, or `reconcile_required`.
Passing the static assessment does not bypass the existing audit, repository,
ownership, runtime, or live-page checks.

Sessions interrupted in `created` or `preflight` are never advertised as
resumable, even if a legacy startup already wrote a runtime pin. New sessions
persist `grant_pending` before making that pin readable, eliminating the
pre-grant resume gap.

This release does not add new Microsoft 365 identity heuristics or automate
credentials, MFA, consent, or profile import. The product-specific dedicated
browser profile remains the durable authentication boundary. Cope continues to
verify live page readiness when work begins without making setup depend on
every transient page presentation.

## Verification

- Recovery classification covers matching, missing, invalid, changed, and
  unreadable inputs, with and without mutation evidence.
- CLI regressions cover early setup blocking, session markers and JSON,
  configuration-independent abort, resume diagnostics, doctor ordering, and
  unsafe bulk-abort rejection.
- The build, complete deterministic unit suite, and end-to-end CLI suite pass.
