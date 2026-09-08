

# ===== PART 1 =====

# cf-stumble Session Summary - Part 1 of 6

## User Requests

The user provided a complex multi-part directive:

1. **Read `/tmp/cf-stumble-handoff.md`** and use it to brief a high-effort GPT-6-Astra oracle
2. **Have the oracle** (as "very expensive advisor"):
   - Read the codebase and architecture  
   - Critique the architecture (high-level code structure)
   - Provide a thorough roadmap to v0 broken into discrete subagent-providable tasks
   - Provide a goal to set once complete
3. **Delegate all work to subagents** after oracle returns
4. **Have plans reviewed by GPT-5.6-Sol (medium effort)** - argue until both satisfied
5. **Use `/skill:poteto-mode` throughout**, keep a decision log, document questions
6. **Use opus manager subagents** for large implementation tasks, **sonnet-5 for general code**
7. **Oracle should use sonnet subagents**; use `pi` with sonnet if websearch breaks
8. User later clarified: **prefer `prime-agent` over `pi`** for shell-outs

## What the Agent Did

### Model Discovery & Substitution (08:59-09:00)

- Read `/tmp/cf-stumble-handoff.md` containing prior session outcomes and architecture decisions
- Loaded skills: `/skill:poteto-mode`, `/skill:improve-codebase-architecture`, `/skill:writing-for-agents`
- Checked available models via `rlm.find_models()`
- **Problem:** `openai-codex/gpt-6-astra` not in RLM catalog
- **Solution:** Found `gpt-5.6-terra-pro` as most expensive/powerful substitute, used as temporary oracle
- **Problem:** First RLM spawn with terra-pro completed silently with no output
- **User intervention:** Confirmed `gpt-6-astra` exists, must be forced; prefer `prime-agent` over `pi`
- **Solution:** Switched to `prime-agent` CLI with explicit model selector `openai-codex/gpt-6-astra`, confirmed reachable with probe

### Durable Planning Infrastructure (09:00-09:01)

Created planning documents in `.audit/v0/` (gitignored, survives /tmp clears):

- **`STATE.md`** - living status tracker (phases S1-S6, current phase, wave progress)
- **`decision-log.md`** - decisions D1-D20 with rationales
- **`questions.md`** - questions for user (Q1-Q6)
- **`PLAN.md`** - execution plan with phases and gates

Key decisions logged:
- D1-D3: Model substitutions and probing strategy
- D4-D6: Durable docs placement, overnight planning, verification gates  
- D7: `prime-agent` preferred for shell-outs (RLM child spawn support)
- D17: Pre-review work restricted to reversible local tasks only

### Oracle Execution (09:02-09:21)

Spawned oracle via `prime-agent --model openai-codex/gpt-6-astra --thinking high --autonomous`:
- Oracle ran for ~18 minutes
- Oracle wrote to `/tmp/cf-stumble-v0/`:
  - `architecture-critique.md` (19 KB) - ranked findings by leverage
  - `roadmap-v0.md` (12 KB) - 3 waves, 9 tasks (T1-T9) 
  - `goal.md` - v0 goal text with acceptance criteria
  - `questions.md` - 6 questions for user (Q1-Q6)
  - `summary.md` - analysis summary
  - `workers-best-practices.html` - downloaded reference doc

Oracle mirrored to `.audit/v0/` for durability

### Goal Setup (09:22)

Set goal via `goal` skill:
- **Objective:** "Ship cf-stumble v0: paid API, one workspace per tenant, arbitrary projects"
- **4 success criteria:** Budget gate landed, capability gate passes with paid Pi call, arbitrary project count supported, streaming model responses work
- **9 acceptance tests:** T1-T9 complete with gates passed

### Dispatch Harness Construction (09:23-09:24)

Built `dispatch_task()` helper that:
1. Creates fresh `git worktree` from base commit `d6ff238`
2. Runs `pnpm install --frozen-lockfile` (~4s)
3. Shells out to `prime-agent` with specified model/thinking
4. Enforces **two gates**: 
   - `pnpm verify` must pass (typecheck, format, lint, 642 tests)
   - Worker report must exist at `.audit/v0/tasks/T{n}.md`
5. Cleans up worktree on completion

Validated with probe: worktree creation, install, and verify pass (93 files, 642 tests in 7.5s)

### Review Process Complications (09:24-09:27)

