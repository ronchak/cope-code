# Live-pilot acceptance matrix

## Current decision: NO-GO for real repository content

As of 2026-07-19, the supplied machine map and project inputs do not include the tenant-specific Copilot URL, organizational identity, protection indicator, UI certification evidence, applicable-terms approval, repository/data-owner approval, or an approved live run on any exact tuple. Edge remains the established compatibility target with live evidence pending. Chrome is a **preview candidate / offline evidence only** and has no transferred certification from Edge. The macOS implementation is also an experimental home-test preview candidate with offline evidence only; it is not certified.

Offline implementation and tests are prerequisites, not substitutes for these gates. Change the decision only through the accountable governance/release process and attach evidence; do not edit a local copy merely to make the CLI run.

Mutable local development runs are not release evidence. OFF-01 remains pending until a clean lockfile install, build, and complete test run are bound to an immutable candidate revision and reviewed record.

Status vocabulary:

- `PASS`: evidence reviewed and approved for the exact candidate tuple.
- `FAIL`: test/control did not meet its threshold.
- `PENDING`: required evidence not yet reviewed.
- `N/A`: approved owner documents why the gate cannot apply; release owner accepts that rationale.

Any `FAIL` or `PENDING` P0 row is a no-go.

## Candidate identity

| Field | Required recorded value | Current value |
| --- | --- | --- |
| Release/source revision | immutable commit/build identifier | PENDING |
| Package lock digest and dependency inventory/SBOM | approved artifact references | PENDING |
| Windows/Edge/Node/npm/Git tuple | exact versions and executable hashes/paths | candidate Windows/Edge/Node/npm values known; Git `2.55.0.windows.3` reported with conflicting Program Files/per-user paths and failed `where.exe`; exact path and all hashes PENDING |
| Windows/Chrome/Node/npm/Git tuple | exact OS/architecture, Chrome version/signature/path/hash, Node/npm/Git versions/paths/hashes | PENDING; no live Chrome tuple may be inferred from the Edge row |
| macOS arm64 preview tuple | MacBook Air `Mac14,2`, macOS `26.4.1` (`25E253`), Edge/Node/npm/Git paths/hashes | machine/OS/APFS inventory known; Node/npm upgrade, Edge installation, hashes, and owner-approved live evidence PENDING |
| macOS x64 preview tuple | MacBook Pro `MacBookPro16,3`, macOS `15.7.7` (`24G720`), Edge/Node/npm/Git paths/hashes and Aqua/SSH envelope | machine/OS/APFS/Aqua inventory known; Edge, hashes, SSH launch evidence, and owner-approved live evidence PENDING |
| macOS Chrome preview tuple(s) | exact machine/OS/architecture/Chrome/Node/npm/Git and Aqua envelope | PENDING separately for every proposed Chrome tuple |
| Copilot product/license/tenant surface | exact approved work experience | PENDING |
| Copilot entry/final/redirect hosts | exact HTTPS URLs/hostnames | PENDING; examples are not certification |
| Identity/protection contract | unique signals and evidence | PENDING |
| UI contract | `copilot-ui/v1:<cert-id>` plus fixture/live evidence | PENDING |
| Organization/repository policy revisions | approved IDs, hashes, owners | PENDING |
| Eligible synthetic/disposable repository | owner and classification | PENDING |

## Governance and data protection gates

| ID | P | Gate and evidence | Owner | Status |
| --- | --- | --- | --- | --- |
| GOV-01 | P0 | Applicable Microsoft/enterprise terms permit automated interaction with this exact Copilot web surface. Written decision attached. | Legal/service owner | PENDING |
| GOV-02 | P0 | Internal acceptable-use/browser-automation approval names users, devices, repositories, rate, and prohibited uses. | Security/service owner | PENDING |
| GOV-03 | P0 | Repository data owner authorizes the exact classification/content destination and scope. | Data owner | PENDING |
| GOV-04 | P0 | Privacy/responsible-AI assessment covers source, identity, logs, metrics, human review, and individual-productivity prohibition. | Privacy/RAI | PENDING |
| GOV-05 | P0 | Microsoft 365 retention, residency, eDiscovery, audit, and protection behavior is documented for the tenant/license. | M365 owner/records | PENDING |
| GOV-06 | P0 | Local audit/artifact/checkpoint/profile ACL, encryption, retention, backup, and deletion procedure is approved. | Security/records | PENDING |
| GOV-07 | P0 | Named product owner, security contact, privacy contact, incident commander, and urgent UI-adapter owner exist. | Sponsor | PENDING |

## Offline core gates

