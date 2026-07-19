# Cope 0.1.1 release notes

Version 0.1.1 replaces the internal command-oriented entrypoint with a guided product interface while preserving the deterministic runtime and advanced operational commands.

## Main changes

- Adds global `cope` and compatibility `copilot-agent` binaries.
- Adds a Windows installer that builds, packs, globally installs, updates the user PATH when needed, verifies the installed version, and offers setup.
- Running `cope` now opens an interactive home screen rather than printing a long usage block.
- Supports plain-English one-shot tasks and path-first launch syntax.
- Adds guided project selection, remembered project and mode, compact help, slash commands, session discovery, and environment diagnostics.
- Adds guided machine and repository onboarding.
- Supports standalone files through a safe Git-backed copy and conflict-aware approved sync-back.
- Replaces JSON-heavy grant, permission, result, progress, and error output with human-readable terminal views. JSON mode remains stable for automation.
- Keeps advanced init, run, resume, status, pause, abort, rollback, audit, and review commands under `cope help advanced`.
- Fixes the Windows preflight tests so they use the same deterministic Git executable resolver as production.

## Compatibility

The runtime still requires Node.js 24 or newer for live use. The visible Edge transport remains dependent on the Microsoft 365 Copilot page satisfying the configured readiness signals. Authentication is always manual.
