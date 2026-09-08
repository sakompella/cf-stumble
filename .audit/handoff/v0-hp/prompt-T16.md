You implement exactly one task. You are one of five workers running in parallel on separate worktrees of the same repository.

# T16 — fix the credit predicate so a failed turn is not known-good evidence

## The fault, already verified from source. Do not re-derive it.

`src/supervisor/projects/turn-settle.ts:133-140` settles all three terminal frame kinds —
`rejected`, `failed` and `completed` — as the relay outcome `body-completed`, and the attempt
already carries HTTP 200 from `src/supervisor/projects/turn-run.ts:200-207`.
`servedSuccessfulResponse` at `src/supervisor/eligibility.ts:165-174` accepts every
`body-completed` attempt with a status below 400, and eligibility counts exactly those at
`src/supervisor/eligibility.ts:131-149`.

Cost: three turns that Pi rejected, or three model errors, can make a generation ELIGIBLE — the
rollback and promotion machinery would then treat code that never completed useful work as known
good. The predicate's own doc comment says it is "a completed body under 400 and nothing else",
which is exactly the transport fact that is too weak to answer the question its caller asks.

## The design constraint, which matters more than the fix

Do NOT reunify the two predicates. The split between `servedSuccessfulResponse` (did this
generation serve a good response? a transport fact, ADR-0031) and `earnsCompletedRealTurnCredit`
(did one real turn complete? a durability fact, goal criterion 6) is correct and deliberate: a
thread-save failure is the Supervisor's storage fault and must not make a healthy harness look
broken. See the doc comments at `src/supervisor/eligibility.ts:150-201`.

What is missing is one more FACT about the terminal outcome on the relay record. Two shapes are
open, and the reviewer named both:

- give terminal rejection and terminal model failure a non-crediting relay outcome, or
- record the proven terminal kind on the attempt and require `completed` in
  `servedSuccessfulResponse`.

Pick one and defend it in your report. Constraint on either: a rejected or failed turn must earn
**neither credit nor blame**. It must not increment the credited count, and it must not trip
`isFailureObservation` at `src/supervisor/eligibility.ts:203-210` — the model refusing or erroring
is not evidence that the harness code is broken, and marking it `body-failed` would wrongly make
the generation ineligible for `failure-observed`. Check `RelayOutcome` at
`src/supervisor/relay/attempt.ts:3-9`; if you add a value you must also extend
`relayOutcomeFromRow` at `attempt.ts:102-113` and the SQLite column's accepted values, and say what
happens to rows written by the previous shape.

## What done means, and the tests that prove it

The condition that ends this task: **a rejected turn and a failed model call each leave eligibility
unchanged.** Two tests, each driving the real settlement path (not hand-built attempt rows): take a
generation that is one credited turn short of eligible, run a turn that ends in a `rejected`
terminal frame, and assert the eligibility verdict and its `creditedTurns` are identical to before.
Repeat for a `failed` terminal frame. Then a third test showing a `completed` turn DOES move it, so
the first two are not passing because nothing counts.

Mutation to run and report: revert your predicate change (or your outcome change) on the production
line, and confirm those tests go red.

## Cut line

Do not change the eligibility POLICY numbers. Do not change what a `save-failed` turn settles as —
that split is correct. Do not touch `src/supervisor/projects/turn-run.ts` lifetime or start
handling: T15 is rewriting that file in parallel, so keep your diff out of `boundedStart`,
`streamAdmittedTurn` and `runProjectTurn`'s ordering. If you truly need a change there, put it in
the report as a hand-off instead.

## Read before you write

`docs/agents/adr/0031-relay-facts-decide-known-good.md`,
`0037-stream-real-turns-to-the-browser.md`, `/home/aditya/repos/cf-stumble/.audit/v0/goal.md` criterion 6, and
`/home/aditya/repos/cf-stumble/.audit/v0/review-sol-code.md` finding 4 and section 2.

## Where you are

Worktree: /home/aditya/wt/T16   (branch `work/T16`, based on main at `9ac4b9c`)
The worktree already has `node_modules`. Work only inside it. `cd /home/aditya/wt/T16` first.

The durable audit trail lives in the MAIN checkout, which is gitignored and shared by reference
only: read `/home/aditya/repos/cf-stumble/.audit/v0/` and write your report to
`/home/aditya/repos/cf-stumble/.audit/v0/tasks/T16.md`. Do not create a `.audit/` tree in your worktree.

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
3. Write `/home/aditya/repos/cf-stumble/.audit/v0/tasks/T16.md` in the shape the existing reports in that directory use:
   task id, commit SHA, changed paths, each acceptance criterion with the evidence that it holds,
   the mutation runs with their exact mutated lines and the tests that failed, what you deliberately
   did NOT do, and any remaining blocker. A truthful partial report beats a false completion.
4. Reply to your parent with `await agent_message.send(<summary>, receiver_role='parent')`. The
   summary must state: commit SHA, gate result with file/test counts, the mutation evidence in one
   line each, and anything you could not do. If you are blocked or you decide the task's premise is
   wrong, say so instead of inventing a completion.
