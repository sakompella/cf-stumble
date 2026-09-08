You implement exactly one task. You are one of five workers running in parallel on separate worktrees of the same repository.

# T20 — the x64 Computer container preflight, run locally, claiming nothing paid

## Why this exists and why it is possible only now

`wrangler.jsonc` binds the workspace container to `ghcr.io/cloudflare/computer-computerd-linux-x64`,
which runs only on x86-64. Every prior session ran on an arm64 Mac and could not start it. **This
box is x86-64 NixOS with Podman live.** That is the reason the work moved here, and nobody has yet
spent the capability.

The gap it closes is recorded as D51 and evidence E1: `scripts/probe/clean-build.sh` passes
`PATH="$PATH"`, so both of its builds share the HOST toolchain. It is a regression guard, not
evidence for goal criterion 7, which asks for "two clean Computer builds of the same labeled commit
produce identical canonical module maps". Running the same probe inside the REAL image is the
missing half, and it costs nothing: pulling a public ghcr image is free.

The `gpt-6-astra` review at `/home/aditya/repos/cf-stumble/.audit/v0/review-astra-low.md` section 1 asks for exactly this:
"Run the pinned x64 container preflight alongside those repairs: Linux can now test tool
availability and clean builds locally, without claiming paid Cloudflare evidence or using
unapproved accounts."

## What to do

1. **Find the pin.** Read `wrangler.jsonc` for the exact image reference and any digest.
   `/home/aditya/repos/cf-stumble/docs/agents/design/computer-integration.md` and
   `docs/agents/adr/0026-adopt-computer-for-facet-work-environment.md` say what the image is for.
   `tools/devbox/` is UNTRACKED on this box and is a different thing — a dev box for the arm64 Mac.
   Do not confuse the two. Read it for the Node-version reasoning only.
2. **Pull it with Podman** and record the resolved digest, so this evidence names an exact image.
3. **Tool availability inside it.** Report presence and version of: `node` (the record says 22.23.2 —
   confirm or correct it), `pnpm`, `git`, `gh`, `ripgrep`. Criterion 3 requires "Git and gh work
   with local credentials outside repositories" and criterion 7 requires a build toolchain. A
   missing `gh` is a finding, not a failure of this task — the roadmap already suspects it.
4. **Two clean builds inside the image.** Run the clean-build probe's work with the CONTAINER's
   toolchain, not the host's — that is the entire point, so make sure `PATH` is the container's.
   Report both module-map sha256 values and whether they match each other AND whether they match the
   host's current `e9c3008ea0dc4829bfec8fc21881310f8e7426f5abae37e1bb421c78d3e0a456` at `9ac4b9c`.
   A mismatch between host and container is a FINDING of real value, not a failure: it would mean
   the host probe has been guarding the wrong thing. Report it plainly either way.
5. **Write down what this is and is not.** It is local container evidence. It is NOT deployed
   Cloudflare evidence and must never be recorded as closing criterion 7 or 9 by itself. Astra:
   "Unanswered paid approval ... does not justify ... calling local container results deployed
   proof." Say precisely which part of which criterion this advances and which part still needs Q7.

## What done means

A reproducible command another person can run on this box, and a written record naming the image
digest, the tool inventory, the two shas, and the exact boundary between what this proves and what
still needs a paid environment.

Commit whatever script or documentation makes it reproducible — a small `scripts/probe/` entry and
its documentation is the right shape, following what `scripts/probe/clean-build.sh` already does.
If nothing in the tree needs to change, say so and put the whole result in the report.

## Cut line

**Spend no money.** No `wrangler deploy`, no Cloudflare API call that bills, no owner account
credentials, no Computer workspace created on Cloudflare. Podman pulling a public image and running
it locally is free and is the whole scope. Do not change `src/`. Do not change the facet build.
If the image will not start, report the exact error — that is a real result and this box's Podman
setup is itself unproven.

## Read before you write

