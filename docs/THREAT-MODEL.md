# Threat model

## macOS preview additions

The exact macOS preview candidates add Aqua-session ambiguity, UID/root misuse, APFS case/NFC-NFD aliases, linked or cross-device Application Support trees, credential-equivalent dedicated profiles, SSH-originated launch behavior, and orphaned POSIX descendants. Controls are fail-closed GUI/UID/version probes, per-volume identity keys, bounded `lstat` ownership/mode/device verification, ordinary-profile exclusion, one dedicated persistent user-data directory, and an expected-parent supervisor that owns the command process group through termination escalation. These controls do not make the Mac a sandbox, protect against a malicious approved executable, certify Keychain/FileVault/endpoint posture, or authorize live/real-repository use.

## Scope and security objective

The system gives an untrusted, browser-hosted reasoning component bounded access to one local Git repository through deterministic tools. Security means that model autonomy cannot exceed explicit organization, repository, and session authority; consequential actions are correlated, bounded, recoverable, and auditable; authentication remains user-controlled; and uncertainty fails closed.

This model covers the local Node process, repository, child commands, local state/checkpoints, product-specific dedicated Edge/Chrome profiles, browser executable discovery and identity checks, semantic UI adapter, and Copilot Chat exchange. It does not claim to model Microsoft service internals, the full Windows or macOS endpoint stack, a malicious administrator, or physical compromise.

## Assets

- repository source, configuration, history, filenames, and pre-existing work;
- secrets and sensitive data present in files or process output;
- integrity and availability of the working tree;
- organization/repository/session policy and grant integrity;
- local audit, disclosure, operation, transient decision/outbox/response, fingerprint-key, completion-handoff, checkpoint, and review-export records;
- authenticated dedicated browser profile, cookies, tokens, account and tenant context;
- Copilot task/conversation correlation and completion truth;
- developer workstation compute, disk, network, and child processes; and
- release/update dependencies and signing provenance.

## Actors and inputs

- authorized developer/operator;
- organization, repository data owner, security/privacy, and service owners;
- Microsoft 365 Copilot Chat and its generated output;
- repository contributors who may place malicious text in source/docs/tests;
- command/process output and dependencies;
- an attacker controlling model output, a repository file, a dependency, browser UI content, or local unprivileged files; and
- an endpoint or administrator-level attacker, which is outside the guarantees of local hash/file-mode controls.

All model output, repository content, filenames, Git data, command output, browser DOM/content, configuration files, session files, and replay fixtures are treated as untrusted until validated by the receiving component.

## Assumptions and non-assumptions

Required assumptions:

- the account and endpoint controls on the exact approved Windows or macOS tuple are trustworthy enough to protect the process, config, state root, and profile; on a Mac this includes the intended non-root console UID, Aqua-session ownership, FileVault/storage posture, and local Application Support protections;
- the approved Edge or Chrome executable and pinned Node dependencies are genuine;
- repository and organization policy authors are authorized;
- command catalog facts are reviewed and truthful;
- the configured identity/protection signals uniquely identify the approved Copilot context; and
- Copilot Chat is an authorized destination for the granted content classification.

The design does not assume Copilot follows instructions, repository text is benign, command output is safe, chat delivery is exactly once, UI selectors are stable, a command marked offline is technically unable to use network, local deletion is secure erase, or a completion claim is true.

## Threat/control matrix

