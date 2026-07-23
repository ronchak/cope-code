# Cope

Cope turns Microsoft 365 Copilot Chat into a local coding agent through a visible Microsoft Edge Stable or Google Chrome Stable session. Edge remains the established compatibility target. Chrome is a **preview candidate / offline evidence only** until its separate live acceptance gates pass. The normal interface is intentionally small: install it once, run `cope setup`, then run `cope`, choose a project, and describe the task in plain English.

The deterministic harness remains responsible for repository boundaries, permissions, local tools, checkpoints, validation, recovery, and audit records. Copilot supplies the coding judgment through its normal browser UI. Cope does not use private Copilot endpoints, token extraction, network interception, or automated sign-in.

## Current release

The current package version is **0.1.5**. See the
[Cope 0.1.5 release notes](docs/RELEASE-NOTES-0.1.5.md) for the complete
Microsoft 365 Copilot readiness and live-browser compatibility fixes.

## Install on Windows

Extract the release zip, then double-click:

```text
install.cmd
```

The installer performs a locked dependency install, builds the TypeScript release, creates a packed npm artifact, installs the global `cope` command, and offers to run guided browser setup. It is browser-neutral: it neither chooses nor downloads a browser. The packed install is deliberate. Moving or deleting the extracted release folder later will not break the global command.

The installer also remembers the extracted source folder for local updates. From that checkout, pull or apply the changes you want, then run `cope update` to rebuild and reinstall Cope. Moving or deleting the source folder does not break the installed command, but you must rerun `install.cmd` from the folder's new location before using `cope update` again.

Open a new PowerShell window after installation and run:

```powershell
cope
```

Requirements are Node.js 24 or newer, npm, Git, Windows 11, and Microsoft Edge Stable or Google Chrome Stable. Cope refuses elevated execution for live sessions.

## Install on macOS (experimental preview candidate)

macOS operation is an uncertified, exact-tuple home-test preview—not production parity or a generic support claim. From a reviewed checkout, with Node 24+, npm 11+, Git, and Edge Stable or Chrome Stable already installed:

```sh
./scripts/install-macos.sh --skip-setup
```

The installer verifies the installed command and, when using the default `~/.local` prefix, safely adds it to `~/.zprofile` if it is not already on `PATH`. Open a new Terminal window, then run:

```sh
cope setup
```

The installer is user-level, validates `${COPE_INSTALL_PREFIX:-$HOME/.local}`, packs a durable artifact instead of linking to the checkout, uses no `sudo`, and downloads no browser. Use `--no-path-update` if shell startup files must remain untouched. Browser choice, the dedicated profile, sign-in, MFA, and consent belong to `cope setup`; authentication remains manual. A live browser additionally requires a logged-in Aqua session; root and logged-out/headless operation fail closed. See [the exact candidate tuples and gates](docs/MACOS-TARGET.md).

## Everyday use

Open Cope in the current Git project:

```powershell
cope
```

Open a project from anywhere:

```powershell
cope C:\work\my-project
```

Run a task directly from inside a project:

```powershell
cope "fix the failing tests"
```

Run a task against another project:

```powershell
cope -C C:\work\my-project "simplify the dashboard CSS"
```

Start read-only:

```powershell
cope --inspect
```

Continue the newest resumable session:

```powershell
cope -c
```

## Standalone files

Cope operates inside Git repositories because checkpoints, diffs, safe recovery, and completion verification depend on Git. A standalone HTML file is now a supported onboarding path rather than a dead end.

```powershell
cope "C:\Users\V0X8\Downloads\Fork-item_prep_1st_shift_dashboard_v.12.9.04.html"
```

Cope offers a recommended clean-project copy beside the file, creates a baseline commit, works in that copy, and asks before copying a verified result back. If the original changed in the meantime, Cope refuses to overwrite it and preserves both versions.

## Interactive interface

Running `cope` opens the guided terminal interface. It remembers the last project and mode, avoids silently turning a home folder into a repository, detects missing configuration, and guides first-time setup.

Preview the terminal interface on any development machine without browser setup:

```text
cope demo
```

From a source checkout where `cope` is not globally installed:

```text
npm run dev -- demo
```

