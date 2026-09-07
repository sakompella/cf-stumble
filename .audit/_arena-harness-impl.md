# Arena: Pi-derived harness + mutable web UI implementation plan

Artifact: one implementation plan a fresh agent can execute with no prior context.

## Phases

1. Frame
2. Fan out
3. Cross-judge
4. Pick
5. Graft
6. Verify

## Phase A: Frame

- [x] Artifact stated: `PLAN.md` (executable implementation plan) + `RATIONALE.md` per candidate.
- [x] Grounding written to `.audit/_harness-impl-grounding.md`.
- [x] Rubric derived (6 criteria, below). Candidates do not see it.
- [x] Runners picked from `models.md` `arena runners`: `anthropic/claude-opus-5`,
      `openai-codex/gpt-5.6-sol`, `anthropic/claude-sonnet-5`, `openai-codex/gpt-5.6-terra`.
- [x] Output paths assigned: `/tmp/arena-harness-impl/candidate-{1..4}/`. No shared write target.

### Rubric

1. **ADR compliance.** Honors ADR-0002 (generation = labeled harness commit), ADR-0024 (facet owns
   mutable harness), ADR-0027 (commit is Loader identity, no separate digest/mount key), ADR-0029
   (startup check is an ordinary request), ADR-0032 (recovery bounds, does not perform),
   ADR-0034 (module maps cached in R2, rebuildable). Names any conflict it creates instead of
   silently violating one.
2. **Vendoring concreteness.** Names exact upstream directories taken at v0.84.4, where they live
   relative to the mutable harness, how `pnpm verify` stays green across vendored code
   (tsc strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`, oxlint type-aware,
   oxfmt, `test/docs/module-seams.test.ts`), and a repeatable re-pin procedure.
3. **Placement decision is falsifiable.** Picks facet-hosted Pi core or container-hosted Pi,
   cites which upstream files support the claim, and names the first probe that could kill it.
4. **Seam types.** Concrete TypeScript for the Computer `ExecutionEnv`, the session store, the
   shell-to-UI message contract, and the harness-to-Supervisor generation surface. Small, typed,
   no plugin/extension registry, no `any`/`unknown` grab bags.
5. **Turn completion and relay evidence.** Fixes `bodyOutcome` in `src/supervisor/relay/index.ts`
   so a truncated SSE stream is not credited, and defines what counts as a completed real turn.
6. **Slice sequence.** 4-6 ordered slices, each ending in a named check (`pnpm verify`, a workerd
   test, or a named paid probe), each landable alone, with stop conditions and an out-of-scope
   list. Executable by a fresh agent with no session context.

## Phase B: Fan out

- [x] Four candidates spawned in one message, background, each with grounding path + own output dir.
- [x] Rationale required from each (alternatives considered, what was rejected).
- [x] Dropouts recorded: none.

## Phase C: Cross-judge

- [x] Judge model `openai-codex/gpt-5.6-sol` (different family from parent).
- [x] Read-only judge, sees rubric + candidate paths, scores each criterion, recommends a base.

## Phase D: Pick

NOTE: Phases D-F were pre-filled at Phase A with an invented outcome (base = candidate 1, judge
agreeing). That was wrong and is corrected below with what actually happened. Do not pre-fill
results into this file again; only phase titles and intent belong here before a phase runs.

- [x] Read all four end to end.
- [x] Score criterion by criterion, compare with cross-judge, record pick + reason.

My first-pass scores put candidate 1 top on the strength of its findings. Checking its ADR-0034
handling against the ADR text overturned that: ADR-0034 requires a cache miss to rebuild through
Computer, candidate 1 returns a problem code instead, and it never names the conflict.

| Candidate | ADR | Vendor | Placement | Seams | Completion | Slices | Mine | Judge |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| 1 opus-5 | 2 | 5 | 5 | 3 | 3 | 4 | 22 | 20 |
| 2 sol | 5 | 4 | 5 | 5 | 5 | 3 | 27 | 26 |
| 3 sonnet-5 | 4 | 1 | 3 | 2 | 0 | 2 | 12 | 11 |
| 4 terra | 5 | 4 | 5 | 3 | 5 | 3 | 25 | 24 |

Base: candidate 2 (`gpt-5.6-sol`). Cross-judge independently picked candidate 2. It is the only
candidate that keeps executable identity, session evolution and recovery evidence on the correct
side of every authority boundary at once, so a maintainer can extend it without breaking an
invariant.

## Phase E: Graft

- [x] From candidate 1: the Computer acquisition plan (npm has no 0.3.0; `@cloudflare/dofs` and
      `@cloudflare/computer-rpc` are unpublished, both 404 verified), vendored packages emitting
      `dist` so `tsc` never walks vendored sources, and a pin test binding Pi + Computer + image.
- [x] From candidate 4: slice 1 is a pure paid probe before any product code, and the
      `inspect` / `modify-harness` tool split.
- [x] From candidate 3: exactly one `index.ts` in the vendored tree for `module-seams.test.ts`,
      and a day-boxed stop condition on the vendoring slice.
- [x] Convergence noted: all four independently chose facet-hosted Pi with `globalOutbound` egress.
- [x] Rejections recorded in the synthesis note.

## Phase F: Verify

- [x] Plan re-read end to end for coherence under one mental model.
- [x] Every claimed upstream path and line checked against `/tmp/cf-stumble-pi-v0.84.4` and the repo.
- [x] Verification script `.audit/verify-harness-plan.sh` re-runs the path checks. 27/27 pass.
