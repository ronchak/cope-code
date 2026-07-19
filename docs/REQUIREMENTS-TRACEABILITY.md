# Requirements traceability

This matrix maps the PRD's functional requirements to implementation and automated evidence. It is not a release claim. Code/test presence must be paired with a clean candidate test record and the live-pilot evidence in [LIVE-PILOT-ACCEPTANCE.md](LIVE-PILOT-ACCEPTANCE.md).

The macOS expansion requirements MAC-001 through MAC-052 map to `src/platform`, per-volume filesystem identity, private storage/profile checks, POSIX supervision, macOS packaging, and the hosted offline matrix. The exact three candidate tuples and evidence-date/status fields are maintained in [MACOS-TARGET.md](MACOS-TARGET.md). MAC-060 Windows A/B evidence and both owner-approved Mac live records remain pending; therefore this is implementation traceability, not a preview certification.

Legend:

- `Automated`: direct implementation and offline automated coverage exists.
- `Target`: implementation exists; Windows/managed-tenant evidence remains required.
- `Partial`: a material portion is not a complete v1/product control; the gap is named.
- `Live`: cannot be established without approved tenant/browser testing or governance.

## CLI and session lifecycle

| Req | Evidence | Disposition / remaining gate |
| --- | --- | --- |
| FR-001 | `src/cli`, `src/session`; CLI argument/control/runnable-e2e/state/export tests | Automated: run, persisted status inspection, pause, resume, abort, rollback, audit verification, and review export exist; operator UAT remains. |
| FR-002 | `src/preflight/machine.ts`; preflight tests | Target: standard-user integrity check/elevation refusal needs Windows exercise. |
| FR-003 | `SessionStore.acquireWorkspaceLock`; session-state test | Automated; target filesystem/PID behavior still in WIN gates. |
| FR-004 | CLI abort control channel, `AgentRuntime.emergencyStop`, browser kill switch, `ProcessRunner.cancelAll`; control/runtime/browser/command tests | Automated core; CLI-to-Windows browser/process-tree game day remains. |
| FR-005 | policy modes, CLI parser; policy/CLI tests | Automated. |
| FR-006 | `cba-effective-grant/1` terminal approval envelope; persisted status grant/mode/budget output | Automated: start displays the complete path/command/disclosure/network/change/budget/checkpoint/escalation envelope and hashes; status redisplays the full stored grant, mode, and budget snapshot. Status is deliberately not fresh Git evidence. |
| FR-007 | session/artifact/journal/runtime recovery; agent-runtime tests | Automated for modeled crash states; full fault-injection matrix remains. |
| FR-008 | scripted fixture and transcript replay; transport and e2e tests | Automated. |

## Repository boundary and state

| Req | Evidence | Disposition / remaining gate |
| --- | --- | --- |
| FR-010 | `RepositoryBoundary.discover`; repository-boundary tests | Automated. |
| FR-011 | boundary normalization/canonical resolution; escape/link/hardlink tests | Target: adversarial Windows junction/reparse/ADS/device/TOCTOU corpus remains. |
| FR-012 | `GitInspector`, `SnapshotDiffInspector`; repository-tools/snapshot-diff/e2e tests | Automated: status plus bounded working-tree, staged, checkpoint, and whole-session diffs; exceptional real repository cases need pilot scenarios. |
| FR-013 | session `preExistingChanges`, completion attribution; completion/e2e tests | Automated. |
| FR-014 | file SHA-256/state metadata, operation journal | Automated. |
| FR-015 | boundary/patch engine revalidation | Automated; concurrent Windows editor fault tests remain. |
| FR-016 | repository ignore service; repository-tools test | Automated. |
| FR-017 | text/type/size/ignore/protected controls; repository/patch tests | Automated for covered formats; repository-specific generated/vendor rules remain onboarding work. |

## Autonomy and policy

| Req | Evidence | Disposition / remaining gate |
| --- | --- | --- |
| FR-020 | `PolicyEngine`, `LayeredRuntimePolicy`; policy/runtime-policy/e2e tests | Automated. |
| FR-021 | allow/ask/deny schemas/engine/runtime | Automated. |
| FR-022 | persisted session approvals and no-repeat policy behavior | Automated; UAT must confirm user experience. |
| FR-023 | pause/abort control channel, SIGINT/SIGTERM pause, kill switch, process cancellation; CLI/runtime tests | Automated core; target UAT remains. |
| FR-024 | policy/session budget meter; policy/session/runtime tests | Automated. |
| FR-025 | bounded `expandSessionGrant`; policy/runtime-policy tests | Automated; CLI UAT remains. |
| FR-026 | reason codes and explanations | Automated schema/engine evidence; accessibility/understandability UAT remains. |

## Tool protocol