Demo mode is intentionally side-effect free. It does not create configuration, inspect or modify project files, launch a browser, contact Microsoft 365, or create sessions. Sample task prompts show the live handoff point and then return to the demo prompt.

Describe a task directly at the prompt. The small in-session command set is:

```text
/help       Show interactive help
/mode       Switch inspect, edit, or auto
/resume     Resume interrupted work
/sessions   Show recent work
/repo PATH  Open another project or file
/sync       Copy an approved standalone-file result back
/doctor     Check Node, Git, browser, and configuration
/config     Show configuration locations
/setup      Redo machine onboarding
/exit       Close Cope
```

The legacy operational commands still exist for recovery and automation, but they are no longer the front door:

```powershell
cope help advanced
```

## First-run onboarding

`cope setup` detects installed Edge Stable and Chrome Stable copies, verifies their product identity, and guides the choice only when a meaningful choice exists. One detected browser is preselected; two produce an arrow-key selector that defaults to an existing choice or otherwise Edge; none produces retry and manual-installation actions. Existing valid configurations remain selected and are not silently changed. Plain terminals receive a numbered fallback.

Setup creates local machine policy, browser configuration, and a product-specific dedicated profile, then visibly launches the selected browser for manual sign-in readiness. It asks for the account name or email visibly shown in Microsoft 365 Copilot and uses `https://m365.cloud.microsoft/chat` by default. Credentials, MFA, CAPTCHA, consent, and ordinary-profile import are never automated. For managed automation only, `cope setup --browser edge|chrome` and `--browser-executable <path>` are available; normal users do not need them.

Per-project setup is guided automatically. Cope detects useful package scripts such as `test`, `check`, `build`, `typecheck`, and `lint`, then creates `.cba\repository.json`. Inspect mode starts read-only. Edit mode allows project changes subject to the layered policy and task grant.

Run the environment checker at any time:

```powershell
cope doctor
```

## Development and verification

From the source folder:

```powershell
npm ci
npm test
```

The suite builds the project and runs deterministic tests serially. Browser classifier tests use synthetic page states, and agent-loop tests use local fixtures. They do not contact Copilot.

The two previous Windows preflight failures were caused by tests invoking bare `git` while production already used the Windows Git resolver. Version 0.1.1 makes the tests use the same resolver and includes spawn diagnostics if Git genuinely fails.

## Configuration locations

```text
Machine policy   %LOCALAPPDATA%\CopilotBrowserAgent\config\organization-policy.json
Browser config   %LOCALAPPDATA%\CopilotBrowserAgent\config\browser.json
Edge profile     %LOCALAPPDATA%\CopilotBrowserAgentEdgeProfile
Chrome profile   %LOCALAPPDATA%\CopilotBrowserAgentChromeProfile
Project config   <project>\.cba\repository.json
Session state    %LOCALAPPDATA%\CopilotBrowserAgent
```

The browser adapter verifies the selected executable's Edge/Chrome identity and recorded hash, dedicated-profile product marker, approved host, conversation, visible identity, optional protection indicator, composer, and UI contract before submitting a prompt. Edge and Chrome never share a dedicated profile, and Cope rejects overlap with either ordinary browser profile. UI changes can still require browser-contract adjustments. Cope fails closed with diagnostics rather than sending content from an unverified page.

## Technical documentation

Architecture and controls remain documented under `docs`:

- `docs/ARCHITECTURE.md`
- `docs/POLICY-AND-CONFIGURATION.md`
- `docs/PROTOCOL.md`
- `docs/RECOVERY-AND-AUDIT.md`
- `docs/LIMITATIONS.md`
- `docs/OPERATOR-GUIDE.md`
- `docs/WINDOWS-TARGET.md`
- `docs/MACOS-TARGET.md`
- `docs/LIVE-PILOT-ACCEPTANCE.md`
- `docs/RELEASE-NOTES-0.1.5.md`

## Uninstall

Double-click `uninstall.cmd`, or run:

```powershell
npm uninstall --global @local/copilot-browser-agent
```

For the macOS preview candidate, `./scripts/uninstall-macos.sh` retains state/profile by default; the destructive `--remove-state` and `--remove-profile` flags are explicit.
