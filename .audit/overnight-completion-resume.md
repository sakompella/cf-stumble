# Overnight completion resume

## Intent

Continue `.audit/overnight-completion-plan.md` from the Night 1 Computer vendoring job. Keep the decision trail uncommitted. Run one green unit at a time. Do not deploy without explicit approval.

## Verified progress

- `main` is clean at `caffbbc`.
- `d5cd134` adds the version 0 feature map.
- `caffbbc` leaves later tenant harness ownership open after mining old chats.
- `pnpm verify` passed before both commits through the pre-commit hook. The baseline is 33 test files and 168 tests.
- The program loop `cf-stumble-overnight-audit` was observed red because `tools/verify-version0.mts` does not exist yet, then cancelled during this pause. Re-arm it before the next implementation iteration.
- Clean Computer source evidence exists at `.audit/night1-computer-build-facts.md`.
- The chosen Night 1 design exists at `.audit/night1-computer-synthesis.md`.

## Night 1 partial branch

Branch `pi-agent-4c1236bb-9849-47e` contains commit `34678ff`.

Do not merge it as written.

Useful work in the commit:

- `tools/vendor-computer.mts`
- machine-readable Computer pin
- canonical `npm pack` extraction
- checksum checker and tamper test
- TypeScript conformance imports
- Wrangler dry-run check
- package and workspace wiring

Known defects:

1. The commit omits every `vendor/computer-0.3.0/dist/**` file. Root `.gitignore` ignores every directory named `dist`. `SHA256SUMS` names 78 files that the commit does not contain, so verification cannot pass in a clean checkout.
2. The worker hit its Codex usage limit before reporting or verifying.
3. The generator does not compare two clean builds or package contents, although determinism is a Night 1 stop condition.
4. The adapted package leaves optional peer dependencies. pnpm's `autoInstallPeers` installed `@platformatic/vfs`, `ai`, and `zod`, which expanded the lockfile. Remove peer metadata when the retained exports do not need those peers at import time, then prove the required subpaths still bundle.
5. Root application code will need `@cloudflare/computer: workspace:*`. Confirm whether the branch added it under `devDependencies` and keep one intentional dependency location.

First action on resume:

1. Spawn a fresh Sonnet or Opus code owner in an isolated worktree at `caffbbc`.
2. Have it cherry-pick `34678ff` without committing, fix the defects above, regenerate from a clean detached Computer checkout, and commit only after the checker, tamper test, Wrangler proof, deterministic double-build comparison, and `pnpm verify` pass.
3. Verify the resulting commit in another clean worktree before integrating it into `main`.

## Night 2 design state

Workflow `wf_655a10832504` completed four candidates and an Opus judge. Its final synthesis call failed. The durable journal is `.audit/evidence/night2/capability-arena.workflow.jsonl`.

Read candidate indexes 0 through 3 and judge index 4. Write the synthesis to `.audit/night2-probe-synthesis.md` before spawning a Night 2 writer. Do not use index 5 because it records the failed synthesis.

The earlier Night 1 workflow is superseded by `.audit/night1-computer-build-facts.md` and `.audit/night1-computer-synthesis.md`.

## Durable state

- Plan: `.audit/overnight-completion-plan.md`
- Decision trail: `.audit/overnight-completion-decisions.tsv`
- Running owner questions: `.audit/design-questions.md`
- Current handoff: `.audit/overnight-handoff.md`
- This resume note: `.audit/overnight-completion-resume.md`
- Night 1 evidence: `.audit/night1-computer-build-facts.md`
- Night 1 decision: `.audit/night1-computer-synthesis.md`

## Loop recovery

Re-arm the cancelled loop with the exact `arm` command in `.audit/overnight-completion-plan.md`. Tick it after the repaired Night 1 commit verifies.

## Gates

- No Cloudflare deployment or resource creation has approval.
- Paid checkpoint A remains closed.
- Night 2 implementation depends on a verified Night 1 commit.
- Night 3 and later remain blocked by paid checkpoint A.

## Transcript

Transcript: host-supplied current Pi session. The resume path does not depend on the transcript. Use this note, Git commits, branches, workflow journals, and local audit files.