| Req | Evidence | Disposition / remaining gate |
| --- | --- | --- |
| FR-030 | `src/protocol` `cba/1` contracts | Automated. |
| FR-031 | exact task/turn/message/operation IDs; protocol/transport tests | Automated. |
| FR-032 | strict parser; protocol-adversarial tests | Automated. |
| FR-033 | Ajv schemas and semantic validation | Automated. |
| FR-034 | tool/result/denial serializers and tool host | Automated/e2e. |
| FR-035 | repair envelope and repair budget; runtime test | Automated; live repair-rate threshold remains. |
| FR-036 | parser ID set, operation journal, submission intent; journal/runtime/browser tests | Automated for modeled states; crash matrix remains. |
| FR-037 | bootstrap and per-turn protocol reminder | Automated; long live conversation drift threshold remains. |
| FR-038 | immutable version discriminators, strict unsupported-version tests | Automated for v1; future-version compatibility process not yet exercised. |

## Repository tools and disclosure

| Req | Evidence | Disposition / remaining gate |
| --- | --- | --- |
| FR-040 | repository list/search/read tools; repository-tools/e2e tests | Automated. |
| FR-041 | ignore/text/type/size, classification, secret processor | Automated; classifier/scanner operational false-negative review remains. |
| FR-042 | hash-chained `DisclosureLedger`; security tests | Automated. |
| FR-043 | layered disclosure authorization and content processor | Automated. |
| FR-044 | runtime disclosure guard on serialized outbound/bootstrap/results | Automated/e2e; seeded full-boundary test record required for release. |
| FR-045 | deterministic secret redaction, disclosure ledger, `cba-review-package/1` redaction findings; security/review-package/export tests | Automated: the source-free review package exposes inspectable HMAC-derived finding metadata after ledger/audit verification without exporting secret text. |
| FR-046 | read/search/diff/output limits and truncation | Automated. |

## Source modification

| Req | Evidence | Disposition / remaining gate |
| --- | --- | --- |
| FR-050 | policy path/change facts, patch budgets | Automated. |
| FR-051 | boundary/text-file/patch type restrictions, index-gitlink and descendant-Git-boundary rejection; boundary/patch/preflight tests | Automated for listed file classes and submodule/nested-repository cases; Windows reparse corpus remains. |
| FR-052 | non-negatable repository exclusions, `ProtectedPathPolicy` mandatory floors, layered additions; security/runtime-policy tests | Automated: Git/agent controls, environment/key material, CI workflow controls, generated/vendor/lock/binary classes, and other conservative defaults cannot be removed by live configuration; repository-specific additions remain onboarding work. |
| FR-053 | base SHA-256 conflict; patch tests | Automated. |
| FR-054 | all-before-write transaction plus restore; patch tests | Automated; crash/power-loss target testing remains. |
| FR-055 | patch result inventory and repository fingerprint | Automated. |
| FR-056 | external checkpoint store; patch/e2e tests | Automated. |
| FR-057 | pre-existing vs agent inventory, checkpoint/session diffs, compare-and-restore rollback; completion/snapshot-diff/patch tests | Automated for local cases; UAT/reconciliation exercise remains. |

## Command execution

| Req | Evidence | Disposition / remaining gate |
| --- | --- | --- |
| FR-060 | strict `CommandCatalog`, layered policy, and pre/post command-integrity boundary | Automated for versioned catalog definitions; side-effecting commands require explicit effective-policy/grant permission. |
| FR-061 | catalog ID plus typed parameters; `ToolHost` command gate | Automated offline: explicitly granted `sideEffects: true` validation runs in `edit`/`auto` and may create ordinary Git-ignored artifacts; every command binds tracked/nonignored, protected, Git-control, and nested-repository state, while declared-read-only commands also bind a bounded ignored-file inventory. Intentional command-driven source mutation remains unsupported pending a future versioned write-scope/checkpoint contract. |
| FR-062 | shell/shim deny and `shell:false`; command tests | Automated. |
| FR-063 | standard user, repository cwd, minimal environment | Target: Windows integrity/environment exercise remains. |
| FR-064 | timeout, output, process-tree controls; command tests | Partial: no kernel-level CPU/RAM/disk/process-count quotas. Use endpoint/isolation controls for stronger resource limits. |
| FR-065 | pause/abort runtime signals, `cancelAll`, process-tree termination test | Target: Windows `taskkill` behavior/game day remains. |
| FR-066 | explicit command outcome enum plus recovery-required undeclared-mutation path | Automated: disallowed or unverifiable command drift is indeterminate/recovery-required and cannot become trusted validation. |
| FR-067 | content processor/redaction before model result; command/security tests | Automated. |
| FR-068 | typed parameter variants and bounds; command tests | Automated. |

## Browser transport and identity

