# Windows target and installation

## Candidate target inventory — not certified

The provided machine map records this intended first target:

| Component | Observed target |
| --- | --- |
| OS | Windows 11 Enterprise, version 10.0.22631, build 22631, x64 |
| Edge | Stable 149.0.4022.98 |
| Edge executable | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` |
| Node.js | 24.17.0 at `C:\Program Files\nodejs\node.exe` |
| npm | 11.13.0 |
| Git | candidate version `2.55.0.windows.3`; inventory conflicts between a machine-wide and a per-user path, so the runtime checks the per-user `%LOCALAPPDATA%\Programs\Git\cmd\git.exe` location, then machine-wide Program Files locations, then controlled `PATH`, and preflight must record the exact approved executable |
| PowerShell | Windows PowerShell available; `pwsh.exe` absent |
| Filesystem | temporary directory, create, rename, case-insensitive lookup, and long filename probes succeeded |

No global Playwright package was found. `playwright-core` is pinned locally and launches only the verified selected Edge or Chrome binary; installation and setup must not download another browser. The recorded Edge tuple remains the established compatibility target. Chrome is a **preview candidate / offline evidence only** until its own exact Windows tuple passes the live matrix.

The inventory also reports no usable Python, .NET, Java, Go, Rust, ripgrep, pnpm, or yarn toolchain. Do not make build, packaging, search, or support procedures depend on them. A Microsoft Store `python.exe` alias is not a Python runtime.

Some inventory probes failed or were inconsistent: CPU/memory/disk collection failed; Git paths differ between sections; `where.exe` did not find `git.exe` even though Git commands worked; security services were reported stopped/manual; exact proxy settings and Edge policy values were intentionally omitted. No exact tuple is certified. Resolve every item, record executable hashes/paths, and complete WIN-01 through WIN-06 before treating this machine as an approved target.

## Install as a standard user

For the current personal-preview release, extract the zip and run `install.cmd` from a non-elevated Windows account. The installer reads the release version from the package manifest, performs `npm ci`, builds and packs that release, installs the global `cope` command, adds the npm global command directory to the user PATH when needed, verifies the packed and installed versions against the manifest, and offers guided setup. Reopen PowerShell after installation, then run `cope`.

The packed global installation is intentional. It does not remain linked to the extracted source folder, so moving or deleting that folder later does not break `cope`. No administrator rights, Windows service, or browser extension is required.

For a governed deployment, the release owner must still verify the artifact, dependency lock, Node, npm, Git, and selected-browser tuple before running the installer. The runtime checks Windows integrity groups and refuses high/system integrity. Use `COPE_NO_PAUSE=1` only for controlled installer automation. The legacy Windows wrapper files and their existing prompt text remain byte-identical for compatibility; their setup action invokes the same browser-neutral `cope setup` workflow.

Manual source verification remains available:

```powershell
npm ci
npm test
```

After installation:

```powershell
cope setup
cope doctor
cope C:\work\sample-repo
```

The first project launch creates or reviews `.cba\repository.json`. Setup creates a separate dedicated local profile for the selected product outside repositories and outside the Cope state root. Run an inspect-only task against a synthetic repository before disclosing real repository content.

## Browser profiles and authentication

The profile is credential-equivalent local state.

- Use exactly one dedicated profile per product and authorized user/environment. Edge and Chrome must never share it.
- Never point at `Default`, an ordinary Edge or Chrome user-data directory, a copied profile, a repository or agent-state directory, a shared drive, or another user's profile. The protected ordinary roots include `%LOCALAPPDATA%\Microsoft\Edge\User Data` and `%LOCALAPPDATA%\Google\Chrome\User Data`.
- Use a conventional local absolute path. UNC, device-namespace, and shared-form paths are refused. The loader resolves an existing directory or its deepest existing parent, including symlinks/junctions, and refuses canonical overlap with repository or state storage.
- Do not start another browser process with that profile. The agent uses a product marker and exclusive lock and fails closed on wrong-product, tampered, unmarked/non-empty, or live-owned profiles.
- Let the user perform sign-in, MFA, Conditional Access, consent, reauthentication, and security interstitials in the visible window.
- Never record passwords, MFA codes, cookies, tokens, storage state, authentication headers, or private network captures.
- Protect the profile with Windows ACLs and include it in incident-response and decommissioning procedures.

The launcher uses a persistent, headful context, disables downloads, and navigates only to the configured HTTPS entry URL. It launches the canonical executable whose requested product identity, version, and SHA-256 were verified; it does not fall back to another Playwright channel. Setup allows up to 15 minutes for manual sign-in, MFA, consent, and tenant SSO. Known Microsoft authentication hosts and external HTTPS URLs without embedded credentials may remain visible during that wait only when their page belongs to the exact setup target/popup chain or was observed at the exact configured Copilot or strict Microsoft-auth waypoint. They are never valid submission hosts.

## Configure the target

Run guided setup:

```powershell
cope setup
cope --inspect C:\work\sample-repo
```

Guided setup detects stable Edge and Chrome installations using a deterministic bounded order, verifies product identity, and asks only when a meaningful choice exists. A current valid configuration remains selected; a sole detected browser is preselected; both browsers produce a keyboard selector defaulting to the current choice or otherwise Edge; none produces retry and advanced manual-path actions. Browser changes require confirmation. The selection and product-specific profile are persisted only after visible manual readiness succeeds. Guided project onboarding creates a repository-specific `.cba\repository.json` and detects bounded npm validation scripts. The files in `config/examples` remain nondeployable governance templates for organizations that need a separately reviewed policy and UI contract.

Windows discovery checks only the corresponding `Program Files (x86)`, `Program Files`, and `%LOCALAPPDATA%` application locations for `Microsoft\Edge\Application\msedge.exe` or `Google\Chrome\Application\chrome.exe`, after an applicable explicit override. Edge's pre-existing machine/user order is unchanged; Chrome candidates are additive. It does not use `PATH` or an unbounded filesystem search for browsers.

For managed automation, `cope setup --browser edge|chrome` is available, and `--browser-executable <path>` may accompany the selected product. Normal users should use plain `cope setup`. `COPE_BROWSER_EXECUTABLE` is the browser-neutral process override; `COPE_EDGE_EXECUTABLE` remains an Edge-only compatibility alias. Overrides still undergo the same identity checks.

For a personal-preview launch, `cope setup` writes a usable local configuration from the Copilot URL and visible account identity you provide. It does not copy the nondeployable `.invalid` template. The baseline semantic UI contract is still verified at runtime and fails closed when the page no longer matches.

For a governed deployment, separately record approval for:

- the exact Copilot Chat work URL and every redirect/final hostname;
- the exact visible work-account identity string or tenant-approved matching pattern;
- the expected enterprise protection indicator and locator evidence;
- the selected product, dedicated profile path, executable identity/version/hash, and support status;
- every semantic locator candidate and completion signal;
- acceptable response/action/manual-authentication timeouts; and
- tenant terms, licensing, repository classification, and automation authorization.

The target map intentionally omitted tenant-specific URL, identity, and protection evidence. Guided setup removes the manual JSON-editing burden for personal use, but it is not a substitute for organizational certification.

## npm commands without command shims

Interactive setup may use PowerShell/npm normally. Model-callable commands are different: the process runner uses `shell: false` and the command catalog rejects shells plus `.cmd`, `.bat`, and `.ps1` executable paths.

Use:

```text
executable:      C:\Program Files\nodejs\node.exe
fixedArguments: C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js, run, <script>
```

Do not catalog `npm.cmd`, `npm.ps1`, `cmd.exe /c`, `powershell.exe -Command`, or a repository-created wrapper. Verify the `npm-cli.js` path after Node/npm servicing.

The direct executable form removes shell/shim ambiguity but does not authorize source mutation. Commands that can create build output, caches, snapshots, coverage, or generated files must remain `sideEffects: true`; in `edit`/`auto`, explicitly granted definitions may run and may create ordinary Git-ignored artifacts. Do not relabel them as side-effect-free: every command is checked before and after for nested Git plus Git-visible/nonignored, keyed protected, and Git-control drift, while `sideEffects: false` additionally inventories ordinary ignored files under fixed bounds. Tracked/nonignored, protected, control, nested, or unverifiable drift enters `RECOVERY_REQUIRED` and cannot be trusted as validation. Intentional source or lockfile mutation by a command is unsupported until a future versioned write-scope/checkpoint contract; use `apply_patch` for those changes.

The command boundary is not an OS filesystem, network, or resource sandbox. Approved executables and transitive scripts are trusted computing base, and the runtime cannot comprehensively prevent or observe external writes. The live-pilot target remains NO-GO until the endpoint owner approves the exact command/script inventory and supplies or explicitly accepts the required application-control, egress, filesystem, and resource containment.

## Preflight behavior

For all transports, preflight requires Node 24+, a working Git executable, a Git working tree, no index gitlinks, and no descendant `.git` file/directory. On Windows, Git resolution checks `%LOCALAPPDATA%\Programs\Git\cmd\git.exe`, then the machine-wide Program Files locations, then `git` on the controlled `PATH`; the selected executable is reused consistently by runtime and test helpers. For a live browser it additionally requires Windows, the verified configured Edge or Chrome executable, its recorded version, and a verified non-elevated token. The legacy Edge discovery order is frozen; Chrome candidates are additive and bounded to approved machine-wide and user-local locations. The Git-boundary invariant is also checked as repository tools are composed and on relevant path/completion access. Minimal environment values are inherited for probes and child commands.

Preflight is necessary but not a compatibility certificate. Browser configuration loading and launch require an exact `Program Files`/`LOCALAPPDATA` Stable location and verify product-specific Windows version metadata, expected company/product/original filename, Authenticode signer, canonical path/stat identity, version, and SHA-256. That rejects known prerelease/portable/lookalike locations, a mismatched supported product, and unsupported Chromium derivatives. It is not independent channel attestation and cannot defeat privileged replacement by another vendor-signed binary; exact binary/channel approval remains part of tuple certification. It also does not prove tenant authorization, locator correctness, future update identity, endpoint integrity, repository eligibility, egress containment, antivirus/EDR status, sufficient disk/RAM, or live Copilot protocol adherence.

## Upgrade and recertification

Re-run offline and product-specific live gates after any change to Edge/Chrome, Copilot UI, Node/npm, Git, Windows policy, Conditional Access, browser configuration, UI contract, protocol, command catalog, dependencies, or security controls. Pin the tested compatibility tuple rather than claiming compatibility with all future versions. Chrome certification cannot be inferred from Edge's Chromium lineage.

If the selected browser or Copilot changes unexpectedly, disable live transport, preserve metadata, avoid source-bearing diagnostics by default, and use fixture/replay or manual fallback until a new UI contract is certified.

## Uninstall and decommission

1. Abort active sessions and confirm child processes/browser context are closed.
2. Retain or export approved non-source audit evidence per records policy.
3. Remove source-bearing session artifacts using the approved secure-deletion process.
4. Remove the dedicated profile as credential-equivalent data; revoke relevant sessions if incident policy requires.
5. Remove local configuration and package files.
6. Remove or archive repository `.cba` configuration according to the repository owner's decision.
7. Record decommissioning, unresolved sessions, and any retained checkpoints.

Ordinary filesystem deletion is not guaranteed secure erasure on SSDs. Follow the organization's endpoint and encryption policy.
