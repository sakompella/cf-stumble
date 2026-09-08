You implement exactly one task. You are one of five workers running in parallel on separate worktrees of the same repository.

# T15 — make one turn one lease-scoped operation

## The fault, already verified from source. Do not re-derive it.

The four-minute turn deadline is applied TWICE — once to start and again, whole, to the stream —
under a five-minute lease. A start that loses its race is never cancelled. Evidence:

- `src/supervisor/projects/turn-run.ts:133-146` takes the lease, then calls `boundedStart`.
- `src/supervisor/projects/turn-run.ts:169-183` `boundedStart` races `input.start(...)` against a
  `setTimeout`. It passes no abort signal and it never cancels the losing start.
- `src/facet/generation-0/facet-turn.ts:96-124` a late successful `startTurn` still starts the
  facet pump eagerly, so the orphan does real work.
- `src/supervisor/projects/turn-stream.ts:145-171` if start wins, the stream installs a FRESH
  complete `deadlineMs` timer.
- `src/supervisor/supervisor.ts:85-110` the constants: lease 5 minutes, deadline 4 minutes.
- `src/supervisor/threads/decisions.ts:20-57` after lease expiry admission allows a replacement.

Cost: worst case 4 + 4 = 8 minutes of turn against a 5-minute lease. A replacement turn is admitted
at 5 minutes and the orphan facet keeps editing the ONE shared tenant workspace (ADR-0038) for
another 3. T5's lease fencing protects the thread save; nothing protects the files.

A second, related fault in the same code path: attribution is sampled too late.
`src/supervisor/supervisor.ts:388-399` reads the then-current active generation to pick the mount.
`src/supervisor/projects/turn-run.ts:143-156` awaits all start work, and only THEN
`streamAdmittedTurn` calls `input.attribution()` at `turn-run.ts:194-207`. An activation during
mount, provisioning or facet start separates those two reads, so a turn can run generation A and be
recorded against generation B. Note that the doc comment on `runProjectTurn` already CLAIMS the
snapshot is taken at admission. The comment is wrong today; make it true.

## What to build

1. **One absolute deadline for the whole turn.** Compute the turn's end instant once, at admission,
   from the same clock the lease uses, and derive every remaining budget from it. Start and stream
   must share it, so start time is spent out of the same budget the stream reads from. The turn
   must not be able to outlive the lease that admitted it. Decide and state in your report whether
   the bound is the deadline or the lease; they are different numbers today and one turn should
   have one lifetime.
2. **Cancellation that propagates.** One signal for the turn. Pass it through mount, provision,
   facet start and stream read. When the bound fires, or a start loses its race, or the browser
   disconnects, the losing or orphan work must be cancelled, not merely ignored. A start that
   returns after the bound has passed must have its frames cancelled before the lease is released.
3. **One attribution read.** Snapshot `{active, preparationCheckId}` exactly once after admission
   and use that same snapshot for the mount and for the attempt. Delete the second read.

## What done means, and the test that proves it

The condition that ends this task: **a test admits a replacement turn and proves the superseded
facet stopped writing to the workspace.** Concretely, the test drives a first turn whose start or
stream is slow, lets the bound pass, admits a replacement turn on the same project, and then shows
that a workspace write attempted by the first turn's facet does not happen — because its signal was
aborted, not because the test declined to call it. A test that merely asserts a timer was cleared
does not prove this.

Add a second test for attribution: activate a new generation DURING start and prove the attempt
records the generation that actually served the turn.

## Cut line

No alarms, no scheduler, no queue, no reconnect or resume, no background turns, no steering. Do not
change the frame protocol shape. Do not change the page. Keep the numbers configurable where they
are configurable today; if you change a constant's value, justify it in the report.

## Read before you write

`docs/agents/adr/0037-stream-real-turns-to-the-browser.md`,
`0038-one-thread-per-project-one-shared-workspace.md`, `0031-relay-facts-decide-known-good.md`,
`0036-pure-decisions-imperative-shells.md`, and
`/home/aditya/repos/cf-stumble/.audit/v0/review-sol-code.md` findings 1 and 3.

