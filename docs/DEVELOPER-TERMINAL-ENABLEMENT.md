# Enabling the Developer terminal on an existing installation

The diagnostic is read-only. `cope doctor` does not widen a grant or write,
rewrite, back up, regenerate, chmod, rename, or delete any policy file. The
later operator steps are explicit human actions. There is no `cope policy
upgrade` command.

## Step 1 — run doctor first

Run the diagnostic from the project:

```
cope doctor
```

`Project setup` reports only the concrete `.cba/repository.json` file and its
repository schema. The optional `Developer terminal` check evaluates a new
Developer (`auto`) session in this order:

1. A `cba-repository-config/1` file means the session layer denies
   `terminal_exec` unconditionally. The Developer-terminal check does not use
   the machine policy to characterize this denial.
2. A v2 file with `developer_terminal.enabled: false` has the same session
   denial, and the Developer-terminal check does not evaluate a machine-policy
   terminal decision.
3. For v2 with `developer_terminal.enabled: true`, doctor resolves the embedded
   repository policy. If it produces `ask` or `deny`, doctor names the winning
   field, policy identity, and revision, and does not evaluate a machine-policy
   terminal decision.
4. Only when the v2 enable bit and embedded repository policy both allow does
   the Developer-terminal check read and evaluate the exact organization-policy
   path from the active state home.
   It distinguishes an absent, unreadable, malformed, `ask`, `deny`, or
   `allow` machine policy. An `ask` is not a denial, but it does not provide an
   unconditional initial terminal grant.

Tool-rule provenance follows runtime precedence exactly:
`capabilities.tools.deny`, then `capabilities.tools.ask`, then
`capabilities.tools.allow`, then `capabilities.tools.unmatched`, then
`default_decision`. A missing `capabilities.tools` falls through to
`default_decision`.

The separate required `Browser setup` check continues to inspect overall
machine configuration, including organization-policy validity. Therefore
`not_read` in Developer-terminal evidence means “not read by this terminal
decision check,” not that no other doctor check accessed the file.

## Step 2 — follow a v1 or disabled-v2 diagnosis

If doctor reports a v1 repository or
`developer_terminal.enabled: false`, and Developer mode is intended, the
documented repository remedy is:

```
cope init . --quick --force
```

Back up and diff the file first. `cope init . --quick --force` **overwrites**
`.cba/repository.json`, including custom commands, limits, grants, and
completion settings. The command is an explicit repository-local rewrite; it
does not silently migrate an existing configuration.

The quick standard profile writes repository schema v2 with the Developer
terminal enabled. Inspect and manual profiles keep the terminal disabled.

## Step 3 — address the machine policy only when doctor reports it

If doctor reaches the machine layer, use the exact path and evidence it prints.
The policy must be a valid organization-layer policy before its terminal
decision can be reported. A machine `allow` is sufficient only together with
the repository v2 enable bit and an embedded repository `allow` decision.

`cope setup` does not rewrite an existing valid machine policy. When the file is
absent, setup may create a local Developer-capable policy as part of its normal
human-run setup flow. There is no in-product migration for an existing valid
machine policy that asks or denies `terminal_exec`.

If, and only if, you own the machine policy and have decided to replace it, the
replacement remains an explicitly human-controlled procedure:

```
# Back it up first — this is machine-wide authority.
# Replace these placeholders with the exact path printed by cope doctor.
cp "/exact/path/organization-policy.json" "/exact/path/organization-policy.json.bak"
rm "/exact/path/organization-policy.json"
cope setup
```

Do not remove or replace an administrator-managed policy. If an organization
placed it, ask the policy owner to change the policy instead; replacing it with
local authority would override managed control.
