# Erratum: banner provenance is the protocol label, not Microsoft's prose

Applies to: `docs/PRD-0.1.9-PROTOCOL-INGESTION.md`

Status: correction adopted in 0.1.10. The 0.1.9 PRD is left unedited as a
record of what that release actually decided and shipped; this erratum states
what is true now and why the earlier decision was wrong.

Verification scope: the reported Windows/Edge failure and its reason code are
known, but this worktree has not observed the current live M365 banner wording
and has not passed live Windows/Edge acceptance. Installed-Chromium tests use
synthetic DOM fixtures; they exercise the real extraction code without
attesting the current service DOM or prose.

## What 0.1.9 specified

The 0.1.9 PRD treats the complete English M365 information-banner sentence as
an immutable capture contract. It specifies an "exact expected M365 banner",
routes an "exact-banner-match enum" into capture classification, and states the
design rule directly:

> Do not add fuzzy banner matching. A changed M365 banner is a UI contract
> change […]

That was implemented literally. `RESPONSE_PROTOCOL_DESCRIPTORS` stored two full
sentences, including the U+2019 apostrophe in "isn’t":

```
cba-agent/1 isn’t fully supported. Syntax highlighting is based on Plain Text.
```

The in-page classifier extracted a supported protocol label from the banner and
then compared the **entire banner string** against that stored sentence. Any
difference produced `changed_supported_banner`, which the host normalizer mapped
to `unsupported_capture_contract` with reason code
`PROTOCOL_WIDGET_BANNER_CONTRACT_CHANGED`.

## Why that was wrong

The stored sentence conflated two things with very different stability:

- **the protocol label** (`cba-agent/1`, `cba/1`) — chosen by Cope, emitted by
  the model, and genuinely load-bearing for executable provenance; and
- **the sentence Microsoft wraps around it** — vendor UI chrome that Microsoft
  may reword, repunctuate, recapitalize, reflow, or localize at any time,
  without notice and without changing the widget's structure or meaning.

Gating execution on the second made every such change a total outage of the
response path, presenting as an unexplained pause rather than as a UI drift
signal. A response could satisfy every property that actually establishes
provenance — one response-owned `.scriptor-component-code-block`, one banner,
one supported label, one read-only editor, contiguous line indices, bounded
bytes, valid JSON, matching dialect, successful host envelope reconstruction —
and still be refused solely because a period, an apostrophe, a non-breaking
space, or a translation had changed.

The blast radius was wider than the executable path: the 0.1.8 legacy `cba/1`
correlation predicate used the same full-sentence equality, so prose drift also
silently rebound old response baselines onto rendered text.

The failure mode was also undiagnosable from the outside. Evidence recorded only
that "the banner contract changed", never *how*, so distinguishing a Microsoft
wording change from a structural capture regression required a live reproduction.

## What is true in 0.1.10

Executable provenance requires, unchanged in strictness:

- a `.scriptor-component-code-block` owned by the assistant response;
- exactly one informational banner owned by that block;
- **exactly one boundary-safe supported protocol label** in that banner, either
  `cba-agent/1` or `cba/1`;
- exactly one read-only Code editor;
- contiguous `data-line-index` values from zero or one;
- bounded editor bytes with an exact byte-count match;
- host-side envelope reconstruction that reproduces the captured bytes;
- a JSON body whose dialect agrees with the declared label.

What changed is only this: the surrounding sentence is no longer an execution
gate. It is recorded instead, as `bannerMatchesBaseline` plus `bannerVariant`,
a 32-bit identifier of the label-masked, case- and whitespace-folded vendor
banner chrome. Eligible Code-editor descendants are removed before label
classification and hashing, so editor/body bytes cannot affect either field.

This is **not** fuzzy matching, and the 0.1.9 prohibition it appears to relax
still holds in substance. The label itself is still matched exactly, with
non-consuming boundary assertions on both sides, so `cba-agent/10`,
`cba-agent/1.0`, `xcba-agent/1`, and `cba_agent/1` are all distinct from
`cba-agent/1` and none of them is executable. Unicode letters, numbers, and
combining marks are also treated as identifier adjacency, while Unicode
punctuation remains a valid separator. JSON shape is still never capture
authority. What was removed is authority that Microsoft's prose never should
have had.

Two conditions remain fail-closed and are unchanged or strengthened:

- an unsupported label (`cba-agent/2`, `cba-agent/10`, dotted or glued
  lookalikes) is still non-executable;
- a banner carrying **more than one** protocol label is now explicitly rejected
  as `PROTOCOL_WIDGET_BANNER_LABEL_AMBIGUOUS` rather than resolved by taking the
  first match, closing a gap the 0.1.9 single-`exec` scan left open.

`PROTOCOL_WIDGET_BANNER_CONTRACT_CHANGED` is no longer emitted. The
`unsupported_capture_contract` status remains reachable through
`PROTOCOL_WIDGET_NOT_OWNED`.

## Diagnostic consequence

A future Microsoft banner change is now visible without a live-response mystery.
A response that still carries one owned supported label keeps executing, and the
drift shows up as `bannerMatchesBaseline: false` in capture evidence and audit.
Normalized prose changes also change `bannerVariant`; case- or whitespace-only
drift may intentionally retain the same folded variant. When some other condition
does force a pause, both fields reach the browser-capture diagnostic. If Microsoft
ever removes the protocol label itself, that is a genuine contract change and the
widget correctly stops being executable.

## Scope note on `cope doctor`

`cope doctor`'s protocol-capture probe runs the host normalizer against
synthetic fixtures only. In 0.1.9 its wording implied broader verification than
it performed. It now covers the fail-closed banner branches as well as
reconstruction, and it states explicitly that it does not open a browser and
does not verify live M365 widget or banner compatibility. Installed-Chromium
capture tests (`npm run test:chromium-safety`) render synthetic fixtures in a
real browser and cover the in-page extraction seam, but they are not live M365
acceptance.
