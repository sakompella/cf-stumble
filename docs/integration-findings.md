# S8 integration findings

The in-memory vertical path composes cleanly for generation 0 seeding, pinned turns, candidate
building, replay validation, attested promotion, rollback, reset, and module deduplication.
`pnpm test`, `pnpm typecheck`, and `pnpm lint` pass with 118 tests.

## Supervisor state is not available yet

S8 cannot exercise D17 against the supervisor because `src/supervisor/` is intentionally absent
while S10 is in progress. The test keeps conversation history, learned facts, and corpus entries
in a separate test-owned object, and uses the real `MemoryValidationResultStore` for validation
evidence. Rollback leaves all of them intact, but this proves pointer rollback does not mutate
state passed alongside it; it does not prove Durable Object persistence or supervisor routing.

## The executor seam is supplied by the integration test

The existing validation API accepts a `Sha` and a `ValidationExecutor`, while no production agent
loop yet maps generation modules to either `ReplayAgentLoop` or the four tools. The integration
support therefore reads the generation's policy module, drives the real replay runner and gate,
and runs live turns through `InMemoryWorkspace` and `executePrimitive`. This is a deliberate
scripted executor, not a stub of the gate, but it is not the eventual supervisor agent runtime.

No source slice semantics were changed, and no other integration seam failed in the sequential
path. The remaining S10 work must replace the test-owned accumulated state and scripted executor
with supervisor-owned implementations before D17 and unattended production turns can be claimed.
