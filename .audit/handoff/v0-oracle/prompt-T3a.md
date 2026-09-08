You implement exactly one task from a roadmap. You are in a dedicated git worktree.

Worktree: /tmp/cf-stumble-wt/T3a   (branch work/T3a, based on d1f241264f5fdf73f2cdf23b00c1aaf17e590a02)
Task:     /Users/aditya/repos/projects/cf-stumble/.audit/v0/roadmap-v0.approved.md — read the "Dispatch contract" section and ONLY the section for T3a.
Cut line: /Users/aditya/repos/projects/cf-stumble/.audit/v0/goal.md — do not exceed it.
Confirmed evidence for this task (already verified from source; do not re-derive, use it):
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E3-per-project-workspace-encodings.md
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E6-no-http-turn-surface.md
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E9-wave2-preconditions.md
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E10-e1-fixed-and-proven.md

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

## You are T3a: the DETERMINISTIC half of the workspace migration
Do T3a only. T3b (the paid concurrency experiment) is a separate task blocked on owner approval.

## Cut-line guard
No alarm, no scheduler, no queue framework. If a criterion seems to need one, you have over-read it;
say so in the report instead of building one.

## E3 gives you the three encodings - do not rediscover them
ADR-0038 and ADR-0039 are human-approved: ONE shared Computer workspace per tenant holding the
harness repository and every project repository as separate directories. Three places still encode
the layout those ADRs replaced:
1. `src/workspace-names.ts` hashes `identity + audience + project.id`, so every project gets its own
   container. Callers: `src/workspace/provisioning.ts:114`, `src/supervisor/projects/project-turn.ts:85`.
2. `HARNESS_BUILD_WORKSPACE_NAME = "harness-build-workspace"` — a separate, TENANT-BLIND global build
   container, used at `src/supervisor/artifacts/build-workspace.ts:117`.
3. `PROJECT_ROOT = "/project"` is defined TWICE, independently:
   `src/workspace/project/resolve.ts:11` and `src/facet/generation-0/execution-env-paths.ts:12`,
   plus `src/project-provision.ts:26-27`.

**Treat the repository-relative root as ONE seam, not two constants.** Give it a single owning module
that both consumers read. The facet copy is the PATH-ESCAPE GUARD
(`execution-env-paths.ts:33`): if the two definitions drift, addressed-path translation and the
sandbox check disagree about what is inside the root, which is a security divergence, not a tidiness
problem.

`docs/agents/design/computer-integration.md` states the same requirement in its own words:
"The current implementation still derives a separate Computer workspace name for each project and a
separate name for harness builds. It must be simplified to use the shared workspace before version 0
is complete."

## Scope boundaries
- T5 is already MERGED. `supervisor.ts` thread wrappers (finish/abandon now REQUIRE a lease id) are
  not yours. You own Supervisor CONSTRUCTION and workspace wiring.
- `supervisor.ts:87` constructs `new ProjectThreads(ctx.storage)` with NO catalog, so it falls back
  to the placeholder catalog. That line is in your constructor region; T6a needs a real catalog
  passed there. Either wire it or leave a written interface for T6a. Say which.
- `src/access/index.ts` scope widening is YOURS alone; T6a consumes it. That includes the owner-only
  Access policy acceptance item and its local rejection tests.
- Enumerate the test files you touch in the report. Do not reach into `test/facet/**`, which T4 owns
  in this wave.

## A race that is now yours
`planHarnessBuild` in `src/harness-build.ts` emits `rm -rf ${directory} && mkdir -p ${directory}` for
a directory keyed only by the commit, so two same-commit builds delete each other's tree. T1a merged
`d1f2412` and handed this to you in writing rather than widening it. Decide the isolate/install
location policy. A bounded conflict or a narrow serialization policy is in scope; a scheduler is not.

## Do not break what just landed
`pnpm verify` on main is 96 files / 658 tests, and `scripts/probe/clean-build.sh` produces two
byte-identical module maps. Re-run BOTH before you claim success, and report the clean-build sha.
## Finish
1. `pnpm verify` passes. Commit on green, conventional-commit message.
2. Write /Users/aditya/repos/projects/cf-stumble/.audit/v0/tasks/T3a.md: task id, commit SHA, changed paths, each acceptance criterion with the evidence that it holds, what you deliberately did NOT do, and any remaining blocker. A truthful partial report beats a false completion.
