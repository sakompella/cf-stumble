You implement exactly one task. You are one of five workers running in parallel on separate worktrees of the same repository.

# T21 — prove a saved compaction survives a Supervisor reload and a generation replacement

## Why this exists

The `gpt-6-astra` review at `/home/aditya/repos/cf-stumble/.audit/v0/review-astra-low.md` section 1 names this as missing
work that belongs in v0: "Add the missing saved-compaction -> Supervisor reload ->
replacement-generation test." The owner's standing instruction is to treat that review as almost
certainly correct.

It sits across two goal criteria in `/home/aditya/repos/cf-stumble/.audit/v0/goal.md`:
- **5**: "A forced-compaction test continues from saved Pi context."
- **8**: the owner activates a second harness commit "and continues the same project conversation."

## What exists today, so you do not rebuild it

`test/facet/generation-0/compaction.test.ts:111` already proves *"a replacement facet continues from
the saved compacted context, and a fresh state drops it"*. Read it first. It is a good test and it
is FACET-LEVEL: it calls `runPiAgentTurn` directly and passes state from one call to the next.

What it does not touch is the path the product actually takes:

1. a turn compacts, and the compacted context is saved through the **Supervisor's thread store**
   (`src/supervisor/threads/store.ts`, `src/supervisor/threads/message-fields.ts` — note
   `compactionSummary` is a first-class saved role);
2. the **Supervisor is reloaded** — a Durable Object is evicted and rehydrated from storage, so the
   saved thread is read back from SQLite rather than held in memory;
3. a **replacement generation is activated** (`src/supervisor/generations/`), so the next turn runs
   on DIFFERENT harness code;
4. the conversation continues from the compacted context across all three.

Nothing proves that chain. `test/supervisor/threads/fresh-thread.test.ts` and
`thread-messages.test.ts` handle the `compactionSummary` message shape but not the lifecycle.

## What to build

One integration test that drives the real Supervisor surface for the whole chain above, plus the
negative that stops it being vacuous: after a fresh thread, the compacted context is GONE while
every repository's files are untouched (criterion 5's second half).

Decide honestly how far the reload can be simulated in `workers` test pool. If the vitest workers
pool can genuinely evict and rehydrate a Durable Object, use that — check
`cloudflare:test`'s `runInDurableObject` / storage helpers and any existing test that already
rehydrates one (`grep -rn 'runInDurableObject\|listDurableObjectIds' test/`). If it cannot, then
read the thread back through a NEW Supervisor instance over the same storage, and state in your
report exactly which part is real eviction and which part is a stand-in. Do not describe a
stand-in as a reload.

## What done means

The test fails if the compacted context is dropped at any of the three hops. Prove that by
mutation, one hop at a time: break the save of the compacted role, then break the read-back, then
break the hand-off to the newly activated generation, and confirm each turns the gate RED. Name the
three mutated lines and the failing tests in your report. Three separate mutations, because a
single test that only catches one hop would leave the other two decorative — which is the exact
fault this whole round is answering.

## Cut line

No new production feature. If a seam is genuinely missing to make this testable, add the smallest
injected boundary and justify it; do not refactor the generations module. No background turns, no
automatic recovery, no scheduler — astra names those explicitly as things NOT to add. No paid
Cloudflare call, no model provider call, no network, no spend.

## Coordinate

T15 is rewriting `src/supervisor/projects/turn-run.ts` and `turn-stream.ts` in parallel and T16 is
rewriting `turn-settle.ts` and `eligibility.ts`. Keep out of those four files. If your test needs a
change there, put the request in your report instead and I will sequence it.

## Read before you write

`test/facet/generation-0/compaction.test.ts` in full, `src/facet/generation-0/compaction.ts`,
`src/supervisor/threads/store.ts`, `src/supervisor/generations/`,
`docs/agents/adr/0033-epoch-versions-generation-control-state.md`,
`0024-facet-owns-the-evolvable-harness.md`, `0038-one-thread-per-project-one-shared-workspace.md`,
and `/home/aditya/repos/cf-stumble/.audit/v0/goal.md` criteria 5 and 8.

## Where you are

Worktree: /home/aditya/wt/T21   (branch `work/T21`, based on main at `9ac4b9c`)
The worktree already has `node_modules`. Work only inside it. `cd /home/aditya/wt/T21` first.

The durable audit trail lives in the MAIN checkout, which is gitignored and shared by reference
only: read `/home/aditya/repos/cf-stumble/.audit/v0/` and write your report to
`/home/aditya/repos/cf-stumble/.audit/v0/tasks/T21.md`. Do not create a `.audit/` tree in your worktree.

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
3. Write `/home/aditya/repos/cf-stumble/.audit/v0/tasks/T21.md` in the shape the existing reports in that directory use:
   task id, commit SHA, changed paths, each acceptance criterion with the evidence that it holds,
   the mutation runs with their exact mutated lines and the tests that failed, what you deliberately
   did NOT do, and any remaining blocker. A truthful partial report beats a false completion.
4. Reply to your parent with `await agent_message.send(<summary>, receiver_role='parent')`. The
   summary must state: commit SHA, gate result with file/test counts, the mutation evidence in one
   line each, and anything you could not do. If you are blocked or you decide the task's premise is
   wrong, say so instead of inventing a completion.