| Threat or abuse case | Primary controls | Residual risk / required operational control |
| --- | --- | --- |
| Model invents repository facts | typed read/search/Git tools; bootstrap says never invent; local outcomes authoritative | model may still reason poorly; human final review |
| Model emits malformed/ambiguous action | one strict `cba/1` envelope; schemas; exact task/turn; direction, batch, duplicate validation; bounded repair | sustained protocol drift may block task; live adherence must be measured |
| Repository prompt injection changes authority | data delimiters; nested-fence-safe parser; no direct capability; local policy on every request | injection may influence permitted engineering choices; minimize disclosure and review changes |
| Path traversal, drive/UNC/ADS/device/link escape, case/NFC-NFD alias, cross-device tree, or nested repository boundary | repository-relative normalization; per-volume identity keys; canonical boundary; link/type/device checks; index-gitlink and descendant `.git` preflight rejection; repeated nested-boundary checks; mandatory non-negatable protected/excluded floors; local-only profile syntax plus canonical prospective profile/state/repository separation | Windows reparse/namespace cases and each exact Mac's APFS behavior require target-machine adversarial certification |
| Model overwrites stale or user-edited content | exact current-byte SHA-256; pre-existing inventory; atomic transaction; checkpoint; post-state verification | concurrent external editors can still create conflicts; one agent lock does not lock all user tools |
| Duplicate mutation after crash | operation IDs/journal; persistent intent; completed replay; indeterminate mutation pause | manual reconciliation may be needed; do not edit journal to force resume |
| Duplicate browser message after timeout/crash | persistent outbox/intent; unique marker; resolve-before-retry; same conversation hash; retry only proven not-submitted | UI may not expose decisive evidence; indeterminate state intentionally pauses |
| Response from prior/wrong conversation | task/turn/submission markers; conversation binding; baseline response count/hash; correlation checks | locator/UI drift can defeat evidence; certified fixtures and live smoke tests required |
| Submission to wrong host/account/tenant | exact HTTPS host allowlist; identity/protection assertion before and immediately before send; no wildcard; blocking state classifier | visible labels can change or collide; tenant-specific selectors and manual certification required |
| Credential/MFA automation or theft | manual authentication; no credential tools; dedicated protected profile; no profile export/network capture; downloads disabled | profile remains credential-equivalent and may be stolen by local malware/admin; ACL, encryption, incident response |
| Secret or restricted data disclosure | excluded paths; classification policy; bounded reads; secret scan/redaction; final serialized scan; disclosure ledger; v1 credential deny | pattern scanners have false negatives; data owner/DLP/tenant controls remain required |
| Sensitive diagnostics persist source/account data | minimal diagnostic codes/counts/hashes; raw screenshots/traces/DOM/network disabled by default; separate artifacts and retention | operators may capture screenshots manually; support procedure and access controls |
| Arbitrary command/shell injection or undeclared command mutation | catalog ID only; shells and command shims rejected; fixed executable/args; typed parameters; no joined command; `shell:false`; minimal environment/cwd; explicit policy/grant for side-effecting commands; every command bracketed by nested-Git and Git-visible/nonignored, keyed protected, and Git-control checks; declared-read-only commands also bind a bounded ordinary-ignored inventory | ordinary ignored output from an approved side-effecting command is allowed; intentional source-mutating commands are unsupported; a trusted executable/transitive script can still have external effects or exploit a race; catalog/script review and endpoint containment remain required |
| Unauthorized network from a command | network metadata plus layered policy; network-required host list | not OS egress isolation; managed firewall/sandbox needed for enforceable containment |
| Child process escape/resource exhaustion | standard user; timeout/output bounds; cancellation/process-tree kill; expected-parent POSIX supervisor on macOS; Windows `taskkill` tree semantics; command allowlist | no CPU/RAM/disk quotas; platform process-tree controls require exact-machine crash/abort tests; endpoint/container controls for high risk |
| Model changes policy, audit, agent, CI/deployment, or credentials | no policy tool; `.cba`/state/credential paths excluded/protected; CI/deploy protection; organization denies | repository-specific control paths must be added; malicious local user outside model boundary may edit config |
| False completion | local verifier checks pending/submission/repository/scope/required fresh commands; actual state in report | tests and criteria can be insufficient; human review and product validation remain necessary |
| Audit, disclosure, fingerprint-key, or review-record tampering | sequence/session/hash chain; strict verification; partial-record rejection; existing sessions refuse a missing/malformed fingerprint key; review package derives only from verified evidence and carries a deterministic body digest; restrictive local modes | hash chains/package digest are unsigned/local; Windows ACLs need separate certification, while macOS ownership/mode/device checks do not resist a privileged attacker; approved ACL/signing/anchoring if required |
| Checkpoint corruption or destructive rollback | external storage; bounded manifests/blobs; SHA-256/size/path checks; pre-rollback snapshot and restoration | checkpoint contains source; storage/retention and manual path review required |
| Malicious fixture/replay | bounded strict JSON; correlation/order/content digest; pinned source file hash | fixture content is executable model intent within policy; review as test code and keep synthetic |
| Wrong or substituted browser product | deterministic bounded candidates; explicit product choice; exact platform metadata/signature checks; canonical path, version, stat identity and SHA-256 pinning; recheck at launch | endpoint compromise can subvert local evidence; product identity is not tenant/UI/release certification |
| Ordinary-profile or cross-product profile access | product-specific roots and markers; both ordinary Edge and Chrome roots denied; link/device/owner/mode checks; exclusive lock; non-empty unmarked and wrong-product roots rejected | a compromised browser or OS can still escape application controls; live zero-access observation remains required |
| Supply-chain compromise | minimal exact dependencies and lockfile; offline tests; intended SBOM/provenance/signing gates | npm/Node/Playwright/Edge/Chrome compromise has broad access; organizational release process is mandatory |
| UI update causes wrong action | versioned semantic contract, candidate quorum, expected counts, multi-signal completion, changed-selector state, kill switch | live UI is inherently unstable; continuous recertification and fast disable owner required |
| Local policy is weakened or emergency stop is removed | optional Ed25519-signed managed bundle, pinned trust key, strict canonical payload digest, freshness/expiry checks, signed kill switch, source-free provenance | endpoint controls must prevent the Cope user from deleting/replacing both managed files; offline delivery has no independent server liveness |
| Elevated, wrong-user, or hidden execution | Windows integrity preflight; macOS UID 0 refusal plus console-owner and `gui/<uid>` Aqua checks; visible headful selected browser; explicit stop | a Windows UAC-filtered admin can still have a medium token; an Aqua probe cannot prove future UI reliability; organizational endpoint policy and exact-machine visible-launch tests decide eligibility |

