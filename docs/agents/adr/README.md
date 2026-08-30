# Architecture decisions

This directory records current decisions. When a decision no longer applies, delete its ADR; Git retains the historical record. `test/docs/adr-index.test.ts` checks that this index names every ADR in the directory.

## Harness and recovery

- **[ADR-0002](0002-generations-are-materialization-attempts.md)**: a generation is one numbered main-harness preparation attempt, separate from any Git commit used as its source.
- **[ADR-0003](0003-supervisor-sqlite-controls-activation.md)**: the primary Supervisor Durable Object checks requested generation changes and alone updates protected generation and recovery state.
- **[ADR-0024](0024-facet-owns-the-evolvable-harness.md)**: the main facet owns all mutable harness code and may request generation changes; the recovery harness remains outside every generation.
- **[ADR-0027](0027-separate-artifact-and-mount-identities.md)**: the supervisor uses a reusable artifact digest and a distinct per-generation mount key.

## Workspace

- **[ADR-0026](0026-adopt-computer-for-facet-work-environment.md)**: use the verified Computer source and image pair, without fixing the workspace layout or Worker artifact format.

## Documentation

- **[ADR-0022](0022-one-decision-register-kept-indexed.md)**: this directory is the single register for current decisions, and its index is checked.
- **[ADR-0023](0023-agent-generated-docs-live-under-docs-agents.md)**: agent-authored records live under `docs/agents/`.

## Adding a decision

Add an ADR only for a durable decision with a real alternative, then add it to this index. Keep the record short and delete it when the decision no longer applies.
