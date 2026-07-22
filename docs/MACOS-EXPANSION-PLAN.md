# macOS expansion implementation plan

Status: finalized and implemented through the offline Phase 5 gate; owner-machine Phase 6 approval/certification remains pending. Code completion does not certify any live tuple.

> Historical scope note (2026-07-19): this plan records the original Edge-only macOS expansion and its frozen evidence. The browser-product expansion in `ARCHITECTURE.md`, `MACOS-TARGET.md`, and `LIVE-PILOT-ACCEPTANCE.md` supersedes its “never discover Chrome” implementation constraint. Edge evidence in this historical plan does not certify Chrome; Chrome remains a preview candidate/offline-evidence-only lane with separate gates.

Governing documents: `PROTOCOL.md` and `THREAT-MODEL.md` take precedence, followed by the MAC-### requirements in the macOS expansion PRD. The Windows target remains the blocking release target. macOS remains an exact-tuple experimental home-test preview.

## Skeptical review of the draft plan

The draft had the right overall direction, but it was not safe to execute unchanged:

1. **Preflight ordering violated MAC-003.** The current CLI creates the state root, workspace lock, session record, and audit record before machine preflight. A Darwin root process would therefore leave session state before being refused. Host eligibility must run before state/config writes, locks, or session persistence.
2. **The filesystem call-site list was incomplete.** The four PRD examples are not the complete security/mutation surface. Git status and hidden-state keys, repository ignore/filter matching, snapshot diff filtering, checkpoint repository identity, completion comparison, tool-host comparison, and nested `.git` detection also use platform-derived case behavior. Phase 2 is a repository-wide audit, not four substitutions.
3. **The probe boundary was underspecified.** Case and Unicode behavior must be detected on each relevant volume. A temporary-directory probe does not establish repository-volume behavior. Probes must execute at a writable directory on the actual repository/state/profile volume, clean up in `finally`, and fail closed when behavior cannot be established.
4. **GUI eligibility needs a defined signal.** “Usable GUI session” cannot mean merely `process.platform === "darwin"`. Darwin preflight will require a non-root effective UID, an active console user matching that UID, and an addressable per-user launchd GUI domain. The actual visible Edge launch remains the final proof; no headless fallback is permitted.
5. **Permission verification was too narrow.** Requesting `0700`/`0600` at creation does not fix or identify pre-existing broad permissions. Darwin startup must use `lstat`, refuse links, verify owner UID and exact private mode across the state tree and on the dedicated profile root/Cope marker/lock, and bound traversal. Edge-managed profile descendants follow Edge's own layout and are not subject to a false exact-mode promise. Root refusal happens before this check.
6. **CI cannot certify the owner’s machines.** Hosted `darwin arm64` and `darwin x64` jobs are useful offline lanes, but they are not evidence for the two exact home tuples or for SSH-to-Aqua behavior. The matrix and the owner-machine acceptance record remain separate.
7. **The baseline was not runnable on the current shell.** System Node is `22.16.0` and npm is `10.9.2`; the baseline suite fails four tests at the Node 24 preflight. Verification will use the bundled Node `24.14.0` runtime without modifying the machine. Installer smoke testing still requires owner-approved Node/npm upgrades.
8. **The baseline was not immutable.** The repository has no commit and every project file is untracked. Before refactoring, a source-only archive was created in durable Codex storage and named by its SHA-256. It excludes `.git`, agent worktrees, `dist`, and `node_modules`. A real owner-approved initial commit/tag remains a hard prerequisite for parallel writers, branching, release work, or rollback from Git; this single-writer pass uses the content-addressed archive as the PRD's allowed equivalent immutable snapshot.
9. **Operational gates were mixed with code work.** Installing Edge, signing in, modifying the two Macs, exercising the Windows tuple, and issuing a release decision require owner action or access. They are explicit post-implementation gates and cannot be reported as passed by code/tests alone.