## Browser abuse cases

The adapter must not:

- accept Brave, Arc, Chromium, an embedded runtime, or one supported product under the other product name;
- search unbounded filesystem locations, fall back to a Playwright channel, or download a browser;
- reuse an Edge profile for Chrome, reuse a Chrome profile for Edge, or touch either ordinary profile root;
- continue on a broad Microsoft hostname just because it resembles Copilot;
- submit while on authentication/consent/MFA pages;
- dismiss unknown modals;
- select among multiple approved Copilot pages heuristically;
- extract the last visible assistant element without submission baseline/correlation;
- treat stopped streaming alone as completion;
- retry send after an activation exception without evidence;
- automate CAPTCHA/bot controls or security interstitials;
- export storage state, cookies, tokens, headers, or private network logs; or
- accept a UI selector change by operator guess during a live real-repository task.

## Repository and command abuse cases

The harness must reject:

- absolute, upward-traversing, link, alternate-stream, device, or out-of-root paths;
- binary, archive, certificate, key, executable, submodule, nested Git worktree, or unsupported encoding mutation;
- a patch based on a different current hash;
- duplicate normalized paths in one transaction;
- arbitrary executable/arguments, environment-variable expansion, shell metacharacter interpretation, or unknown parameter names;
- `.cmd`, `.bat`, `.ps1`, shell, script-host, or repository-provided wrapper executables;
- command time/output beyond catalog and policy;
- every command not explicitly allowed by the effective policy/grant, including side-effecting commands in `inspect` mode;
- a command whose before/after tracked/nonignored, protected, Git-control, or nested-repository state changes, plus any ordinary ignored-file drift from a command declared side-effect-free;
- every intentional command-driven source mutation until a versioned bounded write-path/checkpoint contract exists;
- a claimed offline command whose catalog metadata requires network without permission; and
- completion with stale or missing required validation.

## Privacy and governance risk

Enterprise protection indicators do not themselves authorize source disclosure or browser automation. Before real use, document applicable Microsoft/enterprise terms, tenant/license configuration, data residency/retention/eDiscovery, repository owner consent, classification eligibility, responsible AI/privacy review, acceptable interaction rate, support access, and metrics rules. Session metrics must not be repurposed as individual productivity surveillance.

## Security testing

Release candidates should cover:

- Unicode, case, separator, long-path, reserved-name, UNC, drive, ADS, link/junction, and time-of-check/time-of-use paths on Windows;
- case-sensitive and case-insensitive APFS, NFC/NFD aliases, `/tmp`/`/private/tmp` canonicalization, linked/cross-device state and profile trees, wrong ownership/modes, UID/root and logged-out Aqua failures, and SSH/display-asleep visible launch on each exact Mac tuple;
- macOS parent death before/after supervisor handshakes, active command cancellation, child/grandchild SIGTERM-to-SIGKILL escalation, and zero survivors;
- nested/multiple/truncated/oversized fences, duplicate IDs, wrong task/turn, schema extras, random interruption, and adversarial Unicode/line endings;
- seeded credentials in source, filenames, diffs, command output, bootstrap, tool-result serialization, and truncation boundaries;
- command flags, leading dash, newline/NUL, environment, cwd, timeout, output flood, cancellation, child tree, and mislabeled network metadata;
- browser wrong account/host/conversation, signed-out/MFA/consent, streaming/partial response, service error/throttle, modal, duplicate response, changed selector, crash before/after send, and kill switch;
- crash at every persistent intent/commit point; and
- checkpoint/audit/disclosure/artifact corruption and partial writes.

Use only synthetic repositories, accounts/content approved for testing, controlled request frequency, and explicit stop conditions for live tests.

## Residual-risk decision

The most important residual risks are governance authorization, brittle browser UI evidence, scanner false negatives, authenticated-profile compromise, unsupported intentional command-driven source mutation, trusted-command/transitive-script behavior and externally invisible writes, absence of kernel-level filesystem/resource/network isolation, unsigned local audit/review metadata, and inability to prove some uncertain delivery/mutation states automatically.

These risks are acceptable only for the scope approved in the live-pilot matrix. If stronger guarantees are required, run inside an approved disposable VM/container with egress/resource controls, use a supported model API when authorized, add externally anchored audit and enterprise DLP, or retain manual operation.
