# Session Chunk 2 Summary: Task Verification, Evidence Collection, and First Merges

**Time span:** 2026-09-05 09:31:09 → 09:51:29 (20 minutes)  
**Context:** Continuation of wave-1 dispatch work; no new user requests in this chunk.

## Evidence Collection and Architecture Findings

The agent conducted systematic verification of task partition claims and architectural assumptions, yielding three new evidence items:

### E6: Coding Half Has No HTTP Surface
**Discovery:** The owner API serves only six paths (`/api/status`, `/api/generations/*`, `/api/recovery/latest`, `/fresh`). The Supervisor's project-turn methods (`startProjectTurn`, `finishProjectTurn`, `abandonProjectTurn`, `streamProjectTurn`) have **no route** calling them—zero HTTP exposure. The entire coding-agent half of v0 is unreachable from browsers.

**Impact:** Blocks goal criteria 4, 5, and 6. The codebase's own comment in `streamProjectTurn` admits "joining the halves" is "the next unit's work" (ADR-0037). Assigned to T9 (wave 2) to build the missing HTTP surface.

### E7: Streaming Plumbing Already Exists
**Good news:** The incremental-response path is narrower than expected. The facet boundary already returns `ReadableStream<Uint8Array>`, and Pi exports `createAssistantMessageEventStream()`. The non-incremental surface is exactly **two hops**: the model route's return type (E5) and `route-stream.ts:streamOnce`, which awaits the entire reply and wraps it as a stream of one event.

**Impact:** Makes T4 smaller. No need to invent streaming through facet, page transport, or Pi—just give the route an incremental interface (`stream: true`) and push deltas. Recorded in T4's brief as a "narrow change at a real seam."

### E8: Paid Evidence Already Exists
**Correction of the oracle:** The plan review criticized existing paid evidence as proving "only R2 and Workers AI." This was too strong. `docs/agents/design/computer-integration.md` records a 2026-08-29 paid-account test proving: container commands, persistent files, isolated workspaces, Node/pnpm/Git/FUSE presence, network package installs, and no Computer issue #114.

**Genuinely unproved chain:** module-map build for labeled commit → R2 cache → Worker Loader load by commit id → facet cold start with workspace capability passed as argument. Step one must run twice (dirty and clean) to prove byte-identical output (goal criterion 7). Saved paid budget by narrowing T1's scope.

## Task Dispatch and Re-dispatch

### Original T1 Dispatch (killed ~6 min, nothing lost)
- **Scope:** Wave 0, all criteria 1–5 plus pin check/replacement.
- **Problem:** Lacked automation for E1 (build/module-map drift). Plan review B2 flagged: "fixes E1 but does not prove it." No regression test means drift returns on next edit.

