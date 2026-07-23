# Cope 0.1.5

Cope 0.1.5 fixes the complete authenticated Microsoft 365 Copilot readiness
and live-browser interaction chain uncovered while reproducing the Windows
setup failure. A visible, signed-in Copilot page can now reach verified
readiness and sustain correlated multi-turn tasks against the current M365 UI.

## Fixed

- Setup accepts the exact account name or email visibly exposed by Copilot and
  recognizes the current owner-avatar/account-manager presentations without
  treating alternate profiles or generic account actions as identity proof.
- Readiness failures preserve the source-free diagnostic that identifies a
  missing or conflicting identity channel instead of replacing it with generic
  sign-in guidance.
- Current M365 user and assistant message envelopes are recognized for exact
  submission-marker and response correlation.
- The Lexical composer permits only its known trailing zero-width sentinels
  while retaining exact draft ownership checks.
- First send may materialize the configured `/chat` entry route into a new
  conversation only after the exact unique task marker appears there.
  Trailing path slashes are normalized, query state remains part of
  conversation identity, and existing same-path query conversations remain
  tracked without receiving rebinding authority.
- Temporary marker remounts and the current rolling four-response DOM window
  are handled without carrying evidence across conversations or accepting
  baseline drift.
- Current M365 read-only code-editor rendering reconstructs a `cba/1` fence
  only when one assistant-owned block contains the exact block-owned language
  warning and valid protocol JSON. Ordinary JSON, unlabeled, and ambiguous
  blocks remain inert.
- Passive conversation and transcript evidence no longer runs meaningless
  actionability probes that could consume the shared browser deadline during a
  transient remount.

## Browser action integrity

- Send uses a trusted Playwright click on the already-bound element with normal
  receives-events enforcement; forced coordinate clicks and locator
  re-resolution remain prohibited.
- A capture guard cancels off-target trusted activation and proves that exactly
  one click reached the bound Send element.
- Guard state and cleanup are owned by the page Window, so a synchronous M365
  Send-button replacement cannot strand listeners or block later turns.
- Installed-Chrome regressions cover late hover overlays, synchronous
  Send-button replacement across consecutive clicks, current message
  envelopes, entry-route materialization, and strict protocol reconstruction.

## Verification

- The synchronized release-version check, build, and complete installed-Chrome
  suite pass with 540 tests, zero failures, and zero skips.
- The hosted offline matrix passes on Windows x64, macOS x64, and macOS arm64.
- Two fresh authenticated Cope inspect tasks completed against live M365
  Copilot. One exercised `git_status`; the other exercised `git_status` and
  `git_diff`; both required multiple browser sends and reached verified
  completion with zero project mutations.
- Independent P1/P2 audit and the final GitHub Codex review reported no
  remaining major issues on the tested tree.

## Distribution and support

Windows and macOS installers continue to build, pack, install, and verify the
exact package version from synchronized package metadata. Microsoft Edge
Stable remains the established compatibility target. Google Chrome Stable
remains a preview candidate/offline-evidence target until every Chrome-specific
live acceptance gate is approved. Historical release notes and incident
records remain unchanged.
