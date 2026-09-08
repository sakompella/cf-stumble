You implement exactly one task from a roadmap. You are in a dedicated git worktree.

Worktree: /tmp/cf-stumble-wt/T2   (branch work/T2, based on d6ff2380487a60f410c568272635d99f30560d14)
Task:     /Users/aditya/repos/projects/cf-stumble/.audit/v0/roadmap-v0.md — read the "Dispatch contract" section and ONLY the section for T2.
Cut line: /Users/aditya/repos/projects/cf-stumble/.audit/v0/goal.md — do not exceed it.
Confirmed evidence for this task (already verified from source; do not re-derive, use it): none

## Rules
- Read AGENTS.md and follow docs/agents/domain.md before you write code. Read the ADRs your task names.
- Apply the repo skills: typescript-best-practices for any .ts; agents-sdk and durable-objects for Supervisor, facet, thread or RPC work; cloudflare and workers-best-practices for bindings and Worker config.
- Stay inside your task's listed scope. Do not fix unrelated things you notice; list them in the report instead.
- Do not edit README.md. Do not create or edit GitHub issues. Do not push.
- `pnpm verify` is the gate: typecheck, format check, lint, tests, about 11s. Run it before you claim anything works.
- Delete obsolete code and its tests rather than leaving them unreachable. An unused safe path is a fault, not a safety net.
- ADR-0030 is human-approved and defines the outcome: no request ids, no command fingerprints, no
  `generation_control_journal`. Candidate resubmission returns the EXISTING generation. Activating the
  already-active generation is a no-op. Activation and rollback KEEP their epoch checks. Epoch-based
  stale-write protection must survive this change intact.
- Scope measured before dispatch: 58 references in `src` across `src/page/script-generations.ts`,
  `src/page/markup.ts`, `src/routes/generations.ts`, `src/supervisor/control/request.ts`,
  `src/supervisor/control/index.ts`, and the whole 91-line module `src/supervisor/control/journal.ts`;
  plus 83 references across 13 test files. `journal.ts` should not survive.
- Prove the behaviour ADR-0030 promises with tests, not just the absence of the journal: resubmitting
  the same candidate returns the existing generation, activating the active generation is a no-op, and
  a stale epoch is still rejected.
## Finish
1. `pnpm verify` passes. Commit on green, conventional-commit message.
2. Write /Users/aditya/repos/projects/cf-stumble/.audit/v0/tasks/T2.md: task id, commit SHA, changed paths, each acceptance criterion with the evidence that it holds, what you deliberately did NOT do, and any remaining blocker. A truthful partial report beats a false completion.