### T1a Re-dispatch (opus-3, running at chunk end)
Split T1 into local-only half; paid half explicitly blocked pending user approval:
- **Running:** Criteria 1–3, pin *check* only. Includes `build:artifact` script (canonical map export), `.githooks/pre-commit` calling `scripts/probe/clean-build.sh` for byte-identical build proof, and E1 fix (align `bin/app-build.sh` and `wrangler.toml`'s `buildCommand`).
- **Blocked:** Criteria 4–5, pin *replacement*—anything requiring deploy, workspace creation, billing API, or account credentials. Recorded as blocked (not passed or simulated) per T1's own rule.
- **Committed:** `4bdd6dc fix(build): make a lab` (artifact script + E1 alignment).

### T5 Dispatch (opus-5)
- **Scope:** Lease fencing for turn lifecycle (E2 fix). Wave 1, ADR-0033.
- **Tier raised:** From `sonnet-implementer` to `opus-implementer`. Justification: Criterion 3 needs durable thread identity or monotonic version + reset-race test (empirical design = L tier per roadmap rules). Also changes interface consumed by multiple callers. Logged as deviation.
- **Brief emphasis:** FORBIDDEN_FIELDS enforcement, no HTTP surface (that's T9), T1 dependency is wave-ordering only.
- **Committed:** `df094f3 feat(threads): require the admitting lease to finish or abandon a turn` (10 files, +509/−147, including new 173-line `turn-lease.test.ts`).

### T4 Dispatch (sonnet-5, running at chunk end)
- **Scope:** Model route streaming (E5 fix). Wave 1, ADR-0034.
- **Brief carries E7 proof:** Two-hop change only. Keep `FORBIDDEN_FIELDS`, fixed model, test **mid-stream** failure (not just pre-stream).
- **Status:** Still reading vendored Pi helpers at chunk end; 0 files modified in worktree yet.

### T2 Inherited (sonnet-4, from prior chunk)
- **Scope:** Apply generation requests directly (ADR-0030 cleanup). Delete request id, fingerprint, journal replay.
- **Committed:** `119a7ce refactor(control): apply generation requests directly (ADR-0030)` (36 files, +386/−663).

## Plan Review and Integration Notes

### Plan Review (opus-reviewer-3)
- **Verdict:** SHIP WITH FIXES.
- **Convergent calls:** Recommended "T5, then T2, plus T4 minus paid clause, with T1a in parallel and T1b queued"—exactly the active dispatch. Called `Dependencies: T1` on T2/T4/T5 "fictional" (matches agent's earlier refusal).
- **Critical objection (B2):** T1 fixes E1 but doesn't prove it. Prompted T1a re-dispatch with regression tests.
- **Collision discovered (B6):** T2 and T5 both touch `supervisor.ts` at different regions (T2: GenerationRequest type lines 5–9, 145; T5: thread wrappers ~226–265). Merge order: T5 first, then T2.
- **Coverage gaps:** Four gaps against 10 done-criteria (partial gap on criterion 2: no local Access owner-policy test until T12.4; others noted).
- **Output:** `.audit/v0/roadmap-v0.approved.md` (approved plan with fixes incorporated).

### Wave-1 Integration Notes
- **File:** `.audit/v0/wave1-integration-notes.md`
- **Collision map:** Agent ran `git diff --name-only` across all four worktrees. Found **two-file overlap** between T2 and T5 (predicted: `supervisor.ts`; **unpredicted:** `test/supervisor/threads/threads.test.ts`). Merge order T1a → T5 → T2 → T4 documented with explicit instruction: when merging T2, diff that test file and confirm no T5 test case lost.
- **Anti-pattern check:** T2's brief silent on "delete only" in page files that T10 rewrites (wave 4). Must check diff and reject any layout work.

## Merges to Main

### T5 Merge (`567d25e merge(T5)`)
- **Verification:** Agent ran `pnpm verify` independently (not trusting report): green at 653 tests (94 files). Objective checks: 7/7.
- **Design improvement:** Worker collapsed duplicate method pair instead of expected "call `*WithLease` and delete unfenced ones." Now one method set where lease is mandatory:
  - `startTurn` returns `ThreadLeaseResult`, serializes `leaseId` to client
  - `finishTurn(project, messages, now, leaseId)` and `abandonTurn(project, leaseId)` **require** lease
  - No `WithLease` symbol survives; `expectedRevision` gone from `finishTurn` (criterion 3: don't admit write by numeric equality alone)
  - Kept HTTP surface absent (confirmed T9's work)
- **Test additions:** +11 tests (new lease test file).

### T2 Merge (`c3e0d5a merge(T2)`)
- **Verification:** `pnpm verify` green at 639 tests (94 files). Objective checks: 4/4.
- **Scope discipline:** Explicitly declined to edit files outside scope list; left `feature-map.md` reconciliation to T12.
- **Test changes:** Net −3 tests (journal-replay tests deleted; fresh-schema and malformed-body tests added).

### Merge Order and Gating
```
567d25e merge(T5)  -> pnpm verify green, 653 tests
c3e0d5a merge(T2)  -> pnpm verify green, 650 tests
```

Predicted collision on `threads.test.ts` auto-merged (T5: 80 lines changed, T2: 4 lines changed). Agent checked afterwards: `turn-lease.test.ts` present, `leaseId` referenced in shared test, `control/journal.ts` gone. Re-ran both audits **against main** (not worktrees): still 4/4 and 7/7.

**Baseline movement:** 93 files/642 tests → 650 tests on main. Explanation documented (T5 +11, T2 −3).

## Concrete Outcomes

### Files Created/Modified
- **Committed to main:**
  - `scripts/probe/clean-build.sh` (T1a)
  - `.githooks/pre-commit` update (T1a)
  - 36 files refactored (T2: +386/−663, journal deleted)
  - 10 files for lease fencing (T5: +509/−147, new test file)
- **Audit documentation:**
  - `.audit/v0/roadmap-v0.approved.md`
  - `.audit/v0/wave1-integration-notes.md`
  - `.audit/v0/tasks/T2.md`
  - `.audit/v0/tasks/T5.md`

### Test Results
- T1a: 5/5 objective checks passing at chunk end
- T2: 4/4 objective checks, verified green at 639 tests
- T5: 7/7 objective checks, verified green at 653 tests
- Main after merges: 650 tests passing, 94 files

### Commits
- `4bdd6dc` (T1a): fix(build): make a lab
- `119a7ce` (T2): refactor(control): apply generation requests directly (ADR-0030)
- `df094f3` (T5): feat(threads): require the admitting lease to finish or abandon a turn
- `567d25e`: merge(T5)
- `c3e0d5a`: merge(T2)

### Blockers Resolved
- **E2 (lease fencing):** Fixed and merged via T5. Duplicate method pair gone, lease mandatory on finish/abandon, `startTurn` returns id to client. Goal criterion 6's fencing half now implementable and tested.
- **E1 (build drift):** Fixed via T1a (alignment + regression test in commit gate). Not yet merged pending full 5/5 completion.
- **ADR-0030 cleanup:** Completed and merged via T2. No request ids, fingerprints, or journal; epoch checks intact.

## Problems and Errors

1. **Original T1 lacked regression test:** Plan review B2 caught this. Agent killed original T1 at ~6 min (reading only), re-dispatched as T1a with `build:artifact` script and `.githooks/pre-commit` calling `clean-build.sh` for byte-identical proof.

2. **Merge collision on test file unpredicted:** T2 and T5 overlap on `threads.test.ts` was missed by plan review. Agent discovered via `git diff --name-only` sweep and documented specific merge instruction (diff explicitly, confirm no test cases lost).

3. **Agent's objective checks initially wrong on T5:** Showed 2 red checks. Agent inspected code and found worker did something better than spec (collapsed duplicate pair entirely instead of expected approach). Checks were false negatives.

## Open Threads at Chunk End

- **T1a running:** Has committed E1 fix + artifact script; needs to finish criteria 2–3 (byte-identical build proof).
- **T4 running:** Still reading vendored Pi helpers (~8 min elapsed); 0 files modified yet. Agent notes slight concern about duration but task is reading three helper files.
- **Roadmap revision task:** Finished with approved file (`.audit/v0/roadmap-v0.approved.md`).
- **Still blocked:** T1b (paid probe), T9 (HTTP surface for project turns), wave-2+ tasks.
- **Remaining blockers:** E3 (harness build workspace separation), E4 (placeholder catalog), E5 (model route non-incremental), E6 (no HTTP surface for coding half, assigned to T9).
- **No money spent:** Q7 (disposable paid environment approval) still blocking every paid step.
- **Wave 1 progress:** 3 of 4 tasks running; 2 of 4 merged to main.
