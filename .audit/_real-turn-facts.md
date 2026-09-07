# Real turn facts

1. Read the governing design and source. Done.
2. Define the durable attempt and fact shapes, then implement relay recording. Done.
3. Add the pure eligibility policy and its Supervisor read surface. Done.
4. Add real-workerd relay tests and deterministic policy tests. Done. Local cancellation propagation and source stream errors remain unproved.
5. Run formatting and the full verification gate, then inspect the diff. Done. `pnpm verify` passed with 50 tests.

## Throughput checkpoint

- **Blocking first steps.** The fact shape and eligibility contract must exist before relay code and tests use it.
- **Independent workstreams.** The relay ledger and pure policy have a narrow shared type boundary, so their implementation can proceed after that boundary is fixed.
- **Shared mutable state.** Durable relay records serialize in the Supervisor Durable Object because terminal state must settle once.
- **Smallest safe decomposition.** One implementation owner is safest because the Supervisor API, SQLite schema, relay lifecycle, and tests share a contract.

Architect skipped: the supplied outcome set, persistence boundary, and eligibility rules leave no unresolved implementation alternative that warrants a separate design review.