**First attempt (gpt-5.6-sol):**
- Spawned via `prime-agent` with gpt-5.6-sol medium thinking
- **Failed:** `openai-codex` provider quota exhausted (resets 05:57 local, ~3.5 hours)

**Provider probing:**
- `openai-codex/gpt-5.6-sol`: quota exhausted  
- `prime-inference/openai/gpt-5.6-sol`: HTTP 401 (not authenticated)
- `opencode/gpt-5.6-sol`: 401 (no payment method)
- `anthropic-3p/claude-opus-5`: **Works**

**Decision D18:** Substituted `claude-opus-5` (high thinking) as adversarial reviewer rather than wait 3.5 hours

### Independent Verification (09:27-09:30)

Agent **independently verified** oracle's 5 key findings by reading source:

**E1 - Build blocker (CONFIRMED):**
- `src/harness-build.ts:30` runs only `build:module-map`
- Imports `@cf-stumble/pi` which resolves to `vendor/pi-typescript/packages/pi/dist/index.js`
- `vendor/pi-typescript/packages/pi/dist/` is **untracked by git**
- `pnpm verify` self-heals with `build:pi`, but clean clone fails
- **Blocker:** Supervisor cannot build any labeled commit from clean state
- Maps to task **T1**

**E2 - Lease fencing unreachable (CONFIRMED):**
- `src/supervisor/threads/store.ts` has two parallel method sets:
  - Lease-aware: `startTurnWithLease`, `finishTurnWithLease`, `abandonTurnWithLease`  
  - Lease-discarding: `startTurn`, `finishTurn`, `abandonTurn`
- `src/supervisor/threads/project-threads.ts` (public surface) **only calls lease-discarding variants**
- Lease methods exposed on supervisor RPC but have **zero callers** (grep confirmed)
- **Blocker:** Turn lease fencing exists but protects nothing
- Maps to task **T5**

**E3 - Workspace layout superseded (CONFIRMED):**
- ADR-0038/0039 require **one shared workspace per tenant** with repos as subdirectories
- Three places encode old layout:
  1. `src/workspace/workspace-names.ts:28` - `deriveProjectWorkspaceName` hashes `project.id`, giving each project own container
  2. `src/supervisor/index.ts:87` - separate `HARNESS_BUILD_WORKSPACE_NAME` global build container  
  3. `src/routes/computers.ts:9` + `src/harness-build.ts:13` - hard-coded `PROJECT_ROOT = "/project"` (duplicated)
- **Blocker:** Old per-project container layout still active despite approved ADRs
- Maps to task **T3**
- **Ordering constraint found:** T3 must precede T6 (if third project lands before shared workspace, creates third container - exactly what ADR-0038 deleted)

**E4 - Catalog is 2-tuple type (CONFIRMED):**
- `src/project-catalog.ts:33` declares `export type ProjectCatalog = readonly [Project, Project]`
- Arity is **in the type system** - tuple, not array
- 17 references across 5 files
- Goal criterion 3 needs arbitrary projects, requires type change
- Maps to task **T6**

**E5 - Model route fully synchronous (CONFIRMED):**
- `src/routes/models.ts` returns complete `ProviderResult` with finished assistant message
- No streaming types, no `stream: true` flag, no `ReadableStream` in codebase
- Goal criterion 4 requires streaming; needs interface change
- Maps to task **T4**

### Task Scoping (09:30)

Measured **T2 scope** (journal removal per ADR-0030):
- 58 references in `src/` across 6 files
- 83 references across 13 test files  
- `supervisor/control/journal.ts` is self-contained 91 lines (entire file deletable)
- ADR-0030 already approved, outcome fixed
- Safest task - purely mechanical deletion

**Decision D20:** Independent verification audit complete. Logged ordering constraint (T3 before T6).

### First Implementation Dispatch (09:30-09:31)

**Dispatched T2 as pilot task** while opus review still running (>30 minutes):

**Rationale for pre-review dispatch:**
1. Outcome fixed by approved ADR-0030 (reviewer cannot invalidate)
2. Local & reversible (own worktree, own branch, no paid resources)
3. Independent of T1 (paid platform proof)
4. Pilots dispatch harness end-to-end on lowest-risk task

**Worker:** `anthropic-3p/claude-sonnet-5` high thinking

**Task brief:** Remove journal end-to-end, but tests must prove ADR-0030 promises:
- Resubmitting candidate returns existing generation
- Activating active generation is no-op  
- Stale epoch still rejected
- Epoch-based stale-write protection intact

