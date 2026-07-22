# Reliability testing

Cope's reliability harness exercises the local runtime, transport, operation journal, patch/checkpoint, and audit boundaries without a browser or network. It is deterministic by default and intentionally bounded in pull-request CI.

## Commands

- `npm run test:reliability` runs 24 seeded iterations for each critical-boundary scenario.
- `npm run test:reliability:soak` runs 200 iterations for local or scheduled soak evidence.
- `npm run test:coverage` uses Node's native test coverage over the critical runtime and persistence suites.

Set `COPE_RELIABILITY_SEED` to an integer from 1 through 4294967295 to reproduce a run. `COPE_RELIABILITY_ITERATIONS` accepts 1 through 500. Failures write a source-free JSON diagnostic containing the scenario, seed, and error to `COPE_RELIABILITY_ARTIFACT_DIR` when configured. CI uploads that directory, including its coverage report, for 14 days.

The fault schedule names runtime commit boundaries and can inject after each deterministic checkpoint. Persistence scenarios model accepted-versus-executing journal crashes, corrupt audit bytes, repeated patch/apply/rollback, and duplicate transport submissions. These tests are regression evidence, not live browser certification, OS process-containment proof, or exhaustive state-space exploration. Release evidence should record the exact commit, seed, iteration count, host tuple, coverage output, and any retained diagnostics.
