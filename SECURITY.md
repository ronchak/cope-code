# Security policy

## Reporting

Report suspected vulnerabilities, unsafe browser behavior, data disclosure, credential/profile exposure, repository-boundary escape, command injection, audit corruption, or duplicate mutation/submission through the organization's approved private security channel.

Do not open a public issue containing repository names, tenant URLs, identities, source, prompts/responses, session state, checkpoints, browser profiles, screenshots, traces, cookies, tokens, or exploit details. This source tree does not name a public response mailbox; deployments must configure an accountable product owner, security contact, privacy contact, and Edge/Copilot adapter owner before pilot use.

For an active incident, stop the agent, disable live transport if needed, isolate the endpoint according to organizational procedure, preserve approved evidence, and follow [Recovery, checkpoints, and audit](docs/RECOVERY-AND-AUDIT.md).

## Candidate security baseline

This source tree does not certify a supported live compatibility tuple. The primary candidate inventory reports Windows 11 Enterprise build 22631, Edge 149.0.4022.98, Node 24.17.0, npm 11.13.0, and Git 2.55.0.windows.3, but it contains conflicting Git executable discovery and incomplete host/security probes. The two exact Mac candidates are experimental home-test preview lanes only and have offline implementation evidence, not live approval; see [the macOS target record](docs/MACOS-TARGET.md). A deployment may claim support only for exact executable paths/hashes, configuration revisions, tenant/UI contract, endpoint posture, and machine tuple that pass the live-pilot gates. A source checkout or passing offline tests is not that certification.

The following are mandatory for real-repository use:

- written browser-automation and data-owner authorization;
- exact tenant URL, work identity, and protection-indicator certification;
- a protected dedicated Edge profile with manual authentication;
- non-elevated execution and approved endpoint/network controls;
- reviewed organization/repository/session policy;
- reviewed catalog executables and transitive scripts, truthful side-effect/network metadata, explicit policy/grant approval, and endpoint containment; side-effecting validation may create ordinary Git-ignored artifacts, but intentional source-mutating commands remain unsupported until a versioned checkpointable write-scope contract is approved and implemented;
- approved storage ACL, encryption, retention, and deletion procedures;
- dependency provenance, vulnerability review, SBOM, signing, and distribution controls;
- offline/adversarial tests and target-machine live acceptance; and
- tested kill switch, rollback, incident response, and manual fallback.

## Security boundaries

The harness provides application-level policy, path, command, content, idempotency, checkpoint, and audit controls. It is not a VM/container, kernel filesystem/network/resource sandbox, data-loss-prevention product, anti-malware system, network firewall, credential vault, or cryptographically signed audit/review service. Approved executables and transitive scripts are trusted computing base, and the harness cannot comprehensively prevent or observe their external writes. Review-package body hashes are integrity metadata, not signatures, and POSIX-style file modes do not establish Windows ACLs. These containment gaps remain live-pilot/release gates even when offline tests pass. See the [threat model](docs/THREAT-MODEL.md) and [limitations](docs/LIMITATIONS.md) for residual risk.

No mode authorizes credential automation, arbitrary shell, unrestricted filesystem/Git/browser control, policy modification, elevation, hidden browser operation, push, deploy, publish, or release.
