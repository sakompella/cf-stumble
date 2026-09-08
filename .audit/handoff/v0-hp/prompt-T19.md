You implement exactly one task. You are one of five workers running in parallel on separate worktrees of the same repository.

# T19 — make the model route's streaming path actually covered

## The fault, already verified from source. Do not re-derive it.

A cross-vendor reviewer replaced the entire body of `ModelRoute.runStream` with a `throw` and all 21
model, facet and module-map tests stayed GREEN. Find it with
`grep -rn 'runStream' src/ test/`; the production surface is `src/model-route.ts`,
`src/model-route-stream.ts`, `src/model-route-stream-parse.ts` and `src/model-route-events.ts`.

So the streaming interface T4 built — the one goal criterion 4 depends on, since streamed text is
what the browser renders — has no test that binds it. The 21 tests exercise other things and pass
regardless.

## What to build

Read the four modules and work out what `runStream` actually promises: how a provider's byte stream
becomes events, what happens to a malformed chunk, a truncated stream, an error mid-stream, a
provider HTTP failure, and how the events reach the facet turn. Then write the tests that FAIL when
that behaviour is absent.

Make them property assertions, not shape assertions. "The parser was called" is not coverage.
"A provider stream carrying two text deltas and a stop reason produces exactly those two text
events and one terminal event, in order" is.

While you are here, check whether the sibling paths have the same hole: mutate
`model-route-stream-parse.ts`'s parse function and `model-route-events.ts`'s mapping the same way
and see if the gate notices. Fix what you find inside this module group.

## What done means

The condition that ends this task: **replacing the body of `ModelRoute.runStream` with a throw
turns the gate red.** Show the mutation, the command, and the failing test names in your report,
then revert and show green. Do the same for any sibling hole you closed.

## Cut line

Tests and test-support code only, plus the smallest production change that makes the behaviour
testable if a seam is genuinely missing — and if you make one, say exactly why in the report and
keep it to an injected boundary, not a refactor. Do not change the wire protocol. Do not change the
facet or the Supervisor. Do not call a real model provider: no network, no API key, no spend.

## Read before you write

`docs/agents/adr/0037-stream-real-turns-to-the-browser.md`, `/home/aditya/repos/cf-stumble/.audit/v0/tasks/T4.md`, and
`/home/aditya/repos/cf-stumble/.audit/v0/review-sol-tests.md`.

## Where you are

Worktree: /home/aditya/wt/T19   (branch `work/T19`, based on main at `9ac4b9c`)
The worktree already has `node_modules`. Work only inside it. `cd /home/aditya/wt/T19` first.

The durable audit trail lives in the MAIN checkout, which is gitignored and shared by reference
only: read `/home/aditya/repos/cf-stumble/.audit/v0/` and write your report to
`/home/aditya/repos/cf-stumble/.audit/v0/tasks/T19.md`. Do not create a `.audit/` tree in your worktree.

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
3. Write `/home/aditya/repos/cf-stumble/.audit/v0/tasks/T19.md` in the shape the existing reports in that directory use:
   task id, commit SHA, changed paths, each acceptance criterion with the evidence that it holds,
   the mutation runs with their exact mutated lines and the tests that failed, what you deliberately
   did NOT do, and any remaining blocker. A truthful partial report beats a false completion.
4. Reply to your parent with `await agent_message.send(<summary>, receiver_role='parent')`. The
   summary must state: commit SHA, gate result with file/test counts, the mutation evidence in one
   line each, and anything you could not do. If you are blocked or you decide the task's premise is
   wrong, say so instead of inventing a completion.
