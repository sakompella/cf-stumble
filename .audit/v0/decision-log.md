# cf-stumble v0 — decision log

## D1 — SUPERSEDED by D7 — Oracle model substitution
User asked for `openai-codex/gpt-6-astra` effort high. `rlm.find_models` shows no
`astra` and no `gpt-6` selector on this host. Available codex tier:
`gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, plus
`prime-inference/openai/gpt-5.6-terra-pro` and `...-luna-pro`.
Decision: use `prime-inference/openai/gpt-5.6-terra-pro` with thinking=high as the
"expensive oracle" stand-in. Reviewer stays `openai-codex/gpt-5.6-sol` medium as asked.
Question for user: Q1.

## D2 — No HTML
`improve-codebase-architecture` normally emits an HTML report. User said no HTML.
Oracle uses the skill only for vocabulary and lens; deliverables are Markdown in /tmp/cf-stumble-v0/.

## D3 — Artifacts outside the repo
Plans, critique, and this log live in /tmp/cf-stumble-v0/ so nothing untracked lands in the repo.

## D4 — Document first, durable home is `.audit/v0/`
Owner: "for long horizon planning document first to avoid losing info".
`.audit/` is already gitignored and already holds this project's planning notes.
All stage artifacts land there before the next stage starts. `/tmp/cf-stumble-v0/`
stays as the oracle's scratch path and is mirrored in.

## D5 — Overnight autonomy
Owner is asleep. Q1 (oracle model stand-in) is unanswered, so the run proceeds on
`prime-inference/openai/gpt-5.6-terra-pro`. The choice is reversible: if the owner
prefers another model, only the plan stage re-runs, not the implementation.

## D6 — Heartbeat drives the pipeline
A 20-minute internal heartbeat advances the pipeline overnight instead of polling
inside a turn. It reads `.audit/v0/STATE.md`, checks child replies, and moves to
the next unblocked stage.

## D7 — `gpt-6-astra` is reachable; shell out with `prime-agent`
Owner: the model exists, it just has to be forced, and `prime-agent` is the
preferred shell-out (pi has subagents too, but weaker).
`rlm(..., model='openai-codex/gpt-6-astra')` fails: "unavailable, unauthenticated,
or expired" — the RLM host catalog has no entry. The CLIs accept it as a custom
model id and the provider answers.
Decision: run the oracle as `prime-agent --model openai-codex/gpt-6-astra
--thinking high -p --autonomous`, with an autonomous gate that fails until all
four deliverables plus the summary exist on disk. Its sonnet readers are also
`prime-agent --model anthropic/claude-sonnet-5 -p` shell workers writing to files.
D1 (terra-pro stand-in) is dead; Q1 is answered and closed.
Rule for the rest of this run: any model the RLM catalog rejects gets a
`prime-agent --model <selector>` shell-out instead of an `rlm()` spawn.

## D8 — Fan-in is the filesystem
Shelled-out `prime-agent` runs are sibling root sessions, not RLM children, so no
`agent_message` reply arrives. Every delegated unit must write its result to a
known path under `/tmp/cf-stumble-v0/` or `.audit/v0/tasks/`. The autonomous gate
enforces that the files exist before a run is allowed to finish.

## D9 — Goal set from the oracle's goal.md
Goal id c0552403-7594-4996-a8ec-26fcef7b5812. Ten done criteria and an explicit cut
line live in `.audit/v0/goal.md`. Release completion is judged against that file, not
against a worker's self-report.

## D10 — Review before dispatch, even overnight
The owner asked for plans reviewed by sol until both sides are satisfied. No
implementation task is dispatched until the review converges. Cost: about one
heartbeat of wall clock. Benefit: T1 spends paid Cloudflare budget and T6 touches the
owner's GitHub account, so a defect found now is much cheaper than one found after a
paid deploy.

## D11 — Six product questions raised by the oracle, all with defaults
Q2 gh device authorization, Q3 partial messages on cancel, Q4 controls drawer,
Q5 recording publication, Q6 the fixed Workers AI model vs the recorded OpenAI
preference. Each has a reversible default recorded in `.audit/v0/questions.md`;
the run proceeds on the defaults and the owner can flip any of them later.
Q5 blocks publication only, never implementation.

## D12 — One worktree per writer, two gates per worker
The roadmap's dispatch contract requires a separate worktree per writer. Validated:
`git worktree add` + `pnpm install --frozen-lockfile` costs 4s and `pnpm verify` runs
green in the fresh tree (93 files, 642 tests, 13.6s).
Every dispatched worker gets two autonomous gates: `pnpm verify` must pass AND its
report file must exist. A worker therefore cannot finish by claiming success — the
gate re-runs the real test suite, and the report is the fan-in artifact (D8).

## D13 — E1 confirmed independently; T1 gets the diagnosis, not a puzzle
The oracle reported a clean-archive build failure. The root agent verified the cause
from the manifests and the git index rather than trusting the report: the Supervisor's
`buildCommand` omits `build:pi`, and the vendored Pi `dist/` is untracked. The T1 brief
will carry this diagnosis and the recommended fix so the worker spends its budget on
proving the fix from clean state, not on rediscovering the fault.

## D14 — Codex quota exhausted; same model, different provider
The first sol review died instantly: `usage_limit_reached`, plan `plus`, primary
window 100% used, resets 2026-09-05 05:57 local; secondary window 94% used, resets in
about 4.7 days. The `gpt-6-astra` oracle run spent that budget, and it delivered, so
the spend was worthwhile.
Consequence: the `openai-codex/*` provider is unavailable until 05:57. That includes
any further `gpt-6-astra` oracle call.
Decision: do not wait and do not substitute a weaker model. The same model is sold by
three providers — `openai-codex`, `opencode`, and `prime-inference`. The review was
relaunched on `prime-inference/openai/gpt-5.6-sol` at thinking medium, which is the
model the owner asked for, billed elsewhere. `prime-inference/openai/gpt-5.6-sol-pro`
and `opencode/gpt-5.6-sol` remain as further fallbacks.
Rule for the rest of the run: on a provider quota error, re-resolve the SAME model id
under another provider before considering any change of model.

## D15 — E1 handed to the reviewer as a test of the plan
The relaunched review carries E1 as an extra input and must judge whether T1 as
written actually fixes and proves the clean-build blocker. This turns a found bug into
a check on plan quality.

## D16 — Every non-Anthropic provider is unavailable tonight
Probed all three routes to the requested reviewer model:
- `openai-codex/gpt-5.6-sol` — quota exhausted, resets 05:57 local.
- `prime-inference/openai/gpt-5.6-sol` — HTTP 401, not authenticated on this host.
- `opencode/gpt-5.6-sol` — 401 CreditsError, no payment method on the workspace.
`anthropic/claude-sonnet-5` and `anthropic/claude-opus-5` both answer.
D14's rule (re-resolve the same model under another provider) is now exhausted for
`gpt-5.6-sol`. It stands for future quota errors.

## D17 — Review now with opus-5, re-review with sol after 05:57
Blocking the whole overnight run for 3.5 hours on a quota is worse than reviewing with
a different strong model. Round 1 runs on `anthropic/claude-opus-5` against the same
review brief plus E1. When the codex window resets at 05:57, `openai-codex/gpt-5.6-sol`
at medium re-reviews the roadmap as the owner asked, and any objection it raises that
opus missed is applied before the affected task starts.
Dispatch is staged to match that confidence: after the opus review converges, only
reversible local work may start — no paid task, and nothing that a failed platform
assumption in T1 would waste. The review must name which of T2, T4, T5 qualify.

## D18 — Anthropic-only worker pool tonight
Opus-5 managers and sonnet-5 implementers are unaffected by the outage, so the
implementation plan needs no change.

## D19 — Verify the critique's load-bearing claims instead of trusting them
Two of the oracle's top findings are now confirmed by direct source inspection rather
than by report: E1 (clean build) and E2 (lease fencing). Both are blockers tied to a
numbered goal criterion. E2 also sharpens the fix direction: the `*WithLease` methods
are dead code, so the deletion test points at deleting the UNFENCED variants after the
client surface carries the lease id, not at deleting the unused safe ones.
Each confirmed finding goes into the owning task's brief so a worker spends its budget
proving a fix rather than rediscovering a fault.

## D20 — Independent audit: five of the oracle's findings confirmed from source
E1 build command, E2 lease fencing, E3 workspace layout, E4 catalog tuple, E5 model
route. Each is now backed by file-and-line evidence rather than by report, and each maps
to a numbered goal criterion (7/8, 6, 3, 3, 4). Written to `.audit/v0/evidence/`.
Three of the five turned out to be TYPE-level faults, not data or wiring faults:
- E4: `ProjectCatalog` is a fixed two-tuple, so no connect flow can add a project.
- E5: the model route returns one finished message, so there is nothing to stream.
- E2: the client thread surface has no parameter that could carry a lease id.
That changes sizing. Each of T4, T5, T6 changes an interface and every consumer of it,
so none is the small specified edit a sonnet implementer is best at. Raise the review's
tier question for T4, T5, and T6 rather than accepting the roadmap's tiering.

## D21 — Plan defect found by the audit: T3 must not follow T6
E3 shows the container name hashes `project.id`; E4 shows T6 adds real projects. If T6
lands before T3, connecting a third repository creates a third container — the exact
layout ADR-0038 deleted. The roadmap puts T3 in wave 1 and T6 in wave 2, which is the
right order, so this is a constraint to PRESERVE, not a defect to fix. Recorded so that
no later resequencing moves T6 earlier.

## D22 — Dispatch T2 now as the pilot, before the review lands
The opus review has run 30+ minutes. Rather than idle the whole overnight window, T2 is
dispatched first, on four grounds:
1. Its outcome is fixed by ADR-0030, which is HUMAN-APPROVED. The reviewer can question
   the roadmap's wording, not the decision, so the review cannot invalidate the work.
2. It is local and reversible: own worktree, own branch, no paid resource, no account.
3. It does not depend on T1's paid platform proof, so a T1 surprise cannot waste it.
4. It pilots the dispatch harness end to end with a real worker on the safest task,
   before any full wave fans out.
Scope was measured before dispatch rather than left to the worker: 58 `src` refs across
5 files plus the whole 91-line `src/supervisor/control/journal.ts`, and 83 refs across
13 test files. Tier: sonnet-5, thinking high — the outcome is specified, the edit is wide
but mechanical.
The brief demands tests for the ADR's PROMISED behaviour (resubmission returns the
existing generation, activating the active generation is a no-op, stale epoch still
rejected), not merely the journal's absence. Deleting code and calling the missing
behaviour proof is the obvious failure mode here.

## D23 — The audit corrected the oracle once, and shrank one task
Seven of the eight evidence notes confirm the critique. Two change the plan in the
opposite direction from "everything is worse than it looks":
- E7: the streaming plumbing already exists on both sides of the seam; exactly one await
  in `route-stream.ts:streamOnce` collapses it. T4 is narrow, not cross-cutting.
- E8: the critique understated existing paid evidence. Computer container behaviour is
  already proved on a paid account. T1's budget belongs to the Loader/facet/module-map
  chain alone.
Accepting the oracle's advice as "almost certainly correct" was the right default, and
checking it against source still paid for itself twice.

## D24 — Split T1: dispatch the local half, block the paid half
T1 is wave 0 and everything depends on it, but criteria 4 and 5 spend the owner's paid
Cloudflare budget, and the roadmap itself requires "an approved disposable paid
environment". The owner is asleep and gave no such approval.
Decision: dispatch the LOCAL half now (criteria 1, 2, 3, and the pin CHECK), with paid
spend, deployment, and account credentials explicitly forbidden in the brief. Criteria 4,
5 and pin replacement are recorded as blocked, using the task's OWN rule that missing paid
authorization means blocked and not passed. Faking or simulating a paid result is
forbidden in writing, because that is the obvious way a worker would "finish".
This unblocks the E1 fix, which every later wave needs, and turns the paid probe into one
explicit morning question (Q7) instead of an unsupervised charge.
Criterion 3 - two independent clean builds producing byte-identical canonical maps - is
fully local and is the single most valuable thing tonight can deliver, because it is goal
criterion 7's core and it cannot be checked at all while E1 stands.
Tier: opus-5 manager, as the roadmap specifies. No file overlap with T2.

## D25 — Dispatch T4 and T5 now; T3 held back
Wave 1 is T2, T3, T4, T5. T2, T4 and T5 are now running; T3 is not.
Reasoning: T2, T4 and T5 are local, reversible, in separate worktrees, and each is driven
by a confirmed source-level fault (E2, E5, E7) plus a numbered goal criterion, so the
pending review can change their wording but not their necessity.
T3 waits because it is the largest critical-path task, it collides with T5 in
`supervisor.ts` and with T6 at line 87, and E3 shows it must treat the duplicated
`PROJECT_ROOT` as ONE seam. That is exactly the kind of scope the review should confirm
before an opus manager spends a long run on it.

## D26 — T5 tier raised from the roadmap's sonnet to opus-5
The roadmap tiers T5 `sonnet-implementer`, size M. Its criterion 3 requires a durable
thread identity or monotonic concurrency version plus a reset-race test through storage.
By the roadmap's own sizing rule that is "an empirical design choice", which is L.
E2 also shows T5 changes an interface and every consumer of it, not a contained edit.
Raised to opus-5 at high thinking. Recorded as a deviation for the reviewer to confirm.

## D27 — Every worker brief now carries a written no-paid-spend clause
T1's split (D24) generalised: T4 and T5 carry the same clause. No deploy, no Computer
workspace, no billing API, no account credentials; a criterion needing paid access is
recorded as blocked, and faking or simulating a paid result is forbidden in writing.

## D28 — Spurious dependency called out rather than obeyed
The roadmap lists T1 as a dependency of T5. T1 fixes the clean BUILD path and touches no
thread code, so that is wave ordering, not a semantic prerequisite. The T5 brief says so
and instructs the worker to stop and report if it finds a real dependency. Obeying a
false dependency would have serialised the whole night behind a task whose paid half is
blocked on Q7 anyway.

## D29 — Review round 1 landed: SHIP WITH FIXES. It agreed with the night's calls.
`.audit/v0/review-opus-round1.md` (39 KB, opus-5, independent reads).
Verdict: the plan's content is good; the defects are structural.
It independently reached three conclusions this session had already acted on:
- B1 = D24: T1 is two tasks, and its paid half must not gate work that needs no platform fact.
- The `Dependencies: T1` on T2/T4/T5 is "fictional" = D28.
- Its recommended immediate dispatch set is "T5, then T2, plus T4 minus its paid clause,
  with T1a in parallel and T1b queued" — exactly what was dispatched.
Convergence between an independent reviewer and the dispatcher is worth more than either
alone, so the dispatch decisions stand.

## D30 — Killed and re-dispatched T1 as T1a with the review's B2 requirements
B2 is the objection worth the whole review: T1 as written FIXES E1 but does not PROVE it,
does not stop the same drift returning, and does not test the container preconditions its
repair introduces. The running T1 worker had none of that in its brief.
Killed it at ~6 minutes (reading only, no commits, nothing lost), removed the worktree and
branch, and re-dispatched as T1a carrying:
- (a)-(d): a `build:artifact` script, `buildCommand` set to exactly that script name, a
  gate test asserting `buildCommand` names a real script, and a real clean-build test with
  `HOME`/pnpm store isolated and `node_modules` unreachable.
- Six container preconditions to probe and record, because the oracle's local reproduction
  ran against a WARM pnpm store (`reused 183, downloaded 0`) and a native `koffi`/`cnoke`
  install script — neither of which a fresh container gives.
- The criterion-3 wording correction: a local two-build check is a PRE-CHECK; goal
  criterion 7 needs two clean COMPUTER builds.
- The `rm -rf ${directory}` same-commit race handed to T3 in writing rather than absorbed.
Restarting a 6-minute worker to add a regression proof is cheap. Discovering in wave 5 that
E1 came back silently is not.

## D31 — Wave 2 defects recorded now, before those tasks are written
- B3: T7.5 orders deletion of "duplicate tools", but `git_diff` is NOT a duplicate. It exists
  only on the legacy buffered path (`tools.ts:77,92,138`, `tool-execution.ts:141-151`); the
  Pi path builds exactly four tools and has no diff tool. Deleting it removes the only code
  that produces a diff, which goal criterion 4 and feature-map demo step 3 both require, and
  which T10.2 and T11.1 consume. T7 must gain an acceptance item that the Pi path can produce
  a repository diff, with a frame byte budget large enough not to truncate a small real diff.
- T7 also edits a GENERATED vendored file whose checker (`verify:vendor`) is inside
  `pnpm verify`, so T7 as scoped cannot pass its own gate.
- T6 needs a human at `github.com/login/device` yet sits on the unsupervised critical path.
These are wave-2 tasks; none is dispatched. Fix the roadmap text before they are.

## D32 — One cheap paid probe would de-risk T4, and it is blocked on Q7
The review recommends a five-minute paid smoke probe of
`env.AI.run("@cf/zai-org/glm-5.3-flash", { stream: true, tools: [...] })` to observe whether
text deltas and tool-call fragments arrive incrementally, BEFORE T4 commits to a design.
T4 is already running under the no-paid clause, so it must record what it assumed. If the
route cannot stream tool-call deltas, Q6 reopens and T4's provider-facing half is rewritten;
its Pi-facing half and tests survive either way. Added to Q7 as the cheapest paid unblock.

## D33 — Restarted T4 to stop it hand-rolling a third adapter
The review's defect table says T4 "ignores existing vendored assets": `vendor/pi-v0.84.4/index.ts`
already exports `streamSimple`, `createAssistantMessageEventStream` and
`createGatewayBindingFetch`. The first brief pointed only at `createAssistantMessageEventStream`,
so the worker could have written a third adapter beside two that already exist.
Killed at ~4 minutes (no commits) and re-dispatched with: read all three helpers first and justify
the choice in the report; treat the task as "add a streaming interface across route -> facet -> RPC"
(size L, the roadmap understates it); and keep the design able to survive the opposite answer on
whether `{ stream: true }` yields incremental TOOL-CALL fragments, since that fact needs a paid call
and Q7 is unanswered.
Same trade as D30: a few minutes of rework now beats reworking a committed design later.

## D34 — Two design decisions the review says must not be left to a worker
Recorded so the reports can be judged against them rather than accepted:
- T2 acceptance 4 (already-ready candidate) — reviewer's answer: "already-ready candidate returns
  current status; no implicit re-preparation". T2 is running without this instruction. Check its
  report; if it chose otherwise, require the change.
- T5 acceptance 3 offers "durable thread identity OR monotonic concurrency version" — two designs.
  Reviewer says pick durable thread id. T5 runs on opus-5 (D26) so it can decide, but the report
  must justify the choice against that recommendation.

## D35 — B8: the paid preconditions the owner must set before ANY paid task runs
The review lists eight tasks that spend money or touch the owner's accounts: T1, T3, T4, T6, T8
(an R2 DELETION lifecycle rule on a real bucket), T9, T10, T12 (full deploy plus publishing a
recording — the only step with irreversible DISCLOSURE).
It names preconditions that are currently unwritten: a NAMED non-production account or a
run-prefixed environment so no resource the owner cares about is overwritten; a spend cap or
per-task probe budget with "stop on first paid failure and record" (only T1.6 has that today);
and disposable GitHub repositories under a throwaway owner for every clone or push test.
Folded into Q7 so the owner answers once, precisely, instead of per task.

## D36 — Delegate the roadmap revision instead of hand-editing 33 KB
The reviewer's own summary says the structural defects cost "six roadmap edits, perhaps thirty
minutes of work ... Make them first." Later waves must dispatch from a corrected document, not from
one whose known defects live only in a separate review file that a worker will not read.
Dispatched an opus-5 documentation worker to produce `.audit/v0/roadmap-v0.approved.md` from
roadmap-v0.md + the review + E1-E8 + binding decisions D24-D35. It writes exactly one file, touches
no source, and cannot conflict with the four code workers now running.
Its brief forbids the two failure modes that matter: weakening an acceptance criterion to make it
easier, and adding scope beyond the cut line in goal.md.
The dispatcher stays the judge — `dispatch_task` will point at `roadmap-v0.approved.md` only after
the diff is read and accepted.

## D37 — Dispatcher bug found and fixed: fire-and-forget cleanup raced the new worktree
T4's restart (D33) produced NO worktree and the worker died with `spawn /bin/sh ENOENT` after four
gate attempts, having read nothing and written nothing.
Cause was mine, not the worker's: the restart cell called
`bash('git worktree remove ... ; git branch -D ...')` WITHOUT awaiting it, then immediately called
`dispatch_task`. `bash()` returns a handle, so the cleanup and the new `git worktree add` ran
concurrently and the cleanup destroyed the directory the dispatch had just created. The worker then
`cd`-ed into a path that no longer existed.
Fix applied: await the cleanup, verify `git worktree list` and `git branch --list "work/*"` are
clean, then dispatch. T4 re-dispatched with the same corrected brief.
Lesson recorded because it is a general trap in this harness: `bash()` is non-blocking by design, so
any cleanup whose completion a later step DEPENDS ON must be awaited. Fire-and-forget is correct
only for genuinely independent work.
The two autonomous gates did their job here: the worker could not report success, and the failure
was loud and diagnosable in `/tmp/cf-stumble-v0/run-T4.log` rather than silent.

## D38 — Judge reports with falsifiable checks, not prose
Every worker writes its own report and grades its own acceptance criteria. That is the one place a
truthful-looking run can still be wrong. Built `.audit/v0/acceptance-checks.{md,json}` plus an
`audit(task_id)` runner: crude shell assertions derived from the CONFIRMED evidence (E1, E2, E5,
E7) and the review's B2 items, run against the worktree without reading the worker's prose.
They cannot prove a task is done. They can prove it is NOT done, which is the failure mode that
matters here. A green board still requires reading the report and the diff.
First run, mid-flight: T2 4/4, T1a 4/5, T5 3/5 — and T5's two failures are exactly the ones its
brief called the point of the task (delete the unfenced variants; give `WithLease` callers), so the
checks are discriminating rather than vacuous.

## D39 — Heartbeat instruction rewritten to match reality
The original heartbeat still said "send roadmap-v0.md to gpt-5.6-sol for review, then dispatch
wave 1" — all of which is done or superseded. A stale heartbeat is worse than none: a future turn
would have re-dispatched finished work.
Rewritten to the actual remaining pipeline, in order:
1. Detect finished workers by `pgrep -f wt/<id>` plus the report file, then run the OBJECTIVE checks
   and read the diff. Never accept a report on its word.
2. Merge accepted branches in the collision-safe order T1a -> T5 -> T2 -> T4, gating with
   `pnpm verify` between EVERY merge. A red merge is reset, not repaired in main.
3. Dispatch T3 as soon as T1a is merged — the reviewer's reordering, which removes the wave-0
   serialization point without waiting for the paid gate.
4. After 05:57, run review round 2 on `openai-codex/gpt-5.6-sol` medium against the approved
   roadmap, as the owner originally asked.
Interval tightened to 15 minutes because four workers are now in flight.
Carries forward the two traps this run hit: workers are shell-outs, not RLM children (D8), and any
cleanup a later step depends on must be awaited (D37).

## D40 — My objective checks were wrong twice; fix the CHECK, not the work
Two of the acceptance checks failed against work that was actually correct.
- T1a: the check ran `ls scripts/ tools/` and missed `scripts/probe/clean-build.sh` because it did
  not recurse. T1a now passes 5/5.
- T5: the checks asserted an IMPLEMENTATION SHAPE I had assumed from E2 — "the unfenced `finishTurn`
  is deleted" and "`WithLease` now has callers". T5 did something better: it collapsed the duplicate
  pair entirely. There is now ONE method set in which the lease is mandatory —
  `startTurn` returns `ThreadLeaseResult`, `finishTurn(project, messages, now, leaseId)` and
  `abandonTurn(project, leaseId)` both REQUIRE the lease, `project-threads.ts` serializes `leaseId`
  out to the client, and no `WithLease` symbol survives. `expectedRevision` is gone from
  `finishTurn`, which is exactly what criterion 3 asked for: do not admit a write solely because a
  numeric revision matches.
Rewrote the T5 checks to assert the PROPERTY (finish and abandon require a lease id; no unfenced
overload survives) rather than the shape. T5 now passes 7/7.
Lesson: an objective check must encode the required property, never a presumed diff. A check that
encodes the reviewer's imagined implementation punishes a better one. This is the same failure mode
as a worker grading itself, just relocated to the judge.

## D41 — Wave 1 first commits landed
- T2 `119a7ce refactor(control): apply generation requests directly (ADR-0030)` — 36 files,
  +386/-663. Objective checks 4/4.
- T5 `df094f3 feat(threads): require the admitting lease to finish or abandon a turn` — 10 files,
  +509/-147, including a new 173-line `test/supervisor/threads/turn-lease.test.ts`.
  Objective checks 7/7 after the correction above.
Neither has written its report yet, so neither is accepted. The gate requires `pnpm verify` AND the
report file; both workers are still running.

## D42 — T5 and T2 ACCEPTED and MERGED to main
Both were judged on evidence, not on their reports.
- Read both reports in full. Both are honest and disciplined. T2 explicitly declined to edit files
  outside its scope list and left the `feature-map.md` reconciliation to T12. T5 declined to build
  the HTTP turn surface (E6 says none exists; that is T9's work) and confirmed the T1 dependency
  was wave ordering only — matching D28 independently.
- Ran `pnpm verify` MYSELF in each worktree rather than trusting the claim: T2 94 files/639 tests,
  T5 94 files/653 tests, both green.
- Objective checks: T2 4/4, T5 7/7.
Merged in the collision-safe order with the gate between every step:
- `567d25e merge(T5)` -> `pnpm verify` green, 653 tests.
- `c3e0d5a merge(T2)` -> `pnpm verify` green, 650 tests.
The predicted `test/supervisor/threads/threads.test.ts` collision auto-merged (T5 changed 80 lines,
T2 changed 4). Verified afterwards that nothing was lost: `turn-lease.test.ts` still present,
`leaseId` still referenced in the shared threads test, `control/journal.ts` gone. Re-ran both audits
against MAIN, not the worktrees: still 4/4 and 7/7.
Test-count movement is explained, not hand-waved: baseline 93 files/642 tests -> 650 tests on main.
T5 adds 11 (the new lease test file), T2 removes 3 net (journal-replay tests deleted, a fresh-schema
test and a malformed-body test added).

## D43 — Two of the five confirmed blockers are now closed
E2 (lease fencing was dead code) is fixed on main: the duplicate method pair is gone, the lease is
mandatory on finish and abandon, and `startTurn` hands the id to the client. Goal criterion 6's
fencing half is now implementable and tested.
The ADR-0030 cleanup is done: no request ids, no fingerprints, no `generation_control_journal`,
epoch checks intact. That closes the largest item the previous session deferred.
Still open: E1 (T1a running), E3, E4, E5/E7 (T4 running), E6 (needs T9).

## D44 — E1 is closed, and I proved it myself
T1a committed `4bdd6dc`. Rather than read its report and accept, I ran the probe: `pnpm verify`
green (94 files, 650 tests) and `scripts/probe/clean-build.sh` exit 0, producing TWO byte-identical
module maps (sha256 `387ed749...`, 905270 bytes) from independent clean `git archive` checkouts.
The same operation previously failed with five `Could not resolve "@cf-stumble/pi"` errors.
Recorded as `.audit/v0/evidence/E10-e1-fixed-and-proven.md`, including the cold-store measurements
(13 s per build, 491M build dir, 598M cold store) that B2 Gap 3 demanded and that T1b needs to set
the cold-build timeout. Those are now measured, not guessed. The 598M cold store is a container
disk-budget warning for T1b.
T1a is NOT yet merged: its report has not been written, and the acceptance rule is verify + objective
checks + a read report. Three of four hold; I wait for the fourth rather than relax the rule.

## D45 — The approved roadmap landed
`.audit/v0/roadmap-v0.approved.md`, 77 KB, with a "Changes from roadmap-v0.md" table where every
edit names the objection, defect row, collision row, coverage row, evidence note, or decision that
caused it. Splits applied: T1->T1a/T1b, T3->T3a/T3b, T6->T6a/T6b, T12->T12a/T12b. The fictional
`Dependencies: T1` on T2, T4 and T5 is gone. Coverage gaps closed, including the owner-only Access
policy (criterion 2) and the Pi-path diff (criterion 4).
Future dispatches point at this file. `dispatch_task` already defaults to it.

## D46 — T1a ACCEPTED and MERGED. Three of four wave-0 tasks are done.
`d1f2412 merge(T1a)` on main. `pnpm verify` green: 96 test files, 658 tests (up from the 93/642
baseline). Objective checks 5/5 against MAIN.
The report is the best of the three. Every container precondition is labelled with what settles it
rather than asserted:
- Node: SETTLED LOCALLY — container Node 22.23.2 satisfies every `engines` entry; the tightest are
  `^20.19.0 || >=22.12.0`, `>=22.0.0` and vitest's range. It also notes the local Node 26.7.0 run is
  MORE permissive than the container, so it cannot disprove a Node-22-specific failure. That is the
  kind of honesty that makes a report usable.
- Native scripts: SETTLED LOCALLY — `esbuild` and `workerd` ship prebuilt platform binaries the
  lockfile names for linux-x64, and `koffi` only serves the Hegel tests, never a harness build. So a
  build container needs no compiler, node-gyp, CMake or Python.
- Registry: BLOCKED — the existing paid evidence is one `pnpm add is-odd@3.0.1`. That proves one
  small package once; it does not prove 186 packages and ~145 MB compressed.
- A residual risk nobody had raised: `package.json` pins `"packageManager": "pnpm@11.18.0"`, so a
  container running pnpm 11.24.0 will DOWNLOAD pnpm 11.18.0 from the registry before `pnpm install`
  even starts. That network dependency has never run in a container.
The criteria that need money are marked BLOCKED, not passed, exactly as instructed. No paid call was
made anywhere tonight.

## D47 — Scoreboard against the goal's ten done-criteria
Closed or advanced tonight:
- Criterion 6 (fencing half): E2 fixed, lease mandatory, tested. MERGED.
- Criterion 8 (journal half): ADR-0030 cleanup complete. MERGED.
- Criterion 7 (local half): two clean builds produce byte-identical maps. MERGED. The Computer half
  is T1b, blocked on Q7.
Untouched: criteria 1, 2, 3, 4, 5, 9, 10. Criterion 4 still needs an HTTP turn surface that does not
exist (E6). Criterion 3 still needs the workspace migration (E3) and the catalog type change (E4).
v0 is not close. Three real blockers are gone and the plan is now evidence-backed, which is what one
night could honestly buy.

## D48 — T3a dispatched off MERGED main, not the old base
Base for T3a is `d1f24126` (main with T1a, T2 and T5 merged), not `d6ff238`. A worker branching
from the stale base would have re-created the journal and the unfenced thread methods, and its merge
would have silently reverted tonight's work.
Rule for every later dispatch: branch from current main, not from the run's original base.
T3a is the reviewer's recommended reordering (D29 / review section 4): start T3 as soon as T1a lands
rather than waiting for T1b's paid Computer gate, which Q7 blocks. That removes the wave-0
serialization point entirely.
Its brief carries E3's three encodings with file and line numbers, the "one seam not two constants"
instruction for `PROJECT_ROOT` (the facet copy is the path-escape guard, so drift is a security
divergence), the `supervisor.ts:87` catalog hand-off to T6a, sole ownership of the
`src/access/index.ts` widening plus the owner-only policy that closed coverage gap 2, the
`rm -rf ${directory}` race T1a handed over in writing, and the cut-line guard "no alarm, no
scheduler, no queue framework".
It must re-run BOTH gates before claiming success: `pnpm verify` and `scripts/probe/clean-build.sh`,
reporting the module-map sha so a regression in tonight's proof cannot pass unnoticed.

## D49 — Validated the approved roadmap AFTER dispatching from it (loop closed honestly)
D36 said the dispatcher stays the judge and would read the revision before dispatching from it.
I dispatched T3a from it first and validated afterwards. That was out of order; recording it rather
than hiding it. The validation passed on the three things that mattered:
1. **Criteria strengthened, not weakened.** T3a gained criterion 2 — an owner-only Access policy
   with local rejection tests for unauthenticated, wrong-identity and caller-supplied-tenant
   requests — which closes coverage gap 2. Criterion 3 now says the repository-relative root gets
   **one owning module** that both `resolve.ts` and `execution-env-paths.ts` read, so the two
   `PROJECT_ROOT` definitions cannot drift. That is E3's point, written into the plan.
2. **B3 is fixed.** T7 is retitled "Finish Pi instruction, compaction, **diff**, and turn-event
   integration", mentions the diff 11 times, and covers the `vendor-pi` regeneration rule 5 times.
   The task that would have deleted the only diff-producing code now owns producing one.
3. **Cut-line guard present.** "No alarm, no scheduler, no queue framework" sits in T3b criterion 4,
   not T3a. My first check looked only inside T3a's section and wrongly read it as missing. T3b is
   the concurrency experiment where a scheduler would actually creep in, so that placement is
   better than the one I asked for.
Test ownership is enumerated per task, so T3a explicitly cannot reach `capabilities.ts`,
`route-stream*`, `workers-ai-adapter*` or `test/model-route.test.ts` — the exact collision review
section 4 predicted between T3 and T4.
My running T3a brief carries the guard independently, so nothing was lost by the ordering mistake.

## D50 — Checked whether T4 was stuck; it is not, and I left it alone
T4 had run ~16 minutes with zero file changes, which looked like a hang. `pgrep -f "wt/T4"` matched
only the shell wrapper (0:00 CPU), because the prime-agent child's command line does not contain the
worktree path — a false negative in my own liveness check.
Inspected its session file instead: 118 messages, last write 26 s earlier, and the final tool result
is a read of `vendor/pi-v0.84.4/packages/agent/src/agent-loop.ts`, specifically
`streamAssistantResponse` and the `StreamFn`/`transformContext` path. That is exactly the right
thing to be reading before writing a streaming adapter, and exactly what its brief ordered: evaluate
`streamSimple`, `createAssistantMessageEventStream` and `createGatewayBindingFetch` BEFORE writing
anything.
Decision: no intervention. A worker reading deeply on an L-sized task is not a stalled worker, and
interrupting it would repeat the churn of D33 for no reason.
Correction for later liveness checks: `pgrep -f "wt/<id>"` finds the wrapper, not the agent. Use the
session file's mtime and message count as the real progress signal.

## D51 — Re-ran the clean-build probe on MERGED main, not just on T1a's branch
`pnpm verify` passing after a merge does not prove the clean-build path still works: the gate runs
`build:pi` first and so hides exactly the fault E1 described. So I re-ran
`scripts/probe/clean-build.sh` on `d1f2412` with all three merges in place. Exit 0, two identical
maps, sha256 `387ed749...`.
The map is byte-identical to the one from T1a's own commit, even though T2 rewrote generation
control across 36 files and T5 rewrote the thread store. That is correct: the map covers the
generation-0 FACET, while the Supervisor is immutable host code. Recorded as E11, because it is the
first empirical evidence that the host/harness boundary v0 exists to prove behaves as ADR-0034
documents.
General rule this establishes: after every merge, re-run the PROBE as well as the gate. A gate that
hides the fault it is meant to catch is not a regression test.

## D52 — T1a wrote its findings into TRACKED docs, and surfaced two new container risks
Checked what the merges changed under `docs/`: T1a added 60 lines to
`docs/agents/design/computer-integration.md` — a "Harness build preconditions" section and a
"Clean-build checklist" — and T2 removed the now-stale gap note from ADR-0030. So tonight's evidence
is not trapped in gitignored `.audit/`; the durable parts are tracked where `docs/agents/domain.md`
says they belong.
That section carries two risks nobody had raised, both cheap to test and both likely to fail:
- `tar` is NOT in the recorded container toolchain, yet the checkout step runs `git archive` and
  `tar`.
- Outbound HTTPS to `github.com` is not covered by the recorded network evidence, yet provisioning
  runs `git clone --no-checkout` and `git fetch`. The recorded evidence covers the npm registry only.
It also quantifies the install properly: 186 packages, ~145 MB compressed, ~496 MB unpacked, with
`@cloudflare/workerd-linux-64` alone 38 MB / 152 MB, and recommends a 900 s cold-build timeout until
a paid run measures it.
Folded all of it into Q7 as a concrete seven-item probe list, so the owner's approval buys a
measurement plan rather than an open-ended spend.

## D53 — E12: verified the criterion-6 credit gap, and found a trap in the obvious fix
The review noted `eligibility.ts:140` credits any `body-completed` under 400. Verified on merged
main and traced its consumers: `isCreditedTurn` feeds `GenerationEligibility` at line 108, which is
ADR-0031's relay-facts-decide-known-good machinery.
So one predicate currently answers two different questions — generation health (an HTTP fact, which
is correct there) and completed-real-turn credit (a durability fact, which criterion 6 requires and
the predicate cannot express).
The trap: tightening `isCreditedTurn` to require a saved thread would silently change generation
eligibility, so a thread-save failure could make a healthy harness generation ineligible. T9 must ADD
the durability requirement without collapsing the two concepts, and must say in its report which
question each predicate answers.
This is exactly the kind of defect that a worker following the review's one-line instruction
("add eligibility.ts to T9's scope") would have implemented wrongly. Recorded as E12 so T9's brief
carries the distinction.

## D54 — Heartbeat is active but has never fired; the run has been driven by goal turns
`rlm_heartbeat.list()`: label `cf-stumble-v0`, status active, every 15m, next run 03:16 local,
**run_count 0**, no error.
So the safety net is armed but unproven. Everything tonight has been driven by goal-context turns,
not by the heartbeat — plausibly because delivery mode is `follow_up` and the session has been
continuously busy, so each scheduled prompt was superseded before it ran.
Risk this creates: if goal turns stop while T3a and T4 are still running, and the heartbeat still
does not fire, the workers will finish and nothing will merge them. Their branches and reports would
sit intact in `/tmp/cf-stumble-wt/` and `.audit/v0/tasks/` — recoverable, but not automatic.
Mitigation already in place rather than new work: `STATE.md` is a complete resume document. It names
main's exact commit, the merge order, the gate commands, the liveness signals, and the six operating
rules. Any later turn, heartbeat or human, can pick the run up from that file alone. That was the
point of documenting first.
No action taken. Forcing the heartbeat is not possible, and adding a second one would duplicate work
if both fire.

## D55 — Deliberately holding: conserve the dispatcher's context for the merge work
Both workers are progressing (T4 implementing after its research phase, T3a's session still growing).
Nothing is dispatchable: T6a and T7 wait on T3a and T4, and T1b, T3b and T8's substance wait on Q7.
The audit has produced twelve evidence notes; the marginal value of a thirteenth is now low, while
the remaining work that ONLY the dispatcher can do — run the objective checks, read each report and
diff, merge in the collision-safe order, gate between every merge, and re-run the clean-build probe
after each one — still lies ahead and costs context.
So the correct action this turn is to add nothing. Manufacturing further investigation would trade
context that the merge step needs for findings nobody is waiting on.
This is recorded because "do nothing" is a decision, and an unexplained quiet period in this log
would otherwise look like a stall.

## D56 — T3a ACCEPTED and MERGED `43e7ac8`; four of seven faults now closed
Judged on evidence: report read in full, `pnpm verify` run by me (101 files, 681 tests),
objective checks, and `scripts/probe/clean-build.sh` re-run AFTER the merge (two identical
maps, sha256 `d88c8204...`).
New tests on main name the work: `workspace-names.test.ts`, `workspace/layout.test.ts`,
`workspace/harness-build-isolation.test.ts`, and `supervisor/artifacts/build-concurrency.test.ts`
— the last covering the `rm -rf ${directory}` same-commit race T1a handed over in writing.
Two things it did right that a weaker worker would have faked:
- Left `supervisor.ts:87`'s catalog as a WRITTEN INTERFACE for T6a
  (`new ProjectThreads(ctx.storage, catalog)`, same optional argument on `streamProjectTurn`)
  instead of wiring a placeholder that would prove nothing.
- Stated its own limit: the local clean-build result is a PRE-CHECK, not goal criterion 7.

## D57 — T3a corrected a false premise that three planning layers carried
The roadmap, inherited from the review's coverage map and repeated in my own brief, said criterion 2
"has no owner-only Access policy anywhere in the codebase today". FALSE at the base commit, and I
verified the correction myself: `src/access/index.ts:48-65` reads `CF_ACCESS_OWNER_SUB`, refuses any
other identity with `not-owner`, fails closed on a blank subject, and `test/access-owner.test.ts`
covers it. It landed in `2f3a7f7`, before this run.
What T3a actually added is narrower and better: `AccessRequestResult.ok` now carries
`scope: { identity, audience }` so T6a consumes the verified scope rather than deriving a tenant,
and `authenticateAccessRequest` refuses caller-supplied `tenant`/`identity`/`audience`/`workspace`/
`supervisor` fields BEFORE the token is parsed — proved by driving the real `worker.fetch` and
spying on `env.SUPERVISOR.getByName`, the first call that names anything.
Lesson: the oracle, the adversarial reviewer, and the dispatcher all carried the same false premise.
The worker that had to implement it checked and found it wrong. Verification at the point of work
caught what three planning layers missed — which is an argument for briefs that cite file and line
so a worker CAN check, rather than briefs that assert.

## D58 — T4 ACCEPTED and MERGED `638890e`; wave 0/1 complete
`pnpm verify` 103 files / 698 tests, objective checks 5/5 against main, clean-build probe green with
sha `8e821d86...` (moved from `d88c8204...`, correct: T4 changed `route-stream.ts` inside the facet,
so E13's property held for a second independent harness change).
Its report answered the question D33's restart existed to settle, with file evidence:
- `createAssistantMessageEventStream` — USED, it was already the right container.
- `createGatewayBindingFetch` — rejected, needs an AI Gateway resource; `wrangler.jsonc` configures
  only a plain `ai` binding.
- `streamSimple` — rejected for the RIGHT reason: it drives the OpenAI SDK against an HTTPS endpoint
  with an API key, so reusing it would reintroduce exactly the credential/endpoint surface the route
  exists to remove and `FORBIDDEN_FIELDS` blocks. Pi's own `cloudflare-workers-ai` provider has the
  same flaw (REST + `CLOUDFLARE_API_KEY`, not the binding).
So its minimal SSE parser is a justified third adapter, not a redundant one. The restart was worth
it: either answer would have been informative, and this one is defensible.
Blocker stated correctly: whether `tool_calls` arrive incrementally needs a real Workers AI call, and
the parser is tested to be correct under EITHER answer.

## D59 — Wave 2 dispatched: T6a and T7, off merged main
First wave that could not have started earlier — both dependencies cleared only when T3a, T5 and T4
merged. Each brief leads with the confirmed traps rather than the task text:
- T6a: E4's tuple TYPE, E9's zero credential path, T3a's two written interfaces (consume
  `scope: { identity, audience }`; supply the catalog to `new ProjectThreads(ctx.storage, catalog)`),
  and the correction that owner-only Access already exists so it must not be re-added.
- T7: the three traps — `git_diff` is not a duplicate and its deletion breaks criterion 4;
  `vendor/index.ts` is generated and gate-checked so it must use `--refresh-generated` and never
  `--update`; and compaction may be unreachable anyway because `ROUTE_MODEL.contextWindow` is 0.
Both must re-run `pnpm verify` AND the clean-build probe and report the sha.

## D60 — T7 ACCEPTED and MERGED `54b02e2`; the competing turn definition is gone
`pnpm verify` 105 files / 698 tests, objective checks 5/5 against main, clean-build probe green with
sha `18cea22b...` (moved from `8e821d86...`, correct: T7 changed facet code — E13 holding for a
third independent harness change).
It deleted the legacy buffered path entirely (~1470 lines, `turn.test.ts` removed), which the
architecture critique named as a competing turn definition.

## D61 — E7's compaction guess was WRONG, and T7 proved it from Pi's source
I flagged the risk that `ROUTE_MODEL.contextWindow: 0` makes compaction UNREACHABLE. T7 read
`vendor/pi-v0.84.4/packages/agent/src/harness/compaction/compaction.ts:247-250`:
`return contextTokens > contextWindow - settings.reserveTokens`. No division, no fallback. With a
zero window and the default `reserveTokens: 16384` the threshold is -16384, so an EMPTY conversation
already exceeds it. The zero window does not disable compaction — it makes it ALWAYS TRUE, so the
agent would compact on every turn. Two tests now pin `shouldCompact(0, 0, ...) === true`.
Its fix respected the scope boundary: `model-route.ts` and `route-stream.ts` belong to T4, and
`ROUTE_MODEL`'s comment forbids inventing values, so T7 declared an explicit harness budget (64,000
tokens, `keepRecentTokens` 8,000) and passed it to Pi's OWN `shouldCompact` — decision rule Pi's,
bound the harness's, stated the same way `MAX_MODEL_CALLS` is. It then named where the honest number
belongs: the route owns the model id, so the route can publish the pinned model's documented window
without inventing it. Follow-up recorded, not silently guessed.

## D62 — Third objective check that encoded my assumption instead of the requirement
My T7 check asserted a diff tool in `pi-agent-turn.ts`. It failed. But the brief ALLOWED either a
tool or `bash` + `git diff` proven through a tool-result frame, and T7 took the second route:
`turn-policy.ts:13` instructs "Run `git diff` with the bash tool when the user asks what changed",
`turn-policy.ts:31` names goal criterion 4 and the forty-line diff case, and
`test/facet/generation-0/turn-diff.test.ts` drives `bash` with `command: "git diff"` and checks the
frame at a caller-chosen size. That keeps the four-tool surface AND proves the byte budget.
After T1a (path), T5 (method shape) and now T7 (tool vs prompt), the pattern is unambiguous:
an objective check must assert the REQUIREMENT, never the implementation the reviewer imagined.
Each time, the worker's alternative was better than mine.

## D63 — T9 stalled when the host slept; work preserved, not discarded
Between 04:43 and 08:10 the host slept. T9's wrapper process survived but its agent session last
wrote at 04:43, so it was dead in practice with 18 files of uncommitted work.
Preserved rather than discarded: committed as `044bb6e wip(T9)` on top of its own genuine first
commit `56971c4 refactor(workspace): delete the unreachable legacy execution path`, and the branch
renamed `work/T9-stalled`.
Re-dispatched T9 fresh off the same base, and told it the stalled branch exists — explicitly as a
HINT, not as correct: nothing in it passed `pnpm verify` and no report justified it. Cherry-picking
is allowed only if the result is verified. That keeps the option without importing unverified work,
which is the same rule applied to every worker report tonight.

## D64 — Codex quota reset at 05:57; the sol review the owner asked for is finally running
`openai-codex/gpt-5.6-sol` answers again (probed). D17 promised a second-opinion review once the
window reset, and this is it — round 2, against the MERGED state rather than the plan.
Its brief is deliberately different from round 1. Round 1 reviewed a roadmap; round 2 reviews seven
merged commits and seven worker reports that are CLAIMS. It is told to spot-check the criteria that
would be easiest to fake or costliest if wrong, to check whether the hand-resolved merge conflict in
`fresh-thread.test.ts` dropped anything, to judge whether T7's `bash` + `git diff` answer really
satisfies goal criterion 4 (its own round-1 objection B3), and to look for the inverse of tonight's
pattern: places where a worker's answer was accepted TOO easily.

## D65 — Codex quota died mid-review; round 2 reassigned to opus, brief unchanged
The 08:11 probe returned `SOL_OK`, so `gpt-5.6-sol` looked available. The real review then failed
immediately: "You have hit your ChatGPT usage limit (plus plan). Try again in ~6488 min" — about
4.5 days, so this is a WEEKLY cap, not the 5-hour window that reset at 05:57. A one-token probe is
therefore NOT evidence that a real run will fit; only the real run is.
D17's promise of an independent second opinion cannot be kept before roughly Sep 9. Options were to
wait (leaves seven merged commits unreviewed for days), skip (loses the check entirely), or reassign.
Reassigned to `claude-opus-5` high with the brief UNCHANGED, plus one instruction: round 1 reviewed a
ROADMAP, round 2 reviews MERGED CODE, so do not repeat round-1 objections that the code may already
have answered — verify whether it did. Same reviewer model, genuinely different artifact.
This is weaker than a cross-vendor second opinion and the morning brief says so plainly. Marked in
`questions.md` as still-open: re-run the sol review when the weekly cap resets.

## D66 — T9 merged as `eb7c575`; the review's headline objection was that it was still unmerged
Third attempt (T9b) finished at 08:35. Verified by me, not accepted on its report: `pnpm verify`
116 files / 829 tests (from 113/797), `git merge-tree` clean, and after merging, the gate green
again plus two identical clean builds. The probe sha moved `18cea22b...` -> `313ddf26...`, which is
CORRECT here and would have been a red flag otherwise: T9b changed facet code, so the module map
must move. D51's rule is that the sha moves only when facet code changes, not that it never moves.
T9b answered both things its brief demanded, in the report's own table:
- `isCreditedTurn` was RENAMED `servedSuccessfulResponse` (logic unchanged) — "is this generation
  known good?", a transport fact about one relay attempt.
- `earnsCompletedRealTurnCredit` is NEW — "did one real turn complete?": Pi terminal success AND a
  committed thread save AND an attempt still delivering. Criterion 6's durability fact.
That is exactly E12's requirement: add the durability question without collapsing it into the HTTP
one. Cut line respected: "No reconnect, resume, background turn, steering, alarm, scheduler, or
queue."
Deleted `work/T9-stalled` and `work/T9-del` per the review's item 3, so the next reader cannot
mistake two dead attempts for pending work.

## D67 — the round-2 review found a real hole in T7 that D62 had recorded as closed
Verdict SOUND WITH FIXES. It independently re-ran the gate and the clean-build probe rather than
trusting the brief, and confirmed the hand-resolved `fresh-thread.test.ts` conflict lost nothing
(test-case count 4 at base, 6 after T5, 6 at every merge through HEAD; T5's 7 lease tests all
survive T6a's 102-line rewrite with identical names).
Its sharpest finding contradicts my own D62. `test/facet/generation-0/turn-diff.test.ts:41-56`
hand-feeds stdout to a `FakeProjectCapability`; no git ever runs. The only thing that produces a
diff in production is one sentence in `GENERATION_0_SYSTEM_PROMPT`
(`src/facet/generation-0/turn-policy.ts:13`). So criterion 4's diff is a PROMPT INSTRUCTION, not a
guarantee — and Q6 pins a flash model at `reasoning_effort: "low"`, where skipping one clause of a
five-clause prompt is ordinary, not a tail risk. The test "would still pass with `git diff` renamed
to `cat`".
I recorded D62 as "the worker's alternative was better". The review's correction: the alternative
proved a DIFFERENT, EASIER property, and I relaxed the check to match it. D40 was applied correctly
to T1a and T5 and applied to the wrong half on T7. Logged as a new task rather than argued with.
Also corrected: the clean-build probe passes `PATH="$PATH"`, so both builds share the host toolchain
— it is a regression guard for E1, NOT evidence for criterion 7's two Computer builds.

## D68 — T13 merged `3a77907`; the diff is now the harness's, and the test finally proves it
Verified by me, not accepted on report: `pnpm verify` 116 files / **834** tests (from 829), two
identical clean builds, probe sha `313ddf26...` -> `e9c3008e...` (facet code changed, so it must
move), and three property checks run by hand:
- `grep -rn "Run .git diff" src/` -> ABSENT. The prompt sentence D67 identified is gone; the prompt
  now tells the model the harness shows the diff so it should not spend a tool call on one.
- `facet-turn.ts:67` publishes `readWorkspaceDiff(env, signal)` whenever the turn emitted a
  `tool-start` for `bash`, `edit`, or `write` — regardless of what the model said.
- the new `test/facet/generation-0/git-diff-exec-backend.ts` SNAPSHOTS file bytes at `commit()` and
  computes a real unified diff against current bytes. The old test would have passed with `git diff`
  renamed to `cat`; this one would not.
It also added ADR-0040 and listed its own residual risks rather than hiding them: `git` in a REAL
workspace is unverified because nothing in this repo spawns a child process (blocked on Q7), and an
untracked new file is invisible to `git diff HEAD` (a harness limit, deliberately outside the cut
line, and criterion 4's demo turn edits an existing file).

## D69 — T10 was dispatched before T13 landed, so it cannot know about the new frames
T10 started at 08:49 off `eb7c575`; T13's `diff` and `diff-unavailable` frame kinds landed at 09:09
in `3a77907`. Workers are shell-outs, not RLM children (D8/D50) — there is no way to message a
running one, and fan-in is the filesystem. So T10 will render every frame kind EXCEPT the two newest.
Not treated as a T10 failure: it is a scheduling consequence of my own dispatch order. The fix is a
small follow-up after T10 merges, to render `diff` and `diff-unavailable`, and the lesson is to
dispatch a consumer only after its producer has landed, or to accept a known follow-up when running
them in parallel for speed.

## D70 — plan item 1 confirmed done, main pushed; the gate on hp is 117 files / 842 tests
Verified rather than accepted: `9ac4b9c merge(T14)` is on local main, `pnpm verify` green in 63.8s
with **117 test files / 842 tests**. Note the T14 brief's "118 files / 841 tests" figure was wrong
in both halves; 117/842 is the measured baseline on this box and every worker brief now carries it.
`git push origin main` moved origin `7818f8d..9ac4b9c`. `work/T14` no longer exists locally, so the
`f00eaac` commit reaches origin through main and through the pre-existing `origin/work/T14`.

## D71 — the remaining five plan items run as five parallel RLM children, one worktree each
The previous run's workers were `prime-agent` shell-outs with no way to message a running one
(D8/D50), which is what produced D69's dispatch-order fault: T10 could not learn that T13 had
landed. On this box the workers are RLM children, so a running worker CAN be sent a correction and
CAN be observed mid-flight. That removes the reason to serialize dependent work.
Five worktrees at `/home/aditya/wt/T15..T19`, all based on `9ac4b9c`, each with its own
`node_modules`, were already prepared. Mapping from `review-sol-consolidated.md`'s ordered plan:

| id | plan item | scope | conflict surface |
|---|---|---|---|
| T15 | 2 | one absolute turn deadline, propagated cancellation, one attribution read | `turn-run.ts`, `turn-stream.ts`, `supervisor.ts`, `facet-turn.ts` |
| T16 | 3 | the credit predicate | `turn-settle.ts`, `eligibility.ts`, `relay/attempt.ts` |
| T17 | 4 | the diff proven over a real Git repository | `test/facet/generation-0/**`, vitest config |
| T18 | 5 | land or retract `pnpm harness:browser` | `tools/browser-harness/**`, `package.json`, `AGENTS.md` |
| T19 | 6 | cover `ModelRoute.runStream` | `src/model-route*.ts`, its tests |

T15 and T16 are the one adjacent pair, both around the turn lifecycle. Rather than serialize them I
partitioned the files in the briefs: T16 is told to keep its diff out of `boundedStart`,
`streamAdmittedTurn` and `runProjectTurn`'s ordering and to hand anything it needs there to T15.
Merge order is mine and stays serial: gate green on the merged tree before each merge, then the
clean-build probe, exactly as D51 requires. Briefs are at `.audit/handoff/v0-hp/prompt-T1[5-9].md`.
Every brief carries the mutation-proof requirement and the reviewer's three demonstrated green-under-
mutation results, because that is the finding this whole round exists to answer.

## D72 — each brief states the fault as already-verified evidence with file and line, not as a hunt
The four sol reviews had already located every fault from source. Re-deriving them would spend a
worker's context on work that is done and risks a worker "discovering" a different, easier problem
and fixing that instead — which is exactly how D62/D67 went wrong on the diff. So each brief opens
with a "do not re-derive it" evidence block and states the single condition that ends the task.
T17 and T18 additionally carry an explicit escape hatch: T17 may report that the diff seam needs a
design change instead of producing a second fake, and T18 may retract the advertised command
instead of landing it. Both are told to make that call in the first line of their report. A worker
allowed only to succeed will report success.

## D73 — the clean-build probe on `9ac4b9c` is green and its sha did NOT move, as T14 predicted
Two clean builds, 25s each, identical maps, sha256 `e9c3008e...` — the same sha T13 produced at
`3a77907`. Correct: T14 is page-side only and `src/page/**` is Worker code, not facet code, so it is
not in the module map the probe hashes. A moved sha here would have meant T14 exceeded its cut line.
Recording the reasoning because "the sha did not move" is only evidence when the reason it should
not have moved is stated in advance.

## D74 — the astra review landed at 23:13, was read at 23:20, and it CONFIRMS the plan while
## strengthening three of its items and adding two more
`.audit/v0/review-astra-low.md`, `gpt-6-astra` at low effort. It reviewed the supplied reviews and
the hp brief, not a fresh tree — it says so itself, so its authority is over JUDGEMENT, not over
facts about the code. The owner's standing instruction is to treat it as almost certainly correct.
Its highest-leverage action is a STRENGTHENING of the plan's item 2, not a different item, so no
switch of current work was needed. The five workers were already running; three got live
corrections. That is the payoff from D71's choice of RLM children over shell-outs — the correction
reached T15, T17 and T18 mid-flight and all three acknowledged within minutes. Under the old
shell-out model this review would have arrived too late to change anything and would have cost a
re-dispatch of three tasks.

### Where astra and `review-sol-consolidated.md` disagree, astra wins

1. **Item 2 was under-specified and I had already dispatched it that way.** Sol asked for one
   deadline, propagated cancellation and one attribution read. Astra: "an abort signal alone is not
   the safety guarantee ... Lease checks on new calls do not stop a command already executing."
   Correct, and it exposes a hole in my own brief: I asked T15 to prove "the superseded facet
   stopped writing", which an implementation could satisfy by aborting a signal nothing was blocked
   on. A `bash` tool call already running in the workspace ignores an aborted signal. So admission
   itself must become conditional on the old turn having lost the ability to mutate, and it must
   **fail closed** — refuse the replacement rather than admit it into a workspace an orphan may
   still be writing. Refusing a turn is recoverable; two turns editing one shared tenant workspace
   (ADR-0038) is not. T15's proof test is now specific: an already-running write command that
   SURVIVES the first cancellation request, plus the cancellation-errors and cancellation-never-
   returns paths.
2. **Item 5's option (B) is withdrawn.** Sol offered "land or retract" and my brief preferred
   landing. Astra: "retracting a broken browser command repairs documentation but does not satisfy
   UI acceptance." Criterion 4 is a UI claim and the page has zero runnable UI evidence. Retraction
   is now available to T18 only as a REPORTED BLOCKER, never as a completion.
3. **Item 4 is half a design problem, not only a discipline problem.** Sol read the circular fake as
   a discipline failure. Astra: both, and the design half is that "the turn's diff" has no defined
   meaning. `git diff HEAD` describes tracked changes against HEAD; it is not "what this turn
   changed". It misses an untracked new file, misses an edit the turn itself committed, and includes
   dirt present before the turn began. D68 conceded the untracked-file gap and filed it as "outside
   the cut line" — astra's correction is that it is a CONTRACT to be written down, not a limitation
   that may stay implicit. So T17 now defines the contract first, tests pre-existing dirt, an
   untracked file and an in-turn commit, and treats killing the `cat` mutation as a MINIMUM check
   rather than as proof that the semantics meet criterion 4.

### What astra adds that the ordered plan did not have

4. **The x64 container preflight, dispatched as T20.** "Linux can now test tool availability and
   clean builds locally, without claiming paid Cloudflare evidence." This is the capability that
   justified moving the work to hp and nobody had spent it. It attacks D51/E1 directly: the host
   probe passes `PATH="$PATH"` so both its builds share the HOST toolchain, which makes it a
   regression guard and not criterion 7 evidence. Running the same two builds inside the real pinned
   `ghcr.io/cloudflare/computer-computerd-linux-x64` image is the missing half and pulling a public
   image costs nothing. Explicit boundary written into the brief: local container evidence is NOT
   deployed evidence and must never be recorded as closing criterion 7 or 9 on its own.
5. **The saved-compaction chain, dispatched as T21.** Checked before dispatching rather than taken
   on faith, and the gap is real. `test/facet/generation-0/compaction.test.ts:111` already proves a
   replacement FACET continues from saved compacted context, but it is facet-level: it passes state
   from one `runPiAgentTurn` call to the next. Untested is the product's actual path — compacted
   context saved through the Supervisor's thread store, Supervisor evicted and rehydrated from
   SQLite, a replacement GENERATION activated, conversation continuing across all three. That spans
   criterion 5 and criterion 8. T21 must mutate each of the three hops separately, because one test
   that catches only one hop leaves the other two decorative.
6. **Item 7 moves earlier.** "prepare the criterion-mapped Q7 request now rather than after all six
   fixes." The owner is on a flight; the request should be waiting when he lands, not started then.
   I own this, not a worker.
7. **Criterion 10 splits.** "separate public publication in criterion 10 from private release
   acceptance pending owner approval, while retaining the recording and release artifacts." Today
   criterion 10 bundles making the recording with publishing it to an approved destination, so an
   unanswered publication question blocks an otherwise-complete criterion. I own this edit to
   `goal.md`.

### Where astra says do NOT go, recorded so a later turn does not drift there
No background turns, no automatic recovery, no broader cache policy, no general scheduler, no
architecture rewrite. Known-good POLICY expansion stays outside v0 — but false credit inside
retained code is still in scope, which is exactly T16. And v0 does not shrink: "useful coding, saved
conversation across generation changes, manual rollback, owner isolation, and durable files are the
product, not optional hardening." Unanswered paid approval makes their evidence BLOCKED; it is not a
licence to delete the criteria.

## D75 — Q7 is re-specified as one criterion-mapped request, and hp shrinks it before the owner sees it
`.audit/v0/q7-request.md` supersedes the five Q7 addenda that accreted across the overnight run.
The addenda stay as history but they had started repeating each other, and a request the owner has
to reconstruct from five appended fragments is a request that gets a slow answer.
The re-spec does three things the fragments did not. It maps all 19 measurements to the goal
criterion each unblocks. It separates the rows hp can now answer FOR FREE — nine of them, all the
toolchain and clean-build questions, because the pinned x64 image runs on this box — from the ten
that genuinely need paid budget and a deployment. And it isolates the five decisions only the owner
can make, led by the one that gates everything: a NAME for the disposable environment, since "an
approved disposable paid environment" is not a name and without one a probe can overwrite something
he cares about.
It also offers a subset: rows 10, 13 and 11 (the streaming model probe, the Worker Loader cold path,
Access) are the three cheapest probes that each invalidate a whole task, so approving only those
three unblocks the critical path far more cheaply than approving the whole gate.
Sequencing note: T20 is running now and is expected to answer the nine free rows within the hour.
The document is written with those rows marked pending so it can be completed rather than rewritten.

## D76 — goal criterion 10 splits into 10a acceptance and 10b publication
Astra: "separate public publication in criterion 10 from private release acceptance pending owner
approval, while retaining the recording and release artifacts." As written, criterion 10 bundled
making the recording with publishing it, so Q5 — an unanswered question about a DESTINATION — could
block an otherwise-finished release. 10a is now the owner-independent half (recording made, paid
probe output and release notes retained) and is what "v0 is accepted" means. 10b is publication and
stays blocked on Q5. A blocked 10b no longer makes 10a incomplete.
The number stays 10 with lettered halves rather than becoming 10 and 11, because "criterion 10" is
referenced throughout `.audit/v0/` and renumbering would silently invalidate those references.


---

# Run of 2026-09-08 (overnight, hp): finishing v0

## D75 — the tracked container image could never have started

Verified on the paid account. `wrangler.jsonc` named
`ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11...` directly as the container
image. Three separate faults, each proved by a deployed failure:

1. `IMAGE_REGISTRY_NOT_CONFIGURED`. Cloudflare containers pull only from the deploying account's
   managed registry or from a registry that account has configured with credentials. A fresh
   account has neither, so the container application was never created and the deploy aborted
   after uploading the Worker.
2. The pinned image is a single layer over `scratch` holding only the dynamically linked
   `computerd` binary. It has no libc, no shell and no toolchain, so Cloudflare starts it and it
   exits 1. `scripts/probe/container-preflight.Dockerfile` already recorded this fact and copied
   the binary into a Debian and Node userland; the deployed configuration did not.
   `podman run` of the pinned image reproduces it locally:
   "exec container process (missing dynamic library?) `/usr/local/bin/computerd`".
3. `FUSE_MOUNT=auto` selects the kernel FUSE backend inside a Cloudflare container and computerd
   exits 1. `FUSE_MOUNT=shim` starts and serves. This is the fix that turned a 60 second
   `workspace-unavailable` into a 2 second answer.

Decision: `wrangler.jsonc` names `containers/computerd.Dockerfile`, which pins the same digest in
its `FROM`, copies `computerd` into Debian plus Node 22, adds `git`, `gh`, `tar` and corepack, and
sets `FUSE_MOUNT=shim`. wrangler builds it and pushes to the deploying account's own managed
registry, which is also what Workers Builds does for a deploy button user. The probe script and
the deployed image now come from one file, so they cannot drift.

Recorded because it changes what "the pinned pair ran on a paid account" meant: the pair had run in
a *locally built* userland, never as the deployed container image.

## D76 — deploying from hp needs a local override config

podman rewrites an image manifest when it pushes, so the digest podman reports locally is not the
digest the registry stores, and wrangler asks Cloudflare for the local one. Cloudflare then answers
`IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE`. Verified against the registry API with both Docker and OCI
accept headers and with `podman push --format v2s2`, which produced a third digest. There is no
shim for this, so hp builds and pushes the image by hand and deploys with `/tmp/wrangler-hp.jsonc`,
whose only differences from the tracked config are an absolute `main`, the managed-registry digest,
`observability`, and the probe `vars`. A docker host and Workers Builds do not have this problem.

## D77 — deployed probes run against an injected Access JWKS

`tools/access-session.mts` mints a disposable ES256 key pair and one token, and the Worker verifies
it through its ordinary path because `CF_ACCESS_PUBLIC_KEYS` is a supported configuration. The
deployed probes therefore exercise real Access verification code with a key the run owns. This is
not proof that a Cloudflare Access application admits the owner; that claim still needs the real
application and the owner's own login, and is recorded separately.

Fail-closed evidence from the same deployment: no credential gives 401, a credential with no Access
configuration gives 500 (`invalid-configuration`).

## D78 — decision 6's premise was false, and the R2 cut is a replacement

There is no "existing, tested Supervisor SQLite artifact store". Module maps live only in R2
(`src/supervisor/artifacts/cache.ts`), and `src/supervisor/artifacts/index.ts` says SQLite stores
no module source. Cutting R2 therefore means writing a store. Reviewed with sol
(`.audit/v0/review-sol-simplify.md`): canonical encoding split into 1 MiB UTF-8 BLOB chunks plus a
manifest row, written in one `ctx.storage.transactionSync`, because a Durable Object row may not
exceed 2 MB and one generated module can be larger. `prepare` may build, `load` never does, so
rollback cannot rebuild. Kept the owner's decision rather than keeping R2, which would have been
the smaller diff.

## D79 — the harness browser command has never worked

`package.json` points `harness:browser` at `tools/browser-harness/run.mts`, which does not exist;
the entrypoint is `smoke.mts`. `tools/browser-harness/README.md`, which `AGENTS.md` tells every
agent to read, does not exist either. Found by the recovery-deletion worker. Fixed out of band on
its own branch, because the end-to-end web testing this run owes depends on that command.

## D80 — the deployed build is blocked by the container, not by this repository

Five distinct deployed failures of the build step. Four were real faults here and are fixed on
`main`: tar's metadata syscalls against Computer's userspace filesystem, no time budget on a
planned command, a module map read that the workspace filesystem API could not see, and one
Workspace Host stub held for a whole multi-minute build.

The fifth is the container. Inside the durable workspace, installing about fifty thousand
`node_modules` files resets the Durable Object that hosts the workspace mid-build. Moved to the
container's own filesystem, the Durable Object survives and the container exits 1 at about 300 s of
`pnpm run build:artifact`. The container is `vcpu: 0.5, memory: 4 GiB, disk: 8 GB`, and
`PATCH .../containers/applications/<id>` with `instance_type: standard-4` returns 200 and changes
nothing.

A first attempt to move the build to `/tmp` also moved the working directory there and died with
"spawn failed: no such path": Computer resolves a working directory against the workspace. Every
step now runs in the workspace and names the scratch path in the command.

Recorded as blocked, with the next three experiments in
`.audit/v0/evidence/deployed-plumbing-probe.md`. Nothing about the generation loop is claimed as
deployed proof.

## D81 — the Cloudflare Access application needs one owner action

`GET /accounts/.../access/apps` reads with the run's OAuth token; `POST` to the same path returns
401, and `access/organizations` returns 403. The Zero Trust team domain
`adityakompella.cloudflareaccess.com` exists and serves a JWKS, and the zone `akompella.dev` is
active, so the remaining work is one application, one owner policy, and reading the `sub` claim
from the owner's first login. `docs/deploy.md` carries the steps. Deployed probes used an injected
JWKS instead (D77) and no claim is made about Access admitting the owner.

## D82 — the deployed loop closed, and what it cost

Superseding D80's "blocked". The build's own output was the cause: Computer holds a command's output
in memory, and an unbounded `pnpm install` log made the container exit 1 part way through every
build. A probe that discarded the install log ran the whole build, wrote a 942311 byte module map
and left the container alive. `a199797` makes the install silent and keeps the last 4000 bytes of
the rest; `2efcb75` seeds the pnpm store into the image so the registry is off the critical path.

With that in place the deployed loop runs: submit to ready in 334 s, activation in 0.3 s, a
deliberately broken candidate recorded `response-rejected` while the active generation kept
serving, rollback in 0.26 s with no Workspace Host call at all, and a real coding turn that read a
file, wrote it, ran a command, streamed its work and saved its thread.

Three more bugs sat in the turn path, and each hid the next:

1. The facet told Pi the route had a zero context window and a zero output budget, so Pi sized
   every response against zero (`a15718d`).
2. Workers AI's default output budget truncated the model's answer before any content arrived
   (`194a76f`).
3. The provider stream parser read only Workers AI's classic `{response}` shape. The model streams
   chat-completion chunks whose text and tool calls live in `choices[0].delta`, so the route
   recorded the token count and threw away every answer and every tool call (`2849183`).

`@cf/meta/llama-3.3-70b-instruct-fp8-fast` was tried while diagnosing 2 and rejected every call:
the Workers AI binding validates against the model's schema, and that model takes
`messages[].content` as a string while Pi sends content parts. The comment on `MODEL` records it.

Known defect, not fixed: the workspace `write` tool returns a backend error, and the agent falls
back to `bash`. The turn completes, so it is a follow-up rather than a blocker.

## D83 — every project-file write was failing, and why nobody knew

The `write` tool answered `backend-unavailable` on every deployed turn, and the agent worked around
it with `bash`. That code is the fallback for an error with no errno, so the cause never left the
Durable Object. Logging the unmapped error named it in one turn: the runtime requires
`state.storage.transactionSync()` rather than the SQL `BEGIN TRANSACTION` or `SAVEPOINT` that
Computer's `workspace.db.transactionSync` issues. The workspace's database is the object's own
SQLite storage, so the write now uses the Durable Object API, the same one the generation store and
the module-map store already use (`a50b14a`).

The lesson is the logging, not the transaction. A typed failure code with no cause attached costs
one deployed run per bug.

## D84 — what the deploy button question actually reduces to

The button does three things: it forks the repository into the user's GitHub, it drives
Cloudflare's provisioning screen from `wrangler.jsonc`, and it sets up Workers Builds. Only the
middle one is about this repository, and the handoff said so: the supported-resource list is
documentation, not evidence that this config survives the flow.

That part is now evidence. A second Worker deployed from the tracked configuration, with no Access
variables, provisioned both Durable Object namespaces with their SQLite migrations, the container
application, and every binding, and then failed closed with 401 and 500 as the guide promises. It
was deleted afterwards. The remaining gap is Cloudflare's own screen, which needs an interactive
login, and the fork itself, which needs a second GitHub account.

Recorded so nobody re-opens the question as if the repository were the unknown part.

## D85 — the page, proved against the deployment, and one defect that was not one

The 41 browser cases drive the real page against a stub. This closes the remaining gap: headless
Chromium against the deployment itself, with the Access token as the `CF_Authorization` cookie a
signed-in browser would send. The sidebar lists the harness with its working directory, selecting
it switches the conversation, the drawer reads the real active generation, four page-driven turns
completed and saved, and the transcript survives a reload with its tool calls and diff. No console
errors.

The near-miss is worth keeping. Every probe run showed `turn-state: running` while the same turn
through `curl` took 1.9 s, which reads like a page defect. It was the probe. A run that kills the
browser mid-stream abandons its turn, the lease holds the project to its deadline, and the page
guards Send on the thread's `turnActive`. `wrangler tail` proved it: in the run that looked stuck
there was no turn POST at all, only the page's own reads. The page had refused to start a second
turn while one was live.

The rule this earns: before filing a defect against a surface, check whether the request the defect
assumes was ever made.

## D86 — I6 is the owner's step, and the checklist says so

Two turns were spent asking the owner to choose between recording the button flow and accepting the
repository-side evidence. That is blocking on the human over work the owner had already classified.
Directive 3 took the demo recording out of agent scope because it needs a person's hands;
Cloudflare's fork and provisioning screen needs an interactive dashboard login and a second GitHub
account, which is the same class. So I6 is recorded as skipped with that reason, beside the
recording, and the checklist has nothing unresolved left.

What is not being claimed: that a stranger's button click works. What is: the repository is public,
the button reaches Cloudflare's flow carrying it, the tracked configuration provisions a brand-new
Worker with every binding and fails closed, and a fresh instance runs the whole demo path.

## D87 — the instance was unreachable because nothing claimed the hostname

Not a fault in this repository. The zone has a proxied wildcard record pointing at another machine,
so `stumble.akompella.dev` resolved there, and the Worker had neither a route nor a custom domain.
Access was correctly configured in front of the hostname, which is what made it confusing: the
login succeeds and the page that appears belongs to the other machine.

Fixed with one route in `wrangler.jsonc`, chosen over a custom domain because a custom domain
writes a DNS record and a route does not, and the wildcard already makes the hostname proxied. The
symptom and both fixes are now in `docs/deploy.md`, because a reader with a wildcard record will
hit exactly this.

## D88 — Access admits the owner, and the run can stop saying "injected JWKS"

Every deployed claim until now carried the caveat that Access verification ran against a key this
run minted. That caveat is retired. With the real team domain, the real audience and no
`CF_ACCESS_PUBLIC_KEYS`, the Worker fetched Cloudflare's signing keys and admitted the owner's own
token: `sub 3eb1d2b2-2e13-5243-ba1b-147f5bd3c2a1`, issuer `adityakompella.cloudflareaccess.com`.
The `sub` is the `user_uuid` from `get-identity`, so no correction was needed.

Reading it needed a temporary diagnostic, because `wrangler tail` redacts
`cf-access-jwt-assertion` and a refusal would not have printed the subject either. The diagnostic
decoded the presented token, logged its claims once, and was removed and redeployed within
minutes. Worth remembering: a boundary that refuses without saying what it refused costs one
deployed round trip per question, which is the third time this run has paid that toll.

## D89 — bootstrap is an owner action, and the guide said otherwise

The owner's instance answered 503 `no-active-generation` on every relayed route because nothing
bootstraps on its own. The Supervisor waits for `POST /api/generations/submit`. The handoff's
fresh-account sequence describes the Supervisor labeling the clone's HEAD on the first
authenticated request, and `docs/deploy.md` repeated that, so the guide told a forker to expect
something the code does not do. Recorded as a finding rather than built, because the owner asked
for the finding and building it is new behavior.

Second cause of the same confusion: the Supervisor's name comes from the verified Access identity
and audience, so the probe identity this run used and the owner's real identity are different
tenants with different workspaces. Everything this run proved earlier was proved on a Supervisor
the owner had never signed in to.

## D90 — three faults between a deployed Worker and a first generation

1. The image seeds a pnpm store and no build ever used it. A command Computer runs in the container
   inherits `PATH` and nothing else, so `PNPM_HOME` never arrives and pnpm falls back to its
   default store under `$HOME`. Neither `/root/.npmrc` nor `~/.config/pnpm/rc` moves the store, so
   the seeded store is linked into the default location. Install went from about 300 s and an
   OOM-killed native install script to 39 s.
2. A build only ever sees committed and pushed code, because it extracts the submitted commit from
   the remote. Two probe rounds were spent on a fix that was sitting in the working tree.
3. One shell command could not survive a whole build. Three consecutive attempts died at about
   690 s, two as Durable Object resets and one as exit 1 with empty output, while everything that
   ever succeeded was 527 s or shorter. A build is now one step per phase, so each has its own RPC,
   exit code, bounded log and budget, and a failure names the phase. The owner's instance
   bootstrapped on the first attempt afterwards, in 321 s.

## D91 — two surfaces a forker will misread

`/api/status` omits `generation` when none is active rather than zeroing it, and its `epoch`
legitimately starts at 0, so the response reads like an active generation at a glance. And `/health`
has no special case: anything that is not `/api/...` and is not a browser navigation relays to the
active generation, so before the first generation exists `/health` answers the same 503. There is
no generation-independent way to check that a deployed Worker is alive. Both recorded, neither
changed, because a health route is new behavior and this run does not add features.
