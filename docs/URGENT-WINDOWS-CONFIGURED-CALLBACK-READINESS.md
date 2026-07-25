# URGENT: completed popup authentication can hide a ready Copilot callback

## Status

Root cause reproduced locally against `main` after PR #29.

The earlier authenticated-readiness timeout and page-churn failures remain
separate incidents. This failure is in the setup-only SSO handoff logic added by
PR #29.

## User-visible failure

The dedicated browser completes authentication and displays the configured
Copilot Chat surface, but Cope continues waiting for manual authentication.
After the fifteen-minute manual-readiness window, setup returns without
persisting the browser configuration.

This occurs when a popup authentication flow returns to the configured Copilot
origin and path but the popup remains open alongside its configured opener.
Both pages are visibly legitimate configured surfaces. The callback popup has
completed authentication, but its continued presence is interpreted as an
active manual handoff.

## Confirmed root cause

`ContextSemanticPage.#configuredCallbackHandoffPage()` deliberately recognizes
the exact two-page overlap formed by one configured opener and one
provenance-bound popup that has navigated back to the configured Copilot
surface.

`holdForManualAuthenticationHandoff()` previously allowed setup to inspect a
returned configured page only when:

- an external SSO page remained open; and
- exactly one configured Copilot page existed.

It did not provide the equivalent readiness-only path when the popup itself had
already returned to the configured Copilot surface. In that state there are two
configured pages, so every setup poll returned the synthetic
`MANUAL_SSO_HANDOFF` inspection without reading either configured page. No
subsequent DOM change could make Cope ready; only closing the popup ended the
handoff.

The fifteen-minute timeout therefore did not indicate slow authentication or a
Playwright failure. It was the expected result of a stable state that the
readiness state machine had no transition for.

## Deterministic reproduction

The regression uses one tracked configured page and one popup:

1. The configured page opens a provenance-bound external SSO popup.
2. The popup navigates to a descendant of the configured Copilot entry path.
3. The popup remains open.
4. Ordinary readiness continues to report an active handoff.
5. Before this fix, setup readiness also continued to report the handoff and
   never inspected the callback page.

The focused test fails on the pre-fix implementation because
`holdForManualAuthenticationHandoff(false, true)` returns `true`. It passes
after the fix because setup receives a bounded readiness-only observation of
the exact callback popup.

## Fix

During setup readiness only, the exact provenance-bound configured callback is
now eligible for semantic inspection while its configured opener remains open.
The observation records the complete expected configured-page set and requires
that:

- the callback page remains open;
- it remains on the configured origin and path;
- the configured opener and callback are the only configured pages;
- the same callback page owns every snapshot;
- URL, navigation epoch, native-dialog epoch, and page ownership remain stable
  through the completion barrier.

If any part of that pair changes during inspection, the sample is rejected as a
pre-dispatch page transition and the existing bounded manual-readiness loop
takes a new full sample.

## Safety boundary

This does not make two configured pages generally acceptable and does not grant
runtime action authority through an overlapping popup.

- The exception is scoped to `waitForSetupReadiness()` and final setup
  revalidation.
- Ordinary inspection, prompt fill, submission, and response correlation remain
  blocked until the popup closes.
- An unrelated second configured page remains an ambiguity hard stop.
- An external IdP page is not inspected.
- Setup still requires the normal host, path, identity, protection, composer,
  modal, and ownership checks before configuration is committed.
- Setup never fills, clicks, submits, accepts, dismisses, or closes a browser
  control.

## Validation boundary

The deterministic regression proves the missing state transition and the
source-level fix. It does not replace the live Windows gate. The exact commit
must still be installed on the reported Windows 11 / Edge 149 target and pass:

```powershell
git rev-parse HEAD
cope update
cope version
cope setup
cope doctor
```

The live record should contain only source-free state and diagnostic fields. Do
not include account identities, tenant identifiers, query parameters, cookies,
tokens, prompts, responses, or chat content.
