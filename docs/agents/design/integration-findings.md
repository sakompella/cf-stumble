# S8 integration findings

The in-memory vertical path composes generation 0 seeding, pinned turns, candidate building, replay validation, attested promotion, rollback, reset, and module deduplication. At this point, `pnpm test`, `pnpm typecheck`, and `pnpm lint` passed with 118 tests.

## Supervisor state was not available

S8 could not test ADR-0003's requirement that the compatibility corpus live outside generations because `src/supervisor/` was absent while S10 was in progress. The test kept conversation history, learned facts, and corpus entries in a separate test-owned object, and used `MemoryValidationResultStore` for validation evidence. Rollback left that state intact. This showed that pointer rollback did not alter accompanying state; it did not show Durable Object persistence or supervisor routing.

## The integration test supplied the executor seam

The validation API accepted a `Sha` and a `ValidationExecutor`, but no production agent loop mapped generation modules to `ReplayAgentLoop` or the four primitives. The integration support read the generation policy module, used the real replay runner and gate, and ran turns through `InMemoryWorkspace` and `executePrimitive`. This executor was scripted, not a gate stub, but it was not the eventual supervisor runtime.

S8 did not change source-slice semantics, and the sequential path found no other failed seam. S10 needed to replace the test-owned accumulated context and scripted executor with supervisor-owned implementations before the project could claim ADR-0003 or unattended production turns.
