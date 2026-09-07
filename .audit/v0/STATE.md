# cf-stumble v0 — run state

Living index. Written before acting, updated after each step. Durable home `.audit/v0/` (gitignored).
Last consolidated 03:00.

## Objective

Goal id `c0552403`. Ten measurable done-criteria and the cut line: `.audit/v0/goal.md`.
Dispatch from `.audit/v0/roadmap-v0.approved.md` (the reviewed roadmap; `roadmap-v0.md` is the
oracle's original and is superseded).

## Read these, in this order

1. `MORNING-BRIEF.md` — what happened and what needs the owner.
2. `questions.md` — Q7 blocks every paid step; Q2-Q6 have reversible defaults already applied.
3. `decision-log.md` — D1..D52, every choice and why.
4. `evidence/E1..E11` — findings confirmed from source, each tied to a goal criterion.
5. `review-opus-round1.md` — adversarial plan review, verdict SHIP WITH FIXES.
6. `wave1-integration-notes.md` — collisions and coverage gaps.
7. `acceptance-checks.md` — how a worker's claim is falsified.

## Main branch

`0161f91`. `pnpm verify` green: 113 test files, 797 tests (baseline was 93/642).
`scripts/probe/clean-build.sh` green on merged main: two identical maps, sha256 `18cea22b...`.

## Task board

| id | title | tier | status |
|---|---|---|---|
| T1a | Clean-commit build correctness + regression proof | opus-5 | **MERGED** `d1f2412` |
| T2 | Remove generation request journaling (ADR-0030) | sonnet-5 | **MERGED** `c3e0d5a` |
| T5 | Thread completion requires the admitting lease | opus-5 | **MERGED** `567d25e` |
| T3a | One tenant workspace holds every repository | opus-5 | running |
| T4 | Streaming interface across route -> facet -> RPC | sonnet-5 | **MERGED** `638890e` |
| T1b | Paid capability / build / load gate | opus | BLOCKED on Q7 |
| T3b | Shared-container concurrency experiment | opus | BLOCKED on Q7 |
| T6a | Connected projects, unsupervised half | opus-5 | **MERGED** `0161f91` |
| T6b | Owner-run device authorization | owner | waits for T6a, T1b |
| T7 | Pi instructions, compaction, diff, turn events | opus-5 | **MERGED** `54b02e2` |
| T8 | R2 cache age rule | sonnet | mostly paid; waits for Q7 |
| T9 | Own the saved streamed turn + its HTTP surface | opus-5 | **MERGED `eb7c575`** on the third attempt (T9b). 116 files / 829 tests. Probe sha moved `18cea22b` -> `313ddf26` as expected: facet code changed. |
| T13 | the turn's diff is the harness's, not the model's (from review 2.1) | opus-5 | **MERGED `3a77907`** 116 files / 834 tests, probe sha `e9c3008e`. Follow-up: T10 must render the two new frames. |
| review r2 | opus-5 high (sol quota dead ~4.5 days) | adversarial review of the MERGED state | **DONE** -> `.audit/v0/review-round2.md`. Verdict SOUND WITH FIXES. |
| T10 | Connected project conversation on one page | sonnet | waits for T2, T6a, T9 |
| T11 | Workflow under failures and races | opus | waits for T3a, T8, T9 |
| T12a/b | Deploy, evidence, demo, release | opus/owner | last |

## Blockers against the ten criteria

| evidence | fault | criterion | state |
|---|---|---|---|
| E1 | clean build of a labeled commit failed | 7, 8 | CLOSED, proven (E10, E11) |
| E2 | lease fencing was dead code | 6 | CLOSED, merged |
| E3 | three encodings of the old workspace layout | 3 | CLOSED, merged `43e7ac8` |
| E4 | `ProjectCatalog` is a fixed two-tuple type | 3 | CLOSED, merged `0161f91` |
| E5/E7 | model route has no streaming interface | 4 | CLOSED, merged `638890e` |
| E6 | no HTTP route reaches any turn method | 4, 5, 6 | T9 running |
| E9 | no credential path; compaction unexported | 3, 5 | CLOSED, merged |

## Operating rules earned this run

- Branch every new task from CURRENT main, never the run's original base (D48).
- Await any cleanup a later step depends on; `bash()` is non-blocking (D37).
- Workers are `prime-agent` shell-outs, not RLM children. `pgrep -f "wt/<id>"` finds only the
  wrapper — use the session file's mtime and size as the liveness signal (D50).
- After every merge, re-run the PROBE as well as the gate. The gate hides the E1 fault (D51).
- Objective checks must assert the PROPERTY, never a presumed implementation (D40).
- No paid spend until Q7 is answered. Blocked, never faked (D27).

## Heartbeat

Label `cf-stumble-v0`, every 15 min. Detect finished workers, run objective checks, merge in a
collision-safe order gating between every merge, dispatch the next unblocked task, and run the
`gpt-5.6-sol` round-2 review after 05:57 when the Codex quota resets.
