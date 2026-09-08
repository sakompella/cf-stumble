You implement exactly one task from a roadmap. You are in a dedicated git worktree.

Worktree: /tmp/cf-stumble-wt/T14   (branch work/T14, based on 7818f8d5e06a3887bb16662f3fb854c7267687f6)
Task:     /Users/aditya/repos/projects/cf-stumble/.audit/v0/roadmap-v0.approved.md — read the "Dispatch contract" section and ONLY the section for T14.
Cut line: /Users/aditya/repos/projects/cf-stumble/.audit/v0/goal.md — do not exceed it.
Confirmed evidence for this task (already verified from source; do not re-derive, use it): none

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

## One narrow job: the page must render the two frame kinds T13 added.
T10 built the page (`7818f8d`) and T13 added the frames (`3a77907`). T10 was dispatched BEFORE T13
landed, so it renders every frame kind EXCEPT the newest two. `grep -rn "diff-unavailable" src/page/`
returns nothing today. That is the whole gap.

## Read first, then match what is there
- `src/facet/generation-0/turn-frames.ts` — the `diff` frame (`content`, `truncated`) and the
  `diff-unavailable` frame (`detail`). Use the real field names; do not invent any.
- `src/supervisor/projects/turn-frames.ts` — how both are proven and forwarded to the browser.
- `src/page/script-render.ts` and `src/page/script-turn.ts` — how T10 renders the frames it knows,
  including its bounded output and collapsible tool detail. FOLLOW THAT SHAPE. Do not restyle the
  page, do not refactor T10's modules, do not add a framework.
- `src/page/styles.ts` — T10's report says it already carries "diff colours". Check before adding any.

## What done means
A turn that edits a file ends with its diff visible in the transcript, and a turn whose repository
could not answer shows the reason (`detail`) instead of silence. A long diff must not break the
page: T13 already truncates and sets `truncated`, so say so in the UI rather than pretending the
diff is whole.

## Cut line
No framework, no bundler, no client router, no new endpoint, no change to any frame's shape, no
change to `src/facet/**` or `src/supervisor/**`. This is page-side only.

## Do not break what landed
`pnpm verify` on main is 118 files / 841 tests. `scripts/probe/clean-build.sh` gives two identical
maps, sha256 `e9c3008e...`. Re-run BOTH before claiming success and report the sha — your work is
page-side, so the sha should NOT move. Say so explicitly if it does.
## Finish
1. `pnpm verify` passes. Commit on green, conventional-commit message.
2. Write /Users/aditya/repos/projects/cf-stumble/.audit/v0/tasks/T14.md: task id, commit SHA, changed paths, each acceptance criterion with the evidence that it holds, what you deliberately did NOT do, and any remaining blocker. A truthful partial report beats a false completion.