| Req | Evidence | Disposition / remaining gate |
| --- | --- | --- |
| FR-070 | `EdgeCopilotTransport`, persistent headful `playwright-core` context | Target/Live: not run on mapped Windows/Edge. |
| FR-071 | manual readiness classifier; browser-adapter test | Live: verify exact auth/CA flows without automation. |
| FR-072 | exact host, identity, protection checks before composer/send | Live-blocked: tenant URL/identity/protection contract missing. |
| FR-073 | fail-closed page classifications | Automated synthetic; live negative cases pending. |
| FR-074 | marker, intent, resolve-before-retry; browser/runtime tests | Automated synthetic; live crash/send evidence pending. |
| FR-075 | conversation hash/task binding/baseline; browser tests | Automated synthetic; live evidence pending. |
| FR-076 | streaming + stable content + composer/response/page signals | Automated synthetic; live thresholds pending. |
| FR-077 | classifier corpus for sign-in/MFA/consent/throttle/error/modal/selectors | Automated synthetic; tenant fixture certification pending. |
| FR-078 | minimal source-free diagnostics | Automated; approved support retention/redaction process is governance work. |
| FR-079 | `src/browser` behind `ModelTransport`, independent UI contract version | Automated architectural boundary; import/maintenance review remains. |

## Agent loop and completion

| Req | Evidence | Disposition / remaining gate |
| --- | --- | --- |
| FR-080 | `AgentRuntime` loop and offline e2e scenario | Automated offline; sustained live turns pending. |
| FR-081 | session state/store/journal/audit separate from chat | Automated. |
| FR-082 | pending operations, journal/submission states | Automated. |
| FR-083 | protocol/tool failure flow in e2e; command integrity guard | Automated offline, including an explicitly granted side-effecting validation command; live ordinary-failure scenarios remain pending. |
| FR-084 | user/capability handling plus explicit pause control/monitor | Automated core; CLI UAT pending. |
| FR-085 | boundary errors and browser trust failures stop/pause | Automated synthetic; incident/kill-switch game day pending. |
| FR-086 | `verifyCompletion`, fresh consistency-checked run/resume handoff, completion/e2e/CLI tests | Automated: completion is locally verified, then the active CLI requires a fresh status/diff fingerprint match; later standalone status remains a persisted snapshot. |
| FR-087 | persisted bootstrap/outbox/response/conversation summary facts | Partial: safe same-conversation recovery exists; deliberate fresh-conversation reconstruction/replacement is not fully certified. |

## Audit and records

| Req | Evidence | Disposition / remaining gate |
| --- | --- | --- |
| FR-090 | session IDs and append/fsync audit chain | Automated. |
| FR-091 | runtime audit event types and safe metadata | Automated core; review event coverage against every CLI path before release. |
| FR-092 | no auth capture; minimal browser diagnostics | Automated design; live support practice pending. |
| FR-093 | separate transient outbox/response/decision artifacts, checkpoints, fingerprint key, completion handoff, ledgers, and source-free review package | Automated. |
| FR-094 | restrictive file creation and artifact cleanup | Partial/governance: no built-in Windows ACL provisioning, encryption management, secure erase, backup/eDiscovery integration. |
| FR-095 | session/audit/disclosure/checkpoint/artifact integrity checks | Automated. |
| FR-096 | status/JSON and `cba-review-package/1`; CLI export/review-package tests | Automated: `export-review` locks the workspace, verifies session/audit/disclosure evidence, and atomically emits a versioned, integrity-protected, source-free review package. The digest is not a signature or external attestation. |

## Non-functional and release requirements

| Area | Evidence | Remaining gate |
| --- | --- | --- |
| Security | strict protocol/policy/path/catalog/content/browser tests; threat model | Windows adversarial corpus, tenant live tests, endpoint controls, governance, supply-chain approval |
| Reliability | explicit state machine, intent/journal/artifact ordering, fault-specific tests | systematic crash injection at every commit point and live browser recovery |
| Maintainability | separated modules, central contracts/versions, fixture/replay transport | architecture dependency enforcement and UI-owner recertification process |
| Performance | bounded reads/output/context and state-based waits | measured large-repository and live-turn thresholds on target |
| Usability/accessibility | non-color CLI structures, explicit pause/status controls, and specific policy reasons | operator UAT and accessible terminal review |
| Privacy/governance | minimized local metadata, no added telemetry, explicit classification | written terms/data-owner/privacy/records decisions |

## Known release-blocking gaps

Irrespective of automated tests, real-repository pilot remains blocked until governance approval, exact Copilot tenant/URL/identity/protection certification, dedicated profile approval, Windows target execution, live exactly-once and response-completion evidence, endpoint storage/network/resource decisions, approved executable/transitive-script review and external-write risk disposition, release provenance/signing/SBOM, and operations/incident ownership are complete.

The partial FR-064, FR-087, and FR-094 items require an explicit product decision or implementation before claiming full PRD conformance. The deterministic offline autonomous-loop path supports granted side-effecting validation without accepting tracked/nonignored, protected, control, or nested-repository drift; it is not live certification. A future versioned write-scope/checkpoint contract is still required before intentionally source-mutating child commands can be supported.
