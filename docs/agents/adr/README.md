# Architecture decisions

This directory records current decisions. Every ADR declares whether a human approved it or an agent recorded it without human approval. Read the human-approved decisions first: they take precedence over agent-only records when the two conflict. When a decision no longer applies, delete its ADR; Git retains the historical record. `test/docs/adr-index.test.ts` checks that this index names every ADR in the directory.

## Human-approved decisions

- **[ADR-0002](0002-generations-are-materialization-attempts.md)**: a generation is one specific, labeled Git commit in the harness repository.
- **[ADR-0003](0003-supervisor-sqlite-controls-activation.md)**: the primary Supervisor Durable Object checks requested generation changes and alone updates protected generation and recovery state.
- **[ADR-0024](0024-facet-owns-the-evolvable-harness.md)**: the main facet owns all mutable harness code and may request generation changes; the recovery harness remains outside every generation.
- **[ADR-0026](0026-adopt-computer-for-facet-work-environment.md)**: use the verified Computer source and image pair, without fixing the workspace layout or Worker artifact format.
- **[ADR-0027](0027-use-labeled-commit-as-loader-identity.md)**: the labeled harness commit ID is the Worker Loader identity.

## Agent-only decisions

- **[ADR-0022](0022-one-decision-register-kept-indexed.md)**: this directory is the single register for current decisions, and its index is checked.
- **[ADR-0023](0023-agent-generated-docs-live-under-docs-agents.md)**: agent-authored records live under `docs/agents/`.
- **[ADR-0028](0028-harness-artifacts-are-module-maps.md)**: a generation's executable form is a module map, and a bundle is a one-module map.
- **[ADR-0029](0029-startup-check-is-an-ordinary-request.md)**: a generation's startup check is one bounded ordinary request, not a health protocol.
- **[ADR-0030](0030-generation-requests-are-journaled-and-epoch-bound.md)**: generation requests are epoch-checked and journaled by request ID.

## Adding a decision

Add an ADR only for a durable decision with a real alternative, then add it to this index. Keep the record short and delete it when the decision no longer applies.
