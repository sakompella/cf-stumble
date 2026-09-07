# E6 — There is no HTTP surface for a project turn; the coding half of v0 is unreachable

Status: CONFIRMED by the root agent. Blocks goal criteria 4, 5 and 6.
Sharpens architecture-critique finding 1 and roadmap tasks T9 and T10.

## Route inventory

Every path the owner API serves (`src/routes/owner-api.ts`):

```
/api/status
/api/generations/submit
/api/generations/activate
/api/generations/rollback
/api/recovery/latest
/fresh
```

Supervisor methods those routes reach: `getActiveGeneration`, `getProjectThread`,
`startFreshProjectThread`, and the generation-control ones.

## What is missing

`Supervisor` exposes `startProjectTurn` (226), `finishProjectTurn` (236),
`abandonProjectTurn` (248) and `streamProjectTurn` (265). Searching all of `src` outside
`supervisor.ts` for those four names returns ONE match: the internal helper
`src/supervisor/projects/project-turn.ts:84`. No route calls any of them.

So the generation-control half of v0 is wired to HTTP, and the coding-agent half is not
reachable from a browser at all. A turn cannot be started, streamed, saved, or cancelled
over HTTP today.

## The code already says so

`src/supervisor/supervisor.ts`, doc comment on `streamProjectTurn`:

> "It reads and writes no thread, so a caller drives both halves — take the lease, stream
> the turn, then save the `state.messages` the terminal frame carries ... **Joining them is
> the next unit's work**, because it has to settle what a disconnected browser leaves
> behind (ADR-0037), not merely call the two in order."

The codebase concedes the gap. T9 is that unit. But T9 is bigger than "join two halves":
there is no HTTP entry point to join them behind, and T10's page has nothing to call.

## Consequences for the roadmap

- T9 must create the turn route surface, not only the Supervisor-side join. Size it as L.
- T10 cannot be a page-only task if T9 does not deliver the endpoints it consumes. Confirm
  the split, or T10 blocks on an interface that does not exist.
- Goal criterion 6 ("a rejected, failed, truncated, cancelled, or unsaved turn earns no
  completed-real-turn credit") is untestable end to end until this surface exists.

## Two smaller facts found in the same read

1. **T3/T5 partition holds, at region level.** T5 edits `supervisor.ts` lines 226-263 plus
   `threads/project-threads.ts` and `threads/store.ts`. T3 edits the constructor (74-88) plus
   `workspace-names.ts` and `artifacts/build-workspace.ts`. Same file, different regions:
   the wave-1 manager must merge and re-run the gate, as the dispatch contract says.
2. **The Supervisor builds its threads with no catalog.** `supervisor.ts:87` is
   `new ProjectThreads(ctx.storage)` — the optional `catalog` argument is omitted, so
   `resolveProject` falls back to the default two-placeholder catalog (E4). T6 must pass a
   real catalog here, and this line is inside T3's constructor region, so T3 and T6 touch it.

## The constructor confirms E3 in the code's own words

> "A cache miss builds the labeled commit in the harness build workspace, which is a
> separate Workspace Host from the project workspace and is named by a module constant."
