You implement exactly one task. You are one of five workers running in parallel on separate worktrees of the same repository.

# T17 — prove the turn diff for real, over a real Git repository

## The fault, already verified from source. Do not re-derive it.

T13 was dispatched to fix a fake diff test and reproduced the same false proof. A cross-vendor
reviewer replaced `git --no-pager diff HEAD` with `cat` in production and all 13 turn-diff and
project-turn tests stayed GREEN.

Why: `test/facet/generation-0/git-diff-exec-backend.ts` — the test double — IMPORTS
`TURN_DIFF_COMMAND` from production and gives its fake diff behaviour to whatever the constant says.
So the test follows production instead of binding it. It snapshots file bytes and computes a
unified diff in TypeScript; no `git` process is ever involved. Read that file and
`src/facet/generation-0/turn-diff.ts` (or wherever `TURN_DIFF_COMMAND` now lives — find it with
`grep -rn TURN_DIFF_COMMAND src/ test/`) before you plan.

This is the second attempt at this property. Decision D67 in `/home/aditya/repos/cf-stumble/.audit/v0/decision-log.md`
records the first failure and D68 records the incorrect "fixed" claim. Read both.

## What to build

Delete the five tests the reviewer named as decoration — `/home/aditya/repos/cf-stumble/.audit/v0/review-sol-tests.md`
lists them; if its list is ambiguous, delete the ones that cannot fail under the `cat` mutation and
say which in your report — and replace them with an **integration test over a temporary Git
repository**.

That test must:
- create a real temporary directory, `git init` it, commit a file, modify the file;
- run the production diff path against it, through the real command the production constant names;
- assert the unified diff the production code produces describes that modification.

Nothing in this repository spawns a child process today, which is why the fake exists. That
constraint is real and you must confront it honestly:
- the vitest workspace runs test files in `workerd` pools where `node:child_process` is unavailable;
- check `vitest.config.*` / `vitest.workspace.*` and `package.json` for whether a NODE-pool project
  already exists or can be added, and whether `pnpm verify` runs it;
- a node-pool integration test for a harness-side helper is legitimate and is the likely answer.
  Adding one small project to the vitest config so `pnpm verify` covers it is IN scope.
- if, after real investigation, no such seam can exist without exceeding the cut line, then say so
  plainly, remove the fake test's false claim rather than leaving it, and report the design change
  the diff seam needs — a spawn boundary the test can substitute WITHOUT reading the production
  constant. Do not invent a second fake.

## What done means

The condition that ends this task: **replacing the production diff command with `cat` turns the
gate red.** Demonstrate it. Put the exact edit, the command you ran, and the failing test names in
your report, then revert and show green. If you cannot achieve this, your report says so in its
first line, and the alternative it proposes is a design change, not another double.

## Cut line

No new dependency. No Docker, no Podman, no container. No paid Cloudflare call. Do not change what
the diff frame looks like on the wire, and do not touch the page.

## Read before you write

`docs/agents/adr/0040-*.md` (T13's ADR), `docs/agents/adr/0039-treat-the-workspace-as-a-development-machine.md`,
`/home/aditya/repos/cf-stumble/.audit/v0/tasks/T13.md`, and `/home/aditya/repos/cf-stumble/.audit/v0/review-sol-tests.md`.

## Where you are

Worktree: /home/aditya/wt/T17   (branch `work/T17`, based on main at `9ac4b9c`)
The worktree already has `node_modules`. Work only inside it. `cd /home/aditya/wt/T17` first.

The durable audit trail lives in the MAIN checkout, which is gitignored and shared by reference
only: read `/home/aditya/repos/cf-stumble/.audit/v0/` and write your report to
`/home/aditya/repos/cf-stumble/.audit/v0/tasks/T17.md`. Do not create a `.audit/` tree in your worktree.

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
3. Write `/home/aditya/repos/cf-stumble/.audit/v0/tasks/T17.md` in the shape the existing reports in that directory use:
   task id, commit SHA, changed paths, each acceptance criterion with the evidence that it holds,
   the mutation runs with their exact mutated lines and the tests that failed, what you deliberately
   did NOT do, and any remaining blocker. A truthful partial report beats a false completion.
4. Reply to your parent with `await agent_message.send(<summary>, receiver_role='parent')`. The
   summary must state: commit SHA, gate result with file/test counts, the mutation evidence in one
   line each, and anything you could not do. If you are blocked or you decide the task's premise is
   wrong, say so instead of inventing a completion.
