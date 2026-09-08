# Sol review: merge or reject T14

T14 is finished and unmerged. It sits at commit `f00eaac` on branch `work/T14`, based on `7818f8d`.
Its report is `/Users/aditya/repos/projects/cf-stumble/.audit/v0/tasks/T14.md`.

T14 exists because of a scheduling error, logged as D69 in the decision log: T10 (the owner page) was
dispatched before T13 (the harness diff) landed, so the page cannot render the `diff` and
`diff-unavailable` frames T13 added. T14 is the narrow follow-up that closes that gap.

Your worktree is `/private/tmp/cf-stumble-sol/t14`, already installed, detached at `f00eaac`. Run the gate there.
Compare against `7818f8d` with `git diff 7818f8d..f00eaac`.

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

The owner needs one decision: merge `f00eaac` into `main`, or send it back. Reach it by answering:

1. **The gap.** Does the diff actually render both frame kinds T13 emits? Read the frame shapes in
   `src/facet/` and the dispatch in `src/page/script-turn.ts`.
2. **The cut line.** T14 was scoped to the page alone. Confirm from the diff which directories it
   touched.
3. **The test.** T14 added cases to `test/page/owner-page.test.ts`. Name the production change each
   one breaks.
4. **The merge.** Does `f00eaac` merge cleanly into `7818f8d`, and does the gate stay green on the
   merged tree? Produce that tree in your worktree and run it.
5. **The remainder.** After T14, state what still stands between the owner page and goal criterion 4.

## Verdict

End with one line: `MERGE`, `MERGE WITH FIXES`, or `SEND BACK`, and the reason in one sentence.

## Finish

Write your review to `/Users/aditya/repos/projects/cf-stumble/.audit/v0/review-sol-t14.md`.
Then send the review's verdict line plus your top five findings to your parent with
`await agent_message.send(<text>, receiver_role='parent')`.

You are done when every item in your scope list above carries a verdict and evidence, and the file exists.
