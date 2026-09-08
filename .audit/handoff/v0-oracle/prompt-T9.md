You implement exactly one task from a roadmap. You are in a dedicated git worktree.

Worktree: /tmp/cf-stumble-wt/T9   (branch work/T9, based on 0161f912b01a1a58ef277aa7662f3b2ee236dd6f)
Task:     /Users/aditya/repos/projects/cf-stumble/.audit/v0/roadmap-v0.approved.md — read the "Dispatch contract" section and ONLY the section for T9.
Cut line: /Users/aditya/repos/projects/cf-stumble/.audit/v0/goal.md — do not exceed it.
Confirmed evidence for this task (already verified from source; do not re-derive, use it):
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E6-no-http-turn-surface.md
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E12-turn-credit-is-http-not-durability.md
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E2-lease-fencing-dead-code.md

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

## A previous attempt at T9 stalled. Its work is preserved; you may use it or ignore it.
Branch `work/T9-stalled` holds two commits off this same base:
- `56971c4 refactor(workspace): delete the unreachable legacy execution path`
- `044bb6e wip(T9)` — 18 files of uncommitted work, NEVER verified, never reported.
Inspect it with `git show`/`git diff main..work/T9-stalled` if useful. Treat it as a hint, not as
correct: nothing in it passed `pnpm verify` and no report justified it. Redo anything you cannot
confirm. Cherry-picking is allowed if you verify the result.

## Two confirmed facts define the shape of this task.

### E6: there is NO HTTP surface for a turn. You must build one.
The owner API serves only `/api/status`, `/api/generations/{submit,activate,rollback}`,
`/api/recovery/latest`, `/fresh`, and T6a's new project routes. No route reaches
`startProjectTurn`, `finishProjectTurn`, `abandonProjectTurn` or `streamProjectTurn`.
The `streamProjectTurn` doc comment names this work: "Joining them is the next unit's work, because
it has to settle what a disconnected browser leaves behind (ADR-0037), not merely call the two in
order."

### E12: turn credit is an HTTP fact today, and the obvious fix breaks generation eligibility.
`src/supervisor/eligibility.ts`:
`isCreditedTurn = attempt.outcome === "body-completed" && attempt.responseStatus < 400`,
consumed by `GenerationEligibility` — ADR-0031's relay-facts-decide-known-good machinery.
ONE predicate answers TWO questions: generation health (an HTTP fact, correct where it is) and
completed-real-turn credit (goal criterion 6 needs a DURABILITY fact: Pi terminal success AND a
committed thread save). Tightening `isCreditedTurn` would silently make a healthy generation
ineligible after a thread-save failure. ADD the durability requirement WITHOUT collapsing the two,
and state in your report which question each predicate answers.

## What landed that you build on
- T5: `startTurn` returns a lease id; `finishTurn`/`abandonTurn` REQUIRE it. Do not weaken it.
- T7: typed Pi frames, instructions, compaction, and a diff via `bash` + `git diff`; the legacy
  buffered path is gone. Consume T7's frames; do not resurrect it.
- T6a: connected projects, `AccessRequestResult.ok.scope`, real catalog. Routes must consume the
  verified scope, never a caller-supplied tenant.
- T4: the model route streams.

## Cut line
No alarm, no scheduler, no queue framework, no background-turn feature, no reconnect/resume feature.
A cancelled or disconnected turn earns NO completed-real-turn credit — criterion 6, not a feature.

## Do not break what landed
`pnpm verify` on main is 113 files / 797 tests, and `scripts/probe/clean-build.sh` produces two
identical maps (sha256 `18cea22b...`). Re-run BOTH before claiming success and report the sha.
## Finish
1. `pnpm verify` passes. Commit on green, conventional-commit message.
2. Write /Users/aditya/repos/projects/cf-stumble/.audit/v0/tasks/T9.md: task id, commit SHA, changed paths, each acceptance criterion with the evidence that it holds, what you deliberately did NOT do, and any remaining blocker. A truthful partial report beats a false completion.
