# Security policy

## Reporting

Report suspected vulnerabilities or unsafe behavior through the project's approved private security channel when possible.

Relevant reports include:

- a browser submission sent to the wrong host, account, tenant, or conversation;
- automated credential, MFA, consent, cookie, token, or profile handling;
- a mutation or external action being replayed after an uncertain outcome;
- model or repository text becoming executable without a valid top-level tool request;
- Cope reporting a command, mutation, validation, or completion as successful without local evidence;
- unintended privilege elevation;
- corruption or exposure of Cope's private state, operation records, checkpoints, or dedicated browser profile;
- loss or overwrite of pre-existing user work;
- a documented developer-mode or hardened-mode boundary being bypassed.

Do not open a public issue containing repository names, tenant URLs, identities, source, prompts or responses, session state, checkpoints, browser profiles, screenshots, traces, cookies, tokens, or exploit details.

For an active incident, stop or pause the agent, preserve relevant local state, reconcile the repository before resuming, and follow [Recovery, checkpoints, and audit](docs/RECOVERY-AND-AUDIT.md).

## Product security posture

Cope's primary target is a powerful local developer agent used by one developer. Developer mode intentionally accepts the ordinary risks of running local development commands with the current user's authority.

The selected project is the intended workspace and default working directory. It is not a kernel-enforced sandbox around arbitrary child processes. A shell command may read files available to the user, use the network, start descendants, consume resources, and modify state outside the project. Cope must state that residual risk honestly rather than claim portable containment it does not provide.

Users who require stronger containment should use hardened mode or run Cope inside a restricted account, disposable worktree, container, VM, operating-system sandbox, or managed endpoint with real filesystem, network, and resource controls.

The governing product and implementation guidance is in [AGENTS.md](AGENTS.md), [Architecture](docs/ARCHITECTURE.md), and [Developer mode target](docs/DEVELOPER-MODE-TARGET.md).

## Security floor retained in developer mode

Developer mode retains controls that protect user authority and execution truth:

- visible supported-browser operation and manual authentication;
- approved Copilot host, identity, conversation, and response correlation;
- no generic browser-control tool exposed to the model;
- durable browser outbox and resolve-before-retry handling;
- harness-owned operation identity and durable operation records;
- no blind replay of uncertain mutations or consequential external actions;
- truthful tool outcomes and independent completion verification;
- no administrator, root, UAC, or other privilege elevation;
- no typed repository access to Cope private state or dedicated browser profiles;
- bounded model-visible output, cancellation, and process-tree cleanup;
- explicit preservation and reporting of pre-existing work;
- outbound secret scanning and redaction where applicable.

These controls do not make a launched executable trustworthy or contained.

## Developer mode

The target developer mode authorizes, after one concise grant:

- project file reads and mutations;
- direct argv and shell execution;
- command-generated source changes;
- normal network-dependent development tools;
- local Git reads and writes;
- installed developer tools and ordinary user environment access.

General terminal authority will be introduced through a separately versioned tool contract. Existing catalog-backed `run_command` semantics remain unchanged for hardened mode and named validation.

Known destructive remote, deployment, publication, or release actions should remain separately visible or authorizable where Cope can identify them. Arbitrary scripts can conceal external effects, so application policy is not complete service-level enforcement.

## Hardened mode

Hardened mode may retain reviewed command catalogs, direct argv only, narrow path grants, declared network hosts, lower budgets, no command-generated source mutation, and isolated execution.

Those restrictions are optional deployment controls. They do not define the default product architecture.

## Current release status

Cope 0.1.9 is a hardened precursor. It does not currently expose arbitrary shell execution, normal command-generated tracked-file mutation, or broad network-dependent developer commands.

That is a current implementation limitation, not a permanent security requirement. Do not use the 0.1.9 restriction set to reject or redesign the documented developer-mode target.

Current operational instructions remain in [Operator guide](docs/OPERATOR-GUIDE.md). They should describe what the released code can actually do until developer mode ships.

## Boundaries and non-guarantees

Cope provides application-level authorization, browser correlation, operation identity, recovery records, repository observation, and completion verification.

It is not inherently:

- a VM, container, or kernel sandbox;
- an anti-malware system;
- a network firewall or enforceable egress controller;
- a credential vault;
- perfect data-loss prevention;
- a secure-delete system;
- a cryptographically anchored audit service;
- a guarantee that passing tests or model reasoning are correct.

Security work should prioritize concrete failures that can break the core agent loop, execute unintended content, lose user work, duplicate consequential actions, expose authentication state, or produce false results. Speculative enterprise hardening should not block useful developer functionality unless the maintainer explicitly makes it a release requirement.
