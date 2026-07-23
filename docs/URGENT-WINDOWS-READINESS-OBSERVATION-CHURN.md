# URGENT: Windows setup aborts on recoverable Copilot page churn

## Status

Open live blocker after PR #25.

PR #25 fixed a real authenticated-readiness timeout and added strict semantic
observation consistency checks. The first live Windows validation after merge no
longer failed with the original generic timeout. It instead produced the more
specific diagnostic below while the dedicated Edge profile was already signed
in and visibly showing the normal Copilot chat surface:

```text
The Copilot page changed during semantic readiness inspection
Diagnostic: ACTIVE_PAGE_CHANGED_DURING_OBSERVATION
```

This record defines the follow-up product requirement. It includes an initial
candidate implementation, but Codex and reviewers must verify the precise live
navigation trigger and may replace the implementation if a safer or more exact
solution is demonstrated.

## High-level bug

Cope correctly rejects a semantic readiness sample when the active page changes
while the sample is being collected. It then incorrectly treats that
pre-dispatch sample invalidation as fatal during the broader manual-readiness
window.

Microsoft 365 Copilot can perform benign same-tab navigation, route
canonicalization, hydration navigation, or an authentication handoff while the
page remains visibly usable. A sample spanning that transition is not trustworthy
and must be discarded. The transition itself does not mean setup has failed.
Once the page settles, Cope should take a fresh complete sample and re-run all
host, ownership, identity, protection, modal, and composer checks.

Current behavior does the first half and not the second. The consistency barrier
invalidates the mixed sample, then the exception escapes the readiness state
machine and aborts setup.

## Why this is problematic

This blocks first-run setup on the actual Windows target after browser discovery,
executable verification, launch, and authentication have all succeeded.

The operator sees an authenticated Copilot page with existing chats and an
enabled textbox, but Cope exits before atomically saving browser configuration.
`cope doctor` then correctly reports browser setup as missing or invalid.

Repeated manual setup attempts are unreliable because the failure depends on
when Microsoft navigation occurs relative to Cope's concurrent semantic probes.
The result looks like a broken or unsupported account even though the failure is
an internal readiness retry-policy defect.

## Observed environment

- Windows 11 workstation
- Non-elevated Windows PowerShell
- Node.js 24.17.0
- npm 11.13.0
- Git 2.55.0.windows.3
- Microsoft Edge Stable 149
- Cope 0.1.2 built and installed from current `main` after PR #25
- Dedicated Cope Edge profile already authenticated
- Standard entry URL: `https://m365.cloud.microsoft/chat`
- Existing chats visible
- Composer visible and enabled
- Optional enterprise-protection requirement disabled for the reproduction

Do not put work email addresses, tenant identifiers, conversation IDs, query
parameters, cookies, tokens, prompts, responses, or chat content in fixtures or
diagnostics.

## Exact live reproduction

1. On the Windows target, update the local checkout to `main` containing PR #25.
2. Install the checkout:

   ```powershell
   cd C:\path\to\cope-code
   cope update
   cope version
   ```

3. Confirm the dedicated Edge profile is already signed into Microsoft 365
   Copilot.
4. Run:

   ```powershell
   cope setup
   ```

5. Accept Microsoft Edge Stable 149.
6. Enter the visible approved work-account identity.
7. Use:

   ```text
   https://m365.cloud.microsoft/chat
   ```

8. Answer `n` to the optional visible protection-indicator requirement for this
   reproduction.
9. Observe Edge open to the authenticated Copilot page with chats and an enabled
   textbox.
10. Do not interact with the page.
11. Observe setup abort with:

   ```text
   The Copilot page changed during semantic readiness inspection
   Diagnostic: ACTIVE_PAGE_CHANGED_DURING_OBSERVATION
   ```

12. Run:

   ```powershell
   cope doctor
   ```

13. Observe `Browser setup: missing or invalid; run cope setup` because setup did
   not commit.

## Current implementation state

`ContextSemanticPage.currentUrl()` begins an observation by recording the active
page, URL, navigation epoch, and native-dialog epoch. Every main-frame
`framenavigated` event increments the navigation epoch.

Each semantic snapshot and the final completion barrier call
`#verifiedObservationPage()`. That method throws
`ACTIVE_PAGE_CHANGED_DURING_OBSERVATION` when any of these conditions changes:

- selected page ownership
- page liveness
- observed URL
- main-frame navigation epoch
- native-dialog epoch

This is intentional fail-closed behavior. A sample assembled across different
page states must never certify readiness or authorize submission.

The setup path uses `EdgeCopilotTransport.waitForManualReadiness()`, which calls
`waitForStableManualReadiness()` around one-shot adapter inspections. The outer
state machine owns the ten-minute manual window, polling, hydration stability,
and terminal-state rules. Before this PR, it did not distinguish a recoverable
pre-dispatch observation invalidation from a fatal browser failure. Any thrown
`ACTIVE_PAGE_CHANGED_DURING_OBSERVATION` escaped immediately.

The adapter's own broad manual-wait method is not the setup path and changing it
alone would not fix this incident.

## Root-cause statement

The confirmed code defect is fatal propagation of a pre-dispatch semantic
observation invalidation from the one-shot readiness inspector through the outer
manual-readiness state machine.

