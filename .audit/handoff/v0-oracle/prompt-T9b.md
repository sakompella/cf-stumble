You implement exactly one task from a roadmap. You are in a dedicated git worktree.

Worktree: /tmp/cf-stumble-wt/T9b   (branch work/T9b, based on 0161f912b01a1a58ef277aa7662f3b2ee236dd6f)
Task:     /Users/aditya/repos/projects/cf-stumble/.audit/v0/roadmap-v0.approved.md — read the "Dispatch contract" section and ONLY the section for T9b.
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

## You are T9 (this worktree is named T9b; two earlier attempts died for infrastructure reasons).
Preserved earlier work, for REFERENCE ONLY — never verified, no report justified it:
- `work/T9-stalled`: `56971c4` (delete the unreachable legacy execution path) + `044bb6e` (18 files WIP)
- `work/T9-del`: `6b880c5`, the same first move made independently by attempt two.
Both attempts began by deleting the unreachable legacy execution path, which is suggestive but not
proof. Inspect with `git diff main..work/T9-stalled` if useful. Redo anything you cannot confirm.
Do NOT create branches or worktrees outside your own worktree; work only in this directory.

## Two confirmed facts define the shape of this task.

### E6: there is NO HTTP surface for a turn. You must build one.
No route reaches `startProjectTurn`, `finishProjectTurn`, `abandonProjectTurn` or
`streamProjectTurn`. The `streamProjectTurn` doc comment names this work: "Joining them is the next
unit's work, because it has to settle what a disconnected browser leaves behind (ADR-0037), not
merely call the two in order."

### E12: turn credit is an HTTP fact, and the obvious fix breaks generation eligibility.
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
- T7: typed Pi frames, instructions, compaction, a diff via `bash` + `git diff`; legacy buffered path gone.
- T6a: connected projects, `AccessRequestResult.ok.scope`, real catalog. Consume the verified scope.
- T4: the model route streams.

## Cut line
No alarm, no scheduler, no queue framework, no background-turn feature, no reconnect/resume feature.
A cancelled or disconnected turn earns NO completed-real-turn credit.

## Do not break what landed
`pnpm verify` on main is 113 files / 797 tests; `scripts/probe/clean-build.sh` gives two identical
maps (sha256 `18cea22b...`). Re-run BOTH before claiming success and report the sha.
## Finish
1. `pnpm verify` passes. Commit on green, conventional-commit message.
2. Write /Users/aditya/repos/projects/cf-stumble/.audit/v0/tasks/T9b.md: task id, commit SHA, changed paths, each acceptance criterion with the evidence that it holds, what you deliberately did NOT do, and any remaining blocker. A truthful partial report beats a false completion.
