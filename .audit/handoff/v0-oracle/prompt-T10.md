You implement exactly one task from a roadmap. You are in a dedicated git worktree.

Worktree: /tmp/cf-stumble-wt/T10   (branch work/T10, based on eb7c5755dd1cb8548b6a51d53b41cfa33cceb451)
Task:     /Users/aditya/repos/projects/cf-stumble/.audit/v0/roadmap-v0.approved.md — read the "Dispatch contract" section and ONLY the section for T10.
Cut line: /Users/aditya/repos/projects/cf-stumble/.audit/v0/goal.md — do not exceed it.
Confirmed evidence for this task (already verified from source; do not re-derive, use it):
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E6-no-http-turn-surface.md
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E10-page-is-server-rendered-only.md

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

## You own criterion 4's BROWSER half. T9 just merged the server half; consume it, do not rebuild it.
`POST /api/projects/{id}/turn` exists now (`src/routes/turns.ts`). Read it and `src/routes/route-stream.ts`
FIRST and build the client against the frames they actually emit. Do not invent a frame shape.

## Confirmed facts
- `src/page/` is ~645 lines over nine files with NO sidebar, NO collapsible anything, NO streaming
  client: `grep -rln "sidebar\|collapsib\|EventSource\|ReadableStream" src/page/` returns nothing.
- `src/page/markup.ts:30` still hardcodes the project-id input default to `project-one`. T6a made
  the catalog real: read `GET /api/projects` instead. A hardcoded id is a bug, not a placeholder.

## Criterion 4 wants, in the browser
a sidebar of connected projects; a conversation that streams as the turn runs (not one block at the
end); and one real turn whose reply shows a diff. Collapsible tool detail so a long turn stays
readable. You own the first two and the readability of the third.

## Cut line
No framework, no build step for the page, no bundler, no client-side router, no reconnect/resume,
no offline cache. This is a Worker serving HTML plus a small script. Keep it that way.

## Do not break what landed
`pnpm verify` on main is 116 files / 829 tests and `scripts/probe/clean-build.sh` gives two
identical maps (sha256 `313ddf26...`). Re-run BOTH before claiming success and report the sha.
Your work is host-side, so the sha should NOT move; say so explicitly if it does.
## Finish
1. `pnpm verify` passes. Commit on green, conventional-commit message.
2. Write /Users/aditya/repos/projects/cf-stumble/.audit/v0/tasks/T10.md: task id, commit SHA, changed paths, each acceptance criterion with the evidence that it holds, what you deliberately did NOT do, and any remaining blocker. A truthful partial report beats a false completion.
