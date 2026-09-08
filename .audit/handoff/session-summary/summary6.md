# Session Chunk 6 Summary

## User Requests

The user made three identical requests at the end of the chunk:
1. **17:08:23** - "summarize all changes done"
2. **17:23:10** - "summarize all changes done" (after empty response)
3. **04:58:58** (next day) - "summarize all changes done" (after empty response)

All three received empty responses from the agent.

## Key Issues and Decisions

### Codex Quota Exhaustion (D65)
- **Problem**: At 15:38, the round-2 review with `gpt-5.6-sol` failed immediately with quota exhaustion (~108 hours / ~4.5 days until Sep 9)
- **Root cause**: A one-token probe at 08:11 returned `SOL_OK` but consumed the last available quota; the weekly cap was already nearly exhausted
- **Lesson recorded**: "A one-token probe is not evidence that a real run will fit. Only the real run is."
- **Solution**: Reassigned round-2 review to `claude-opus-5` instead, noting this is NOT the cross-vendor second opinion originally requested

### Review Overturn of D62 (D67)
- **Finding**: Round-2 review caught that T7's diff test "hand-feeds stdout to a fake" — would pass with `git diff` renamed to `cat`
- **Problem**: Production diff relies on one prompt sentence with flash model at `reasoning_effort: "low"`, making skipped clauses ordinary risk, not tail risk
- **Decision**: Logged as new task T13 to make diff a harness property, not a model cooperation hope

### T10 Scheduling Error (D69)
- **Issue**: T10 dispatched 08:49, T13's new `diff` and `diff-unavailable` frames landed 09:09
- **Problem**: Workers are shell-outs (not RLM children), no way to notify running workers of world changes
- **Impact**: T10 cannot render the two new frame types
- **Lesson**: "Dispatch a consumer after its producer, or accept a known follow-up when running parallel for speed"
- **Solution**: T14 dispatched as narrow follow-up to add diff frame rendering

### Clean-Build Probe Scope Correction
- **Review finding**: Clean-build probe shares host toolchain via `PATH="$PATH"`
- **Correction**: Probe is regression guard for E1, **NOT** evidence for criterion 7 (reproducible builds)

## Round-2 Review

**File**: `/tmp/cf-stumble-v0/review-round2.md`  
**Base**: `0161f91` (main with 7 merged commits)  
**Verdict**: **SOUND WITH FIXES**

**Key findings**:
1. T7's diff test inadequate (led to T13)
2. T9b finished, gate-green, cleanly mergeable
3. Verified 116 files / 829 tests pass
4. Confirmed hand-resolved merge conflict (T5/T6a lease tests: 4 → 6 → 6, all survived)
5. Criterion 10 (paid disconnect/deadline) still blocked on owner approval for paid probe
6. Six of ten criteria cannot move without Q7 approval

**Review scope**: Evaluated merged code, not roadmap (unlike round 1)

## Tasks Merged

### T9b → `eb7c575` (15:48:24)
**Brief**: Own the saved streamed turn behind one turn route  
**Changes**: 113 files / 797 tests → 116 files / 829 tests  
**Key improvements**:
- Fixed issue E12: Renamed `isCreditedTurn` → `servedSuccessfulResponse` (HTTP question)
- Added `earnsCompletedRealTurnCredit` (durability question: Pi success AND committed thread save)
- Separated two concerns that E12 required to stay distinct
- Cut line held: no reconnect, resume, alarm, scheduler, or queue

**Verification**: Gate green in worktree, clean merge tree, gate + clean-build probe green on main  
**Probe sha**: `18cea22b` → `313ddf26` (correctly moved due to facet code changes)

### T13 → `3a77907` (16:10:52)
**Brief**: Make diff a harness guarantee, not a model cooperation hope  
**Changes**: 116 files / 829 tests → 116 files / 834 tests  
**Key work**:
- **Deleted prompt sentence**: `grep "Run .git diff" src/` returns nothing
- **Harness owns it**: `facet-turn.ts:67` publishes `readWorkspaceDiff(env, signal)` on any `bash`, `edit`, or `write` tool-start
- **Test proves property**: Backend snapshots file bytes at commit, computes real unified diff vs current bytes (not hand-fed output)
- **Added**: ADR-0040
- **Honest gaps documented**: Git in real workspace unverified (no spawned processes), brand-new untracked files won't appear in `git diff HEAD`

**Probe sha**: `313ddf26` → `e9c3008e` (correctly moved, facet code changed)

