You implement exactly one task. You are one of five workers running in parallel on separate worktrees of the same repository.

# T18 — land the browser harness, or retract what the repository advertises

## The fault, already verified from source. Do not re-derive it.

`package.json:21` runs `pnpm exec tsx tools/browser-harness/run.mts`. That file exists on NO branch.
`pnpm harness:browser` on main fails with `ERR_MODULE_NOT_FOUND`. `AGENTS.md:23-25` describes what
the command does and points maintainers at `tools/browser-harness/README.md`, which also does not
exist. All four reviewers of this tree found this independently; it is the top convergent finding.

The rest of the harness DOES exist, on `origin/work/T10-harness`:
`tools/browser-harness/{browser-errors,cdp,chrome-binary,chrome-launch,chrome,fixtures,json,page-queries,server-routes,server,smoke,turn-fixture}.mts`
plus a one-line change to `tools/tsconfig.json`. There is no `run.mts` and no `README.md` there.

Warning: `origin/work/T10-harness` diverged from main BEFORE several merges and its `test/` and
`src/` states are STALE. Do not merge that branch. Bring across `tools/browser-harness/**` and the
`tools/tsconfig.json` change only — `git checkout origin/work/T10-harness -- tools/browser-harness
tools/tsconfig.json` is the shape — then reconcile the harness against CURRENT main's page and
routes, which changed under it (T14 added `diff` and `diff-unavailable` frames).

## Your decision to make, and it is a real choice

Either:

**(A) Land it.** Write the missing `tools/browser-harness/run.mts` entrypoint and the README that
`AGENTS.md` promises, and make `pnpm harness:browser` PASS on this box. Export
`CF_STUMBLE_CHROME="$(command -v chromium)"`; Chromium 152 is installed here. `AGENTS.md` says the
harness starts a local stub of the owner API, serves the real page, drives headless Chromium over
the DevTools protocol, and asserts the streaming conversation, the project sidebar, the generation
drawer, keyboard access, and narrow and wide viewports. Whatever your run.mts actually asserts,
`AGENTS.md` must describe exactly that and no more. It must stay OUTSIDE `pnpm verify` — the commit
gate never opens a browser.

**(B) Retract it.** Remove the `harness:browser` script, remove the `AGENTS.md` lines that
advertise it, and delete the stale harness modules rather than leaving an unreachable tree.

Prefer (A): the page has no runnable UI evidence at all today and criterion 4 is a UI claim. Choose
(B) only if you find a concrete blocker on this box, and then name it exactly.

Also add the cheap guard the reviewer asked for, in EITHER case: a test inside `pnpm verify` that
every file path named by a `package.json` script exists in the tree. That is what would have caught
this. Keep it small and make it fail if you delete `run.mts`.

## What done means

The condition that ends this task: **`pnpm harness:browser` matches what the repository
advertises.** Under (A) the command exits 0 and its assertions are real — a harness that starts
Chromium and asserts nothing is a worse lie than a missing file. Under (B) nothing in the
repository claims the command exists.

Report the harness's runtime and what it proved, frame kind by frame kind, including the two frames
T14 added. Say plainly what it does NOT prove: it says nothing about Cloudflare Access, which needs
a deployed environment (blocked on Q7).

## Cut line

No new runtime dependency beyond what is already in `package.json` (`tsx` is there). No Playwright,
no Puppeteer — the existing modules speak raw CDP and that is the design. No paid Cloudflare call.
Do not change `src/` behaviour to make the harness pass; if the page is actually broken, report it
and let the parent dispatch a page fix.

## Read before you write

`AGENTS.md` lines 19-27, `tools/browser-harness/*.mts` on `origin/work/T10-harness` (start with
`smoke.mts` and `server.mts`), `/home/aditya/repos/cf-stumble/.audit/v0/tasks/T10.md` and `T14.md`, and
`/home/aditya/repos/cf-stumble/.audit/v0/review-sol-code.md` finding 5.

## Where you are

Worktree: /home/aditya/wt/T18   (branch `work/T18`, based on main at `9ac4b9c`)
The worktree already has `node_modules`. Work only inside it. `cd /home/aditya/wt/T18` first.

The durable audit trail lives in the MAIN checkout, which is gitignored and shared by reference
only: read `/home/aditya/repos/cf-stumble/.audit/v0/` and write your report to
`/home/aditya/repos/cf-stumble/.audit/v0/tasks/T18.md`. Do not create a `.audit/` tree in your worktree.

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
3. Write `/home/aditya/repos/cf-stumble/.audit/v0/tasks/T18.md` in the shape the existing reports in that directory use:
   task id, commit SHA, changed paths, each acceptance criterion with the evidence that it holds,
   the mutation runs with their exact mutated lines and the tests that failed, what you deliberately
   did NOT do, and any remaining blocker. A truthful partial report beats a false completion.
4. Reply to your parent with `await agent_message.send(<summary>, receiver_role='parent')`. The
   summary must state: commit SHA, gate result with file/test counts, the mutation evidence in one
   line each, and anything you could not do. If you are blocked or you decide the task's premise is
   wrong, say so instead of inventing a completion.
