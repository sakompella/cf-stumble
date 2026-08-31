# Architecture decisions

This directory records current decisions. Every ADR declares whether a human approved it or an agent recorded it without human approval. Read the human-approved decisions first: they take precedence over agent-only records when the two conflict. When a decision no longer applies, delete its ADR; Git retains the historical record. `test/docs/adr-index.test.ts` checks that this index names every ADR in the directory.

## Human-approved decisions

- **[ADR-0002](0002-generations-are-materialization-attempts.md)**: a generation is one specific, labeled Git commit in the harness repository.
- **[ADR-0003](0003-supervisor-sqlite-controls-activation.md)**: the primary Supervisor Durable Object checks requested generation changes and alone updates protected generation and recovery state.
- **[ADR-0024](0024-facet-owns-the-evolvable-harness.md)**: the main facet owns all mutable harness code and may request generation changes; the recovery harness remains outside every generation.
- **[ADR-0026](0026-adopt-computer-for-facet-work-environment.md)**: use the verified Computer source and image pair, without fixing the workspace layout or Worker artifact format.
- **[ADR-0027](0027-use-labeled-commit-as-loader-identity.md)**: the labeled harness commit ID is the Worker Loader identity.
- **[ADR-0033](0033-epoch-versions-generation-control-state.md)**: the generation-control epoch changes only when generation-control state changes.
- **[ADR-0034](0034-cache-rebuildable-module-maps-in-r2.md)**: R2 caches rebuildable module maps under the labeled harness commit, while Computer rebuilds cache misses.

## Agent-only decisions

- **[ADR-0022](0022-one-decision-register-kept-indexed.md)**: this directory is the single register for current decisions, and its index is checked.
- **[ADR-0023](0023-agent-generated-docs-live-under-docs-agents.md)**: agent-authored records live under `docs/agents/`.
- **[ADR-0028](0028-harness-artifacts-are-module-maps.md)**: a generation's executable form is a module map, and a bundle is a one-module map.
- **[ADR-0029](0029-startup-check-is-an-ordinary-request.md)**: a generation's startup check is one bounded ordinary request, not a health protocol.
- **[ADR-0030](0030-generation-requests-are-journaled-and-epoch-bound.md)**: generation requests are epoch-checked and journaled by request ID.
- **[ADR-0031](0031-relay-facts-decide-known-good.md)**: the supervisor records relay attempts and derives known-good eligibility from their terminal outcomes.
- **[ADR-0032](0032-recovery-bounds-an-episode-it-does-not-perform.md)**: recovery picks an evidence-backed fallback and bounds repair and startup checking it does not perform.
- **[ADR-0035](0035-use-better-result-only-inside-process-boundaries.md)**: better-result represents recoverable failures only inside one Worker isolate; public and durable boundaries keep plain values.

## Adding a decision

Add an ADR only for a durable decision with a real alternative, then add it to this index. Keep the record short and delete it when the decision no longer applies.
