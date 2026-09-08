# Chunk 5 Summary: T7/T6a Merged, T9 Stalled and Restarted Twice, Sol Review Dispatched

## Context at Chunk Start
- Main at 54b02e2 (about to merge T7)
- 105 test files / 698 tests
- T7 (facet Pi path completion) ready to merge
- T6a (GitHub connection) still working at 36 files

## User Requests
**No direct user requests in this chunk.** All work continued from prior tasks.

## Agent Actions

### Task Merges

**T7 merged (commit 54b02e2)**
- **Files**: 39 files, +1473/−1479 (roughly break-even)
- **Commit**: `133b275 feat(facet): finish the Pi turn with instructions, compaction, and a diff`
- **What it did**: Finished Pi turn path with instructions, compaction, and diff capability; removed entire legacy buffered path
- **Key finding**: T7 corrected agent's incorrect assumption about `ROUTE_MODEL.contextWindow: 0`. Agent had flagged risk that it would make compaction unreachable, but T7 read actual source (`compaction.ts:247-250`) and found the opposite: threshold computes to −16384, so empty conversation already exceeds it and agent would compact on **every turn** (not disabled)
- **Verification**: Passed 5/5 objective checks, `pnpm verify` at 698 tests
- **Clean-build probe**: Reproduced byte-identically at sha `18cea22b...` (hash moved from `8e821d86...`, correct because T7 changed facet code)
- **Test impact**: Main green at 105 test files / 698 tests after merge

**T6a merged (commit 0161f91)**
- **Files**: 59 files, +4351/−302
- **Commit**: `9bc44cf feat(projects): connect GitHub repositories with a testable credential`
- **What it did**: 
  - Built entire GitHub credential connection flow from scratch
  - Added `src/github/` module
  - Created `docs/agents/design/github-connection.md` design doc
  - Updated `domain.md`
  - **Fixed E4**: Changed `ProjectCatalog` from fixed two-tuple to `readonly Project[]`, enabling runtime addition of third project (goal criterion 3)
  - Created three credential test files
- **Key blocker flagged**: Report noted `gh` CLI on pinned Computer image is unverified—if missing, no repository connection possible. Belongs on Q7's probe list.
- **Verification**: Passed `pnpm verify` at 794 tests (up from 698)
- **Clean-build probe**: sha `8e821d86...` identical to base `638890e`, confirming E13 property (T6a only touched Supervisor host code, not harness)
- **Merge conflict**: Hit one conflict in `fresh-thread.test.ts` imports—T7 had moved `FakeWorkspace` to new path, T6a (branched before) still used old path and added `connectSampleProjects`. Agent took **both** changes rather than either side wholesale.
- **Test impact**: Main green at 113 test files / 797 tests after merge
- **Wave completion**: Wave 2 complete

### Task Dispatches

**T9 dispatched (first attempt)**
- **Base**: `0161f91` (main after T6a merge)
- **Goal**: Build HTTP surface for turn execution (E6 confirmed no HTTP surface exists)
- **Brief highlights**: Must handle E12 (one predicate answers two different questions, fix would silently break generation eligibility)
- **Expected timeline**: 10–20 minutes before first edits (based on T3a and T7 opus patterns)
- **Reads**: 8 minutes of reading before first edit (+55/−4)
- **Progress**: Jumped to 16 files, −515 (removing code new turn surface replaces)
- **First commit**: `56971c4 refactor(workspace): delete the unreachable legacy execution path`
- **Status at sleep**: 18 uncommitted files at 04:43, then machine slept for 3.5 hours

**T9 stalled—first recovery**
- **Problem**: Wrapper process survived but agent was dead after 3.5-hour sleep
- **Recovery**: Agent committed WIP as `044bb6e wip(T9)` on branch `work/T9` (on top of genuine first commit `56971c4`)
- **Reason for preservation**: Nothing lost, branch available to reference or cherry-pick

**Sol round-2 review dispatched**
- **Trigger**: Codex quota reset at 05:57, making `gpt-5.6-sol` available again (blocked all night)
- **Purpose**: User originally requested sol to review the plan, blocked overnight by quota
- **Status**: Dispatched same time as fresh T9

