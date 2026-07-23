# URGENT: a visible Copilot chat can fail setup identity readiness

## Status

Root cause reproduced first through the production Playwright semantic adapter,
then confirmed against an authenticated Microsoft 365 tenant in installed
Chrome 150 using Cope's dedicated persistent profile.

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

The current Microsoft 365 Copilot navigation exposes the signed-in owner as:

```html
<span
  role="img"
  id="user-account-avatar"
  aria-hidden="true"
  aria-label="Chakraborty, Ronak"
>
```

The adjacent clickable overlay is only:

```html
<div role="button" aria-label="Chakraborty, Ronak"></div>
```

Neither element matched the immutable ownership locator. The existing locator
recognized only `mectrl`/`mecontrol` and `data-testid` account/profile buttons.
Selecting the avatar directly is also unsafe for literal matching because its
visible initials and full-name ARIA channel conflict. Selecting every labeled
button would admit unrelated navigation actions as identity evidence.

Four defects combined:

1. The canonical identity selector did not use M365's stable
   `#user-account-avatar` current-owner hook to select the immediately adjacent
   labeled overlay. The production observation therefore reported zero visible
   identity elements even while the page, composer, and owner were visibly
   ready.
2. Interactive setup asked specifically for a work-account email. The account
   control can expose only a display name, so the configured email has no
   identity-equivalent value in the bounded DOM evidence.
3. The classifier parsed account/profile wrappers into canonical identity
   subjects, but the literal-string branch compared the expected identity
   against the original raw channel. It also did not recognize the
   `account manager for` prefix. An exact visible display name therefore still
   failed on older M365 account-control layouts whose ARIA channel contains
   that wrapper.
4. Setup discarded the source-free readiness diagnostic when classification
   failed. `IDENTITY_NOT_VERIFIED`, its `identity` missing signal, and its
   specific remediation were replaced by generic sign-in guidance.

Live prompt acceptance exposed a related chain of runtime contract drift in the
same M365 release:

1. Current user turns use `data-testid="chatQuestion"` and current assistant
   turns use `data-testid="copilot-message-reply-div"`. Neither exact envelope
   matched the legacy `data-content`, `data-author`, or compound `*message*`
   selectors. Cope could click Send, but its delivery marker remained invisible
   to the bounded observer. Confirmation failed with
   `SUBMISSION_EVIDENCE_INCONCLUSIVE`; a later receive recheck failed with
   `TASK_MARKER_NOT_OBSERVED`.
2. M365's Fluent send control ignores the untrusted event emitted by
   `HTMLElement.click()`. The visible button was correct and enabled, but the
   application did not accept the synthetic activation. A protocol-backed click
   on the already-bound element is required.
3. The current Lexical editor appends only trailing U+200B/U+200C sentinels to
   an otherwise exact programmatic fill. Exact post-fill ownership therefore
   failed with `COMPOSER_CONTENT_CHANGED_BEFORE_SUBMIT`.
4. The first send from `/chat` asynchronously materializes
   `/chat/conversation/<id>`. Treating every URL change as foreign conversation
   ownership failed with `CONVERSATION_CHANGED_DURING_RESPONSE`, even though
   the exact task marker moved to that new URL.
5. While appending an answer, M365 briefly unmounts all `chatQuestion`
   envelopes. A single absent sample was treated as permanent marker loss.
   The marker was present again in the same conversation after reload.
6. M365 renders a fenced `cba/1` response as a code-editor widget. Outer
   `innerText()` removes the backticks and adds language badges, warning text,
   and line numbers. The browser received valid protocol JSON, but the local
   parser correctly reported that no CBA fence existed.
7. The live transcript is a rolling four-envelope DOM window. Once full, a new
   answer removes the oldest assistant envelope while appending the newest.
   The model content was unchanged, but the previous append-only prefix check
   failed with `RESPONSE_BASELINE_CHANGED`.
8. A forced protocol click is still coordinate-targeted. An overlay mounted
   after preflight (including from `mousemove`) can receive the trusted event
   instead of the bound send element. Real Chromium reproduced this retargeting.
9. JSON content declaring `protocol: "cba/1"` does not prove that the model
   emitted a `cba/1` fence. Reconstructing from content alone could promote an
   ordinary `json` or unlabeled example into an executable envelope.
10. The generic conversation fallback `/chat|conversation/` also matched
    transient message IDs such as `chatQuestion`, `chatOutput`, and
    `lastChatMessage`. A remount between `isVisible()` and the meaningless
    `isEnabled()` probe on one such presence-only node exhausted the shared
    action deadline and revoked an otherwise healthy second live session.
11. First-send eligibility compared the observed conversation hash with a hash
    of the raw configured entry URL. The harmless `/chat/` versus canonical
    `/chat` slash difference therefore disabled materialization before exact
    marker proof could adopt `/chat/conversation/<id>`.

The stable failure consumed the normal 15-second UI hydration allowance, then
returned `identity-unverified`. It was not a browser discovery, profile,
navigation, authentication, renderer-timeout, or composer-locator failure.

## Live diagnostic log

The authenticated profile was verified without importing cookies or
credentials:

1. The original setup reproduced `IDENTITY_NOT_VERIFIED` with the conversation,
   composer, and visible signed-in account already present.
2. With the owner selector fixed, `cope setup` completed and reported the
   selected Chrome Stable binary, configured M365 URL, and verified visible
   account name.
