# Resume note

## Intent

Replace the interim Supervisor SQLite module-map store with an R2 cache backed by Computer rebuilds on cache miss.

## Approved and committed

`d7c9e1d` and earlier implement locally verified active-generation serving through `HarnessArtifacts`. `pnpm verify` passed with 138 tests. ADR-0034 records the later human-approved target. The target keeps the labeled harness commit as the only Worker Loader identity, treats commits as reproducible for now, uses R2 as an evictable derived cache, and forbids completed module maps in Supervisor SQLite.

## Current state

The code still uses `src/supervisor/harness-artifacts.ts` and the `harness_artifact_modules` SQLite table. It does not conform to ADR-0034 yet. There is no Computer runtime adapter, R2 binding, `@cloudflare/computer` package dependency, or real build command in the repository. No deployment, provider call, dependency change, or R2 configuration was performed.

## Evidence

- `docs/agents/adr/0034-cache-rebuildable-module-maps-in-r2.md` contains the approved decision.
- `docs/agents/design/_computer-r2-materialization-plan.md` contains the unapproved details and spike requirements.
- `.audit/active-generation-serving.tsv` contains the prior active-serving trail.
- Sol and Opus agreed that a paid Computer plus Worker Loader spike must precede deletion of the working SQLite path.

## First action on resume

Design and run the paid Computer, R2, Worker Loader materialization spike after obtaining explicit deployment, binding, and dependency approval. Do not delete `HarnessArtifacts` first.

## Latest checkpoint

Approved R2 cache decision committed as `29e9edd`. `pnpm verify` passed with 138 tests. The first resume action remains the paid Computer, R2, and Worker Loader spike.