### T10 → `7818f8d` (16:12:42)
**Brief**: Put the connected project conversation on one page (criterion 4's browser half)  
**Changes**: 116 files / 834 tests → 118 files / 841 tests  
**Key paths**:
- Rewrote: `element-ids.ts`, `markup.ts`, `styles.ts`, `script.ts`, `script-helpers.ts`
- New: `markup-fields.ts`, `markup-sidebar.ts`, `markup-conversation.ts`, `markup-drawer.ts`, `script-render.ts`, `script-projects.ts`, `script-conversation.ts`, `script-turn.ts`
- Deleted: `script-thread.ts`
- Tests: `test/page/owner-page.test.ts` (new), `test/routes/page.test.ts` (request/Access boundary only)
- Docs: Updated `AGENTS.md`, added `pnpm harness:browser`

**Major fixes**:
- **`project-one` bug gone**: `grep "project-one" src/page/` returns nothing; sidebar reads `GET /api/projects`, reader picks from catalog
- No free-text project ID input
- All raw JSON panels deleted
- CSP nonce, same-origin, no-store preserved

**Merge**: Clean tree against main that had moved twice  
**Probe sha**: `e9c3008e` — unchanged (correct: page-only work, no facet code)

**Partial work preserved**:
- T10 ran out of turns mid-way through phase 2 (real Chromium browser harness)
- Phase 1 proven: real Chromium loads page with no CSP violation, no console error
- Uncommitted harness work preserved on `work/T10-harness` branch (NOT merged)
- Modified: `tools/tsconfig.json`; untracked: `tools/browser-harness/`

**Known gap**: Cannot render T13's `diff` and `diff-unavailable` frames (dispatched before T13 landed)

## Tasks Dispatched

### T10, T13 (15:49:13)
**Base**: `eb7c575` (merged main after T9)  
**T10** (opus): Criterion 4's browser half; read `src/routes/turns.ts` and `route-stream.ts` first; fix `markup.ts:30` bug (hardcoded `project-one`)  
**T13** (sonnet): Diff guarantee task; brief opens with review section that overturned D62; requirement: turn modifying workspace must show diff without model cooperation; test must prove property, not hand-feed expected output

**Status at dispatch**: Both worktrees created at `eb7c575`, 8 task reports on disk

### T14, T11 (16:14:06)
**Base**: `7818f8d` (merged main after T10)  
**T14** (sonnet): D69 follow-up; render `diff` and `diff-unavailable` frames in page matching T10 shape; forbidden from touching `src/facet/**` or `src/supervisor/**`  
**T11** (opus): Failure and race behavior (5 seams: stale/double lease finishes, two credit predicates, concurrent turns on one project, diff failure/timeout paths, activate/rollback under stale epoch); **new rule enforced**: "For every test added, state what production change would break it. If worker cannot name one, delete the test."

## Task Status at Chunk End

**Merged**: T9b, T13, T10 (10 tasks total)  
**Running**: T14 (3 files changed, +48 insertions), T11 (no commits yet)  
**Test progression**: 93/642 → 118/841 tests  
**Main**: `7818f8d`

### T14 Progress (as of 16:16:54)
- 3 files changed, +48 insertions
- Still alive, no report yet

### T11 Progress (as of 16:16:54)
- No commits yet
- Still alive, no report yet

## Criteria Status

**Score**: 8 merged tasks bought 6 of 7 confirmed faults  
**Remaining**: Zero of four criteria needing money or browser  
**Critical path**: Q7 (owner approval for paid probes)  
**Blocked**: 6 of 10 criteria blocked on Q7

## Problems and Errors

1. **Codex quota exhaustion**: 4.5-day block for gpt-5.6-sol review → reassigned to opus-5
2. **Empty agent responses**: Three user requests for summary all received empty responses (17:08, 17:23, 04:58 next day)
3. **T7 diff test inadequate**: Hand-fed fake output, would pass with renamed command
4. **T10 incomplete**: Ran out of turns during browser harness phase 2
5. **T10 scheduling gap**: Cannot render diff frames that landed while it was running
6. **39-minute silence**: Agent polling loop 16:16-16:55, then empty message

## Files Created/Modified

### Review document
- `/tmp/cf-stumble-v0/review-round2.md` — Round-2 review (SOUND WITH FIXES verdict)

### Task reports
- `.audit/v0/tasks/T9b.md` — T9 task report
- `.audit/v0/tasks/T10.md` — T10 task report (phase 1 complete, phase 2 in progress)
- `.audit/v0/tasks/T13.md` — T13 task report

### State documents
- State and decision log updates throughout (tracked via ipython calls)

### Source code (T9b)
- Modified routes and supervisor code for turnstile support
- Added/renamed credit predicates

### Source code (T13)
- `src/facet/facet-turn.ts:67` — Added `readWorkspaceDiff()` call
- Test backend snapshots and diff computation
- Added ADR-0040

### Source code (T10)
- Rewrote 6 page files, added 9 new page files, deleted 1
- Added `test/page/owner-page.test.ts`
- Modified `test/routes/page.test.ts`
- Updated `package.json`, `AGENTS.md`

### Preserved but not merged
- `work/T10-harness` branch: browser harness WIP (modified `tools/tsconfig.json`, untracked `tools/browser-harness/`)

## Open Threads

1. **T14 and T11 still running** — no completion or merge yet
2. **Q7 approval pending** — blocks 6 of 10 criteria, entire critical path
3. **Cross-vendor review postponed** — awaiting Codex quota reset (~Sep 9)
4. **User summary request unanswered** — three attempts, all empty responses
5. **Browser harness phase 2 incomplete** — preserved on work/T10-harness for future work
6. **Diff frame rendering gap** — T14 dispatched to address, still in progress