**Gates:** 
- `pnpm verify` must pass
- Report `.audit/v0/tasks/T2.md` must exist

## Concrete Outcomes

### Files Created

**Planning docs in `.audit/v0/`:**
- `STATE.md` - phase tracker (S1-S6)
- `decision-log.md` - decisions D1-D20
- `questions.md` - questions Q1-Q6  
- `PLAN.md` - execution plan
- `architecture-critique.md` (mirrored from oracle)
- `roadmap-v0.md` (mirrored from oracle)
- `goal.md` (mirrored from oracle)

**Task prompts in `/tmp/cf-stumble-v0/`:**
- `oracle-prompt.md` - oracle task brief
- `review-prompt.md` - adversarial review brief

### Commands Run

- `git worktree add` - probe and T2 worker worktrees
- `pnpm install --frozen-lockfile` - in worktrees (~4s each)
- `pnpm verify` - validation gate (93 files, 642 tests, ~7.5s)
- `prime-agent --model openai-codex/gpt-6-astra --thinking high --autonomous` - oracle execution
- `prime-agent --model anthropic-3p/claude-opus-5 --thinking high --autonomous` - adversarial review
- `prime-agent --model anthropic-3p/claude-sonnet-5 --thinking high --autonomous` - T2 implementation

### Subagents Spawned

1. **`astra-oracle`** (openai-codex/gpt-6-astra, high) - architecture critique + v0 roadmap [COMPLETED]
2. **`opus-reviewer`** (anthropic-3p/claude-opus-5, high) - adversarial roadmap review [RUNNING at chunk end]
3. **`T2-worker`** (anthropic-3p/claude-sonnet-5, high) - journal removal implementation [RUNNING at chunk end]

### Goal Set

Via `goal.start()`:
- **Objective:** Ship cf-stumble v0 with paid API, shared workspaces, arbitrary projects, streaming
- **4 criteria + 9 acceptance tests** (T1-T9)
- **Budget:** 25,000 tokens flagged in goal

### Verified Evidence

**5 blockers confirmed with file/line evidence:**
- **E1:** Clean-archive build fails (T1)
- **E2:** Lease fencing unreachable (T5)  
- **E3:** Workspace layout superseded in 3 places (T3)
- **E4:** Catalog hardcoded as 2-tuple type (T6)
- **E5:** Model route fully synchronous (T4)

**1 ordering constraint discovered:**
- T3 (shared workspace) must precede T6 (arbitrary projects) to avoid creating third container

## Problems & Resolutions

### P1: GPT-6-Astra Not in Catalog
- **Error:** `rlm.find_models()` returned no astra or gpt-6  
- **Attempted:** Substitute with gpt-5.6-terra-pro
- **Failed:** RLM child completed silently, no output
- **Resolution:** User confirmed astra exists, must force. Probed `prime-agent --model openai-codex/gpt-6-astra` directly, confirmed reachable. Used CLI shell-out instead of RLM child.

### P2: Provider Quota Exhausted  
- **Error:** openai-codex primary window fully used, resets in 3.5 hours
- **Attempted:** Try prime-inference route  
- **Failed:** HTTP 401 (not authenticated)
- **Attempted:** Try opencode route
- **Failed:** 401 (no payment method)
- **Resolution:** Substituted anthropic-3p/claude-opus-5 as reviewer (D18). Functionally equivalent (both frontier models, high thinking).

### P3: First Oracle Spawn Failure
- **Error:** RLM child with terra-pro completed without writing deliverables
- **Cause:** Unknown (no error logged)
- **Resolution:** Switched to prime-agent CLI with explicit gpt-6-astra model, which worked

### P4: Model Preferences
- **User correction:** "prefer prime-agent to shell out" (not pi)
- **Resolution:** Updated D7 decision, used prime-agent for all shell-outs (oracle, review, workers)

## Open Threads at Chunk End

### Running Workers
1. **Opus adversarial review** - dispatched 09:26, still running at 09:31 (35+ minutes, empty log)
2. **T2 journal removal** - dispatched 09:31, sonnet-5 high thinking

### Pending Work
- **Wait for opus review** to complete, then converge findings
- **Dispatch remaining Wave 1 tasks** after review:
  - T1: Fix clean-archive build (blocks critical path)
  - T3: Implement shared workspace layout
  - T5: Wire lease-aware turn methods (or delete dead code)
