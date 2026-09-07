# E13 — Artifact identity is sensitive to harness changes and stable under host changes

Status: VERIFIED BY THE ROOT AGENT on T3a's commit `a1bcb7e`. Extends E11.

## The pair of observations

| commit | what changed | module map sha256 | bytes |
|---|---|---|---|
| `d1f2412` main (T5 + T2 + T1a) | Supervisor rewritten: journal deleted, thread store rewritten | `387ed749...` | 905270 |
| `a1bcb7e` T3a | `src/facet/generation-0/execution-env-paths.ts` and workspace addressing | `d88c8204...` | 905943 |

Both were produced by `scripts/probe/clean-build.sh`, and in BOTH cases the two independent
clean builds inside one run were byte-identical to each other.

## Why this pair matters

E11 showed the map is STABLE when host code changes: T2 rewrote generation control across 36 files
and T5 rewrote the thread store, and the artifact did not move, because the Supervisor is immutable
host code outside the facet.

E13 shows the map MOVES when harness code changes: T3a edits `execution-env-paths.ts`, which is
inside `src/facet/generation-0/` and therefore part of the artifact.

Together they demonstrate the commit-keyed identity ADR-0034 assumes, in both directions:
- a host-side change does not silently invalidate a cached harness artifact, and
- a harness-side change cannot silently reuse the previous artifact.

The second half is the one that protects goal criterion 8: the Worker Loader is keyed by the labeled
harness commit, so "a changed harness commit does not silently reuse old code"
(`docs/agents/design/computer-integration.md`).

## What it still does not prove

Both runs are local, with an isolated store, not on Computer. Goal criterion 7 needs two clean
COMPUTER builds. Goal criterion 8 needs a deliberately different harness commit BUILT, cold-checked,
activated and rolled back through the real paid path. T1b and T12a own those and both wait on Q7.
This is a local pre-check that the mechanism behaves as documented, not the release proof.
