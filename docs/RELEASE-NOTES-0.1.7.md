# Cope 0.1.7

Cope 0.1.7 makes disclosure-budget exhaustion survivable and fixes the
repository-listing policy mismatch that prevented routine documentation
inspection. The package manifest remains the single release-version authority;
the CLI, installers, lockfile, README release pointer, and release verification
derive from or are checked against that value.

## Resumable budget exhaustion

- Data-bearing tool results stop before a reserved 64 KiB control-plane window.
  Source-free decisions, denials, and repair notices can still be returned when
  the data budget is spent. The final 8 KiB is reserved exclusively for one
  byte-capped emergency `cba/1` notice.
- An outbound `BUDGET_EXCEEDED` condition pauses the session instead of marking
  it failed. Paused state retains the journal, queued outbound notice,
  checkpoints, and pending recovery evidence.
- The compact queued notice identifies current usage, the applicable limit, and
  the minimum useful expansion. Resuming submits that already-charged notice
  without replaying or recharging completed work.
- Data-plane disclosure exhaustion and other recoverable session budgets offer
  a local, higher-policy-bounded raise-and-continue approval before pausing. The
  decision is journaled and integrity-bound before the expanded grant is
  persisted. The prompt targets the effective higher-layer ceiling, avoiding a
  new approval request on every subsequent turn or operation.
- If the recovery approval prompt is unavailable, both data-plane and
  control-plane paths complete the synthetic request with an integrity-bound
  default-deny decision, clear it from pending work, and pause instead of
  failing or poisoning later completion. Operator guidance now states that the
  durable deny cannot re-prompt under the same recovery request.
- Startup reconciles the exact artifact/journal/session-state interruption
  windows around that default deny, including a missing first artifact write
  (which retries the operator prompt) and a completed journal whose pending
  session state had not yet persisted.
- Default organization and repository budgets provide four-times working
  headroom only for elapsed time, turns, operations, and disclosed bytes.
  Read-file, mutation, command, command-output, and protocol-repair ceilings
  retain their previous absolute bounds.
- A configuration with no strict higher-layer headroom is identified in the
  bootstrap contract and returns `BUDGET_EXPANSION_UNAVAILABLE` at exhaustion,
  naming the blocking layer instead of offering or recommending an impossible
  session approval. Its diagnostic explains that changed policy cannot be
  rebound on resume: update policy through the governed configuration process
  and start a new session.
- Terminal output now surfaces the budget diagnostic and remediation instead of
  showing only `Task failed`.

## Deterministic repository inspection

- `list_files` defaults and explicit result counts are clamped downward to the
  effective per-operation policy ceiling. The applied result count is returned
  as structured metadata and ordinary truncation remains explicit.
- Authorization and repository execution receive the same policy-derived
  bounds through runtime composition.
- Disclosure projection scales with the applied entry count instead of charging
  the maximum listing size for every request.
- Repository-wide patterns consistently include root for `**`, `./**`, and
  `**/*`; narrower patterns remain narrow, and deny precedence is covered.
- Model operation identifiers reject Windows reserved device names before they
  can become journal filenames.

## Capability safety

- Budget expansion must exceed both the effective live limit and current usage.
  Equal, lower, or already-consumed limits are rejected with structured
  `current_limit`, `current_usage`, and `minimum_acceptable` evidence.
- Standalone capability requests that cannot change the effective grant are
  rejected locally without presenting a no-op approval prompt.

## Verification

- Regression coverage drives the real outbound serialization boundary past the
  data ceiling, asserts a durable paused state, resumes it, and proves the
  completed operation is not replayed or charged twice.
- A process-restart regression verifies a production-format `cba/1` emergency
  notice fits its reserved cap, survives state reload, and prevents replay of
  the answered model turn. A separate regression raises an exhausted ordinary
  operation budget and continues the cached turn exactly once.
- Policy tables cover listing ceilings below, at, and above the product default;
  budget tests cover effective-limit and live-usage floors; path tests pin both
  allow and deny behavior at repository root.
- The synchronized release-version verifier checks package metadata, lockfile,
  README, release-note selection, CLI derivation, and installer derivation.
