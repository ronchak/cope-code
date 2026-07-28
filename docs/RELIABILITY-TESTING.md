# Reliability testing

Cope's reliability harness exercises selected high-risk local runtime, transport, operation-journal, patch/checkpoint, and audit boundaries without a browser or network. It is deterministic by default and intentionally bounded in pull-request CI.

## Commands

- `npm run test:reliability` runs one deterministic pass over each hard-exit boundary plus 24 seeded iterations for each bounded fuzz/soak scenario.
- `npm run test:reliability:soak` runs 200 iterations for local or scheduled soak evidence.
- `npm run test:coverage` runs the reliability suite plus current session/setup and disclosure-budget recovery tests with explicit production-file denominators and minimum line, branch, and function floors.

Set `COPE_RELIABILITY_SEED` to an integer from 1 through 4294967295 to reproduce a run. Each scenario derives a nonzero unsigned seed from that base value; failure diagnostics record both values, and the base value is the one to reuse. `COPE_RELIABILITY_ITERATIONS` accepts 1 through 500. Failures write an allowlisted, source-free JSON diagnostic containing only scenario/seed identifiers, error type, and an error-message fingerprint to `COPE_RELIABILITY_ARTIFACT_DIR` when configured. On failure, CI retains only those JSON files for seven days; raw test and coverage output is not copied into the artifact.

Child processes hard-exit immediately after real durable commits and the parent reconstructs from disk. The bounded matrix covers prepared/submitted/answered exchange state, accepted/executing/completed operation journals, durable session effects, mutation side effects, checkpoint creation, worktree commit, and checkpoint sealing. It asserts safe replay, exactly-once delivery/execution, or fail-closed pause/explicit rollback. The full suite runs this matrix on all four hosted platforms; one Linux pull-request lane also enforces selected-source coverage floors without rerunning the reliability tests twice in that job.

These tests are regression evidence, not live browser certification, power-loss proof, exhaustive injection at every commit point, or exhaustive state-space exploration. Coverage percentages are implementation guardrails, not reliability or requirement coverage claims. Release evidence should record the exact commit, base seed, iteration count, host tuple, coverage output, and any retained diagnostics.
