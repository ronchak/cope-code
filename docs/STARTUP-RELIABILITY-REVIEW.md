# Startup reliability review — September 5, 2026

Reviewed `main` at `fb614cd` and implemented the focused fixes on
`codex/reliable-copilot-startup`.

## Assessment

The core idea is reasonable: Copilot can write a structured request, a local
program can execute it, and the result can become the next chat message. The
repository already implements that loop. But a normal chat message does not
install native tools in Copilot. The model needs a clear explanation of the
text relay, and the browser adapter needs to distinguish conversation content
from application state reliably.

Those two boundaries have received less convincing validation than the local
execution, policy, and recovery machinery. Adding another protocol version or
more recovery states is not the first priority. Demonstrating a useful live
read → edit → test → finish sequence is.

## Findings and changes

### 1. Ordinary task text can masquerade as a service outage

`src/browser/config.ts` defines page-wide text matches for phrases including
“rate limit,” “try again later,” and “something went wrong.” The classifier
prioritizes those signals over ready/streaming state. In a real local Chromium
browser with a synthetic page, an assistant response saying “Implement rate
limiting for this API” incorrectly became `SERVICE_THROTTLED`.

The semantic capture layer now excludes ordinary user messages, assistant
prose, composer text, and code from those service signals, while preserving
explicit service alerts. The fix operates on saved configurations too;
regenerating setup is unnecessary. Browser regressions cover both ordinary
content and actual service UI.

### 2. An apostrophe can hide actual service errors

The baseline service-error expression contains `couldn't respond`. With the
locked Playwright dependency, that expression can find an element with
`count()` but fail when composed with `nth(0)`. The resulting selector error
is swallowed by the visibility helper, so the error signal disappears.

The locator boundary now escapes quote characters without changing regex
semantics. Browser tests exercise actual service-error elements, including
the contraction. This and finding 1 are reproduced code defects, rather than
guesses about Copilot behavior.

### 3. Bootstrap never clearly explained who executes tools

The old introduction declared a “contract” and assigned Copilot a role. It did
not plainly say that tool requests are text consumed by a separate local
program. That is a plausible contributor to the reported “I don't have tools”
response, although that causal link needs a live comparison.

Bootstrap now explains the relay, asks for a relevant first observation, and
explains that Copilot needs no native tool access. It also supplies the
previously underspecified answer basis, blocker fields, and batch item shape.
An adapter regression parses the examples from the actual generated prompt
through an observation → result → answer exchange.

### 4. Windows shell context was missing

The terminal executor defaults to `COMSPEC`/`cmd.exe` on Windows. Launching
Cope from PowerShell does not change that behavior. The model previously
received neither platform nor shell facts and therefore had to infer command
syntax.

For terminal-enabled sessions, bootstrap now includes platform, the actual
resolved shell executable, and the project-relative starting directory. It
uses the same resolver as execution. Tests cover Windows and macOS shell
selection and defaults. Only those three facts are added; the environment is
not dumped into the prompt.

### 5. Successful turns repeated stable protocol instructions

Every normal tool result and user decision appended a protocol reminder,
including an informational-answer example. This contradicted the repository's
own guidance to send stable instructions once and repeat them on repair paths.

Normal results and decisions now contain just the harness message. Protocol
errors and rejected completion claims retain repair guidance. A representative
small result shrank from 600 to 258 bytes. The minimal developer bootstrap
grew from about 13.5 KB to 14.3 KB to explain the missing interaction model
once. Prompt size alone is not a demonstrated cause of failure.

## Historical evidence and remaining limitations

Saved local Edge sessions from July 24 contain first-response schema errors
and three pauses at turn six with `RESPONSE_BASELINE_TRUNCATED`. Current main
already supports exact suffix correlation when M365 removes older messages
from the rendered history. These records establish historical failures, not
proof that the same defects remain in this revision or explain the latest
Windows run.

Version 0.1.10 also removed dependence on Microsoft's exact English
syntax-highlighting warning sentence. Capture still depends on a specific
response-owned code widget, supported fence label, read-only editor, and
contiguous editor lines. That is an integration assumption needing live
validation. Loosening parsing to execute arbitrary JSON from chat text would
not establish which content the model selected as an action.

The ordinary CLI default remains Edit. General terminal execution requires
Developer mode (`--auto`) and compatible configuration/grants. Existing v1
configuration does not acquire terminal execution through a code update.
This distinction can explain missing capabilities, but it does not explain a
browser connection failure. This patch does not change existing grants.

The reviewed acceptance documents explicitly describe synthetic/offline
evidence and pending live verification. They do not establish that the current
Microsoft 365 service supports this full loop reliably. We have not run this
patch against the user's Windows/Edge/M365 environment.

## Work that matters before Monday

Use a disposable Git project and the same Windows/Edge/M365 setup that failed.
Record the installed Cope revision so an old global package is not tested by
accident. Use a new conversation for the new bootstrap; resuming an old session
does not resend it.

1. **Read and answer:** ask Cope to read a small known file and report its value.
   Verify the first response requests a real observation and the final answer
   uses the returned fact. Record refusal, parse failure, capture failure, and
   connection failure separately.
2. **Edit and validate:** in Developer mode, ask for one small change and run a
   known test. Verify the disk change and exit result. Include a task or file
   containing “rate limit” and “something went wrong” to exercise the regression.
3. **Sustained loop:** use a task requiring at least ten browser exchanges.
   Verify that passing the old turn-six boundary does not lose response
   correlation. Repeat the small task in three fresh conversations to test
   whether startup works consistently rather than once by chance.

If the model still refuses the relay, compare the same short bootstrap and a
single observation request manually in a disposable conversation. If manual
text works but Cope fails, focus on capture/submission. If it fails manually
too, revise or reject the prompting assumption before building more tools.

Keep the existing local executor, operation journal, and recovery protections.
Defer wider refactoring and new capabilities until these live tests pass. The
next useful artifact is a small failing transcript/DOM fixture tied to its
failure stage, not another large release runbook.

## Verification completed

- Node 24.20.0 / npm 11.19.1 build and release-version checks pass.
- The broad suite ran 985 tests with zero skips: 984 passed; its sole failure
  was the old hardcoded 18-test browser inventory after adding test 19. That
  assertion was corrected.
- After the final edits and rebuild, all 56 focused protocol, runtime-policy,
  and test-inventory checks pass, with zero skips.
- All 19 required Chromium tests pass in installed local Chrome, with zero
  skips. The new test includes 11 service-state scenarios and eight regex
  quoting scenarios.
- `git diff --check` passes. No live Windows/Edge/M365 run was performed.

Local execution logs: `/tmp/cope-startup-test.log` and
`/tmp/cope-startup-final-tests.log` (temporary files, not committed artifacts).
