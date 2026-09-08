You implement exactly one task from a roadmap. You are in a dedicated git worktree.

Worktree: /tmp/cf-stumble-wt/T13   (branch work/T13, based on eb7c5755dd1cb8548b6a51d53b41cfa33cceb451)
Task:     /Users/aditya/repos/projects/cf-stumble/.audit/v0/roadmap-v0.approved.md — read the "Dispatch contract" section and ONLY the section for T13.
Cut line: /Users/aditya/repos/projects/cf-stumble/.audit/v0/goal.md — do not exceed it.
Confirmed evidence for this task (already verified from source; do not re-derive, use it):
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E6-no-http-turn-surface.md

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

## This task exists because the round-2 review overturned an earlier decision of mine. Read it.
`.audit/v0/review-round2.md` section 2.1, and `.audit/v0/decision-log.md` D62 and D67.

## The fault
Goal criterion 4 requires a real turn whose reply SHOWS A DIFF. Today that is a PROMPT INSTRUCTION,
not a guarantee:
- `src/facet/generation-0/turn-policy.ts:13` — one sentence in `GENERATION_0_SYSTEM_PROMPT`:
  "Run `git diff` with the bash tool when the user asks what changed". That is the ONLY thing that
  makes a diff happen in production.
- `test/facet/generation-0/turn-diff.test.ts:41-56` — the test scripts the model to call
  `bash {command: "git diff"}` and then HAND-FEEDS the stdout via
  `handle.push({name:"stdout", ...})` against `FakeProjectCapability`. No git ever runs. The review's
  words: it "would still pass with `git diff` renamed to `cat`".
- Q6 pins `@cf/zai-org/glm-5.3-flash` at `reasoning_effort: "low"`. A flash model at low effort
  skipping one clause of a five-clause system prompt is an ORDINARY event, not a tail risk. Nothing
  in the harness appends a diff when the model does not ask for one.

## What to decide and build
Make the diff a property of the TURN, not a hope about the model. The obvious shape is a diff the
harness itself produces at the end of a turn that touched files, independent of whether the model
chose to run `git diff` — but you own the design. Whatever you choose, a turn that modified the
workspace must be able to show what changed WITHOUT depending on the model's cooperation.
Then make the test prove THAT property. A test that hand-feeds its own expected output proves the
frame budget, not the feature; if a fake is unavoidable, the fake must at minimum run a real diff
over real file contents.
State plainly in your report which part remains model-dependent, if any.

## Cut line
No new tool, no scheduler, no background job, no git wrapper library. Do not touch the model choice
(that is Q6, owner-only). Do not weaken T9's `earnsCompletedRealTurnCredit` or T5's lease fencing.

## Do not break what landed
`pnpm verify` is 116 files / 829 tests; `scripts/probe/clean-build.sh` gives two identical maps
(sha256 `313ddf26...`). Re-run BOTH and report the sha. You ARE touching facet code, so the sha is
expected to move — report the new one.
## Finish
1. `pnpm verify` passes. Commit on green, conventional-commit message.
2. Write /Users/aditya/repos/projects/cf-stumble/.audit/v0/tasks/T13.md: task id, commit SHA, changed paths, each acceptance criterion with the evidence that it holds, what you deliberately did NOT do, and any remaining blocker. A truthful partial report beats a false completion.