**T9b dispatched (second attempt)**
- **Context**: Fresh attempt after first stall, knows prior attempt exists
- **Issue**: Second attempt also died from infrastructure race
- **Problem details**: Cleanup of stalled worktree raced new `git worktree add`, dispatch failed with "Daemon worker client closed" before doing work. Repo ended up with two stray worktrees and three `work/T9*` branches.
- **Verification**: Main never touched, still `0161f91`, clean, zero modified files (verified before and after cleanup)
- **Notable pattern**: Both dead attempts independently began with same first move (deleting unreachable legacy execution path: `56971c4` and `6b880c5`)

**T9b dispatched (third attempt, final in chunk)**
- **Worktree**: Created correctly at `0161f91` with empty log (clean start)
- **First write**: 13 files, +106/−510 (same deletion of legacy path, third convergent vote)
- **First commit**: `c3ac884 refactor` (worktree clean after commit)
- **Second batch**: Jumped to 28 files, +2042 (likely HTTP turn surface plus tests)
- **Second commit**: `6db03d6 feat(sup...)` (supervisor-side work, tree clean again)
- **Status at chunk end**: Two commits done, no report file, continuing work

## Concrete Outcomes

### Commits to Main
1. `54b02e2` - T7 merged (facet Pi path completion)
2. `0161f91` - T6a merged (GitHub connection with credential handling)

### Progress Metrics
- **Test files**: 93 → 113 (+20)
- **Test count**: 642 → 797 (+155)
- **Tasks merged**: 7 total overnight (T1a, T5, T2, T3a, T4, T7, T6a)

### Faults Closed
- **E4**: Fixed at type level (ProjectCatalog no longer fixed two-tuple)
- All seven confirmed faults from overnight closed

### Documentation Created
- `docs/agents/design/github-connection.md` (by T6a)
- Updated `domain.md` (by T6a)

### Branches
- `work/T9` with commits `56971c4` and `044bb6e` (preserved from stalled first attempt)
- `work/T9b` (third attempt, active at chunk end)

## Problems and Resolutions

### T7 Compaction Assumption Error
- **Problem**: Agent's E7 evidence note was wrong—assumed `contextWindow: 0` makes compaction unreachable
- **Resolution**: T7 read actual source code and found opposite behavior (compaction triggers on every turn)
- **Learning**: Third time this session an objective check encoded agent's assumption rather than requirement; each time worker's alternative was better

### T9 First Stall
- **Problem**: Agent died after machine slept 3.5 hours, wrapper alive but no progress
- **Resolution**: Committed WIP to preserve work (`044bb6e wip(T9)` on `work/T9`), killed and re-dispatched fresh

### T9b Second Failure
- **Problem**: Infrastructure race between worktree cleanup and new `git worktree add`
- **Resolution**: Cleaned up two stray worktrees and three `work/T9*` branches, verified main untouched, dispatched third attempt

### Codex Quota Overnight
- **Problem**: `gpt-5.6-sol` blocked all night by quota limit
- **Resolution**: Quota reset at 05:57, dispatched sol round-2 review as requested

## Open Threads at Chunk End

1. **T9b active**: Two commits done (`c3ac884 refactor`, `6db03d6 feat(sup...)`), no report yet, continuing work
2. **Sol round-2 review running**: Dispatched but no output in chunk
3. **Dependent tasks blocked**: T10 and T11 need T9 to complete; T1b, T3b, T8, T6b wait on user's Q7 answer
4. **Q7 probe list addition**: `gh` CLI verification should be added to probe list
5. **Three convergent votes**: All three T9 attempts independently chose same opening move (delete unreachable legacy execution path)—suggestive pattern but not proof

## Key Quotes

Agent on catching own error:
> "The most useful finding of the last hour: my own evidence note was wrong, and the worker caught it."

Agent on objective checks encoding assumptions:
> "That is the third time this session an objective check encoded my assumption rather than the requirement, and each time the worker's alternative was better than the one I imagined."

T6a's honest blocker flag:
> "`gh` on the pinned Computer image is unverified. If it is missing, no repository can be connected, and ADR-0039 would need an install step. *Nothing in this task guesses.*"
