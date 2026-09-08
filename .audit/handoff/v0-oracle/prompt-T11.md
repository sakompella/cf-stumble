You implement exactly one task from a roadmap. You are in a dedicated git worktree.

Worktree: /tmp/cf-stumble-wt/T11   (branch work/T11, based on 7818f8d5e06a3887bb16662f3fb854c7267687f6)
Task:     /Users/aditya/repos/projects/cf-stumble/.audit/v0/roadmap-v0.approved.md — read the "Dispatch contract" section and ONLY the section for T11.
Cut line: /Users/aditya/repos/projects/cf-stumble/.audit/v0/goal.md — do not exceed it.
Confirmed evidence for this task (already verified from source; do not re-derive, use it):
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E2-lease-fencing-dead-code.md
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E12-turn-credit-is-http-not-durability.md

## Rules
- Read AGENTS.md and follow docs/agents/domain.md before you write code. Read the ADRs your task names.
- Apply the repo skills: typescript-best-practices for any .ts; agents-sdk and durable-objects for Supervisor, facet, thread or RPC work; cloudflare and workers-best-practices for bindings and Worker config.
- Stay inside your task's listed scope. Do not fix unrelated things you notice; list them in the report instead.
- Do not edit README.md. Do not create or edit GitHub issues. Do not push.
- `pnpm verify` is the gate: typecheck, format check, lint, tests, about 11s. Run it before you claim anything works.
- Delete obsolete code and its tests rather than leaving them unreachable. An unused safe path is a fault, not a safety net.

## No paid spend tonight
The owner is asleep and has not approved paid probes. Do NOT run `wrangler deploy`, create or start
any Computer workspace, call any billing Cloudflare API, or use the owner's account credentials.
If an acceptance criterion needs a paid environment, record it as **blocked: awaiting owner approval
for a paid probe** and prove everything else. Never fake, mock, or simulate a paid result to close a
criterion. `pnpm verify` runs locally in workerd and is always allowed.

## You own the failure and race behaviour of what now exists. Break it on purpose.
Ten tasks merged. The happy paths are tested. What is thin is what happens when two things collide
or one half fails, and that is exactly where a v0 demo dies.

## The seams worth attacking, each with a real invariant behind it
- **Lease fencing (T5).** `startTurn` returns a lease id; `finishTurn`/`abandonTurn` REQUIRE it.
  What happens when a stale lease finishes after a new turn started? When the same lease finishes
  twice? When abandon races finish?
- **Turn credit (T9/T13, E12).** `servedSuccessfulResponse` answers "is this generation known
  good?" (an HTTP fact) and `earnsCompletedRealTurnCredit` answers "did one real turn complete?"
  (Pi terminal success AND a committed thread save). Prove those two CANNOT be collapsed: a thread
  save that fails must NOT earn credit, and must NOT make a healthy generation ineligible.
- **The turn route (T9).** Two concurrent turns on one project. A turn on a project that is not
  connected. A disconnected browser mid-stream — the cut line says a cancelled or disconnected turn
  earns NO credit; prove it.
- **The diff (T13).** `readWorkspaceDiff` when the command fails, times out (30s), or prints more
  than the budget. T13 says a non-zero exit becomes `diff-unavailable` with git's message rather
  than a silent empty diff. Prove that, and prove exactly one terminal frame still ends the stream.
- **Generations (T2).** Epochs without a journal: activate and roll back under a stale epoch.

## The rule that makes this task worth doing
A test that cannot fail proves nothing. For each test you add, state in the report WHAT PRODUCTION
CHANGE WOULD BREAK IT. If you cannot name one, delete the test. The round-2 review killed an
earlier test that "would still pass with `git diff` renamed to `cat`" — do not add another of those.

## Cut line
No new feature, no retry, no scheduler, no reconnect. If you find a real fault, FIX IT ONLY IF the
fix is small and obviously correct; otherwise write it up as a finding with file:line and leave the
code alone. A clear finding beats a rushed fix.

## Do not break what landed
`pnpm verify` is 118 files / 841 tests; `scripts/probe/clean-build.sh` gives two identical maps
(sha256 `e9c3008e...`). Re-run BOTH and report the sha. Mostly-tests work should NOT move the sha.
## Finish
1. `pnpm verify` passes. Commit on green, conventional-commit message.
2. Write /Users/aditya/repos/projects/cf-stumble/.audit/v0/tasks/T11.md: task id, commit SHA, changed paths, each acceptance criterion with the evidence that it holds, what you deliberately did NOT do, and any remaining blocker. A truthful partial report beats a false completion.
