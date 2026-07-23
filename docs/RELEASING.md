# Release version workflow

`package.json` is the single authority for the current Cope release version. The CLI and the macOS and Windows installers read that metadata at runtime. `package-lock.json` repeats the root version because npm requires it, and verification treats those lockfile fields as derived copies that must match the manifest.

To prepare a version change:

1. Run `npm version <version> --no-git-tag-version --ignore-scripts` so npm updates both manifest and lockfile metadata.
2. Add a new versioned release-notes file. Never rewrite prior release notes or historical incident records merely to match the current version.
3. Run `npm run verify:release-version`, then `npm run check`.
4. Build the candidate artifact from the verified commit and apply the repository's live release gates.

The verifier rejects release-like literals on active runtime, installer, current Windows install-documentation, and UI-test surfaces. The Windows target inventory occurrence-allows its OS, Node, npm, and Git version values because they are target evidence, not Cope releases. The verifier deliberately does not scan versioned release notes, historical plans, or incident records, where exact past versions are evidence rather than drift.
