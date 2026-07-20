# Cope 0.1.2

Cope 0.1.2 fixes the first live target-machine Edge transport failures found after 0.1.1.

## Fixed

- The dedicated Edge context no longer remains pinned to a startup `about:blank` tab.
- Replacement Copilot and genuine Microsoft authentication tabs are tracked, bounded, and brought forward without repeated focus stealing.
- Only the configured Copilot origin and chat path can become submission-capable.
- Unrelated M365 and Office pages cannot qualify as authentication redirects by host alone.
- Persistent unknown and other non-authentication browser states now return a bounded diagnostic instead of appearing hung for the full manual-authentication window.
- The current Microsoft 365 Copilot locator contract covers the live composer and account-control variants while preserving identity, protection, host, and actionability gates.
- Exact email identity matching, ordered display-name matching, assistant-response ownership, replacement-page timeouts, and alternating hostile readiness states are regression-tested.

## Distribution

The Windows installer still performs the same packed global installation. Its banner and post-install version assertion now require 0.1.2. Historical 0.1.1 release notes and documentation remain unchanged.