| ID | P | Gate and threshold | Required evidence | Status |
| --- | --- | --- | --- | --- |
| OFF-01 | P0 | Clean `npm ci`, TypeScript build, unit tests, and end-to-end fixture loop pass from lockfile. | signed CI/terminal record and immutable revision | PENDING immutable/reviewed evidence |
| OFF-02 | P0 | Replay transport rejects order, correlation, version, and content-digest drift. | transport tests | PENDING review |
| OFF-03 | P0 | Parser rejects missing/multiple/nested/truncated/oversized/wrong-version/wrong-task/wrong-turn/duplicate/invalid-batch adversarial cases. | adversarial corpus results | PENDING review |
| OFF-04 | P0 | Organization/repository/session precedence and every allow/ask/deny dimension pass; no grant overrides higher deny. | policy tests | PENDING review |
| OFF-05 | P0 | Windows path corpus prevents traversal, drive, UNC, ADS, device, link/junction, case and TOCTOU escapes. | tests executed on target Windows filesystem | PENDING target execution |
| OFF-06 | P0 | Seeded credentials in file/search/diff/command/final serialization are blocked or deterministically redacted per policy. | content-security test report | PENDING review |
| OFF-07 | P0 | Stale patch, multi-file atomic failure, checkpoint verification, rollback, and pre-existing-change preservation pass. | mutation/recovery tests | PENDING review |
| OFF-08 | P0 | Catalog rejects shells/shims/unknown params/flag injection/unsafe cwd/time/output; cancellation kills process tree. | command tests including Windows child tree | PENDING target execution |
| OFF-09 | P0 | Crash at each browser/mutation commit boundary never blindly replays uncertain side effect. | fault-injection matrix | PENDING |
| OFF-10 | P0 | Completion rejects unknown/out-of-scope/pending/indeterminate/missing/failed/stale validation. | completion tests | PENDING review |
| OFF-11 | P0 | Audit/disclosure/artifact/decision/fingerprint-key/completion-handoff/checkpoint/review-package corruption and partial records fail closed; review export remains source-free and its digest is not represented as a signature. | integrity/export tests | PENDING review |
| OFF-12 | P1 | Dependency vulnerability/provenance review, SBOM, signing, reproducible packaging, and update rollback meet release policy. | release-security evidence | PENDING |
| OFF-13 | P0 | Explicitly granted `sideEffects: true` validation runs in `edit`/`auto`; every command is bracketed by nested-Git and Git-visible/nonignored, protected, and Git-control integrity checks; `sideEffects: false` also detects bounded ordinary-ignored drift; disallowed or unverifiable drift is recovery-required and cannot satisfy validation. | command-boundary implementation and adversarial tests for tracked, policy-hidden, protected, control, nested, ignored, and bounds cases | PENDING review |
| OFF-14 | P0 | Deterministic Edge-only, Chrome-only, both, neither, current-config, automation, and manual-path selection pass; mismatch, derivative, missing, inaccessible, and stale identity evidence fail closed. | discovery/setup/config tests | PENDING immutable review |
| OFF-15 | P0 | Wide, 54-column, resized, raw arrow/Enter/Escape/Ctrl+C, plain numbered, redirected, and no-color setup cases remain legible and cancellation exits 130 without partial persistence. | terminal/setup tests | PENDING immutable review |
| OFF-16 | P0 | Edge/Chrome dedicated profiles remain separate; both ordinary roots, cross-product reuse, marker tampering, non-empty unmarked roots, links/devices/ownership/lock races are rejected. | profile/transaction tests | PENDING immutable review |
| OFF-17 | P0 | Legacy Edge configuration and profile remain unchanged unless explicitly rewritten; frozen Windows wrappers/discovery order, fixture/replay transport, and `cba/1` semantics remain unchanged. | migration/frozen-byte/protocol tests and diff review | PENDING immutable review |

## Target workstation gates

| ID | P | Gate and threshold | Required evidence | Status |
| --- | --- | --- | --- | --- |
| WIN-01 | P0 | Windows 11 Enterprise build 22631 candidate has adequate CPU/RAM/disk; previously failed inventory probes are resolved. | refreshed sanitized inventory | PENDING |
| WIN-02 | P0 | Standard-user preflight passes and elevated high/system tokens are refused. | target test record | PENDING |
| WIN-03 | P0 | Exact Edge 149, Node 24, npm 11, and Git executables are available and approved; conflicting Git discovery is resolved. | executable path/hash/version record | PENDING |
| WIN-04 | P0 | Product-specific dedicated profile locations are empty/marked, user-only, mutually separate, outside repository/state and ordinary Edge/Chrome roots, local/nonshared, and exclusive-lock behavior passes. Cross-product markers and canonical parent-junction containment are tested. | ACL/path/profile test | PENDING |
| WIN-05 | P0 | Endpoint protection, application control, proxy/egress, filesystem/resource containment, encryption, and logging posture is acceptable; the approved executable/transitive-script trusted-computing-base risk and inability to comprehensively prevent/observe external writes are explicitly accepted or mitigated; stopped service indicators are explained. | endpoint/security owner sign-off and reviewed command/script inventory | PENDING |
| WIN-06 | P0 | State/checkpoint/artifact/profile deletion and incident preservation procedures work on target storage. | operations exercise | PENDING |
| WIN-07 | P1 | Install, update, rollback, uninstall, and decommission work without global Playwright/browser download or admin rights. | packaging exercise | PENDING |

