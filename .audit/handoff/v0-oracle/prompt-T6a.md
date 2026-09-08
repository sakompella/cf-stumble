You implement exactly one task from a roadmap. You are in a dedicated git worktree.

Worktree: /tmp/cf-stumble-wt/T6a   (branch work/T6a, based on 638890ef8a8cd231f418306e0d0b9646f8531c66)
Task:     /Users/aditya/repos/projects/cf-stumble/.audit/v0/roadmap-v0.approved.md — read the "Dispatch contract" section and ONLY the section for T6a.
Cut line: /Users/aditya/repos/projects/cf-stumble/.audit/v0/goal.md — do not exceed it.
Confirmed evidence for this task (already verified from source; do not re-derive, use it):
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E4-project-catalog-tuple.md
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E9-wave2-preconditions.md
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E3-per-project-workspace-encodings.md

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

## You are T6a: the UNSUPERVISED half of connecting GitHub repositories
T6b (the one owner-run `github.com/login/device` authorization and the private-repo clone proof) is a
separate wave-5 owner step. Do NOT attempt a device flow, and do not touch the owner's GitHub account.

## Two confirmed facts, already verified - use them
E4: `src/project-catalog.ts` declares `export type ProjectCatalog = readonly [Project, Project]` — a
FIXED-ARITY TUPLE in the type system, 17 references across 5 files, holding two placeholders at
`example.invalid`. Goal criterion 3 needs "at least two" repositories connected at runtime, so a
two-tuple cannot express it and no connect flow can append to it. Change the TYPE to a
variable-length collection and follow it through every consumer. `resolveProject` is the single
choke point every consumer already goes through, so the seam exists; the arity is what must move.

E9: `grep -rn "gh auth|GH_TOKEN|GITHUB_TOKEN" src scripts docs/agents/design` returns ZERO. No
credential path exists anywhere. You are building it from nothing. Also,
`provisionProjectWorkspace` (`src/workspace/provisioning.ts:111`) is exported and has NO caller in
`src/` — the seam you must wire already exists and is currently unreachable, so nothing exercises it.

## T3a merged `43e7ac8` and left you two written interfaces - use them, do not re-derive
1. `AccessRequestResult.ok` now carries `scope: { identity, audience }` — the pair the Supervisor name
   was derived from. CONSUME that scope. Do not derive a tenant of your own, and do not add tenant
   authority: T3a owns `src/access/index.ts`.
2. `supervisor.ts` constructs `new ProjectThreads(ctx.storage, catalog)` and `streamProjectTurn` takes
   the same optional `catalog` argument, both deliberately left for you so ONE catalog reaches both.
   Supply the real catalog there.
Correction you should know: owner-only Access enforcement ALREADY EXISTS
(`src/access/index.ts` reads `CF_ACCESS_OWNER_SUB`, refuses others with `not-owner`, fails closed;
`test/access-owner.test.ts`). The roadmap's claim that it was missing is FALSE. Do not re-add it.

## Credentials: the rule that cannot bend
Goal criterion 3: credentials must never appear in tracked files, application logs, browser
responses, R2 maps, or saved facet state. Build the storage and the connect surface so that a
credential CANNOT reach any of those, and prove the negative with tests. A documented
token-from-secret fallback for automated tests is required, so T9 and T11 are not blocked on a human.

## Do not break what landed tonight
`pnpm verify` on main is 103 files / 698 tests, and `scripts/probe/clean-build.sh` produces two
identical maps (sha256 `8e821d86...`). Re-run BOTH before claiming success and report the sha.
## Finish
1. `pnpm verify` passes. Commit on green, conventional-commit message.
2. Write /Users/aditya/repos/projects/cf-stumble/.audit/v0/tasks/T6a.md: task id, commit SHA, changed paths, each acceptance criterion with the evidence that it holds, what you deliberately did NOT do, and any remaining blocker. A truthful partial report beats a false completion.
