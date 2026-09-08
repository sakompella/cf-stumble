# Sol review: does the test suite prove anything

cf-stumble went from 642 tests to 841 tests in one unattended overnight run. Nobody has asked whether
the new tests bind the production code.

One precedent shapes this review. T7 added a diff test that hand-fed stdout to a fake; it would have
passed with `git diff` renamed to `cat`. The round-2 review caught it and the work was redone as T13.
Assume more tests of that shape are in the suite and find them.

Your worktree is `/private/tmp/cf-stumble-sol/tests`, already installed, detached at `7818f8d`. Run the gate there.

## Where things are

- Repository of record: `/Users/aditya/repos/projects/cf-stumble` (branch `main`, head `7818f8d`).
- Planning and evidence artifacts: `/Users/aditya/repos/projects/cf-stumble/.audit/v0/` (gitignored, present only in the repository of record).
  Read `STATE.md` first, then `decision-log.md` (D1-D69), `questions.md` (Q1-Q7), `goal.md`,
  `acceptance-checks.md`, and the per-task reports under `/Users/aditya/repos/projects/cf-stumble/.audit/v0/tasks/`.
- Prior reviews to argue with, not to repeat: `/Users/aditya/repos/projects/cf-stumble/.audit/v0/review-opus-round1.md` (the roadmap),
  `/Users/aditya/repos/projects/cf-stumble/.audit/v0/review-round2.md` (the merged code). Both were written by `claude-opus-5`.
  You are the cross-vendor second opinion the owner asked for and never got.
- Repository conventions: `AGENTS.md`. Required reading order for architecture: `docs/agents/domain.md`.
- The gate is `pnpm verify` (typecheck, format, lint, tests; about 15 seconds). A gate that fails is *red*.

## How to work

- Read the code before you judge it. Cite `path:line` for every claim about the codebase.
- Rank findings by leverage. Lead with the ones that change a decision.
- State each finding as: what is true, the evidence, what it costs, what to do.
- Mark anything you could not verify as unverified and say what would settle it.
- Spend no money: Q7 (owner approval for a disposable paid Cloudflare environment) is still open,
  so every paid probe stays unrun. Local commands and reads are yours to use freely.
- Confine your writing to your own review file. Leave the repository's tracked files as you found them.

## Scope

Apply one rule to the tests added between `d6ff238` and `7818f8d`
(`git diff --stat d6ff238..7818f8d -- test/`):

> For every test, name the production change that breaks it.

A test whose breaking change you cannot name is decoration. Report each one you find, with
`path:line`, the shape of the fake, and the rename or deletion that would still let it pass.

Then answer:

1. **The fakes.** Where does a test assert against a fixture the test itself supplied, rather than
   against behaviour the production code produced?
2. **The seams that carry the goal.** The lease (T5), the credit predicates (T9b), the diff frames
   (T13), the streamed model route (T4), the tenant workspace (T3a). For each, name the test that
   would go red if the seam broke, or state that none exists.
3. **The gate's reach.** `pnpm verify` never opens a browser and `scripts/probe/clean-build.sh` shares
   the host toolchain. Say plainly what the green gate does and does not prove.
4. **The page.** T10 rewrote `src/page/` and added `test/page/owner-page.test.ts`. Does that file test
   the rendered page or the module's own helpers?

## Verdict

End with one line: `THE SUITE BINDS`, `THE SUITE BINDS WITH GAPS`, or `THE SUITE IS DECORATIVE`, and
the count of tests you would delete.

## Finish

Write your review to `/Users/aditya/repos/projects/cf-stumble/.audit/v0/review-sol-tests.md`.
Then send the review's verdict line plus your top five findings to your parent with
`await agent_message.send(<text>, receiver_role='parent')`.

You are done when every item in your scope list above carries a verdict and evidence, and the file exists.
