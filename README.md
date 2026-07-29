# Cope

Cope turns Microsoft 365 Copilot Chat into a local coding agent through a visible Microsoft Edge Stable or Google Chrome Stable session.

The target product is a Claude Code-like developer experience: run `cope` in a project, describe a task, and let Copilot inspect files, edit code, operate the terminal, use development tools, validate the result, and report what actually changed.

Cope's local runtime owns repository access, terminal and process execution, user authority, checkpoints, recovery, browser correlation, and completion verification. Copilot supplies software-engineering judgment through its normal browser UI. Cope does not use private Copilot endpoints, token extraction, network interception, or automated sign-in.

## Current release and target

The current package version is **0.1.9**.

Version 0.1.9 implements the visible-browser transport, typed
`cba-agent/1` intent protocol, repository inspection and patching, catalog
command execution, durable recovery, and completion foundations. It also fixes
the live response-ingestion failure by reconstructing only response-owned
protocol widgets, carrying source-free capture evidence through recovery, and
preserving exact protocol diagnostics. It is still a hardened precursor rather
than the full developer-mode product: it does not expose a general shell or
permit commands to intentionally modify tracked project files.

Microsoft Edge Stable remains the established live compatibility target.
Google Chrome Stable remains a **Chrome preview candidate / offline evidence
only** status backed by offline and installed-Chrome evidence until its
separate live acceptance gates pass.

The architecture pivot is documented in:

- [Architecture](docs/ARCHITECTURE.md)
- [Developer mode target](docs/DEVELOPER-MODE-TARGET.md)
- [Limitations and compatibility](docs/LIMITATIONS.md)
- [Threat model](docs/THREAT-MODEL.md)
- [Protocol](docs/PROTOCOL.md)
- [Policy and configuration](docs/POLICY-AND-CONFIGURATION.md)
- [Requirements traceability](docs/REQUIREMENTS-TRACEABILITY.md)

Current release behavior is documented in the
[Cope 0.1.9 release notes](docs/RELEASE-NOTES-0.1.9.md) and the [0.1.9 protocol-ingestion
PRD](docs/PRD-0.1.9-PROTOCOL-INGESTION.md). Earlier behavior remains in the
[0.1.8 release notes](docs/RELEASE-NOTES-0.1.8.md).

## Product direction

Developer mode will become the recommended default. One concise project-scoped grant will authorize ordinary repository and terminal work, including shell and argv execution, command-generated project changes, normal network-dependent development tools, and local Git operations.

Inspect mode will remain read-only. The existing fixed command-catalog model will remain available as an optional hardened profile for managed environments.

The target documents describe where Cope is going. They do not claim the 0.1.9
code already implements developer mode.

## Install on Windows

Extract the release zip and double-click:

```text
install.cmd
```

The installer performs a locked dependency install, builds the TypeScript release, creates a packed npm artifact, installs the global `cope` command, and offers guided browser setup. It does not choose or download a browser.

Open a new PowerShell window after installation and run:

```powershell
cope
```

Current requirements are Node.js 24 or newer, npm 11 or newer, Git, Windows 11, and Microsoft Edge Stable or Google Chrome Stable. Cope refuses elevated execution for live sessions.

The installer remembers the extracted source folder for local updates. Pull or apply changes in that checkout, then run:

```powershell
cope update
```

Moving or deleting the extracted folder does not break the installed command, but `cope update` requires the remembered checkout to remain available or to be registered again by rerunning `install.cmd`.

## Install on macOS

macOS remains an experimental exact-tuple preview candidate rather than a general support claim.

From a reviewed checkout with Node 24 or newer, npm 11 or newer, Git, and Edge Stable or Chrome Stable already installed:

```sh
./scripts/install-macos.sh --skip-setup
```

Open a new Terminal window and run:

```sh
cope setup
```

The installer is user-level, does not use `sudo`, and does not download a browser. The selected browser, dedicated profile, sign-in, MFA, and consent remain part of visible manual setup. See [MACOS-TARGET.md](docs/MACOS-TARGET.md) for the exact preview tuples and evidence gates.

