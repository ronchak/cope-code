# Release evidence and trust boundaries

Cope can produce deterministic, inspectable npm release evidence from a clean Git
checkout. This is a foundation for a future release service; it is not the release
service itself and is not wired into the current installers or `cope update`.
The builder copies the exact commit's regular Git blobs into a private temporary
directory, installs the locked development toolchain with lifecycle scripts
disabled, and builds there. It rejects source links and submodules, verifies that
the build did not change tracked bytes, snapshots the exact expected TypeScript
outputs, rejects other build-created files outside `node_modules`, and requires
every file in the packed artifact to match the bytes, digest, and portable mode
of either its Git blob or that isolated-build snapshot.
The exact validated artifact digest is then required by evidence generation.
This isolates packaging from ignored or untracked checkout content and detects
post-build file changes; it is not a hermetic compiler or dependency provenance
attestation.

Run an unsigned preview build through npm and place the output outside the
checkout:

```text
npm run release:build -- <new-output-directory> preview
npm run release:verify -- <new-output-directory>
```

The build derives its evidence timestamp from the exact source commit. If
`SOURCE_DATE_EPOCH` is supplied, it must equal that commit timestamp.
The output directory must not already exist. It contains one npm `.tgz`,
`manifest.json`, `channel.json`, and `sbom.spdx.json`. A stable bundle produced by
a future external signer would also contain `manifest.sig.json`. The manifest
records the exact source commit, UTC creation time, Node/npm build toolchain,
artifact bytes and digest, and every regular file inside the npm archive.
Verification rejects links, non-regular archive entries,
absolute or traversal paths, duplicate and case-colliding paths, Windows-reserved
or otherwise non-portable names, concatenated gzip members, unexpected top-level
files, non-portable archive owners/modes/timestamps, non-canonical metadata, and
digest or inventory drift. The manifest also binds the name, version, executable
mapping, and runtime dependency declarations from the packed
`package/package.json`, and requires the mapped CLI target to be present with an
executable archive mode on POSIX builders. npm's Windows packer records the
JavaScript target as an ordinary `0644` file and installs a `.cmd` launcher, so
Windows evidence accepts that platform-specific mode. Generation and verification
bind the same rule to the recorded builder platform; those claims cannot diverge
from what npm installs.

The SPDX 2.3 JSON document describes the Cope artifact and the non-development
runtime packages in `package-lock.json`. Generation requires the packed package,
source package, lockfile root declarations, and resolved lockfile inventory to
agree: each resolved runtime version must satisfy its exact or range declaration,
and npm aliases must also resolve to the declared target package. Other npm
dependency spec types fail closed rather than producing evidence for an
unverifiable resolution. Generation follows and validates every reachable
non-development dependency and optional-dependency edge; optional peers may be
absent only when matching bound `peerDependenciesMeta` marks them optional.
SPDX SHA-256 and SHA-512 values are lowercase hexadecimal. The document and all
other JSON evidence use the
repository's deterministic key-sorted UTF-8 encoding with one trailing newline.
SPDX creation timestamps use whole-second UTC syntax, and each document namespace
contains a digest of all document content plus its source/build identity.
Reproducibility means byte-for-byte equality for the same source and recorded
Node/npm toolchain; CI performs two clean preview builds on every hosted tuple and
compares every output file.

## Signature presence is not publisher authentication

Preview evidence is always unsigned and says `absent-unsigned-development`.
Repository-local build and CLI entry points refuse stable signing and refuse to
run when a signing-key path is present. This repository defines and tests the
stable Ed25519 signature format and its verifier, but it deliberately does not
implement a production signer: protected signing must run in an isolated,
reviewed system that never executes code from the candidate checkout. A signature
covers the exact manifest bytes, including the channel, packed package identity,
and archive inventory. `channel.json` must exactly mirror that signed data.

A bundle-carried public key only proves that the bundle is internally
self-consistent. It does not establish who published it. Verification reports
`signaturePresent` separately from `publisherAuthenticated`. Publisher
authentication requires one of these out-of-band inputs:

```text
npm run release:verify -- <release> --trusted-public-key <approved-ed25519-public-key.pem>
npm run release:verify -- <release> --trusted-key-id sha256:<approved-spki-digest>
```

The trusted public key or key ID must be provisioned through a protected channel,
not copied from the candidate bundle. Production activation requires a trusted
public-key file outside both the candidate and install root. The install root,
trusted-key file, and their parent directories must be protected from untrusted
writers; file-handle identity checks detect path substitution during reads but
cannot compensate for an attacker who controls those roots.

## Transactional activation primitive

`scripts/release/activate.mjs` is an inactive integration primitive. It snapshots
only the bounded set of expected top-level regular files into a
destination-filesystem staging directory, verifies the snapshot against an
external publisher key, and stores it under
`releases/<manifest-sha256>`. It then atomically replaces the small
`activation.json` pointer, which records both the signed version and manifest
digest. Ordinary activation rejects version downgrades and same-version digest
equivocation. The previous pointer remains available only through an explicit,
publisher-authenticated rollback:

```text
node scripts/release/activate.mjs <candidate> <install-root> --trusted-public-key <key.pem>
node scripts/release/activate.mjs --rollback <install-root> --trusted-public-key <key.pem>
```

Activation is serialized with an exclusive `.activation.lock` directory. Stored
bundle files are made read-only before a second verification and publication;
this is defense against accidental mutation, not filesystem immutability. On
POSIX hosts, file and directory synchronization durably orders release storage
before pointer publication. Node does not expose the directory-handle flags
needed for the equivalent Windows directory flush, so Windows power-loss
durability is not claimed; atomic rename still prevents a partially written
pointer from being observed during normal operation. A hard crash can leave a
stale lock, a partial `.staged-*` directory, a temporary `.activation-*.json`, or
an unreferenced complete release. Operators must verify that no activation is
running before removing a stale lock. The next operation cleans recognized
temporary residue after acquiring the lock. Consumers must resolve
`activation.json` and reverify its selected release; the current Cope launchers do
neither yet. Strong install-root
ACLs, retention, health checks, download policy, trust-root rotation/revocation,
and automated stale-lock recovery remain future integration work.

## What remains unsigned today

The Windows and macOS installers still build and install a packed artifact from a
reviewed local checkout. `cope update` still rebuilds from `COPE_SOURCE_DIR`.
Neither path downloads or activates this release evidence, and neither gains
publisher authentication from this change. CI creates unsigned preview evidence
only. This tooling does not provide Authenticode, Apple Developer ID signing,
notarization, a production signing service, protected release environments, key
custody, publication, or a supported live-platform certification.