## Live browser read-only gates

Use a synthetic repository and synthetic prompt/content only. Define request-rate limits and stop conditions before testing.

| ID | P | Gate and threshold | Required evidence | Status |
| --- | --- | --- | --- | --- |
| WEB-01 | P0 | Exact entry/final/redirect hosts are documented; any unapproved host stops before submission. | page-state/live record with redacted safe metadata | PENDING |
| WEB-02 | P0 | User manually completes sign-in/MFA/consent; adapter never interacts with authentication controls or captures secrets. | observed test and code review | PENDING |
| WEB-03 | P0 | Correct work identity and required protection indicator are uniquely detected before every submission. Wrong/unknown cases stop. | positive/negative fixture and live cases | PENDING |
| WEB-04 | P0 | Signed-out, MFA, consent, throttle, service error, modal, changed selector, multiple page, and disabled states classify correctly. | certified UI fixture corpus | PENDING |
| WEB-05 | P0 | Valid `cba/1` request rate and bounded repair rate meet pilot thresholds over representative sustained turns. | measured threshold and run data | PENDING |
| WEB-06 | P0 | Response association rejects old/wrong/partial responses; multi-signal completion does not accept streaming/unstable text. | synthetic and live evidence | PENDING |
| WEB-07 | P0 | Crash/timeout before and after send proves no duplicate; indeterminate delivery pauses. | controlled fault injection | PENDING |
| WEB-08 | P0 | Conversation navigation/mismatch stops and one task remains bound to one conversation. | negative live test | PENDING |
| WEB-09 | P0 | Kill switch stops browser action immediately and raw source/identity diagnostics are not retained. | operations exercise | PENDING |
| WEB-10 | P1 | Approved interaction frequency avoids throttling and has a documented outage/manual fallback. | M365 owner/runbook approval | PENDING |

## Experimental macOS preview tuple gates

These rows are non-blocking for the Windows artifact, but every P0 row blocks the affected Mac's own preview label. They never override the global NO-GO for real repository content.

| ID | Tuple | P | Gate and threshold | Status |
| --- | --- | --- | --- | --- |
| MAC-A-01 | MacBook Air `Mac14,2` / M2 / macOS `26.4.1` | P0 | Node 24+/npm 11+, Edge Stable, exact executable hashes, non-root/Aqua preflight, private state/profile, and actual-volume case/NFC-NFD checks pass. | PENDING owner-approved machine changes and evidence |
| MAC-A-02 | same arm64 tuple | P0 | Three consecutive synthetic live sessions pass correlated send/response, edit/validation, rollback, forced-send recovery without duplication, and abort/crash with no process survivor. | PENDING |
| MAC-A-03 | same arm64 tuple | P0 | Owner-approved observer records zero Cope/launched-Edge process-tree reads or writes beneath ordinary `~/Library/Application Support/Microsoft Edge`; retains only source-free counts/path hashes. | PENDING |
| MAC-I-01 | MacBook Pro `MacBookPro16,3` / Intel / macOS `15.7.7` | P0 | Edge Stable, exact executable hashes, non-root/private-storage/filesystem checks, and logged-in Aqua ownership pass under Node 24.x. | PENDING owner-approved Edge installation/evidence |
| MAC-I-02 | same x64 tuple | P0 | SSH-originated visible launch into the existing Aqua session, display-asleep operation, logged-out fail-closed case, and three consecutive synthetic live sessions pass. | PENDING |
| MAC-I-03 | same x64 tuple | P0 | Same zero ordinary-profile access observer gate and process-tree crash/cancel corpus pass. | PENDING |
| MAC-WIN-01 | shared artifact / Windows primary | P0 | Frozen Windows characterization remains green and the predeclared A/B local-operation thresholds (≤5% median, ≤10% p95 regression) pass on the exact Windows candidate. | PENDING |

## Chrome preview candidate gates

These gates are additive. Every row must pass independently for each exact OS/architecture/Chrome/Node/npm/Git tuple before removing **Chrome preview candidate / offline evidence only**. Passing Edge gates, sharing Chromium internals, or passing offline Chrome tests does not satisfy them. Chrome acceptance must not weaken any Windows or Edge release gate.