- **Hold Wave 2 tasks** (T4, T6) pending type-level interface discussion with reviewer
- **Potentially re-tier tasks** based on review - three confirmed faults (E2, E4, E5) are type-level changes affecting multiple consumers, not simple edits

### Questions for User (Q1-Q6 from oracle)
All documented in `.audit/v0/questions.md`, includes:
- Q1: Budget gate amount (oracle suggested 25,000 tokens)
- Q6: Model pinning at low effort on flash model - coding quality risk for demo

### Decisions Awaiting Review
- Whether T4, T5, T6 should be re-tiered (type-level changes vs wiring changes)
- Whether to dispatch Wave 1 immediately or wait for opus convergence
- How to handle overnight autonomous work without user interaction

### Verification Status
- Dispatch harness: **PROVEN** (probe passed)
- Oracle deliverables: **COMPLETE** (4 docs + summary)  
- Independent evidence: **5 blockers confirmed**
- Review: **RUNNING** (opus, 35+ minutes)
- Implementation: **1 task dispatched** (T2)
- Remaining tasks: **8 tasks queued** (T1, T3-T9)


# ===== PART 2 =====

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


# ===== PART 3 =====

# Session Chunk 3 Summary: T1a Merge, T3a/T4 Dispatch, and Verification

## User Requests
No direct user requests in this chunk - continuation of autonomous work from previous chunk.

## What the Agent Did

### 1. T1a Verification and Merge (09:51-09:54)
- **Independent verification**: Agent ran `pnpm verify` (96 files, 650 tests, all green) and `scripts/probe/clean-build.sh` on T1a commit `4bdd6dc`
- **Clean build results**: Two independent builds produced identical module maps
  - Archive: 5,785,600 bytes
  - Build time: 13 seconds each
  - Module map: 905,270 bytes, SHA256 `387ed749d810edbabdea95e3078d4f5e3714fbb8007cbe7b989ee4b903b8da00`
  - Cold store: 598 MB (disk budget warning for T1b)
- **Report review**: Read T1a report at `.audit/v0/tasks/T1a.md` (17,781 chars)
  - Report catalogued container preconditions with settlement status
  - Identified residual risk: pnpm packageManager pin means container must download pnpm 11.18.0 before install
  - Registry reachability unproved (only one `pnpm add is-odd@3.0.1` tested, not 186 packages/145 MB)
- **Merge to main**: Merged T1a at commit `d1f2412`, verified on main (96 files, 658 tests)
  - 8 files changed: +442/-21
  - Created `scripts/probe/clean-build.sh` and `test/supervisor/artifacts/build-command.test.ts`

### 2. Approved Roadmap Landing (09:51)
- 77 KB roadmap document landed with full traceability table
- Tasks split: T1→T1a/T1b, T3→T3a/T3b, T6→T6a/T6b, T12→T12a/T12b
- Dependency graph cleaned (removed fictional dependencies)
- Two coverage gaps closed

### 3. T3a Dispatch (09:55)
- Dispatched T3a (workspace migration) from merged main `d1f24126`
- **Critical decision**: Branch from current main, not original base `d6ff238` to avoid reverting merged work
- Brief included: E3 (three encodings), PROJECT_ROOT seam ownership, catalog hand-off, Access policy widening, rm -rf race, cut-line guard
- Validation: Agent reviewed T3a's roadmap section *after* dispatch (noted this as out-of-order but validated)

### 4. Clean Build Verification on Merged Main (09:58)
- Re-ran clean build probe on `d1f2412` (all three tasks merged)
- **Finding E11**: Module map SHA256 identical despite T2/T5 changes to supervisor code
  - Proves host code changes don't disturb harness artifact identity per ADR-0034
  - First empirical demonstration of the boundary v0 exists to prove
- Established new rule: re-run probe after every merge (gate hides E1 fault)

### 5. T1a Documentation Changes (09:59)
- Added 60 lines to `docs/agents/design/computer-integration.md`
  - "Harness build preconditions" section
  - "Clean-build checklist"
  - Quantified install: 186 packages, ~145 MB compressed, ~496 MB unpacked
  - Recommended 900-second cold-build timeout
- **Two new risks identified**:
  - `tar` not in recorded container toolchain
  - Outbound HTTPS to github.com unproved (only npm registry tested)
- Updated Q7 with concrete seven-item probe list