## Where you are

Worktree: /home/aditya/wt/T15   (branch `work/T15`, based on main at `9ac4b9c`)
The worktree already has `node_modules`. Work only inside it. `cd /home/aditya/wt/T15` first.

The durable audit trail lives in the MAIN checkout, which is gitignored and shared by reference
only: read `/home/aditya/repos/cf-stumble/.audit/v0/` and write your report to
`/home/aditya/repos/cf-stumble/.audit/v0/tasks/T15.md`. Do not create a `.audit/` tree in your worktree.

## Rules

- Read `AGENTS.md` and `docs/agents/domain.md` before you write code. Read the ADRs your task names.
- Apply the repo skills: `typescript-best-practices` for any `.ts`; `agents-sdk` and
  `durable-objects` for Supervisor, facet, thread or RPC work; `cloudflare` and
  `workers-best-practices` for bindings and Worker config.
- Stay inside your task's scope. Do not fix unrelated things you notice; list them in the report.
- Do not edit `README.md`. Do not create or edit GitHub issues. Do not push, do not merge, do not
  touch `main`. The parent oracle merges and pushes.
- `pnpm verify` is the gate: typecheck, format check, lint, tests, about 62 seconds on this box.
  Run it before you claim anything works. Never commit through a red gate. `pnpm format` fixes
  formatting; nothing else in the gate is auto-fixable.
- Delete obsolete code and its tests rather than leaving them unreachable. An unused safe path is a
  fault, not a safety net.
- Baseline on your base commit: 118 test files, 842 tests, gate green.

## Mutation is the test review — this is the whole point of this round

The previous round's suite was found to be partly decoration. A cross-vendor reviewer changed
production lines and the gate stayed green:

| mutation | result |
|---|---|
| `git --no-pager diff HEAD` -> `cat` | 13/13 turn-diff tests stayed green |
| `ModelRoute.runStream` body -> `throw` | all 21 related tests stayed green |

So for EVERY test you add or change: break the production line the test claims to cover, run
`pnpm verify`, and confirm it turns RED. Then revert the mutation and confirm green. Record both
runs in your report, naming the exact line you mutated and the test names that failed. A test whose
absence of coverage you cannot demonstrate does not count as evidence.

Assert the PROPERTY, never a presumed implementation. Do not let a fake or a test double import the
production constant it is supposed to pin — that is exactly the fault that produced the fake diff
test.

## No paid spend

The owner is unreachable and has not approved paid probes (question Q7 in
`/home/aditya/repos/cf-stumble/.audit/v0/questions.md`). Do NOT run `wrangler deploy`, create or start any Computer
workspace, call any billing Cloudflare API, or use the owner's account credentials. If a criterion
needs a paid environment, record it as **blocked: awaiting owner approval for a paid probe**.
Never fake, mock, or simulate a paid result to close a criterion. `pnpm verify` runs locally in
workerd and is always allowed.

## Finish

1. `pnpm verify` green. Commit in your worktree with a conventional-commit message. One commit is
   preferred; more is fine if each is green.
2. Run `scripts/probe/clean-build.sh` and report the sha256 it prints, and whether it should have
   moved for your change.
3. Write `/home/aditya/repos/cf-stumble/.audit/v0/tasks/T15.md` in the shape the existing reports in that directory use:
   task id, commit SHA, changed paths, each acceptance criterion with the evidence that it holds,
   the mutation runs with their exact mutated lines and the tests that failed, what you deliberately
   did NOT do, and any remaining blocker. A truthful partial report beats a false completion.
4. Reply to your parent with `await agent_message.send(<summary>, receiver_role='parent')`. The
   summary must state: commit SHA, gate result with file/test counts, the mutation evidence in one
   line each, and anything you could not do. If you are blocked or you decide the task's premise is
   wrong, say so instead of inventing a completion.
