# Configuration examples

These files are review templates, not deployable policy decisions.

| File | Intended destination | Required customization |
| --- | --- | --- |
| `organization-policy.json` | `%LOCALAPPDATA%\CopilotBrowserAgent\config\organization-policy.json` | **nondeployable template**: replace policy ID/revision and obtain externally recorded owner/governance approval |
| `repository.node.json` | `<repo>\.cba\repository.json` | **nondeployable edit-policy template**: replace policy ID/revision and all repository facts; review and explicitly grant its side-effecting npm commands for the onboarded repository |
| `browser.edge149.uncertified-template.json` | `%LOCALAPPDATA%\CopilotBrowserAgent\config\browser.json` | every `REPLACE_...` value plus exact tenant URL/hosts and a certified UI contract |

The organization policy is also deliberately nondeployable: placeholder IDs/revisions are not approvals. The strict policy schema has no `owner` field, so record the accountable owner, approvers, evidence, policy ID/revision, and installed-file hash in the governed approval system rather than adding an unknown JSON property.

The browser file is intentionally named `uncertified-template`. It uses reserved `.invalid` Copilot and authentication hosts, and therefore cannot reach a real tenant until they are replaced. The target-machine inventory did not provide the exact Copilot tenant URL, identity string, protection indicator, or selector evidence, and live Windows/Edge verification has not occurred from this development environment.

The dedicated `profile_directory` must be a local, nonshared absolute path outside both every repository and the `%LOCALAPPDATA%\CopilotBrowserAgent` state root. The template uses a sibling local directory for that reason. UNC/device paths and paths whose canonical existing parent redirects into repository or state storage are refused.

JSON contracts are strict and versioned. Unknown fields fail at both top-level and nested command/browser/UI structures. Do not add comments to the JSON; document decisions in the governed policy record and increment `revision` when meaning changes.

`repository.node.json` is a nondeployable edit-policy review template: it proposes writable paths and requires `npm.test`, which is truthfully marked side-effecting. In `edit`/`auto`, its npm commands may run only after the repository facts are replaced and the combined policy/session grant explicitly permits them. The file is nondeployable because those onboarding and approval decisions are repository-specific, not because side-effecting validation is blanket-denied. For the first synthetic inspect smoke test, use the conservative file produced by `copilot-agent init` (empty writable scope, command catalog, and required-validation list), then onboard only reviewed commands.

The Node command examples call:

```text
C:\Program Files\nodejs\node.exe
  C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js run <script>
```

This avoids `.cmd`/`.ps1` shims and shells, which the catalog rejects. Verify actual paths and transitive scripts on the onboarded repository. Mark a validation command `sideEffects: true` if it can create build output, caches, snapshots, or coverage, even when it does not intentionally edit source. It may create ordinary Git-ignored artifacts, which are excluded from the completion source fingerprint. Every command is checked before and after for nested Git plus Git-visible/nonignored, keyed protected, and Git-control drift; `sideEffects: false` additionally inventories ordinary ignored files under fixed bounds. Any disallowed or unverifiable drift becomes `RECOVERY_REQUIRED` and cannot count as trusted validation. Intentional source-mutating commands are unsupported until a future versioned write-scope/checkpoint contract; use `apply_patch` for source changes.

These checks are not an OS filesystem, network, or resource sandbox. The approved executable and its transitive scripts are trusted computing base, and writes outside the repository cannot be comprehensively prevented or observed. Retain endpoint-containment, egress, resource, and command-review requirements as live-pilot/release gates.

Before installation, validate the combined organization/repository/session decision for representative reads, mutations, denials, commands, disclosures, and budgets. Then complete the target and live gates in [`docs/LIVE-PILOT-ACCEPTANCE.md`](../../docs/LIVE-PILOT-ACCEPTANCE.md).
