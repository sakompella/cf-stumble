# Sol review round: consolidated verdict and ordered plan

Four `openai-codex/gpt-5.6-sol` reviews at medium effort, run against `main` at `7818f8d` and
`work/T14` at `f00eaac`. This is the cross-vendor second opinion the owner's original brief asked
for; `claude-opus-5` had stood in for it twice.

| Review | Scope | Verdict | File |
|---|---|---|---|
| sol-code | merged v0 code | **NOT SOUND** | `review-sol-code.md` |
| sol-tests | the 199 new tests | **THE SUITE BINDS WITH GAPS** (delete 5) | `review-sol-tests.md` |
| sol-t14 | unmerged `f00eaac` | **MERGE** | `review-sol-t14.md` |
| sol-plan | path to v0 | **THE PLAN HOLDS WITH FIXES** | `review-sol-plan.md` |

`review-round2.md` (opus) read the same tree as `SOUND WITH FIXES`. Sol reads it as **NOT SOUND**.
Treat the round-2 verdict as superseded.

## What four independent reviewers converged on

Convergence is the ranking signal here. Each row was reached by reviewers working from separate
briefs on separate worktrees.

1. **`pnpm harness:browser` is red.** All four found it. `package.json:21` and `AGENTS.md:23-25`
   advertise a command whose `tools/browser-harness/run.mts` was never committed; it lives
   uncommitted on `work/T10-harness`. T10's own acceptance criteria 6 and 8 are unfinished.
2. **Main drops T13's diff frames.** `turn-frames.ts:35-65` emits `diff` and `diff-unavailable`;
   `script-turn.ts:86-109` dispatches neither. Criterion 4 cannot show a diff. `f00eaac` closes it.
3. **Turn lifetime is not one operation.** The 4-minute deadline applies once to start and again to
   streaming under a 5-minute lease, and a timed-out start is never cancelled
   (`turn-run.ts:133-183`, `turn-stream.ts:145-171`). An orphan facet can keep editing the shared
   tenant workspace after a replacement turn is admitted.
4. **Serving attribution races activation.** Mount selection and attempt attribution read the active
   generation at different times, so a turn can run generation A and credit B
   (`supervisor.ts:388-399`, `turn-run.ts:143-156,194-207`).

## What the mutation testing settled

sol-tests changed production code and watched the gate stay green. These are demonstrated:

| Mutation | Result |
|---|---|
| `git --no-pager diff HEAD` -> `cat` | 13/13 turn-diff and project-turn tests green |
| `ModelRoute.runStream` body -> `throw` | all 21 model, facet, and module-map tests green |
| page `onClick` helper -> return immediately | all 12 page and 7 page-route tests green |

The first result is the one that matters: **T13 reproduced the exact false proof it was dispatched to
fix.** `GitDiffExecBackend` imports `TURN_DIFF_COMMAND` and gives fake diff behaviour to whatever the
constant says, so the test follows production instead of binding it. Decision D67 is unsettled.

## Ordered plan

Each task states the condition that ends it.

1. **Merge `f00eaac`.** Fast-forwards onto `7818f8d`; gate green at 117 files / 842 tests.
   Done when `main` renders both frame kinds.
2. **Make turn lifetime one lease-scoped operation.** One absolute deadline for the whole turn,
   cancellation propagated through start and streaming, one attribution read shared by mount and
   credit. Done when a test admits a replacement turn and proves the superseded facet stopped
   writing to the workspace.
3. **Fix the credit predicate.** `turn-settle.ts:133-140` settles terminal rejection and model
   failure as HTTP-200 `body-completed`, so `eligibility.ts:131-174` counts them toward known-good
   eligibility. Done when a rejected turn and a failed model call each leave eligibility unchanged.
4. **Prove the diff for real.** Replace the five fake diff tests with an integration test over a
   temporary Git repository. Done when replacing the diff command with `cat` turns the gate red.
5. **Land or retract the browser harness.** Commit `tools/browser-harness/` from `work/T10-harness`,
   or remove the script and its `AGENTS.md` lines. Done when `pnpm harness:browser` matches what the
   repository advertises.
6. **Cover `ModelRoute.runStream`.** Done when replacing its body with a throw turns the gate red.
7. **Re-specify Q7 before asking the owner again.** Bundle pnpm, registry, time, and disk into two
   instrumented builds, add `gh`, and keep the model, Access, GitHub, Loader, race, and eviction
   checks as distinct evidence. Done when each item names the criterion it unblocks.
8. **Reschedule T11** after tasks 2 and 3 and after T8, with T3b and the browser work added to its
   dependency list. Its two earlier dispatches both violated a dependency.

## Standing practice earned by this round

- Mutation is the test review. Change the production line and watch for red; a green gate under
  mutation names a decorative test.
- Convergence across independently briefed reviewers ranks findings better than any single reviewer's
  own ordering.
- A cross-vendor reviewer earns its cost. Same-vendor round 2 read this tree as sound.
