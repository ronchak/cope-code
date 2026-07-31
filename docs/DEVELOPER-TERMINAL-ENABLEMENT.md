# Enabling the Developer terminal on an existing installation

Scope: this is an operator opt-in procedure. It is unrelated to the 0.1.10
protocol-capture fix; a repository that cannot run `terminal_exec` is behaving
as designed, not failing.

Cope never widens authority on your behalf. Nothing here happens automatically,
and no step in this document is performed by the capture fix.

## Where the denial actually comes from

`terminal_exec` must be granted by all three policy layers. For a repository
still on the legacy `cba-repository-config/1` schema, the block is at the
**session** layer and is unconditional:

```
const terminalRequested =
  input.mode === "auto" &&
  configuration.repository.schema_version === REPOSITORY_CONFIG_VERSION && // v2 only
  configuration.repository.developer_terminal.enabled;
```

A v1 repository config has no `developer_terminal` key at all — the loader
fills in `enabled: false` — so the session grant is built with
`tools.deny: ["terminal_exec"]` before any organization policy is consulted.

That means the effective denial on a legacy repository is **not** evidence that
your machine policy forbids the terminal. The two layers must be checked
separately.

## Step 1 — back up, then rewrite the repository config

`cope init --force` **overwrites** `.cba/repository.json`. It re-runs validation
command detection, so hand-tuned `commands`, `limits`, `grant_defaults`, and
`completion` entries are replaced by generated defaults. Back it up first:

```
cp .cba/repository.json .cba/repository.json.bak
cope init . --quick --force
```

Verified result on 0.1.10:

```
schema_version:     cba-repository-config/2
developer_terminal: {"enabled": true}
policy_id:          cope-project (revision 2)
policy tools.allow: … run_command, terminal_exec, …
```

`--quick` selects the `standard` profile, which is what enables the terminal.
`--inspect`-style setup (`writable_paths: []`) yields `enabled: false`.

Diff the backup against the new file and reapply any custom commands or limits
you needed:

```
diff .cba/repository.json.bak .cba/repository.json
```

`cope init` writes only inside the repository. It does not read, modify, or
create anything in the machine state home.

## Step 2 — check the machine (organization) policy separately

```
cope doctor
```

`Project setup` will now report *"Developer terminal enabled by project config
(managed policy still applies)"*. That wording is deliberate: it confirms step 1
only, and does not assert that the machine layer agrees.

To see the machine layer, inspect the policy directly:

```
# Windows
type "%LOCALAPPDATA%\CopilotBrowserAgent\config\organization-policy.json"
# macOS
cat ~/Library/Application\ Support/CopilotBrowserAgent/config/organization-policy.json
```

Read two fields — `default_decision` and `capabilities.tools`:

| Machine policy shape | Terminal after step 1 |
| --- | --- |
| `default_decision: "allow"`, no `tools.deny` (e.g. `cope-local-user`) | **allowed** — step 1 is sufficient |
| `tools.deny` contains `terminal_exec` (the v1 `DEFAULT_ORGANIZATION_POLICY` shape) | **still blocked at the organization layer** |
| `tools.allow` contains `terminal_exec` (`default-developer-organization`, revision 2) | **allowed** |

An omission from `tools.allow` is not by itself a denial: unmatched tools fall
through to `default_decision`. Only an explicit `deny` entry, or a
`default_decision` of `deny`/`ask`, blocks the tool.

## Step 3 — only if the machine layer blocks it

`cope setup` deliberately **never rewrites an existing valid machine policy**.
It generates one from the developer default only when the file is absent. There
is therefore no in-product migration command for a persisted policy that denies
`terminal_exec`, and this is intentional: silently widening a machine-wide
policy would be an authority escalation.

The supported opt-in is to remove the policy deliberately and let `cope setup`
regenerate it, which requires an explicit human decision:

```
# Back it up first — this is machine-wide authority.
cp organization-policy.json organization-policy.json.bak
rm organization-policy.json
cope setup
```

The regenerated policy is `DEFAULT_DEVELOPER_ORGANIZATION_POLICY` with
`policy_id: "cope-local-user"`, which allows `terminal_exec`.

Do not do this on a machine whose policy is administrator-managed. If the
policy was placed by an organization rather than by a previous `cope setup`,
removing it substitutes local authority for managed authority. Escalate to
whoever owns the policy instead.

### Known UX gap

For a user whose machine policy explicitly denies `terminal_exec`, the only
path forward is manual file deletion outside the product. There is no
`cope policy upgrade`-style command, no diagnostic that names the file and the
offending field, and `cope doctor`'s "managed policy still applies" note does
not tell the user whether their own policy is the blocker. That is a product
gap worth tracking separately; it is not something the capture fix should
paper over.
