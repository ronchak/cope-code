# macOS target: experimental home-test preview

## Disposition

macOS is an **experimental home-test preview**, not a certified or production-support claim. Passing hosted or local offline tests does not authorize live Copilot use or real-repository disclosure. Only the two exact owner tuples below may eventually receive their own preview label, and only after the owner-approved live gates in [LIVE-PILOT-ACCEPTANCE.md](LIVE-PILOT-ACCEPTANCE.md) pass.

The code uses the same artifact, `ModelTransport`, browser adapter, `cba/1` protocol, policy, repository boundary, and recovery model as Windows. There is no macOS fork.

## Compatibility matrix

| Tier | Exact candidate tuple | Role | Evidence date/status |
| --- | --- | --- | --- |
| Primary | Windows 11 Enterprise `10.0.22631` x64; Edge `149.0.4022.98`; Node `24.17.0`; npm `11.13.0` | Blocking release/no-regression target | Candidate inventory recorded 2026-07-18; live certification pending |
| Preview | MacBook Air `Mac14,2`, M2 arm64, macOS `26.4.1` (`25E253`), case-insensitive APFS, FileVault on | Development/compatibility | Candidate inventory recorded 2026-07-18; offline implementation evidence only; preview label not yet earned |
| Preview | MacBook Pro `MacBookPro16,3`, Intel x64, macOS `15.7.7` (`24G720`), case-insensitive APFS, logged-in Aqua session | Server operating envelope | Candidate inventory recorded 2026-07-18; offline implementation evidence only; preview label not yet earned |

The general implementation floor is macOS 14, but that floor is not a generic compatibility promise. A new model, architecture, OS build, Edge/Chrome build, filesystem format, tenant/UI contract, or operating envelope requires its own evidence. Edge remains the established compatibility target. Chrome is a **preview candidate / offline evidence only** and requires browser-specific live evidence even on a tuple that has Edge evidence.

## Candidate prerequisites

- Node.js 24 or newer and npm 11 or newer.
- Git available through the controlled probe environment.
- Microsoft Edge Stable or Google Chrome Stable installed at one of the deterministic candidates below, or chosen explicitly during advanced setup. Discovery does not scan the filesystem.

```text
/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge
~/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```
- A non-root process owned by the intended console user.
- A real logged-in Aqua session for a live browser. An SSH-originated shell is acceptable only when the current UID owns `/dev/console` and `launchctl print gui/<uid>` succeeds. Display sleep is not itself a failure; logged-out/no-WindowServer operation is.
- Written browser/data-owner approval and a synthetic-only live test scope until the global acceptance decision changes.

At inventory time, the M2 had Node `22.16.0`/npm `10.9.2`, and neither Mac had an approved Edge tuple. Installing or changing those prerequisites requires explicit owner approval and is not performed by this repository.

## Preflight and fail-closed behavior

Before state, locks, sessions, audit, profile, or browser launch, the runtime verifies the Node floor, effective UID, macOS version, architecture, and—when live—the Aqua session. Machine preflight then verifies Git, the canonical repository/nested-Git boundary, and the selected browser executable before durable session writes.

Root, malformed version/UID evidence, unsupported architecture, missing GUI ownership, missing selected browser, unsafe state/profile permissions, links, device transitions, product mismatch, or unverified filesystem identity are stop conditions. Cope never substitutes headless operation or a different browser product.

`cope doctor` reports Node/npm floors, Git, selected product/version/support status, executable identity, configuration, host/GUI eligibility, product marker/profile privacy, and the repository volume's observed case/Unicode behavior. Human output hides exact paths by default; JSON provides the technical evidence.

## State and dedicated profile

```text
State/config/sessions    ~/Library/Application Support/CopilotBrowserAgent
Dedicated Edge profile  ~/Library/Application Support/CopilotBrowserAgentEdgeProfile
Dedicated Chrome profile ~/Library/Application Support/CopilotBrowserAgentChromeProfile
Ordinary Edge profile    ~/Library/Application Support/Microsoft Edge  (never a Cope profile)
Ordinary Chrome profile  ~/Library/Application Support/Google/Chrome  (never a Cope profile)
```

The state root is boundedly traversed with `lstat` on startup. It must be owned by the current UID, contain no links or device transitions, and use exact `0700` directories/`0600` files. Each dedicated profile root is exact `0700`; the Cope marker and lock are exact `0600`. Browser-managed descendants must remain user-owned, link-free, and on the same device, but retain the browser's own modes. Markers bind the root to exactly one product; cross-product use, tampering, and non-empty unmarked roots fail closed. The persistent launch receives only the selected product's dedicated path as its user-data directory.

Filesystem case sensitivity and NFC/NFD alias behavior are probed on each relevant volume. Security, ignore, checkpoint, Git, snapshot, completion, overlap, and mutation-deduplication keys use those observed semantics.

## Install and update

From a reviewed source/release checkout:

```sh
./scripts/install-macos.sh --skip-setup
```

The wrapper refuses non-Darwin/root execution, requires Node 24+/npm 11+, performs `npm ci`, build, pack, and a packed user-level install under `${COPE_INSTALL_PREFIX:-$HOME/.local}`, and verifies the exact installed `cope --version`. It does not use `sudo`, the machine npm prefix, browser selection, or browser downloads. It validates that the prefix stays under the real user home, has no linked/non-user-owned components, remains on the home filesystem, and is writable. With the default prefix, it safely adds `~/.local/bin` to `~/.zprofile` when needed; `--no-path-update` disables that behavior. Open a new Terminal window, then run `cope setup` for guided detection, product selection, dedicated-profile creation, and manual authentication. Custom prefixes receive exact manual PATH guidance.

Updates rerun the same reviewed installer against the new candidate; they are not an automatic live recertification.

## Live preview acceptance

Each OS/architecture/browser/Node/npm/Git tuple must independently complete at least three consecutive synthetic live sessions, including executable identity, installation/setup, manual authentication and Conditional Access, UI-contract readiness, correlated send/response, patch/checkpoint/rollback, forced send recovery without duplication, abort/crash process-tree cleanup, and uninstall/reinstall. An owner-approved observer must show zero Cope/launched-browser process-tree reads or writes beneath that product's ordinary profile while excluding observer self-access. Chrome evidence cannot be inferred from Edge. Windows preservation and A/B gates remain blocking for the shared artifact.

Until those records exist, the tuple status stays “preview candidate / offline evidence only.” Real repository content remains NO-GO.

## Recertification triggers

Repeat the affected tuple's offline, browser-contract, profile-isolation, crash/recovery, and synthetic live gates after any change to:

- macOS build, hardware architecture/model, filesystem format/case/normalization behavior, or FileVault/endpoint posture;
- Edge or Chrome, Playwright, Node, npm, Git, dependency lock, installer, platform layer, process supervisor, browser classifier/UI contract, policy/protocol, state/profile layout, or tenant identity/protection signals;
- SSH/Aqua/LaunchAgent operating envelope; or
- ordinary/dedicated Edge or Chrome profile configuration.

## Uninstall and decommission

```sh
./scripts/uninstall-macos.sh
./scripts/uninstall-macos.sh --remove-state --remove-profile
```

Default uninstall removes only the package from the validated user prefix and retains state/profiles for recovery. The explicit flags remove only the exact default state and both product-specific dedicated-profile roots after local, non-link, ownership validation. Those removals are recursive and not recoverable by the script. Before decommissioning, follow retention, incident, Keychain, backup/eDiscovery, audit, and evidence requirements; never delete an ordinary Edge or Chrome profile.
