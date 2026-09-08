You implement exactly one task from a roadmap. You are in a dedicated git worktree.

Worktree: /tmp/cf-stumble-wt/T1a   (branch work/T1a, based on d6ff2380487a60f410c568272635d99f30560d14)
Task:     /Users/aditya/repos/projects/cf-stumble/.audit/v0/roadmap-v0.md — read the "Dispatch contract" section and ONLY the section for T1a.
Cut line: /Users/aditya/repos/projects/cf-stumble/.audit/v0/goal.md — do not exceed it.
Confirmed evidence for this task (already verified from source; do not re-derive, use it):
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E1-clean-build-blocker.md
- /Users/aditya/repos/projects/cf-stumble/.audit/v0/evidence/E8-paid-evidence-boundary.md

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

## You are T1a: the LOCAL half of roadmap task T1

Do T1 acceptance criteria 1, 2, 3 only, PLUS the regression proof below. Record criteria 4, 5 and
the pin-replacement half of 6 as **blocked: awaiting owner approval for a paid probe**. T1's own
criterion 6 says missing paid authorization means BLOCKED, not passed. Follow it exactly.

## The fault is already diagnosed - do not rediscover it

E1: `src/harness-build.ts:30` sets `buildCommand: "pnpm run build:module-map"`. `planHarnessBuild`
in that same file runs four steps - provision, isolate, checkout, build - with NO install step and
NO `build:pi` step, into a directory populated by `git archive`, which cannot contain the untracked
`vendor/pi-v0.84.4/dist/`. So esbuild cannot resolve `@cf-stumble/pi`. Local `pnpm verify` hides it
because `verify` runs `build:pi` first.

## Required, and NOT in the roadmap text - an independent review found these gaps

The repair alone is not enough: as written, T1 leaves no automated proof, so the drift returns the
moment anyone edits either side. Deliver all four:

(a) One `build:artifact` script in `package.json` performing install -> `build:pi` ->
    `build:module-map`.
(b) `HARNESS_BUILD_CONFIGURATION.buildCommand` must be exactly that script name, so the deployed
    command and the local gate cannot drift apart again.
(c) A test INSIDE `pnpm verify` asserting that the `buildCommand` string names a script that
    actually exists in `package.json`. Cheap, and it catches renames.
(d) A clean-build test that `git archive HEAD` into a temp directory with `HOME` and the pnpm store
    isolated and `node_modules` unreachable, runs `build:artifact`, and asserts a module map is
    produced. If that is too slow for the ~11s gate, make it a separate COMMITTED script that T12
    and CI run, and whose absence fails a documented checklist. A paragraph in an evidence file is
    not acceptable proof.

Do not commit `dist/` to git: that trades a build fault for a staleness fault.

## Probe and RECORD these container preconditions (do not assume them)

The oracle's local reproduction hides them: its log shows `resolved 183, reused 183, downloaded 0`,
a WARM pnpm store, and a native install script running (`koffi` via `cnoke`). A fresh Computer
container gives none of that. Record each as a named finding, from local inspection plus what the
lockfile and manifests require:
1. pnpm presence and version needed (lockfile is `pnpm-lock.yaml`; local pnpm is 11.18.0).
2. Node version needed (local run used Node 26.7.0; the container ships Node 22.23.2 per
   `docs/agents/design/computer-integration.md`) - flag any incompatibility.
3. npm registry reachability from the build container. This is NOT the same claim as T1.4's
   "arbitrary ordinary internet destination".
4. Whether lifecycle/native install scripts are permitted and can compile (`koffi`/`cnoke`), or
   whether `--ignore-scripts` is required and still yields a working `tsx` and `esbuild`.
   `pnpm-workspace.yaml` has an `allowBuilds` list - read it.
5. Cold-store install wall time and disk use. This number sets the cold-build timeout that T9 and
   T12 depend on later.
6. `git` availability inside the build container, which the existing provision step already assumes.
Where a fact needs the paid container to settle, say so and mark it blocked rather than guessing.

## Criterion 3 wording correction
The roadmap says "two independent clean builds produce byte-identical canonical maps". Goal
criterion 7 says two clean **Computer** builds. Your local two-build check is a fast PRE-CHECK only;
it does not close goal criterion 7. Say that plainly in the report so nobody later mistakes it for
the real proof.

## Hand off one race rather than absorbing it
`planHarnessBuild` emits `rm -rf ${directory} && mkdir -p ${directory}` for a directory keyed only
by the commit, so two same-commit builds delete each other's tree. T3 owns that (T3.4). If your new
install step lands inside that directory the blast radius grows - a partly installed `node_modules`
deleted under a running esbuild. Either state the isolate/install location policy explicitly, or
hand the race to T3 with a written interface in your report. Do not silently widen it.
## Finish
1. `pnpm verify` passes. Commit on green, conventional-commit message.
2. Write /Users/aditya/repos/projects/cf-stumble/.audit/v0/tasks/T1a.md: task id, commit SHA, changed paths, each acceptance criterion with the evidence that it holds, what you deliberately did NOT do, and any remaining blocker. A truthful partial report beats a false completion.