## Everyday use

Open Cope in the current Git project:

```powershell
cope
```

Open another project:

```powershell
cope C:\work\my-project
```

Run a task directly:

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

The current 0.1.9 release starts in its existing edit-capable policy model. The future developer mode described in the architecture docs is not yet available merely because the documentation names it.

## Standalone files

Cope currently operates inside Git repositories because checkpoints, diffs, recovery, and completion verification depend on a repository baseline.

A standalone HTML file can be opened directly:

```powershell
cope "C:\Users\V0X8\Downloads\dashboard.html"
```

Cope offers to create a clean project copy beside the file, establishes a baseline commit, works in the copy, and asks before copying a verified result back. It refuses to overwrite the original if it changed in the meantime.

## Interactive interface

Running `cope` opens the guided terminal interface. It remembers the last project and mode, avoids silently turning a home folder into a repository, detects missing configuration, and guides first-time setup.

Preview the interface without browser setup:

```text
cope demo
```

From a source checkout:

```text
npm run dev -- demo
```

Demo mode is side-effect free. It does not create configuration, inspect or modify project files, launch a browser, contact Microsoft 365, or create sessions.

The in-session command set is:

```text
/help       Show interactive help
/mode       Switch the current supported mode
/resume     Resume interrupted work
/sessions   Show recent work
/repo PATH  Open another project or file
/sync       Copy an approved standalone-file result back
/doctor     Check Node, Git, browser, and configuration
/config     Show configuration locations
/setup      Redo machine onboarding
/exit       Close Cope
```

Legacy operational commands remain available under:

```powershell
cope help advanced
```

## Setup

`cope setup` detects installed Edge Stable and Chrome Stable copies, verifies product identity, creates machine policy and browser configuration, prepares a product-specific dedicated profile, and visibly launches the browser for manual Microsoft 365 sign-in readiness.

Credentials, MFA, CAPTCHA, consent, and ordinary-profile import are never automated.

Per-project setup creates `.cba\repository.json`. The current release detects selected npm validation scripts such as `test`, `check`, `build`, `typecheck`, and `lint`. Those catalog commands remain useful, but they are not the target terminal architecture.

Run diagnostics at any time:

```powershell
cope doctor
```

## Current browser boundary

The browser adapter verifies the selected executable's product identity and pinned evidence, the dedicated profile, approved host, visible identity, optional protection indicator, actionable composer, conversation, and UI contract before sending project content.

Edge and Chrome never share a dedicated profile. Cope rejects overlap with ordinary browser profiles. UI changes may require a browser-contract update. An uncertain send is resolved before retry rather than blindly duplicated.

Generic browser control is not part of the coding-agent target.

## Development and verification

From the source folder:

```powershell
npm ci
npm test
```

The suite builds the project and runs deterministic tests serially. Browser classifier tests use synthetic page states, and agent-loop tests use local fixtures. They do not contact Copilot.

A developer-mode implementation must preserve offline full-loop testing while adding shell execution, command-generated mutation handling, and process recovery coverage.

## Configuration locations

On Windows:

```text
Machine policy   %LOCALAPPDATA%\CopilotBrowserAgent\config\organization-policy.json
Browser config   %LOCALAPPDATA%\CopilotBrowserAgent\config\browser.json
Edge profile     %LOCALAPPDATA%\CopilotBrowserAgentEdgeProfile
Chrome profile   %LOCALAPPDATA%\CopilotBrowserAgentChromeProfile
Project config   <project>\.cba\repository.json
Session state    %LOCALAPPDATA%\CopilotBrowserAgent
```

Cope private state and browser profiles remain outside project workspaces and are not normal coding-tool roots.

## Uninstall

On Windows, double-click `uninstall.cmd` or run:

```powershell
npm uninstall --global @local/copilot-browser-agent
```

On macOS, run:

```sh
./scripts/uninstall-macos.sh
```

The macOS uninstaller retains state and the dedicated profile by default. Destructive removal requires explicit flags.