3. `cope doctor --json` passed browser setup, selected-browser identity, and
   dedicated-profile privacy. Its only failure in the source checkout was the
   expected missing project initialization file.
4. A new isolated Git repository was initialized with `cope init --quick`.
5. Successive real submissions exposed, in order, missing message envelopes,
   ignored synthetic click, Lexical sentinels, entry-route materialization,
   transient marker remount, stripped CBA fences, and the rolling response
   window. Each failure was captured before changing the corresponding guard.
6. After the fixes, one independent inspect session executed `git_status` and
   reached verified completion. A second executed both `git_status` and
   `git_diff` and reached verified completion. Both reported zero mutations.

## Deterministic reproduction

The primary real-Chromium regression serves the current Microsoft 365
navigation shape with:

- a visible `main` conversation surface;
- an enabled `contenteditable` Copilot textbox;
- a send button; and
- an aria-hidden `#user-account-avatar` whose accessible-name attribute is the
  configured display name, immediately followed by the labeled clickable
  overlay.

The production `PlaywrightSemanticPage`, readiness observer, UI contract, and
classifier all run unchanged. Before the selector fix, the production observer
reports zero visible identity elements and classifies the exact visible display
name as `IDENTITY_NOT_VERIFIED`. After the fix, it captures exactly the stable
owner avatar and the page reaches `READY`.

A second real-Chromium regression retains coverage for the older `mectrl`
button with `Account manager for …` presentation.

A separate negative regression configures an email while exposing only the
display name. It must remain `IDENTITY_NOT_VERIFIED`; Cope must not infer that
two distinct identity strings belong to one person.

## Fix

- Prompt for the exact account name or email visibly exposed by Copilot.
- Add only an ownership-specific selector for the labeled overlay immediately
  adjacent to the container holding `#user-account-avatar`. Do not capture the
  avatar's initials or broaden the boundary to all labeled role-buttons.
- Add the exact current M365 `chatQuestion` and
  `copilot-message-reply-div` envelope test IDs to submission/response evidence
  capture. These selectors observe text only and never become action targets.
- Anchor conversation fallback IDs to exact container/root/page/surface/view
  names, never substring-match transient message IDs. Presence/text signals do
  not run element-enabled probes; only composer, Send, and modal actionability
  require them.
- Dispatch a trusted pointer click through the concrete `ElementHandle` already
  bound and hit-tested by the post-fill transaction. Preserve Playwright's
  receives-events enforcement and install a bounded capture guard that cancels
  off-target trusted activation and proves exactly one trusted click reached
  the bound element. Never force a coordinate click or return to a locator that
  can resolve to a replacement node.
- Permit only trailing U+200B/U+200C Lexical sentinels during exact composer
  ownership verification.
- Adopt a first-send materialized conversation only when the exact unique task
  marker is observed on the new URL. Retry a mixed-document observation only
  inside that bounded first-send window; never carry entry-route proof across a
  markerless URL change. Determine entry-route eligibility with the same exact
  origin and trailing-slash-normalized path boundary used by page selection,
  while preserving exact query state as part of conversation identity.
- Treat a temporarily absent marker as pending on the same pinned conversation.
  Reset response stability across the gap and require the exact marker to
  return before accepting any response.
- Within an assistant-owned envelope, reconstruct a `cba/1` fence only when one
  current M365 code-block widget owns both the read-only editor and exactly one
  exact `cba/1` unsupported-language information banner, and the editor contains
  syntactically valid JSON declaring `protocol: "cba/1"`. `json`, unlabeled,
  ambiguous, and ordinary content retain the rendered-text fallback.
- Retain per-envelope response digests locally. Accept one rolling-window shift
  only when every retained envelope matches the prior suffix exactly and there
  is exactly one new final envelope. Durable restart recovery remains
  aggregate-only and fails closed if the prefix is no longer available.
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

It also does not trust a response observed while its task marker is absent,
infer a materialized conversation from timing alone, accept multiple new
assistant envelopes, or weaken recovered-session baseline checks.

The diagnostic remains source-free and contains only controlled state,
diagnostic code, UI-contract version, locator quorum, missing signal names, and
prewritten remediation.

## Validation

Required before merge:

1. Focused classifier and onboarding tests.
2. Real Chromium execution of both the current navigation-avatar and legacy
   account-manager wrapper regressions.
3. Existing Chromium identity ambiguity and native-dialog safety tests.
4. Full `npm run check` (535/535 passing with installed Chrome; zero skips).
5. GitHub Actions matrix green.
6. No unresolved P1/P2 review findings.
7. Codex review approval on the final commit.

The local implementation additionally has real-Chromium composition coverage:
it fills the composer, proves the send event is trusted, changes the entry URL,
renders current M365 user/assistant envelopes, confirms the exact task marker,
reconstructs the rendered CBA fence, and receives the correlated response.
Separate Chromium regressions reproduce a hover-mounted overlay and verify that
neither it nor Send activates, and prove that `json` and unlabeled editors
containing CBA-shaped JSON remain inert and fail protocol parsing.

The authenticated local acceptance sequence completed `cope setup`,
`cope doctor`, isolated project initialization, and two harmless Cope Code
prompt round trips against the dedicated profile. No private account, tenant,
cookie, token, prompt response, or chat content is stored in this bug log or
emitted in diagnostics.
