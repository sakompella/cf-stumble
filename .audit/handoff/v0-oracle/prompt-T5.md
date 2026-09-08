You implement exactly one task from a roadmap. You are in a dedicated git worktree.

Worktree: /tmp/cf-stumble-wt/T5   (branch work/T5, based on d6ff2380487a60f410c568272635d99f30560d14)
Task:     /Users/aditya/repos/projects/cf-stumble/.audit/v0/roadmap-v0.md — read the "Dispatch contract" section and ONLY the section for T5.
Cut line: /Users/aditya/repos/projects/cf-stumble/.audit/v0/goal.md — do not exceed it.
Confirmed evidence for this task (already verified from source; do not re-derive, use it):
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E2-lease-fencing-dead-code.md
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

## Two things already established - use them, do not re-derive

E2: `store.ts` already has `startTurnWithLease` / `finishTurnWithLease` / `abandonTurnWithLease`, and
`grep -rn "WithLease" src test` matches ONLY inside `store.ts`. They have zero callers and zero
tests. `project-threads.ts` and `supervisor.ts` (lines 226-263) expose only the lease-DISCARDING
variants, so a client never receives a lease id and cannot return one.
The deletion test points one way: make the client surface carry the lease id, then DELETE the
unfenced variants. Criterion 1 says exactly this - "remove optional/unkeyed completion paths in the
same task". An unused safe path is a fault, not a safety net.

E6: no HTTP route reaches `startProjectTurn`, `finishProjectTurn`, `abandonProjectTurn` or
`streamProjectTurn` today. So your change has no HTTP caller to migrate. Do not invent one - that is
T9's work. Migrate the RPC wrappers and their tests only.

## Scope boundary with T3, which is running in parallel
T3 owns `supervisor.ts` CONSTRUCTION (lines ~74-88) and workspace wiring. You own ONLY the thread RPC
wrappers at lines ~226-263 plus `src/supervisor/threads/` and `test/supervisor/threads/`.
Do not touch the constructor, `workspace-names.ts`, or `artifacts/`. Say in your report exactly which
`supervisor.ts` line ranges you changed, so the wave manager can merge cleanly.

## Dependency note
The roadmap lists T1 as a dependency. That is wave ordering, not a semantic prerequisite: T1 fixes the
clean BUILD path and touches no thread code. Proceed. If you find a real dependency on T1, stop and
say so in the report.

## Criterion 3 is the hard one
"Fresh thread invalidates old leases even when revision zero recurs" needs a durable thread identity
or a monotonic concurrency version, plus a reset-race test THROUGH storage. Design that first, name
the data shape, then write the test that fails before your change.
## Finish
1. `pnpm verify` passes. Commit on green, conventional-commit message.
2. Write /Users/aditya/repos/projects/cf-stumble/.audit/v0/tasks/T5.md: task id, commit SHA, changed paths, each acceptance criterion with the evidence that it holds, what you deliberately did NOT do, and any remaining blocker. A truthful partial report beats a false completion.
