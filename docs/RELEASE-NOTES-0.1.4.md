# Cope 0.1.4

Cope 0.1.4 fixes a live Windows setup failure caused by Microsoft 365 Copilot page navigation during semantic readiness inspection.

## Fixed

- Setup now discards a pre-dispatch readiness sample that crossed a page transition and takes a fresh, complete sample inside the original manual-readiness deadline.
- Host, page ownership, identity, protection, modal, and composer checks are rerun after every discarded sample; no evidence carries across documents.
- Browser operation timeouts, ambiguous page ownership, native-dialog revocation, possible post-dispatch failures, and other transport errors remain fatal.
- Cancellation wins immediately even when it races a recoverable page-change diagnostic.
- Source-free page-change reasons distinguish navigation epochs, URL changes, page replacement, and authentication precedence without retaining URLs, identities, or page content.

## Distribution

The Windows and macOS installers continue to build, pack, install, and verify the exact package version. Historical release notes remain unchanged.