## Baseline evidence

- Source-only workspace snapshot: `/Users/ronakchak/.codex/baselines/copilot-browser-agent/source-baseline-d1c39e49c929969c079270f1d711daf78512929612d4084a553306f5a8a2ce4b.tar`
- Snapshot SHA-256: `d1c39e49c929969c079270f1d711daf78512929612d4084a553306f5a8a2ce4b`
- Snapshot scope: 160 source/config/test/doc/install files; excludes `.git`, `.agents`, `.claude`, `.codex`, worktrees, `dist`, and `node_modules`; stored read-only (`0444`).
- `package-lock.json` SHA-256: `f3e928ad783dd4a30312524298cf56daba70826393341fbfee34f35b43f7200f`
- Baseline Windows wrapper SHA-256 values (historical 0.1.1 snapshot; not current release hashes):
  - `scripts/install-windows.ps1`: `8f00cb314fea2be37f19db667c3e78ccd975a6cdb612ddd063b1119d3fb354e6`
  - `scripts/uninstall-windows.ps1`: `16b6d9eafb74ac06a2900d9f31f98018e49ec25b78742019b5ad830fb1796a50`
  - `install.cmd`: `8d56b5ac60e1f4365993927d1bc5d40ac11963208c7588954888fc3b62ce474c`
  - `install-cope.cmd`: `3ab30bf64882799b88f9e95883be507b7be325072d2a66f701a44b79f2a14794`
  - `uninstall.cmd`: `79af0b5fbb73ef97274737f367b456006f3dff9b33785a76698ee3620bb5abbb`
  - `uninstall-cope.cmd`: `28ef4abdc66216ea2ddb02f730e084f21179d7842a42a391ceb60d6468d02fdc`
- Current release-preservation hashes are authoritative only in `tests/unit/windows-preservation.test.ts`; update them solely for an audited wrapper change. Release version bumps do not alter the Windows installer now that it derives its banner, packed-artifact expectation, and installed CLI expectation from package metadata.
- Baseline build: passes under system Node 22.
- Baseline test: 181 passed, 4 failed; every failure is the expected Node 24 floor in preflight/E2E.
- Verification runtime: bundled Node 24.14.0, used by prepending its directory to `PATH`; no system runtime is installed or changed.
- Frozen candidate Windows-characterization digests:
  - `tests/unit/platform-host.test.ts`: `762fe12dd0ed8da221eb33cb69a2600d7e9a3a081c192d303f2a125ccb2e845b`
  - `tests/unit/platform-preflight.test.ts`: `42c7530eaeaab2e330690200ecec37e78bf6b08c559fbfe45568865bec37adc7`
  - `tests/unit/windows-characterization.test.ts`: `1afd569831da60b1f8a3239ff5f4b8e01862247b5566856ec04cc1b7d58d5f19`
  - `tests/unit/windows-preservation.test.ts`: `5774d1ea5e2a3d0936afa4f92f80069c0de3988345fdd478088c39385c12b52b`

Historical evidence limitation: the immutable archive predates the injectable host-adapter seams, so the new adapter tests cannot execute byte-identically against the archived modules without changing that baseline. The archive, original-suite result, recorded source behavior, wrapper hashes, and candidate characterization tests are the strongest truthful retrospective evidence. Treating that equivalent as sufficient MAC-050 release evidence requires owner approval; the same-test/pre-refactor chronology is not fabricated or represented as passed.

## Support contract and invariants

| Tier | Tuple | Evidence role | Release effect |
| --- | --- | --- | --- |
| Primary | Windows 11 Enterprise 22631 x64, recorded Edge/Node/npm/Git candidate | Windows semantics, packaging, performance, live release gate | Blocks release |
| Preview | Mac14,2, macOS 26.4.1 arm64 | development and home-test preview | Blocks only this preview label |
| Preview | MacBookPro16,3, macOS 15.7.7 x64 | server/Aqua/SSH operating envelope | Blocks only this preview label |

