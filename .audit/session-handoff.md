# Session handoff

Written before context compaction. This is the durable record of a long session. `.audit/` is gitignored, so nothing here is committed.

## Current state

- `main` is `0b60219`, one commit ahead of `origin/main` at `f4f345f`.
- `pnpm verify` passes: 28 test files, 143 tests.
- Working tree clean.
- Tag `backup-before-pi-rewrite` pins `c1c755f`, the tip before today's history rewrite. Deleting that tag makes the rewrite unrecoverable.
- Branches: `main`, `prototype/isogit-comparison` (kept as a record, cannot run), `pi/worktree/pi-mthrlxlm` (label for the remaining worktree).
- Worktrees: the main checkout, plus `/private/tmp/cf-stumble-pi-mthrlxlm` which holds gitignored scratch files only.

## What shipped, in order

**1. R2 binding spike.** Added `MODULE_MAPS` to `wrangler.jsonc` and `env.d.ts` plus a local workerd test. It proves only that workerd binds, writes, and reads an R2 object. It does not provision the bucket `cf-stumble-module-maps`, which does not exist in the Cloudflare account, and it does not implement ADR-0034's cache. This work was briefly lost during branch cleanup and re-applied by hand as `0b60219`.

**2. better-result pilot.** ADR-0035 records the rule: Results and TaggedErrors live inside one Worker isolate, and every public Supervisor method converts to its plain type before returning. The reason is that Durable Object RPC copies return values, the copy drops behavior, and Cloudflare refuses application-defined classes that do not extend `RpcTarget`. TypeScript cannot catch that, because the declared type is correct on both sides. The pilot replaced the private `CandidateFacet` and `HeaderResult` unions in `startup-check.ts` with `Result` plus three tagged errors.

**3. Source layout restructure.** Executed the eight-step plan an earlier agent wrote but never ran. `src/supervisor/` went from 20 loose files to 9 entries. Added `src/worker.ts`, `src/facet/`, and six groups under `src/supervisor/`. Removed the circular import between `startup-check.ts` and `startup-check-body.ts` by moving `StartupCheckStage` and `StartupCheckOutcome` into `body.ts`. Added `test/docs/module-seams.test.ts`, which fails when an import reaches past a directory's `index.ts`.

**4. History rewrite.** At the user's explicit instruction, `git filter-branch` stripped `".pi/**"` from `oxlint.config.ts` across 229 commits. The user force-pushed. I argued against this first and was overruled; see the trap below for why it does not fix the bug it was meant to fix.

**5. Branch cleanup.** Deleted 38 branches and 6 worktrees. A subagent reviewed the five branches that had patches not in `main` and its verdicts were spot-checked: the R2 binding was genuinely missing and was re-applied, the relay and epoch fixes were already present in `main` under different code, and a docs branch contained broken substitutions such as "supervisor supervisor control".

## Traps this session cost real time on

**oxlint and oxfmt do not read `.gitignore`.** Both walk the whole tree. Two separate outages came from this. A stray agent-written markdown file failed `oxfmt --check` while `git status` stayed clean. Worse, a pi worktree under `.pi/worktrees/` makes oxlint discover a second `oxlint.config.ts` and die with "Plugin name 'anti-slop' is already registered", which blocks every commit because the pre-commit hook runs `pnpm verify`. Removing `.pi/**` from `ignorePatterns` does not help: that setting governs which files are linted, not which configs are discovered. I proved this by reproducing the crash with the entry absent. The real fix is to stop pi creating worktrees inside the repository. That is still open.

**`command | grep ... | tail` hides failures.** A pipeline's exit code is the last command's, and `tail` always succeeds. A lint failure passed my check and only the pre-commit hook caught it. Capture to a file and test `$?`.

**The Worker Loader caches by harness commit.** `env.LOADER.get(name, getCode)` only calls the callback on a miss, per ADR-0027. A new test that reused an existing commit constant silently got the earlier test's worker and asserted the wrong outcome. Every test needing distinct module source needs a distinct commit.

## Open work

1. **Fix pi worktree placement or oxlint config discovery.** Diagnosed twice, still unfixed. It will break the gate again.
2. **Finish ADR-0034.** The R2 binding exists; the cache does not. Needs a Computer builder, a serialized module map, cache-miss rebuild, and eviction. `HarnessArtifacts` still keeps module maps in Durable Object SQLite, which ADR-0034 forbids.
3. **Continue better-result adoption.** `docs/agents/design/_better-result-adoption-plan.md` sequences eight slices; only the startup-check pilot is done.
4. **Drop five redundant `/// <reference types="@cloudflare/workers-types" />` directives.** `tsconfig.json` already sets `"types": ["@cloudflare/workers-types"]` globally. The 20 `@cloudflare/vitest-plugin/types` directives are load-bearing and must stay.
5. **ADR-0035 is marked `Agent-only`.** A human has not reviewed the text. Flip the marker and move its index entry once reviewed.
6. **Two files sit near the 300-line lint cap.** `recovery/index.ts` at 293 and `generations/index.ts` at 285.
7. **`domain.md` lost a two-line edit** during worktree cleanup, most likely a pointer to the layout plan. Cause never established.

## Lost artifacts

`.audit/better-result-pilot-impl.md` and `.audit/src-layout.md` were written inside worktrees that were later removed. Because `.audit/` is gitignored, they were deleted with the directories. Their decisions are folded into this file. Write future audit files in the main checkout, not a worktree.

## Plans still on disk

- `docs/agents/design/_better-result-adoption-plan.md`, the eight-slice sequence.
- `docs/agents/design/_better-result-pilot-slice.md`, the executed pilot plan with its corrections.
- `/private/tmp/cf-stumble-pi-mthrlxlm/docs/agents/design/_codebase-structure-plan.md`, the layout plan, now implemented. Its status line still reads "planned, not started" and is stale.