### 6. Evidence Note E12 Created (10:02)
- Verified `eligibility.ts:140` credit gap (criterion 6)
- **Trap identified**: `isCreditedTurn` serves two distinct purposes:
  - Generation health (HTTP outcome, current implementation correct)
  - Completed-real-turn credit (needs durability fact, requires save)
- Risk: Naive fix would break ADR-0031 semantics
- Recorded for T9: must add durability requirement without collapsing concepts

### 7. Heartbeat Check (10:03)
- Heartbeat armed (`cf-stumble-v0`, 15-minute interval, next: 10:16)
- **Unproven**: `run_count: 0`, never fired (goal turns supersede it)
- Risk: If goal turns stop, finished workers won't auto-merge
- Mitigation: STATE.md complete enough for manual recovery

### 8. Continuous Monitoring (10:03-10:21)
- Both T3a and T4 implementing, no commits yet by chunk end
- **T4 progress**:
  - Research phase: 17+ minutes reading ~900 KB of Pi internals before first edit
  - Editing `src/model-route.ts` (in scope)
  - Final state: 6 files, +257/-106 (after simplification from +454/-53)
- **T3a progress**:
  - Research phase: ~11 minutes before first edit
  - Final state: 54 files, +919/-518 (workspace migration)

## Concrete Outcomes

### Commits & Merges
- `d1f2412`: T1a merged to main (fix build from clean checkout)
- Main state: 96 test files, 658 tests (up from 93/642 baseline)

### Files Created/Modified
- `scripts/probe/clean-build.sh` (executable clean build test)
- `test/supervisor/artifacts/build-command.test.ts` (gate test for buildCommand)
- `docs/agents/design/computer-integration.md` (+60 lines of preconditions)
- `.audit/v0/STATE.md` (consolidated index)
- `.audit/v0/tasks/T1a.md` (17,781 char report)

### Evidence & Decisions
- **E1 closed**: Clean build reproducibility proven with SHA256 `387ed749...`
- **E11**: Host code changes preserve artifact identity (verified empirically)
- **E12**: Turn credit gap documented with trap warning for T9
- Six operating rules established:
  1. Branch from current main, not original base
  2. Await cleanup dependencies (bash() is non-blocking)
  3. Use session file for worker liveness, not pgrep
  4. Re-run probe after merge (gate masks E1 fault)
  5. Assert properties, not implementations
  6. No paid spend until Q7 (blocked, never faked)

### Documentation
- Q7 updated with seven-item paid probe list
- Morning brief updated with real results (3 merged tasks, E1 closed)
- T1a findings in tracked documentation (`docs/agents/design/computer-integration.md`)

## Problems, Errors, Blockers

### Resolved
- **T4 liveness false negative**: `pgrep` only found shell wrapper; session file is real signal
- **Out-of-order validation**: Dispatched T3a before reviewing roadmap section (validated afterwards, passed)

### Open Blockers
- **T1b, T3b, T8 substance**: Blocked on Q7 answer (paid Computer/R2 probes)
- **T6a, T7**: Blocked waiting for T3a/T4 completion
- **Heartbeat unproven**: Never fired, manual recovery may be needed
- **Registry throughput**: Only `is-odd@3.0.1` tested, not full 186 packages
- **Container risks**: tar availability and github.com HTTPS unproved

## Open Threads at Chunk End

### Active Workers (10:21)
- **T3a**: 54 files, +919/-518, implementing workspace migration
- **T4**: 6 files, +257/-106, implementing streaming (simplified from +454/-53)
- Both in implementation phase, no commits or reports yet

### Goal Progress
- **3 of 10 criteria**: 6 (fencing), 7 (local), 8 (journal)
- **3 of 7 blockers closed**: E1 (clean build), lease fencing, ADR-0030 cleanup
- **7 criteria untouched**: 1, 2, 3, 4, 5, 9, 10

### Next Actions
- Wait for T3a/T4 to commit and write reports
- Run objective checks, read reports, merge in collision-safe order
- Gate with `pnpm verify` between merges
- Re-run clean-build probe after each merge
- Need Q7 approval to unblock paid probes (T1b, T3b, T8)

### Context Conservation
- Agent deliberately held at 10:03 to conserve context for merge/verification work
- 149K tokens used at hold point
- STATE.md serves as complete resume document if needed


# ===== PART 4 =====

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


# ===== PART 5 =====

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


# ===== PART 6 =====

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
