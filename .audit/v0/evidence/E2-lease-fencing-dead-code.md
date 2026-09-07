# E2 — Turn lease fencing is dead code; the client surface cannot use it

Status: CONFIRMED by the root agent. Blocks goal criterion 6.
Sharpens architecture-critique finding 1 and roadmap task T5.

## The fault

`src/supervisor/threads/store.ts` exposes two parallel sets of turn methods:

| lease-aware | lease-discarding |
|---|---|
| `startTurnWithLease` | `startTurn` |
| `finishTurnWithLease` | `finishTurn` |
| `abandonTurnWithLease` | `abandonTurn` |

`startTurn` is a wrapper that throws the lease away:

```ts
const started = this.startTurnWithLease(project, expectedRevision, now, leaseMs);
return started.ok ? succeeded(started.lease.thread) : rejected(started.problem);
```

`src/supervisor/threads/project-threads.ts` — whose own doc comment calls it "the thread
surface a client reaches" — calls ONLY the lease-discarding three. `src/supervisor/supervisor.ts`
re-exports those same three over RPC at lines 233, 244, and 249.

`grep -rn "WithLease" src test` returns matches in `store.ts` and nowhere else.
The lease-aware methods have **no caller and no test**. The `turn_lease_id` column is
written on start and never checked on finish or abandon through any reachable path.

## Consequence

A caller never receives the lease id, so it cannot return one. A turn that was
superseded — by a lease expiry, a fresh thread, or a second client — can still call
`finishTurn` or `abandonTurn` and write into the replacement turn's thread. Two browsers
on the same project is a supported v0 configuration, so this is reachable, not theoretical.

## Why it blocks v0

Goal criterion 6: "Tested lease fencing prevents stale completion or cancellation from
changing a replacement turn." No test can pass through the current public surface,
because the surface has no parameter to carry the lease.

## Deletion test

Deleting `startTurnWithLease`/`finishTurnWithLease`/`abandonTurnWithLease` today would
concentrate no complexity: nothing calls them. That is the tell. The pair exists because
the fencing was built and then never threaded through the seam above it.

The fix runs the other way: make the client surface lease-aware — `startTurn` returns the
lease id, `finishTurn` and `abandonTurn` require it — then DELETE the unfenced variants so
the unsafe path cannot be reintroduced. Deleting the safe ones instead would concentrate
the fault permanently.

## Scope note for T5

T5 owns thread RPC wrappers only; T3 owns Supervisor construction and workspace wiring.
This change touches `store.ts`, `project-threads.ts`, and the three `supervisor.ts` method
bodies. Confirm that partition holds before T3 and T5 run in the same wave.
