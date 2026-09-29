# Test-quality handoff, 2026-09-28

This record closes the local test-quality review at `4b4eacd`. It describes tests and evidence, not a deployed release. Local `main` was clean and 48 commits ahead of `origin/main` when this record was written. Nothing was pushed. The owner’s `README.md` was not changed.

## What changed

- `736c128` and `0c9af94` add a Worker HTTP integration path. `697b067` proves that a failed turn saved by the Supervisor keeps its prompt and conversation across a later turn and Durable Object eviction. The tests also check that a disconnect refused during a live turn does not remove the clone.
- `d774ef4` adds two Playwright checks of exact prompt and reply content after a browser reload, including a failed-but-saved turn. The browser stub now persists those messages instead of inventing reload content. A mutation of the stored prompt made both checks fail.
- `4b4eacd` removes seven duplicate assertions from `test/page/owner-page.test.ts`. The gate still checks stable element IDs and turn-frame kinds elsewhere in that file. The sidebar and diff tests retain their distinct checks. No whole test was deleted.

The self-model review covered the whole earlier suite and identified the browser persistence gap. An independent Opus review examined much of the same earlier suite at `1b7e216`, ran mutations, and produced `/tmp/cfs-tq/SYNTHESIS.md`. It did **not** finish every slice: workspace, facet, and generation removal analyses remained open, as did a test-by-test review of vendor, Loader, fixture-reach, and Computer image tests. Its findings are leads, not verified facts about current `main`, which has two more Vitest tests and new browser tests.

## Verification and limits

On combined `main` before the assertion cleanup, the remaining checks after format passed: 24 tool tests, 166 Vitest files with 1,084 tests, and both Playwright tests. In the isolated cleanup worktree, lint, those same tests, Playwright, and all 41 browser-harness cases passed. `pnpm verify` stopped at `format:check` because `README.md` has an existing formatting difference. The file is reserved for the owner, so the check was not made green by changing or excluding it. The cleanup commit bypassed the pre-commit hook only after the downstream checks ran separately. No claim is made that `pnpm verify` passed end to end.

Earlier isolated staging probes passed bootstrap, streamed turns, persistence, failed candidates, rollback, disconnect, and reset. They deployed public source `eafaf99`, **not** current unpublished `main`; therefore they do not prove the new tests or code on `main` work in Cloudflare. The temporary Workers, Containers, and their image tags were deleted. See `docs/agents/live-computer-check-2026-09-28.md` for the separate connect and disconnect deployment evidence and its limits.

## Open test leads

Reproduce these against current source before calling them defects or changing production code:

1. The Opus mutations suggest the Supervisor class has weak composition coverage. Changed argument order, identity-to-Supervisor naming, generation selection at mount, workspace naming, and lease instance wiring survived targeted tests at the older commit. A public Supervisor/Worker integration test is more useful than tests of each component in isolation.
2. Check whether the new HTTP and Playwright persistence tests now kill the older mutations that dropped the prompt or history before the generation and misreported a failed save as saved. They cover storage and reload, but may not cover what the generation receives.
3. Rerun the facet mutations for empty model tool lists, ignored selected directories, and compaction policy. Verify the claimed host turn-bound gap by tracing the current production call path. The old audit did not finish these slices.
4. Investigate rollback epoch checks, streamed startup-check errors, and Computer file bounds with focused tests. Do not assume that a surviving mutation under an older suite still survives on current `main`.

The Opus report proposed seven whole-test deletions, plus assertion trims. Only the seven assertion trims above were made. Review each proposed deletion against current tests and a relevant mutation before removing it. In particular, a browser harness case does not replace a gate test: `pnpm verify` does not run a browser. Keep property, protocol, security, and fixture checks when they guard distinct behavior.

## Bombadil decision

Do not adopt Bombadil now, add it to `pnpm verify`, or run a pilot. Sol recommended an optional local-stub pilot, but Opus tried Bombadil 0.7.7 and recommended against adoption: three of four launches with Playwright Chrome timed out on screenshots, a completed 60-second default-spec run found no violation, and replay diverged. Those local observations do not prove it cannot find a bug. The default properties overlap the existing browser harness, while useful state properties would need a separate, time-boxed experiment. The owner chose **no Bombadil for now**. Neither review changed the repository.

## If work resumes

Start from current `main`, not the audit's older commit. Verify a small number of the highest-risk mutation leads with public behavior tests; do not edit `README.md` or production merely to satisfy the audit. Run `pnpm verify` before claiming the gate works, and report the unchanged format blocker if it remains. Run `pnpm harness:browser` separately for page changes. Do not push or create deployment resources without a new reason and approval.