| ID | P | Gate and threshold | Required evidence | Status |
| --- | --- | --- | --- | --- |
| CHR-01 | P0 | Exact OS/build/architecture, Chrome Stable version, Node, npm, Git, release revision and dependency lock are recorded with canonical executable paths and SHA-256 values. | immutable tuple record | PENDING |
| CHR-02 | P0 | Chrome identity evidence matches expected application metadata and signer/publisher, rejects Edge and unsupported Chromium derivatives, and survives a configure-to-launch stat/version/hash recheck. | target positive/negative identity record | PENDING |
| CHR-03 | P0 | Browser-neutral installer and clean `cope setup` detect/select Chrome without a download; manual-path and managed flag flows work; uninstall/reinstall preserve or deliberately remove state as documented. | clean packaging/setup/decommission exercise | PENDING |
| CHR-04 | P0 | User manually completes Microsoft 365 sign-in, MFA, consent, reauthentication and tenant Conditional Access; Cope does not automate or capture authentication material. | observed synthetic live exercise | PENDING |
| CHR-05 | P0 | The configured Copilot page passes exact host, visible identity, protection, composer, state-classifier and `copilot-ui/v1:<cert-id>` checks on this Chrome tuple, including negative signed-out/MFA/consent/modal/throttle/changed-selector cases. | certified fixture plus live UI record | PENDING |
| CHR-06 | P0 | Chrome uses a Chrome-marked dedicated profile and refuses Edge/cross-product profiles. Owner-approved observation shows zero Cope/launched-Chrome process-tree reads or writes beneath the ordinary Chrome root for the complete setup/session/crash exercise. | profile evidence and source-free observer record | PENDING |
| CHR-07 | P0 | Three consecutive synthetic sessions pass submission marker/baseline correlation, stable response capture, sustained `cba/1` adherence, and wrong/old/partial response rejection. | live run and correlation evidence | PENDING |
| CHR-08 | P0 | Ctrl+C, kill switch, timeout, browser crash and parent crash terminate the full process tree; before/after-send recovery never duplicates a submission and indeterminate delivery pauses. | controlled fault-injection record | PENDING |
| CHR-09 | P0 | Windows Edge discovery order and wrappers remain byte-identical, existing Edge configuration/authentication remains selected, Edge live behavior has no regression, and the shared artifact meets the Windows A/B thresholds. | frozen-surface diff, Edge rerun and performance evidence | PENDING |
| CHR-10 | P0 | Support status remains visible as Chrome preview/offline-only in setup, doctor, docs and release notes until CHR-01–09 plus all shared P0 gates are approved. | product/release review | PENDING |

## Disposable edit/auto gates

| ID | P | Gate and threshold | Required evidence | Status |
| --- | --- | --- | --- | --- |
| AGT-01 | P0 | Agent completes representative multi-turn discover/read/edit/validate/fix/complete tasks without per-action prompts inside grant. | disposable repository scenarios | PENDING live/target evidence |
| AGT-02 | P0 | Out-of-scope write, command, disclosure, secret, network, protected path, dependency, delete, and budget cases ask/deny correctly. | negative UAT | PENDING |
| AGT-03 | P0 | Failed tests lead Copilot to inspect and correct where possible; harness never makes the development decision. | turn/audit evidence | PENDING live/target evidence |
| AGT-04 | P0 | Checkpoint/rollback restores exact pre-operation bytes and preserves unrelated/pre-existing work. | rollback exercise | PENDING |
| AGT-05 | P0 | Fresh run/resume completion handoff matches actual paths, Git status, validation, disclosure metadata, skipped checks, and risks; persisted `status` is not mistaken for a fresh repository observation; exported `cba-review-package/1` is source-free and reconciles to verified records. | handoff/report/export reconciliation | PENDING |
| AGT-06 | P0 | Operator can understand grant, inspect status, deny/expand capability, pause, abort, verify audit, resume safe state, and use manual fallback. | UAT sign-off | PENDING |
| AGT-07 | P0 | No push/merge/deploy/publish/release occurs and no arbitrary shell/browser/filesystem capability is exposed. | audit/code review | PENDING |
| AGT-08 | P1 | Operational support can disable adapter, triage safe diagnostics, recertify UI, and deploy rollback within target time. | game day | PENDING |

## Approval record

Complete only after every P0 row is `PASS` or approved `N/A`:

| Decision | Name/role | Date | Evidence package/hash |
| --- | --- | --- | --- |
| Product owner |  |  |  |
| Repository/data owner |  |  |  |
| Security |  |  |  |
| Privacy/records |  |  |  |
| M365/browser service owner |  |  |  |
| Operations/support |  |  |  |
| Release decision (`GO`/`NO-GO`) |  |  |  |

Approval applies only to the recorded candidate tuple, browser product, repositories/classifications, users/devices, policies, and validity period. Edge/Chrome/Copilot UI, identity/protection behavior, dependency, policy, or platform changes trigger product-specific recertification.