`wrangler.jsonc`, `scripts/probe/clean-build.sh`, `docs/agents/design/computer-integration.md`,
`docs/agents/adr/0026-*.md`, `0027-use-labeled-commit-as-loader-identity.md`,
`0028-harness-artifacts-are-module-maps.md`, `/home/aditya/repos/cf-stumble/.audit/v0/tasks/T1a.md` (the E1 work), and
`/home/aditya/repos/cf-stumble/.audit/v0/goal.md` criteria 3 and 7.

## Where you are

Worktree: /home/aditya/wt/T20   (branch `work/T20`, based on main at `9ac4b9c`)
The worktree already has `node_modules`. Work only inside it. `cd /home/aditya/wt/T20` first.

The durable audit trail lives in the MAIN checkout, which is gitignored and shared by reference
only: read `/home/aditya/repos/cf-stumble/.audit/v0/` and write your report to
`/home/aditya/repos/cf-stumble/.audit/v0/tasks/T20.md`. Do not create a `.audit/` tree in your worktree.

## Rules

- Read `AGENTS.md` and `docs/agents/domain.md` before you write code. Read the ADRs your task names.
- Apply the repo skills: `typescript-best-practices` for any `.ts`; `agents-sdk` and
  `durable-objects` for Supervisor, facet, thread or RPC work; `cloudflare` and
  `workers-best-practices` for bindings and Worker config.
- Stay inside your task's scope. Do not fix unrelated things you notice; list them in the report.
- Do not edit `README.md`. Do not create or edit GitHub issues. Do not push, do not merge, do not
  touch `main`. The parent oracle merges and pushes.
- `pnpm verify` is the gate: typecheck, format check, lint, tests, about 62 seconds on this box.
  Run it before you claim anything works. Never commit through a red gate. `pnpm format` fixes
  formatting; nothing else in the gate is auto-fixable.
- Delete obsolete code and its tests rather than leaving them unreachable. An unused safe path is a
  fault, not a safety net.
- Baseline on your base commit: 118 test files, 842 tests, gate green.

## Mutation is the test review — this is the whole point of this round

The previous round's suite was found to be partly decoration. A cross-vendor reviewer changed
production lines and the gate stayed green:

| mutation | result |
|---|---|
| `git --no-pager diff HEAD` -> `cat` | 13/13 turn-diff tests stayed green |
| `ModelRoute.runStream` body -> `throw` | all 21 related tests stayed green |

So for EVERY test you add or change: break the production line the test claims to cover, run
`pnpm verify`, and confirm it turns RED. Then revert the mutation and confirm green. Record both
runs in your report, naming the exact line you mutated and the test names that failed. A test whose
absence of coverage you cannot demonstrate does not count as evidence.

Assert the PROPERTY, never a presumed implementation. Do not let a fake or a test double import the
production constant it is supposed to pin — that is exactly the fault that produced the fake diff
test.

## No paid spend

The owner is unreachable and has not approved paid probes (question Q7 in
`/home/aditya/repos/cf-stumble/.audit/v0/questions.md`). Do NOT run `wrangler deploy`, create or start any Computer
workspace, call any billing Cloudflare API, or use the owner's account credentials. If a criterion
needs a paid environment, record it as **blocked: awaiting owner approval for a paid probe**.
Never fake, mock, or simulate a paid result to close a criterion. `pnpm verify` runs locally in
workerd and is always allowed.

## Finish

1. `pnpm verify` green. Commit in your worktree with a conventional-commit message. One commit is
   preferred; more is fine if each is green.
2. Run `scripts/probe/clean-build.sh` and report the sha256 it prints, and whether it should have
   moved for your change.
3. Write `/home/aditya/repos/cf-stumble/.audit/v0/tasks/T20.md` in the shape the existing reports in that directory use:
   task id, commit SHA, changed paths, each acceptance criterion with the evidence that it holds,
   the mutation runs with their exact mutated lines and the tests that failed, what you deliberately
   did NOT do, and any remaining blocker. A truthful partial report beats a false completion.
4. Reply to your parent with `await agent_message.send(<summary>, receiver_role='parent')`. The
   summary must state: commit SHA, gate result with file/test counts, the mutation evidence in one
   line each, and anything you could not do. If you are blocked or you decide the task's premise is
   wrong, say so instead of inventing a completion.
