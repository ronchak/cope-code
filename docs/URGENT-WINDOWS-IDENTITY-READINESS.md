# URGENT: a visible Copilot chat can fail setup identity readiness

## Status

Root cause reproduced locally through the production Playwright semantic adapter
and fixed with deterministic unit and real-Chromium coverage.

The previously fixed authenticated-page timeout, navigation churn, and popup
callback incidents were real but separate failures. They did not change the
identity proof required before setup can persist a browser configuration.

## User-visible failure

On Windows, `cope setup`:

1. discovers and verifies Microsoft Edge Stable;
2. launches a visible persistent context with Cope's dedicated Edge profile;
3. navigates to the configured Microsoft 365 Copilot Chat page;
4. displays an authenticated conversation and enabled message textbox; and
5. waits before failing with:

   ```text
   The selected browser did not reach a verified Copilot-ready state
   ```

The previous guidance incorrectly suggested that sign-in, MFA, consent, or
tenant protection was incomplete even when the visible page had already
completed those steps.

## Root cause

Readiness requires more than a visible conversation and actionable composer.
It also requires the configured account identity to match the text or
accessible name of Microsoft 365's account control.

Microsoft 365 commonly exposes that control with a display-name wrapper such
as:

```text
Account manager for Jane Doe
```

Three defects combined:

1. Interactive setup asked specifically for a work-account email. The account
   control can expose only a display name, so the configured email has no
   identity-equivalent value in the bounded DOM evidence.
2. The classifier parsed account/profile wrappers into canonical identity
   subjects, but the literal-string branch compared the expected identity
   against the original raw channel. It also did not recognize the
   `account manager for` prefix. An exact visible display name therefore still
   failed when the ARIA channel contained the wrapper.
3. Setup discarded the source-free readiness diagnostic when classification
   failed. `IDENTITY_NOT_VERIFIED`, its `identity` missing signal, and its
   specific remediation were replaced by generic sign-in guidance.

The stable failure consumed the normal 15-second UI hydration allowance, then
returned `identity-unverified`. It was not a browser discovery, profile,
navigation, authentication, renderer-timeout, or composer-locator failure.

## Deterministic reproduction

The real-Chromium regression serves a synthetic Microsoft 365 origin with:

- a visible `main` conversation surface;
- an enabled `contenteditable` Copilot textbox;
- a send button; and
- a `mectrl` account button whose accessible name is
  `Account manager for Ronak Chakraborty`.

The production `PlaywrightSemanticPage`, readiness observer, UI contract, and
classifier all run unchanged. Before the fix, configuring the exact visible
display name produces `IDENTITY_NOT_VERIFIED`. After the fix, the page reaches
`READY`.

A separate negative regression configures an email while exposing only the
display name. It must remain `IDENTITY_NOT_VERIFIED`; Cope must not infer that
two distinct identity strings belong to one person.

## Fix

- Prompt for the exact account name or email visibly exposed by Copilot.
- Recognize and narrowly unwrap the current-owner presentation
  `account manager for` before literal display-name comparison.
- Keep alternate-profile and generic account actions such as `switch account`,
  `switch to`, and `work account` from becoming current-owner proof.
- Preserve all existing multi-account, conflicting-channel, alternate-profile,
  Unicode, overflow, and partial-match rejection behavior.
- Propagate the complete minimal readiness diagnostic through initial setup and
  final compare-and-swap revalidation.

## Security boundary

This fix does not:

- map an email address to a display name;
- accept substring, prefix, suffix, or reordered extra-token matches;
- let one matching channel override a conflicting text or ARIA channel;
- ignore multiple visible account controls;
- read an external identity-provider DOM;
- fill, click, dismiss, submit, or import credentials; or
- persist account-control contents in diagnostics.

The diagnostic remains source-free and contains only controlled state,
diagnostic code, UI-contract version, locator quorum, missing signal names, and
prewritten remediation.

## Validation

Required before merge:

1. Focused classifier and onboarding tests.
2. Real Chromium execution of the account-manager wrapper regression.
3. Existing Chromium identity ambiguity and native-dialog safety tests.
4. Full `npm run check`.
5. GitHub Actions matrix green.
6. No unresolved P1/P2 review findings.
7. Codex review approval on the final commit.

The real Windows tenant remains the final product acceptance target. Automated
Chromium coverage proves the exact DOM/classifier defect and fix without
capturing or retaining private account, tenant, cookie, token, prompt, or chat
data.