The exact Microsoft trigger remains evidence-bounded. It may be:

- same-URL main-frame navigation
- path canonicalization
- SPA route replacement that emits a main-frame navigation event
- a brief authentication-page handoff
- replacement of the selected page

The current generic diagnostic proves that observation ownership changed, but it
does not identify which condition changed. The final implementation should add a
source-free reason when practical, such as `navigation-epoch`, `url-changed`,
`page-replaced`, `authentication-precedence`, or `dialog-epoch`.

## Product requirement

During setup/manual readiness only, a semantic observation failure may be retried
when and only when all of the following are true:

- the error is an `AgentError`;
- `diagnosticCode` is `ACTIVE_PAGE_CHANGED_DURING_OBSERVATION`;
- `dispatchAttempted` is exactly `false`;
- the existing manual-readiness deadline has not expired;
- the cancellation signal has not fired;
- the browser transport has not otherwise been revoked.

The failed sample must be discarded in full. Stability counters, terminal-state
quorum, unsafe-host quorum, and any last inspection from the prior document must
be reset before another observation begins.

The retry must wait through the existing bounded polling cadence. It must not
spin, extend the manual-readiness deadline, increase `actionMs`, create a second
browser operation, or reuse semantic evidence from the invalidated page.

The next observation must run the complete readiness contract again. No host,
identity, protection, composer, send, modal, authentication, ownership, or
navigation check may be skipped.

## Initial candidate fix in this PR

The first implementation is intentionally narrow:

- `waitForStableManualReadiness()` catches only the exact pre-dispatch
  `ACTIVE_PAGE_CHANGED_DURING_OBSERVATION` error;
- all other errors remain fatal;
- it clears all accumulated observation evidence;
- it sleeps using the existing `pollMs` bound;
- it retries within the unchanged manual deadline;
- if churn consumes the entire deadline without a valid sample, it rethrows the
  last observation invalidation;
- one-shot inspection, submission, response correlation, and action dispatch are
  unchanged.

This is a candidate for Codex to attack, not a waiver of deeper investigation.

## Required end state

On the reported Windows environment, setup should survive benign transient page
churn and complete once one full stable observation verifies the authenticated
Copilot page.

Successful setup must:

- print `Cope setup is ready`;
- atomically persist browser configuration;
- preserve the dedicated authenticated profile;
- allow `cope doctor` to report browser setup, selected browser, and profile
  privacy as valid.

Unsafe or unresolved states must still fail closed:

- unapproved host remains rejected;
- multiple configured Copilot pages remain ambiguous;
- wrong or unverifiable identity remains rejected;
- required protection evidence remains mandatory when configured;
- native dialogs remain blocking and session-revoking as designed;
- renderer or Playwright operation timeout remains fatal;
- cancellation remains immediate;
- any error with possible dispatch remains fatal;
- no prompt is filled or submitted during setup.

## Regression requirements

Automated coverage must prove at minimum:

1. One pre-dispatch observation invalidation followed by a stable ready sample
   succeeds.
2. Observation invalidation clears stability evidence from the prior document.
3. Repeated invalidation remains bounded by the original manual deadline.
4. `BROWSER_OPERATION_TIMEOUT` is not retried.
5. The same diagnostic with `dispatchAttempted: true` is not retried.
6. Cancellation is not swallowed.
7. Ambiguous page ownership is not retried.
8. Native-dialog safety remains green.
9. Same-URL navigation still invalidates the individual mixed observation.
10. Submission and activation paths remain strict and unchanged.

## Validation matrix

Before merge, run on the exact final commit:

```text
npm run build
npm run test:unit
npm run test:e2e
npm test
npm run check
git diff --check
```

Also run focused suites covering:

- manual readiness
- readiness oscillation
- authenticated readiness inspection
- context observation consistency
- blocking and native dialogs
- renderer and browser-operation timeouts
- onboarding/setup transaction behavior

Hosted Windows x64, macOS arm64, and macOS x64 checks must pass if configured.

## Mandatory live Windows gate

The exact final commit must be installed on the reported Windows 11 / Edge 149
machine and run against the already-authenticated dedicated profile.

Required evidence:

```powershell
git rev-parse HEAD
cope update
cope setup
cope doctor
```

The live gate passes only when setup persists successfully and doctor verifies
the browser configuration. A passing mock, Linux Chromium fixture, macOS run, or
retry that merely changes the diagnostic is not sufficient.

If setup still fails, record only source-free diagnostics and the redacted URL
shape before and after the transition. Do not record account or chat content.

## Non-goals

- Do not remove or weaken the observation consistency barrier.
- Do not ignore navigation epochs globally.
- Do not increase timeouts as the primary fix.
- Do not retry renderer stalls, ambiguous ownership, native dialogs, or possible
  post-dispatch failures.
- Do not automate sign-in, MFA, consent, dialogs, or account selection.
- Do not claim the exact Microsoft navigation trigger without live evidence.

## Merge standard

This PR is not merge-ready merely because the candidate tests pass. Codex should
iterate with skeptical reviewers until the exact final commit satisfies the
security invariants, automated matrix, source-free diagnostic requirements, and
live Windows gate.
