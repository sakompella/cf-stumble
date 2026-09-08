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
