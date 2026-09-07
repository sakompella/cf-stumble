# Sol review of T14

## Decision-changing findings

1. **T14 closes the scheduling gap and should merge.** The facet emits `diff` with `content` and `truncated`, and `diff-unavailable` with `detail` (`src/facet/generation-0/turn-frames.ts:43-44`). The Supervisor preserves those exact fields after validation (`src/supervisor/projects/turn-frames.ts:157-167`). T14 adds an `applyFrame` branch for each kind (`src/page/script-turn.ts:105-113`). The first calls `renderOutput` with `frame.content`, retains the harness truncation signal, and therefore uses the existing bounded, line-coloured diff renderer (`src/page/script-render.ts:63-102`, `src/page/script-render.ts:158-167`). The second writes `frame.detail` through `textContent`, so a failed repository diff is visible without becoming executable markup (`src/page/script-render.ts:170-175`). Sending T14 back would leave both valid nonterminal frames silently ignored by the page.

2. **The merge result is clean and the required gate is green.** `f00eaac` has `7818f8d` as its sole parent. In the supplied worktree I checked out `7818f8d` and ran `git merge --ff-only f00eaac`; Git fast-forwarded without a conflict. I then ran `pnpm verify` on that exact tree. It exited 0 with 117 test files and 842 tests passing. The test output printed intermittent `WorkspaceContainerAPI: DO is not container-enabled` uncaught-exception diagnostics, but the runner completed all 117 files and returned success. This is a green gate under the repository's stated rule (`AGENTS.md:17-21`).

3. **The local browser proof promised by T10 is missing, and T14's tests do not replace it.** `pnpm harness:browser` exits 1 because `tools/browser-harness/run.mts` does not exist, even though the package script invokes it (`package.json:21`) and the repository instructions say it drives the real owner page (`AGENTS.md:23-25`). This fault predates T14 and is outside its three-file cut line, so it is not a reason to reject the fix. It does mean the page's actual DOM behavior, including these frames, remains unverified in a browser.

4. **The added tests are source-text guards, not rendering tests.** The existing test file says explicitly that no DOM runs there (`test/page/owner-page.test.ts:7-11`). The two vocabulary entries at `test/page/owner-page.test.ts:87-88` only require the quoted kind names somewhere in the delivered script. Removing the `diff-unavailable` dispatch literal would break its entry, but the `diff` entry can still pass after removing the dispatch branch because `messageEntry("diff", "diff")` also contains that string (`src/page/script-render.ts:159`). The new test breaks if either dispatch predicate or handler call is removed, if the unavailable handler stops reading `frame.detail`, or if the harness-truncation wording disappears (`test/page/owner-page.test.ts:106-118`). It does **not** break if `diffMessage` stops reading `frame.content` or stops calling the coloured renderer. A browser scenario that feeds both real frame kinds should cover those behaviors. The weak test costs regression confidence, but direct inspection shows the production code is correct, so it does not justify delaying this narrow merge.

5. **T14 stays on the page side.** `git diff --name-only 7818f8d..f00eaac` lists only `src/page/script-render.ts`, `src/page/script-turn.ts`, and `test/page/owner-page.test.ts`. The production change is 32 added lines under `src/page/`; no facet, Supervisor, route, protocol, style, package, or documentation file changed. That matches the follow-up's cut line.

## Scope answers

### 1. The gap

Yes. Both frame kinds are dispatched and rendered with their declared fields. A `diff` is a separate transcript entry, uses the same bounded and coloured output path as a diff-shaped tool result, and states when the harness truncated it (`src/page/script-render.ts:158-167`). A `diff-unavailable` entry displays the repository's reason as text (`src/page/script-render.ts:170-175`). Both return `false` from `applyFrame`, so neither is mistaken for a terminal frame (`src/page/script-turn.ts:105-119`). The facet emits its diff before its terminal outcome (`src/facet/generation-0/facet-turn.ts:62-69`).

### 2. The cut line

Confirmed. The diff touches only two production files in `src/page/` and one existing test file in `test/page/`. It touches no other directory.

### 3. The test

The frame-vocabulary additions intend to fail when either new kind disappears from the delivered client, but the `diff` check is not uniquely tied to dispatch because the renderer contains the same literal (`test/page/owner-page.test.ts:83-98`, `src/page/script-render.ts:159`). The new case fails when either new `applyFrame` predicate or its renderer call is deleted, when `diff-unavailable` stops reading `detail`, or when the visible harness-truncation note is removed (`test/page/owner-page.test.ts:106-118`). It does not execute the handlers and does not protect `frame.content` or coloured rendering.

### 4. The merge

Confirmed. The result is a conflict-free fast-forward from `7818f8d` to `f00eaac`. `pnpm verify` passed on the resulting tree with 117 files and 842 tests.

### 5. The remainder against goal criterion 4

T14 completes the missing page dispatch, not criterion 4 as a whole. The following evidence is still required:

- Restore or finish the browser harness and run it against both new frames. The declared `pnpm harness:browser` command is currently broken because its target file is absent (`package.json:21`, `AGENTS.md:23-25`).
- Run the complete workflow with a real project and model: read a file, edit it, run the repository check, and observe tool activity, command output, the diff, and then the `saved` terminal frame. The required order is explicit in the goal (`.audit/v0/goal.md:10`), and source ordering alone is not release evidence (`.audit/v0/goal.md:22-24`).
- Prove the workspace diff command in Computer. The local facet now asks for the diff independently of the model and publishes it before completion (`src/facet/generation-0/facet-turn.ts:62-69`), but the paid runtime probe remains unrun while Q7 is open (`.audit/v0/questions.md:42-54`).

No paid probe was run for this review.

MERGE — `f00eaac` renders both T13 frame kinds, stays inside the page-only cut line, fast-forwards cleanly, and passes `pnpm verify`.