The implementation does not change `cba/1` wire/schema/transport meaning, model transport contracts, browser polling, response capture, the agent loop, or manual-authentication behavior. It does add a host-neutral path-key injection point to protocol semantic validation so filesystem-identity deduplication follows the probed volume. Edge Stable remains the only live browser. Linux remains offline-only. All uncertainty fails closed.

## Phase 0 — Characterize and freeze current behavior

Outcome: preserve Windows-observable behavior before replacing inline platform decisions.

Implementation:

- Add and freeze dedicated MAC-050 characterization tests for Windows Edge discovery order, elevation refusal/integrity labels, controlled probe environment and `windowsHide`, Git discovery order, Windows state root, `taskkill.exe` tree termination selection, atomic-write directory-fsync skip, protected-path case matching, patch-dedupe case keys, profile-overlap case keys, and completion path keys.
- Make tests injectable so Windows semantics can be asserted on a non-Windows development host without pretending to execute Windows itself.
- Record the Windows wrapper hashes above and assert all six remain unchanged during this implementation.
- Do not change `cba/1` wire/schema/transport meaning or browser hot-path behavior. A minimal host-neutral path-key injection into protocol semantic deduplication is allowed and implemented.

Intended freeze criterion was to add minimal seams, run byte-identical characterization tests on baseline and candidate, freeze their digests, and rerun them at every gate. The repository's untracked/no-seam starting state made that literal sequence unavailable without changing the baseline being measured.

Actual retrospective disposition:

1. The source-only archive was created before host refactoring and remains immutable/read-only.
2. The original baseline suite result and dependency lock were recorded under the same available runtime constraints.
3. Candidate-only injectable characterization tests now cover the enumerated Windows facts, including exact `taskkill.exe` selection and no offline-Windows warning, and their final digests are frozen above.
4. Windows wrappers are byte-identical and candidate characterization/full-suite results are green.
5. The missing byte-identical baseline/candidate characterization run remains an explicit MAC-050 evidence deviation. Owner approval is required to accept the archive/original-suite/source record as equivalent; actual Windows execution and A/B evidence remain Phase 6 gates.

Verification status: candidate characterization passes; literal same-test baseline evidence is **PENDING owner equivalence approval**, not represented as passed.

## Phase 1 — Host-capabilities contract and early eligibility

Outcome: one selected host object owns capability decisions; Darwin becomes an eligible live host only after strict checks.

Files/modules:

- `src/platform/contracts.ts`
- `src/platform/windows.ts`
- `src/platform/darwin.ts`
- `src/platform/unsupported.ts`
- `src/platform/index.ts`
- `src/preflight/machine.ts`
- `src/session/paths.ts`
- `src/cli/commands.ts`
- `src/cli/onboarding.ts`
- `src/cli/doctor.ts`
- `src/tools/process-runner.ts`

Contract responsibilities:

- OS/architecture identity and macOS 14+ validation.
- Live-browser eligibility.
- Windows integrity check versus Darwin effective-UID/root refusal.
- Darwin GUI check: active console owner and `gui/<uid>` launchd domain.
- Controlled probe environment and spawn flags.
- Git and Edge discovery candidates in the exact preserved Windows order and Darwin system/user application order.
- Platform state/profile defaults.
- Windows `taskkill.exe` versus POSIX process-group SIGTERM/SIGKILL escalation.
- POSIX mode and directory-fsync capabilities.

Ordering:

1. Select/inject the host once at CLI composition.
2. Refuse Darwin UID 0 before every write-capable entrypoint: interactive (before preferences or standalone-file sync), setup/onboarding, init, new session, resume, pause/abort control writes, rollback, review export, installer, and uninstall. `doctor` may report the failure read-only; help/version/demo remain source-free. Linux offline behavior is unchanged.
3. Run OS/live-host eligibility before any state root, lock, session, audit, profile, or browser configuration write.
4. Resolve and verify private state storage.
5. Run repository/Git/Edge checks.
6. Only then create durable session state.

