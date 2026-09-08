# Chunk 4 Summary: Wave 0/1 Merge and Wave 2 Dispatch

## User Requests

No direct user messages in this chunk. The agent is executing a dispatched work plan from earlier, monitoring parallel background workers through completion and merge.

## What the Agent Did

### Wave 0/1 Monitoring and Verification (T3a, T4)

**T3a (refactor workspace)**
- Monitored T3a until commit `a1bcb7e`: "refactor(workspace): hold every repository in one tenant workspace" — 63 files, +1427/−561
- Ran independent verification while waiting for report:
  - `pnpm verify`: 101 test files, 681 tests (up from main's 96/658)
  - `scripts/probe/clean-build.sh`: two byte-identical builds, module map sha256 `d88c820412f259...` (905,943 bytes)
- Recorded **E13**: commit-keyed artifact identity behaves correctly in both directions
  - Host change (T2/T5 Supervisor rewrite): map stayed `387ed749...`
  - Harness change (T3a facet edit): map changed to `d88c8204...`
  - Both reproduced byte-identically across independent clean builds
- Read T3a report, found important correction: roadmap incorrectly claimed "no owner-only Access policy exists today" — T3a verified `src/access/index.ts:48-65` already implements owner-only enforcement via `CF_ACCESS_OWNER_SUB`
- **Merged T3a** → commit `43e7ac8` on main

**T4 (model-route streaming)**
- T4 committed `e4d1d9c` then `d6ff238`: "feat(model-route): stream real model events instead of one buffered message" — 12 files, +1340/−99
- Independent verification:
  - `pnpm verify`: 659 tests passing
  - Objective checks: 5/5 pass
- **Merged T4** → commit `638890e` on main
- Post-merge verification: 103 test files, 698 tests green; clean-build probe sha256 `8e821d86...` (map changed again because T4 edited `route-stream.ts` inside facet — E13's property holding)

**Session totals after wave 0/1**: 93 files / 642 tests → 103 files / 698 tests

### Wave 2 Dispatch (T6a, T7)

Dispatched two opus-5 workers off merged main `638890e`:

**T6a — connected GitHub projects**
- Carries E4 (catalog tuple type), E9 (zero-credential finding)
- Given two interfaces T3a left: consume `AccessRequestResult.ok.scope`, supply real catalog to `new ProjectThreads(ctx.storage, catalog)`
- Briefed with correction: owner-only Access enforcement already exists
- Monitored through expansion: 1 file → 9 files → 11 files → 35 files, +849/−298
- Still running at chunk end

**T7 — Pi instructions, compaction, diff**
- Brief allowed either: dedicated diff tool **or** prove `bash` + `git diff` returns diff through tool-result frame
- Monitored through expansion: 1 file → 6 files → 28 files → 39 files, +1473/−1479
- **Committed** `133b275`: "feat(facet): finish the Pi turn with instructions, compaction, and a diff" — 39 files
- Objective checks revealed issue: check initially FAILED for "Pi path has a diff capability"

### Problem: Objective Check Encoded Assumption (Third Instance)

Agent's check asserted diff tool must exist in `pi-agent-turn.ts`. Check failed because Pi path binds exactly four tools (read, write, edit, bash).

**Investigation revealed**:
- T7 satisfied requirement via the second permitted route: `bash` + `git diff`
- `src/facet/generation-0/turn-policy.ts:13` instructs: "Run `git diff` with the bash tool when the user asks what changed"
- `test/facet/generation-0/turn-diff.test.ts` proves the frame carries diffs at caller-chosen sizes (40-line diff test for goal criterion 4)
- Better solution than fifth tool: keeps four-tool surface, proves byte budget with real diff

**Root cause**: Third time objective check encoded agent's assumption instead of requirement (after T1a path location, T5 method shape). Agent recognized pattern: "I will fix the check to assert the property (Pi path can produce a diff **and** test proves the frame carries it) rather than the location."

## Files Created/Edited

### Evidence
- Created **E13** (location not shown in chunk, but referenced as written)

### No direct file edits by orchestrator
Agent monitored workers; workers created/edited files in their worktrees:
- T3a: 63 files in workspace refactor
- T4: 12 files in model-route streaming
- T6a: expanding to 35 files (in progress)
- T7: 39 files in Pi turn completion

## Commands Run

**Independent verification for T3a**:
```bash
# In T3a worktree
pnpm verify  # 101 files, 681 tests, 15.34s
scripts/probe/clean-build.sh  # exit 0, sha256 d88c820412f259...
```

**Independent verification for T4**:
```bash
# In T4 worktree
pnpm verify  # 659 tests
```

**Post-merge verification**:
```bash
# On main after T4 merge
pnpm verify  # 103 files, 698 tests
scripts/probe/clean-build.sh  # sha256 8e821d86...
```

**Objective checks**: Automated Python checks against each commit (T3a, T4, T7)

## Concrete Outcomes

### Commits to Main
1. `43e7ac8` — T3a merged (workspace refactor)
2. `638890e` — T4 merged (model-route streaming)

### Evidence Recorded
- **E13**: Commit-keyed artifact identity validation
  - Host changes (Supervisor): map stable at `387ed749...`
  - Harness changes (facet edits): map updates (`d88c8204...`, then `8e821d86...`)
  - Byte-identical reproduction across independent builds

### Test Coverage Growth
- Start: 93 test files, 642 tests
- After wave 0/1: 103 test files, 698 tests
- +10 test files, +56 tests

### Scoreboard Update
- **Five of seven confirmed faults closed**: E1 (build), E2 (lease fencing), E3 (workspace layout), E5/E7 (streaming), plus ADR-0030 cleanup
- **Remaining**: E4 (catalog tuple, owned by T6a), E6 (no HTTP turn surface, owned by T9)

### Workers Dispatched
- T6a (opus-5): connected GitHub projects
- T7 (opus-5): Pi turn completion

## Problems and Resolution

### T3a Report Correction
**Problem**: Roadmap claimed "no owner-only Access policy exists today" — false at base commit.

**Evidence**: `src/access/index.ts:48-65` already reads `CF_ACCESS_OWNER_SUB` and refuses non-owner identities.

**Resolution**: Agent verified claim directly, accepted correction, briefed T6a with accurate state.

### T7 Objective Check False Negative (Third Instance)
**Problem**: Check FAILED "Pi path has a diff capability" because it asserted specific implementation (diff tool in specific file).

**Root cause**: Brief permitted two routes; T7 chose bash+git diff route; check encoded assumption not requirement.

**Resolution**: 
- Agent investigated actual implementation
- Verified `turn-policy.ts` instructs bash diff usage
- Verified `turn-diff.test.ts` proves frame carries diffs
- Recognized pattern (third instance after T1a, T5)
- Declared intent to fix check to assert property not location

### Module Map Hash Validation
**Challenge**: Distinguish legitimate hash changes (harness edits) from build non-determinism.

**Evidence gathered**:
- T2/T5 (Supervisor rewrite, host code): hash stable
- T3a (facet edit): hash changed `387ed749...` → `d88c8204...`
- T4 (facet edit): hash changed `d88c8204...` → `8e821d86...`
- All changes reproduced byte-identically

**Outcome**: E13 establishes property for goal criterion 8 (though criterion 8's release proof still needs Computer builds and activate-rollback cycle from Q7).

## Open Threads at Chunk End

### In Progress
- **T6a**: 35 files, +849/−298, still expanding
- **T7**: committed `133b275`, passes 4/5 objective checks (1 check needs fix), no report written yet

### Waiting
- T6a and T7 reports (gate condition before merge)
- T6a and T7 independent verification (pnpm verify, clean-build probe) after reports land

### Unaddressed
- **Q7's seven paid-probe items**: T1b Computer gate, T3b concurrency experiment, T8 R2 deletion rule, T6b device authorization, T12 deployment smoke, criterion 7/8 Computer proofs

### Wave Planning
- Wave 2 is the first wave that could not have started earlier (dependencies cleared by T3a/T5/T4 merges)
- Future waves and paid work still pending user attention
