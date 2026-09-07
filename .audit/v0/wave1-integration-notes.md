# Wave-1 integration notes and open roadmap defects

Source: `.audit/v0/review-opus-round1.md` sections 4 and 5, plus root-agent verification.
Read this before merging any wave-1 branch or writing any wave-2 task.

## File collisions among the branches now in flight

| file | who touches it | handling |
|---|---|---|
| `src/supervisor/supervisor.ts` | T5 (thread wrappers, ~226-265) and **T2** (`GenerationRequest` type at 5-9 and 145) | different regions; merge T5 first, then T2. Verify both diffs before merging. |
| `src/facet/generation-0/capabilities.ts` | T4 owns it; T3 will import `WorkspaceRequest`/`WorkspaceResult` from line 6 later | freeze `WorkspaceCapability` during wave 1. T4 is the owner. |
| `test/facet/**` | T4 (adapter tests) now; T3 later | enumerate both test lists before dispatching T3. |
| `src/page/{markup,element-ids,script-generations}.ts` | **T2** now; T10 rewrites them in wave 4 | T2 must DELETE only. Its brief did not say so — check the T2 diff and reject layout work. |

## Coverage gaps in the goal's ten done-criteria

- **Criterion 2 — partial gap.** No task implements or locally tests an Access policy restricted to
  the OWNER. It first appears as deploy configuration in T12.1 and is only exercised in T12.4.
  Add an acceptance item to T6 (or T3) for the owner-only policy plus a local rejection test.
- **Criterion 4 — real gap.** The diff is unowned and is actively deleted by T7.5. See D31.
- **Criterion 7 — partial gap.** T1.3 does not require the two builds to run on Computer. T1a
  carries the correction as a pre-check; the real proof belongs to T1b.
- **Criterion 6 — scope omission.** `src/supervisor/eligibility.ts:140` reads
  `attempt.outcome === "body-completed" && attempt.responseStatus < 400` — VERIFIED at that exact
  line. So any completed body under 400 currently earns turn credit, with no requirement that the
  thread was saved. T9.3 addresses it, but `eligibility.ts` is not in T9's scope list. Add it.

## Cut-line risks

T3.4 ("a bounded conflict or a narrow serialization policy") and T9.5 (deadline + reconciliation)
can both grow into schedulers if a worker over-reads them. T9.5 already says no scheduler; add
"no alarm, no scheduler, no queue framework" to T3.4 before dispatching it.

## Reordering the reviewer recommends

Run T1a, T2, T5 in parallel at `d6ff238` (done). Start T3 as soon as **T1a** lands rather than
waiting for T1b's paid Computer probe. Pre-write T9's HTTP adapter against frozen T5/T7 interfaces
during wave 2. That removes the wave-0 serialization point and shortens wave 3.


## Measured overlap between the branches actually in flight (02:47)

Computed with `git diff --name-only HEAD` per worktree, not predicted from the roadmap.

| branch | files touched |
|---|---|
| T1a | 4 — `package.json`, `src/harness-build.ts`, `test/workspace/harness-build.test.ts`, `scripts/probe/clean-build.sh` |
| T2 | 36 — incl. `docs/agents/adr/0030-*.md` and `scripts/deploy/README.md` |
| T5 | 10 — `src/supervisor/threads/*`, `src/supervisor/supervisor.ts` |
| T4 | 0 so far (still reading the vendored Pi helpers) |

**Only one real overlap: T2 and T5.**

1. `src/supervisor/supervisor.ts` — predicted by review B6 (T2's `GenerationRequest` type edge vs
   T5's thread wrappers). Different regions.
2. `test/supervisor/threads/threads.test.ts` — **NOT predicted by anyone.** T2 is editing a threads
   test, presumably because it constructs a Supervisor that references generation-control types.
   This is a same-file conflict on a test, which is exactly where a careless merge silently drops a
   test case.

Merge order T1a -> T5 -> T2 -> T4 already handles both: T5 lands first and T2 rebases onto it.
When merging T2, diff `test/supervisor/threads/threads.test.ts` explicitly and confirm no T5 test
case was lost. Do not resolve that conflict by taking either side wholesale.

T1a's non-source additions are legitimate: `scripts/probe/clean-build.sh` is the committed
clean-build script required by review B2 Gap 1(d). With it, T1a now passes 5/5 objective checks.
T2 edits ADR-0030 (correct: the ADR records the journal cleanup it is performing) and a deploy
README. Neither is out of scope, but both need a read at merge time.
