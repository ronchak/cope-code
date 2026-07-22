# URGENT: authenticated Windows setup times out on a visibly ready Copilot page

## Status

Urgent live Windows blocker. Reproduced on a Windows workstation after updating to current `main` and rebuilding/linking Cope 0.1.2.

## User-visible failure

`cope setup` successfully verifies and launches Microsoft Edge Stable 149 with the dedicated Cope profile. That profile is already authenticated. The opened Microsoft 365 Copilot page visibly shows the user's chat history and an enabled message textbox on the normal Copilot Chat surface.

Despite that visible ready state, setup does not commit. Observed failures are:

```text
The selected browser did not reach a verified Copilot-ready state
```

and, on a subsequent attempt:

```text
The browser operation exceeded its configured action timeout
Diagnostic: BROWSER_OPERATION_TIMEOUT
```

The browser executable discovery problem fixed in PR #7 is no longer present. Edge is selected and launched correctly. This failure occurs afterward during manual-readiness inspection.

## Environment

- Host: Windows 11 workstation, non-elevated PowerShell session
- Browser: Microsoft Edge Stable 149
- Cope: 0.1.2 built from current `main` after PR #7
- Install path: verified Stable `msedge.exe` under the standard Microsoft Edge application directory
- Browser profile: Cope's dedicated Edge profile
- Authentication state: already signed in; existing chats and the composer are visible immediately
- Protection-indicator requirement: disabled for this reproduction

Do not include the user's work email, tokens, cookies, tenant identifiers, or chat contents in diagnostics or fixtures.

## Reproduction

1. On Windows, clone or update `ronchak/cope-code` to current `main`.
2. Run:

   ```powershell
   npm ci
   npm run build
   npm link
   ```

3. Confirm the installed command resolves to Cope 0.1.2 and includes the PR #7 browser-probe fix.
4. Ensure the dedicated Cope Edge profile is already authenticated to Microsoft 365 Copilot.
5. Run either:

   ```powershell
   cope setup
   ```

   or the explicit verified executable path:

   ```powershell
   cope setup --browser edge --browser-executable "$edge"
   ```

6. Enter the visible work-account identity.
7. Use the standard Microsoft 365 Copilot Chat entry surface and answer `n` when asked whether to require the enterprise-data-protection indicator.
8. Observe that Edge opens the dedicated profile directly to an authenticated Copilot page with chat history and an enabled message textbox.
9. Do not interact with the page. Wait for setup.
10. Observe that setup fails instead of persisting the browser configuration, commonly with `BROWSER_OPERATION_TIMEOUT`.

## Expected behavior

Once the approved host, expected account, shell, conversation surface, and enabled composer are visibly present, `cope setup` should classify the page as ready and atomically commit setup.

A transiently slow semantic locator or renderer operation must not be misreported as an authentication failure. If readiness cannot be established, diagnostics must identify the exact signal or operation that stalled without exposing account or chat content.

## Actual behavior

A visibly authenticated and usable Copilot page is not accepted as ready. A single semantic-page operation can exceed the 15-second action deadline, permanently revoke the delegate, tear down the browser session, and surface `BROWSER_OPERATION_TIMEOUT` even though the outer manual-readiness window is ten minutes.

## Suspected code boundary

This is not yet a confirmed root cause. The likely boundary is the interaction between:

- `src/cli/onboarding.ts`, which waits for manual readiness before committing setup
- `src/browser/manual-readiness.ts`, which allows manual authentication states to consume the broader readiness window
- `src/browser/playwright-semantic-page.ts`, where each semantic snapshot is bounded by `actionMs` and an operation timeout permanently terminates the delegate
- the authenticated Microsoft 365 Copilot identity, composer, modal, or shell locator groups

The investigation should determine which exact locator group or Playwright call stalls on the real Windows page. Raising the timeout blindly is not an acceptable fix.

## Required fix behavior

- Complete setup on the reproduced Windows Edge 149 page when chats and the enabled composer are already visible.
- Preserve fail-closed behavior for unapproved hosts, account mismatch, missing required protection evidence, native dialogs, and ambiguous submission state.
- Never dismiss, accept, fill, click, or submit through an unknown browser dialog during setup.
- Add source-free diagnostics that identify the stalled semantic group and operation type.
- Add deterministic regression coverage for an authenticated ready page whose individual semantic probe is delayed or temporarily blocked.
- Re-run the exact final commit on the live Windows target.
- Re-run the full Windows and macOS test suites and confirm no regression in dialog safety or timeout revocation.

## Acceptance criteria

Setup is not considered fixed until all of the following are true:

1. The exact Windows reproduction completes and persists configuration.
2. `cope doctor` verifies the selected browser and dedicated profile afterward.
3. A focused automated regression test fails before the fix and passes after it.
4. Native-dialog and renderer-stall safety tests remain green.
5. Full validation passes on the exact final commit.