Approved `process.platform` exceptions after this phase are exactly `src/cli/demo.ts` (printing the observed platform label) and `src/cli/presentation.ts` (ASCII versus Unicode terminal glyph selection). Neither changes host capabilities or security behavior. Every runtime capability decision routes through `src/platform/`; there are no test-fixture exceptions in `src/`.

Verification: new `platform-host.test.ts` and `platform-preflight.test.ts`; existing Windows characterization tests unchanged; Linux live transport still returns `TRANSPORT_UNAVAILABLE`; Darwin root returns a distinct diagnostic before state creation.

## Phase 2 — Per-volume filesystem identity

Outcome: all security- and mutation-relevant path equivalence uses actual filesystem behavior.

Files/modules:

- `src/shared/filesystem-identity.ts`
- `src/repository/context.ts`
- `src/repository/boundary.ts`
- `src/repository/patch-engine.ts`
- `src/repository/git.ts`
- `src/repository/ignore.ts`
- `src/repository/repository-tools.ts`
- `src/repository/snapshot-diff.ts`
- `src/repository/checkpoint.ts`
- `src/security/protected-paths.ts`
- `src/browser/profile-lock.ts`
- completion comparisons in `src/cli/runtime-composition.ts`, `src/orchestrator/completion.ts`, and `src/tools/tool-host.ts`

Design:

- Detect case aliasing and NFC/NFD aliasing with bounded, randomized, create-exclusive probes on the relevant volume.
- Probe repository, state, and profile volumes independently; reuse a result only when device identity proves the same volume.
- Reject mount/device transitions beneath each controlled root during boundary traversal and before mutation/read/profile/state access. This effort does not attempt mixed-semantics keys within one logical root. A repository, state tree, or dedicated profile that crosses to another device fails closed with a stable diagnostic. Missing leaves inherit only the identity of their deepest existing ancestor after its device is verified.
- Clean every probe artifact in `finally`; an inconclusive probe is an error, not a platform guess.
- Expose canonical absolute and repository-relative key functions plus normalized glob matching behavior.
- Resolve existing ancestors before overlap checks so `/tmp` and `/private/tmp` aliases converge.
- Inject repository identity into repository/security/checkpoint/completion services. Do not branch inside hashing or tool dispatch.

Audit rule: after conversion, search every `toLowerCase`, `nocase`, `path.relative`, and path-key helper for security/mutation relevance. Presentation and protocol string normalization are out of scope.

Verification: new `filesystem-identity.test.ts` covers simulated case-sensitive, case-insensitive, normalizing, and non-normalizing capabilities; live-volume tests cover the checked-out APFS behavior; patch/protected/profile/completion tests cover case and Unicode aliases plus symlinked ancestors.

## Phase 3 — Darwin state, profile, process, CLI, and doctor safety

Outcome: the preview is locally operable without weakening Windows or browser security.

Implementation:

- Default Darwin state root to `~/Library/Application Support/CopilotBrowserAgent`.
- Keep the dedicated profile outside the repository, state root, and ordinary Microsoft Edge profile. Use `~/Library/Application Support/CopilotBrowserAgentEdgeProfile` by default.
- Verify the Darwin state tree with bounded `lstat` traversal: correct UID, no links/device transitions, directory mode `0700`, and file mode `0600`. Refuse broad or unverifiable state.
- Treat the Edge profile differently from state: verify the dedicated profile root/lock/marker ownership and private modes before launch, refuse links/device transitions, and rely on the user-private application-support parent plus Edge's own descendant layout. Do not require every Edge-managed descendant to have an exact `0600` mode, which Edge does not promise.
- Preserve lock/marker exclusivity. Verify the profile root again immediately before browser launch.
- Route command execution on POSIX through a small internal parent-death supervisor that is the detached process-group leader. The harness passes its expected PID; the supervisor immediately compares `ppid`, begins monitoring before accepting a command, and emits an `ARMED` handshake. Only then does the harness send the fixed executable/argument payload over a private pipe. The supervisor rechecks the expected parent immediately before spawning without a shell, emits `STARTED`, forwards bounded stdio, and kills its own process group if the parent identity changes or the harness is SIGKILLed. The runner does not return control until `STARTED`. Normal cancellation sends SIGTERM, polls, then SIGKILL. Windows retains direct spawn plus `taskkill.exe /pid <pid> /T /F`.
- Add crash-before-`ARMED`, between `ARMED` and payload, immediately before spawn, between spawn and `STARTED`, crash-during-cancel, and ordinary abort tests. Each spawns child and grandchild processes and proves no survivor remains. Because the supervisor binds the expected parent before accepting work and observes kernel reparenting rather than a reusable persisted target PID, PID reuse cannot make it target an unrelated group.
- Add Darwin Edge discovery and manual-path prompt text; never discover Chrome.
- Make setup/doctor/preflight diagnostics report Node 24+, npm 11+ for installation, Edge, GUI, root, state permissions, and repository volume semantics.
- Keep offline transports usable on supported Node/Git even when Edge is absent.

Verification: `platform-darwin.test.ts`, `private-storage.test.ts`, `process-tree-darwin.test.ts`, `cli-macos.test.ts`; an instrumented browser-launch test proves the only user-data directory passed to Playwright is the dedicated path. Phase 6 adds an owner-approved filesystem-I/O observer (for example, macOS `fs_usage`/DTrace run separately with only the necessary observation privilege while Cope and Edge remain non-root). It traces the harness and launched Edge process tree, filters only access events whose path is under ordinary `~/Library/Application Support/Microsoft Edge`, and retains source-free counts/path hashes rather than content. Zero ordinary-profile read/write events is required. A separate before/after metadata digest remains mutation evidence; its own observer reads are excluded by PID and time window.

## Phase 4 — Packaging, CI, and documentation

Outcome: reversible user-level macOS packaging plus accurate preview documentation.

Implementation:

- Add `scripts/install-macos.sh`: Darwin/non-root check; Node >=24 and npm >=11; `npm ci`; build; `npm pack`; no browser download. Install with `npm install --global --prefix` into the deterministic user-owned prefix `${COPE_INSTALL_PREFIX:-$HOME/.local}`. Validate the resolved prefix and existing ancestors are local, non-links, owned by the current UID, and writable; create new prefix directories as the user. Verify the exact `$prefix/bin/cope --version`; for the default prefix, safely configure `~/.zprofile` when PATH needs it, with an explicit `--no-path-update` opt-out. Custom prefixes receive exact manual guidance. Optional setup runs only after verification. The build lifecycle must restore executable mode on the generated CLI so a development link cannot be broken by a rebuild.
- Add `scripts/uninstall-macos.sh`: require Darwin and non-root execution, validate the same deterministic prefix, and run `npm uninstall --global --prefix`; retain state/profile by default; remove only the exact Darwin state/profile roots with explicit separate flags after non-link/ownership validation. No step uses `sudo` or the machine npm prefix.
- Keep every existing Windows installer/wrapper byte-identical.
- Add GitHub Actions offline lanes for Windows x64, Darwin arm64, and Darwin x64. As of this plan, the current official hosted labels are `windows-2025`, `macos-26`, and `macos-15-intel`; workflow comments must state that hosted lanes are not owner-tuple certification.
- Add `MACOS-TARGET.md`; update README, LIMITATIONS, LIVE-PILOT-ACCEPTANCE, ARCHITECTURE, THREAT-MODEL, POLICY-AND-CONFIGURATION, RECOVERY-AND-AUDIT, and REQUIREMENTS-TRACEABILITY.
- Every macOS support statement must be exact-tuple and preview-labeled.

