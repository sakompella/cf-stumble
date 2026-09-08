# Design review package — cf-stumble v0

Written for the owner to review design changes. Nothing is running; every change below is committed
and on origin. Read this file, then the branch diffs it points at.

- `main` = `9ac4b9c`, pushed. Gate on hp: **117 test files, 842 tests, 64s**.
- Six design changes sit unmerged on `work/T15` … `work/T20`, each one commit off `9ac4b9c`.
- Machine: hp, x86-64 NixOS. node 22.23.2 (the Computer container's version), Chromium 152, workerd
  running through nix-ld, Podman live. The arm64 Mac could not run the pinned x64 workspace image;
  this box can, which is why the work moved.

## 1. Merged since the last review

| commit | change |
|---|---|
| `9ac4b9c` | The owner page renders the `diff` and `diff-unavailable` frames the harness emits. Closes the T10/T13 scheduling gap. Page-side only, so the module-map sha correctly did not move. |

## 2. Six design changes awaiting your review

Each began as a verified fault with a file and line, not a hunt. Status is honest: the code is a
worker's unfinished state, preserved as one `wip` commit. None carries a task report yet.

### T15 — one turn owns its whole lifetime (`work/T15`, 7 files, +274/−71)
- **Fault**: the 4-minute deadline applied once to start and again to streaming under a 5-minute
  lease, and a timed-out start was never cancelled (`turn-run.ts:133-183`, `turn-stream.ts:145-171`).
  An orphan facet could keep editing the shared tenant workspace after a replacement turn was admitted.
- **Design**: one admission owns the absolute deadline, the generation snapshot, and cancellation
  through provisioning, start, streaming, and workspace operations. New file `turn-bound.ts` holds
  that boundary. Late starts are disposed of.
- **The part that needs your judgement**: astra pushed this further than the original repair. An
  abort signal is not a safety guarantee, because a `bash` command already running keeps writing.
  Admission must now *establish* that old mutating work has stopped and **fail closed** if it cannot.
  That is a behaviour change: a turn can now be refused where it previously proceeded.

### T16 — credit stops counting failures (`work/T16`, 7 files, +181/−32)
- **Fault**: terminal rejection and model failure settled as HTTP-200 `body-completed`, so
  `eligibility.ts:131-174` counted failures toward known-good eligibility.
- **Design**: the attempt records the real outcome (`relay/attempt.ts`, `relay/attempts.ts`), and the
  two questions stay separate — did we serve a response, versus did this earn completed-real-turn credit.
- **Why it matters to you**: this decides which generations are eligible to serve. Getting it wrong
  either promotes a broken generation or refuses a good one.

### T17 — the diff gets a contract, then a real test (`work/T17`, 5 files, +429/−10)
- **Fault**: the test imported the same constant production used, so the suite stayed green with
  `git diff` replaced by `cat`. Twice now a diff test has passed while production was broken.
- **Design**: astra called half of this a design fault, and I agree. "The turn's diff" had no
  defined meaning — `git diff HEAD` misses untracked files, misses a commit made during the turn, and
  includes pre-existing dirt. So the contract comes first, then real Git behind the production
  adapter (`real-process-project-target.ts`) in a temporary-repository test.
- **Decision for you**: what the diff *should* mean. Untracked files in or out. Pre-existing dirt in
  or out. That is a product decision, not a test decision.

### T18 — the browser harness becomes real (`work/T18`, 13 files, +1689/−1)
- **Fault**: `package.json` and `AGENTS.md` advertised `pnpm harness:browser`, but its entrypoint
  existed on no branch. All four reviewers found this independently.
- **Design**: the harness is committed rather than deleted. Astra withdrew retraction as an option —
  removing the command repairs the documentation but does not satisfy the UI criterion.
- **Note**: the harness discovers a browser through `CF_STUMBLE_CHROME`, so it needs no bundled
  browser download and no lockfile change.

### T19 — the streamed route entrypoint is finally covered (`work/T19`, 3 files, +288/−37)
- **Fault**: replacing `ModelRoute.runStream`'s body with a throw left all 21 related tests green.
  The helpers were bound; the deployed route was not.
- **Design**: a test that crosses the real entrypoint, plus a shared provider-stream fixture.

### T20 — the x64 container preflight (`work/T20`, 2 files, +318)
- **Why it exists**: astra pointed out that this box can run the pinned
  `computer-computerd-linux-x64` image locally under Podman, free, and nobody had spent that
  capability. It probes tool availability and clean-build behaviour without claiming paid evidence.
- **Value**: it should answer nine of the nineteen rows in the Q7 paid request for free.

`work/T21` (saved compaction across a Supervisor reload and a generation replacement) was dispatched
and produced nothing. The gap it names is real and untested.

## 3. Design decisions recorded without code

- **Q7 is now one criterion-mapped request** (`.audit/v0/q7-request.md`), replacing five accreted
  addenda. Every paid item states which criterion it unblocks. This is the single thing waiting on you.
- **Criterion 10 splits** into 10a acceptance and 10b publication, so an unanswered publication
  question no longer blocks a finished release.
- Decisions **D70–D76** in `.audit/v0/decision-log.md` carry the reasoning.

## 4. What astra said, condensed

1. **Order**: mostly right. Keep turn lifetime first, credit second, and run the container preflight
   alongside rather than after.
2. **Lifetime**: correct ownership model, insufficient guarantee. Lease checks on new calls do not
   stop a command already executing. Test that case, and fail closed. Do not build a scheduler.
3. **The diff**: both a discipline failure and a design failure. Killing the `cat` mutation is a
   minimum, not proof.
4. **Scope**: keep v0 as it is. Blocked evidence is not a reason to delete a criterion. Keep
   known-good policy expansion out, but fix false credit in the code that stays.

**Astra's highest-leverage action**: make replacement-turn admission conditional on the old turn
losing all ability to mutate the workspace, and prove it with an already-running write command that
survives the first cancellation request.

## 5. Honest gaps

- The six branches are unfinished worker state. They have not passed the gate and have no reports.
- The resume run never started: hp has no Anthropic API key, so the orchestrator exited immediately
  with `No API key for provider: anthropic`. That is why nothing merged after `9ac4b9c`.
- No money has been spent and no paid result has been faked.

## 6. Suggested review order

1. T15's boundary in `turn-bound.ts`, because it changes when a turn is refused.
2. T17's diff contract, because it is a product decision.
3. T16's credit split, because it decides which generation serves.
4. `.audit/v0/q7-request.md`, the one ask waiting on you.


## 7. Gate results per branch

Measured on hp with `pnpm verify` in each worktree. `pnpm verify` runs typecheck, format check, and
lint *before* the tests, so a style failure means the tests never ran.

| branch | verdict | detail |
|---|---|---|
| work/T16 | **green** | 117 test files, 842 tests |
| work/T19 | **green** | 118 test files, 852 tests (+10 over main) |
| work/T20 | **green** | 117 test files, 842 tests |
| work/T15 | style only | 2 lint warnings, 0 errors: "function too long, consider splitting" in the new turn boundary. Tests not reached. |
| work/T17 | style only | one unformatted file, `test/facet/generation-0/real-process-project-target.ts`. Tests not reached. Formatter has since been run. |
| work/T18 | style only | 1 lint warning, 0 errors, same "function too long" rule in the harness fixture. Tests not reached. |

No branch has a type error, a broken build, or a failing test that the gate reached. The three
amber rows are the repository's own warning budget (`--max-warnings=0`) refusing a long function,
plus one file that missed the formatter. Splitting those two functions is a small mechanical change,
and it is deliberately left for review rather than done silently, because it reshapes code you are
about to read.


## 8. Final merge sweep

`main` is `e769586` on origin. Gate green: 118 test files, 852 tests.

| branch | outcome | tests after merge |
|---|---|---|
| work/T15 | merged `60f3e3f` | 842 |
| work/T16 | merged `e08d4f3` | 842 |
| work/T19 | merged `aff5e4e` | 852 |
| work/T18 | merged `0934ae5` | 852 |
| work/T20 | merged `e73bc6c` | 852 |
| work/T17 | **paused, unmerged** | lint gate refuses the new process adapter; the design is settled and the code is written, only a style pass remains |
| work/T21 | dropped | produced no code |

Every branch is on origin. The full record is tracked at `docs/agents/design/v0-work-record.md`.
