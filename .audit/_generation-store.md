# Generation store

## Feature

1. `how` over the affected subsystem.
2. `architect` for parallel design exploration. Skipping stays as `architect skipped: <reason>`; do not fold the design decision silently into implementation.
3. Write the throughput checkpoint as four todo items. A dimension that genuinely does not apply (single file, no fan-out) keeps its item with `n/a: <reason>` rather than being dropped:
   - **Blocking first steps.** Gates run before fan-out.
   - **Independent workstreams.** Disjoint files, services, or layers parallelize. Shared writes serialize.
   - **Shared mutable state.** Default to splitting the target (the **separate-before-serializing-shared-state** principle skill). Serialize only for real invariants.
   - **Smallest safe decomposition.** If one worker is best, name why.
4. Delegate code-writing to a subagent using your configured feature model (default `grok-4.6-fast-xhigh`) with a specific scope (file paths, named data shape and its organizing structure per **principle-model-the-domain** — a state machine over scattered booleans, a table/registry over branching, a typed model over repeated shape assumptions, chosen before the delegate writes logic — and success criteria); review its diff yourself. When the implementation admits multiple valid shapes (error handling, abstraction layer, test structure), delegate via the **arena** skill instead so the runners surface the alternatives and the cross-judge guards the pick. Mandatory: no skip-with-reason escape, and Laziness Protocol does not override it (the gain is review separation, not lines saved). You can spawn a subagent even though you are one; "the app is small" and "a subagent cannot spawn one" are both wrong. A subagent forbidden to spawn satisfies this by owning the diff directly with the same review separation; no "standing by" reply that waits on a nested agent. Comments per **Comments**. Surgical edits, re-ground against the source for upstream-derived files. Port shared-primitive improvements to all consumers and verify each. Commit liberally.
5. Verify on the matching surface. "Inconclusive" or wrong-surface is not a pass; flag it.
6. Rebase into small, ordered commits; stack follow-ups.
   Use the **sequence-verifiable-units** principle skill, building, verifying, and committing each small unit before the next.
7. If the design is contested, `interrogate` before shipping.
8. Run **Opening a PR**.

## Architect

- [x] Ground. The Supervisor mounts a fixed main facet and forwards `fetch`. Worker Loader uses the labeled commit, and the new synchronous SQLite store is owned only by the Supervisor Durable Object.
- [x] Sketch. `Generations` is a single SQLite-backed registry. `Generation` contains a numeric label, harness commit, and `candidate | ready | failed` status. Active state is a nullable label plus epoch.
- [x] Agree. A unique harness commit and unique label enforce one-to-one identity. Preparation results only transition a candidate once; any repeat returns the persisted generation without moving epoch.
- [x] Implement. The store schema and narrow Supervisor RPC surface match the sketch.
- [x] Scrap. The implementation introduced no repeated friction or escape hatch that would justify a redesign.

## Throughput checkpoint

- [x] Blocking first steps. Read the domain terms, ADRs, loader, test configuration, and the vitest-pool-workers restart API before changing code.
- [x] Independent workstreams. Store implementation and its real-Durable-Object tests are coupled through one public RPC surface, so serialize them.
- [x] Shared mutable state. A single Supervisor owns one SQLite store per object. Database constraints serialize generation labels and commits.
- [x] Smallest safe decomposition. One owner is safest because all changed files depend on the exact discriminated RPC outcomes and test data shape. No Agent tool is available in this sub-agent harness, so delegation cannot be executed here.

## Assumptions and checks

- Labels are non-negative safe-integer numbers represented as `number` in RPC values and SQLite INTEGER values.
- Harness commits are opaque strings in the store because loader validation owns commit syntax.
- Repeated preparation outcomes, including contradictory results, preserve the first terminal result because a check records one event on one labeled commit and must not synthesize a new generation.
- Verified focused workers tests with `evictDurableObject`, then `pnpm verify` with 17 passing tests.