Verification: shell syntax checks, package-content inspection, a temporary clean-home test with a user-owned prefix and constrained PATH, exact version assertion, uninstall/reinstall smoke, docs claim grep, workflow syntax inspection, full `npm run check` under Node 24.

## Phase 5 — Integrated offline release-candidate verification

Outcome: one candidate artifact with evidence, without making a live-support claim.

Checks:

- Clean build and complete offline suite under Node 24.
- Protocol/adversarial, policy, disclosure, checkpoint/rollback, audit/recovery, and browser synthetic suites.
- Repository case/Unicode alias corpus and profile overlap corpus.
- Process child/grandchild cancellation.
- `npm pack` content review.
- All six Windows installer/wrapper digests match Phase 0.
- `rg 'process\.platform' src` matches only the documented non-capability exception list.

Shared security failures block the candidate. Platform-only failures block the affected preview label, but no code result can override the Windows release gate.

## Phase 6 — Owner-machine and release gates (not automatable in this checkout)

These gates remain open until executed on the actual machines with owner approval:

1. Install Node 24+/npm 11+ on the M2 and Edge Stable on both Macs.
2. Create dedicated disposable profiles; complete sign-in/MFA/consent manually.
3. Run three consecutive synthetic live sessions on each Mac, including crash/send recovery and child-tree abort. With explicit owner approval, run a separate filesystem-I/O observer with only the privilege needed to trace the non-root Cope/Edge process tree. Zero reads or writes beneath the ordinary Microsoft Edge profile is required; retain only source-free event counts/path hashes. Also capture a before/after metadata canary for mutation evidence. Any harness-attributable ordinary-profile access blocks the preview.
4. Prove Intel SSH-originated visible launch with logged-in Aqua and sleeping display; prove logged-out failure. Add a LaunchAgent only if direct launch is unreliable.
5. Refresh Windows hardware, executable hashes/paths, endpoint, proxy, policy, and storage evidence.
6. Run the predeclared same-machine Windows baseline/candidate A/B gate: <=5% median and <=10% p95 regression for local operations; report browser/service latency separately.
7. Verify install/update/uninstall and complete the live-pilot approval record. Real repository content remains NO-GO until that separate record is approved.

## Offline implementation record — 2026-07-18

Phases 1-5 code and offline tests are implemented in this checkout. Phase 0 preservation controls are implemented, but its literal same-test historical MAC-050 evidence remains pending owner equivalence approval as stated above. Current local evidence:

- `npm run check` passes under the bundled Node `24.14.0`: **222 tests passed, 0 failed**.
- The focused executable macOS packaging suite passes 4/4, including a stubbed clean HOME whose path contains spaces, dynamic package-version verification before setup, uninstall, and reinstall.
- Shell syntax, workflow YAML parsing, `git diff --check`, and `npm pack --dry-run` inspection pass. The packed manifest contains the compiled CLI and macOS target documentation and excludes `src/` and `tests/`.
- The source scan outside `src/platform/` contains only the two approved non-capability `process.platform` files named in Phase 1.
- All six Windows installer/wrapper digests and the package-lock digest still match the Phase 0 record.
- Independent read-only stage reviewers gave green lights to the plan, host layer, filesystem identity (including persisted approval keys), runtime/process/profile safety, and packaging/CI/documentation.

This local record is not a clean npm 11 installer run or a hosted CI result. The current machine exposes npm `10.9.2`, below the required installer floor, and Edge is absent. Installing/upgrading those prerequisites, running the owner Macs, running Windows A/B, and creating an immutable signed/reviewed candidate require owner-approved Phase 6 work. None is represented as passed here.

## Definition of implementation-complete

Implementation is complete when Phases 0-5 are green, the independent whole-system reviewer gives an explicit green light, and all Phase 6 items are clearly marked pending rather than implied to have passed. Release/certification is complete only after Phase 6 and owner approval.
