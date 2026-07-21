# Cope quickstart

## Install

Extract the release and run `install.cmd`. The installer leaves a durable global command, so the extracted folder is not part of the runtime path after installation.

Open a new PowerShell window:

```powershell
cope setup
cope
```

`cope setup` guides Edge/Chrome selection when needed, product-specific profile creation, machine policy, and manual authentication in the visible selected browser. Then `cope` guides project selection, repository policy creation, and task permissions. Edge is the established compatibility target; Chrome remains a preview candidate/offline evidence only.

## The three normal launch patterns

```powershell
cope
cope C:\path\to\project
cope -C C:\path\to\project "describe the task"
```

A path may be a Git project, a normal folder, or a standalone file. Non-Git folders require explicit approval before Git initialization. Standalone files can be copied into a dedicated sibling workspace.

## Modes

`edit` is the default and can change project files within the configured policy. `inspect` is read-only. `auto` reduces prompts only inside the same project policy. It is not unrestricted mode.

```powershell
cope --inspect
cope --edit
cope --auto
```

Change modes inside the interface with `/mode`.

## Task permissions

Before a task begins, Cope shows a compact access screen with the project, mode, paths, command IDs, Copilot data classes, and network setting. Permission expansions use a three-choice prompt: allow once, allow for the session, or deny.

## Recovery

Use `cope -c` to continue the latest resumable session for the selected project. Use `/sessions` or `cope sessions` to inspect recent work. The complete recovery command set remains available under `cope help advanced`.

## Diagnostics

```powershell
cope doctor
```

This checks Node, Git, the selected browser product/version/identity, machine policy, browser configuration, the selected Git repository, and project configuration. Human-readable output is concise; `--json` adds executable/profile paths and identity evidence for scripts and advanced diagnosis.
