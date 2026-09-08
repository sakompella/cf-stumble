You implement exactly one task from a roadmap. You are in a dedicated git worktree.

Worktree: /tmp/cf-stumble-wt/T1   (branch work/T1, based on d6ff2380487a60f410c568272635d99f30560d14)
Task:     /Users/aditya/repos/projects/cf-stumble/.audit/v0/roadmap-v0.md — read the "Dispatch contract" section and ONLY the section for T1.
Cut line: /Users/aditya/repos/projects/cf-stumble/.audit/v0/goal.md — do not exceed it.
Confirmed evidence for this task (already verified from source; do not re-derive, use it):
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E1-clean-build-blocker.md
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E8-paid-evidence-boundary.md
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E3-per-project-workspace-encodings.md

## Rules
- Read AGENTS.md and follow docs/agents/domain.md before you write code. Read the ADRs your task names.
- Apply the repo skills: typescript-best-practices for any .ts; agents-sdk and durable-objects for Supervisor, facet, thread or RPC work; cloudflare and workers-best-practices for bindings and Worker config.
- Stay inside your task's listed scope. Do not fix unrelated things you notice; list them in the report instead.
- Do not edit README.md. Do not create or edit GitHub issues. Do not push.
- `pnpm verify` is the gate: typecheck, format check, lint, tests, about 11s. Run it before you claim anything works.
- Delete obsolete code and its tests rather than leaving them unreachable. An unused safe path is a fault, not a safety net.
## HARD LIMIT for this dispatch: no paid spend, no deployment

The owner is asleep and has NOT approved a paid probe. You are running the LOCAL half of T1 only.

- DO acceptance criteria 1, 2, 3, and the source/image pin CHECK half of 6.
- DO NOT run acceptance criteria 4 or 5, and do not run the pin-replacement half of 6.
  Do not run `wrangler deploy`, do not create or start any Computer workspace, do not call any
  Cloudflare API that bills, and do not use the owner's account credentials.
- Record criteria 4, 5 and the pin-replacement check as **blocked: awaiting owner approval for a
  paid probe**. The task's own criterion 6 already says missing paid authorization means BLOCKED,
  not passed. Follow that rule exactly. Do not fake, mock, or simulate a paid result to close them.

## The fault is already diagnosed - do not rediscover it

E1 gives you the cause with file and line evidence. In short: `src/harness-build.ts:30` builds a
labeled commit with `pnpm run build:module-map` alone, but `vendor/pi-v0.84.4/dist/` is untracked
and only `pnpm build:pi` creates it, so esbuild cannot resolve `@cf-stumble/pi` from a clean
checkout. Local `pnpm verify` hides this because it runs `build:pi` first.
Spend your budget on the FIX and on proving it from clean state.

Prefer one owning script (for example `build:artifact`) that the Supervisor's build command and the
local gate both use, so the deployed command and the local gate cannot drift apart again. Do not
commit `dist/` to git: that trades a build fault for a staleness fault.

E8 tells you which paid facts already exist so you do not plan to re-buy them.
E3 is context only: T3 owns the workspace-name change. Do NOT change workspace naming here, but if
your build-path edits touch `build-workspace.ts`, keep them narrow and say so in the report.

Criterion 3 (two independent clean builds produce byte-identical canonical maps) is fully local.
It is the highest-value thing you can deliver tonight. Retain the exact commands and their output.
## Finish
1. `pnpm verify` passes. Commit on green, conventional-commit message.
2. Write /Users/aditya/repos/projects/cf-stumble/.audit/v0/tasks/T1.md: task id, commit SHA, changed paths, each acceptance criterion with the evidence that it holds, what you deliberately did NOT do, and any remaining blocker. A truthful partial report beats a false completion.
