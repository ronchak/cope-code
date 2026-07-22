# Release supply chain foundation

Cope can build a platform-labelled npm artifact with deterministic metadata:

```text
SOURCE_DATE_EPOCH=<commit epoch> npm run release:build -- release-out preview
node scripts/release/verify.mjs release-out
```

The output contains the package artifact, `manifest.json`, SPDX 2.3 `sbom.spdx.json`, and stable/preview `channel.json`. Timestamps derive from `SOURCE_DATE_EPOCH` (or the source commit), dependency order and JSON keys are canonical, and all payloads are SHA-256 bound.

This repository does not contain a production signing key and must not claim signed distribution by default. Without `COPE_RELEASE_SIGNING_KEY_FILE`, channel metadata says `unsigned-development`. When CI supplies an Ed25519 PKCS#8 PEM through an approved secret mechanism, generation emits `manifest.sig.json`; production activation requires that signature. A production deployment must pin trusted key IDs outside the release bundle—embedded public-key self-consistency alone is not publisher identity.

`activate.mjs <candidate> <install-root>` requires `COPE_RELEASE_TRUSTED_KEY_ID`, verifies a signed candidate against that externally pinned publisher key ID before copying it, stages on the destination filesystem, rotates `current` to `previous`, and restores `previous` if final activation fails. It never edits the source checkout. This is a transaction primitive, not a complete updater: a future updater must add managed trust-root delivery, download transport policy, platform code-signing/notarization, health checks, locking, retention, and an explicit rollback command.

CI builds and verifies unsigned preview evidence only. Stable publication and production signing remain disabled until release ownership, protected environments, key custody/rotation/revocation, Windows Authenticode, Apple Developer ID/notarization, and incident rollback are approved.
