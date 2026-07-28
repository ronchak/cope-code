# Cope 0.1.8

Cope 0.1.8 moves protocol bookkeeping out of the model and into the
deterministic harness. It also hardens browser response correlation, clarifies
access and validation reporting, and improves recovery diagnostics.

## Model-facing intent protocol

- Copilot now emits `cba-agent/1` intents, informational answers, blocked
  states, and progress updates without task, turn, message, or operation IDs.
- Cope deterministically generates and validates the internal `cba/1` envelope.
  Identical captured responses replay with identical operation IDs.
- Independent reads use an `observe` intent; Cope validates the tools and owns
  batching. Mutations, commands, user/capability requests, and completion remain
  single-action intents.
- Historical model-authored `cba/1` remains accepted for migration. Only fresh
  marker- and baseline-proven visible-browser responses may rebind stale
  task/turn correlation, and every rebind is audited. Cached recovery replay and
  offline fixtures remain strict.
- Informational `agent_answer` responses are first-class completion claims with
  an evidence basis. They cannot complete a task after project files were
  mutated.
- `agent_blocked` is a defined structured path. Recoverable blockers pause with
  a durable source-free reassessment turn; unrecoverable blockers terminate.

## Diagnostics and terminal truth

- Generic Copilot service fallbacks enter the bounded protocol-repair path only
  when no valid protocol envelope is present.
- Protocol errors now carry stage, structured details, repairability, expected
  and actual facts where applicable, and actionable next steps.
- Browser baseline truncation reports exact bounded counts and preserves the
  session for inspection when a safe suffix alignment cannot be proven.
- Terminal progress identifies the parsed model action instead of repeating an
  untyped “Copilot responded” status.
- Requested product mode and effective task capabilities are displayed
  separately. Empty write and command grants render as inspect-only effective
  access.
- Completion output distinguishes accepted protocol/evidence from project
  validation. When no commands are configured or run, Cope does not imply that
  tests or builds passed.
- Working-tree output separates files attributed to the task from unchanged
  pre-existing files and other unattributed changes.

## Browser safety and correlation

- Playwright launches the verified Edge or Chrome executable with the Chromium
  sandbox enabled, removing Cope’s previous implicit `--no-sandbox` launch.
- M365 response correlation can prove multiple virtualized rolling-window
  shifts using per-envelope digests. Ambiguous histories still fail closed.
- Browser timeouts and response-baseline failures expose structured transport
  diagnostics and recovery guidance.

## Compatibility and verification

- Existing 0.1.7 completion handoffs remain readable; new completion provenance
  fields are optional and strictly validated when present.
- Offline end-to-end fixtures exercise `cba-agent/1` through real policy,
  repository mutation, failed validation, correction, and verified completion.
- Regression coverage includes deterministic replay IDs, stale legacy
  correlation gates, bounded generic-fallback repair, recoverable blocker
  resume without replay, answer-only completion safety, Chromium sandbox
  launch options, multi-shift browser baselines, task access display, and
  validation/file-provenance output.
