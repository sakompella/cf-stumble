# Arena: the session store slice

Skill: **arena**. Runners: four `anthropic/claude-sonnet-5`, as the owner asked for sonnet. Cross-judge: `openai-codex/gpt-5.6-sol`, a different family from the parent. Decision trail rows go in `.audit/worker-previews-adoption.tsv` under phase `arena`, since this run continues the same night.

## Phase A: Frame

**Why this subject.** P1 of the feature map needs a real coding turn, and most of P1 is blocked. The model route does not exist, the real Computer image is untested, and R2 is disabled. One P1 piece is unblocked and testable in local workerd today: opaque session documents stored outside generation state, with revision-checked writes and one active turn per session. It is also the piece whose data shape is expensive to change later, because every later turn, client and rollback path reads it.

**Artifact.** Working code plus tests in each candidate's own worktree, under `src/supervisor/sessions/`, wired into the Supervisor, with a short rationale file.

**Rubric.** Six gradeable criteria.

1. **Session table shape.** One SQLite table keyed by `sessionId`, holding an opaque document, a revision integer and turn state. No generation label, activation id or harness commit appears in the session schema. A session must be readable after the active generation changes.
2. **Stale write rejection.** A save takes the caller's expected revision and fails with a distinct tagged error when it does not match. A test writes twice from the same stale revision and proves the second fails and the stored document is unchanged.
3. **Turn admission.** Starting a turn while another is active for the same `sessionId` fails with a conflict error distinct from the stale-revision error. Finishing or abandoning a turn releases the slot. Two different `sessionId` values run at the same time. Tests cover all four.
4. **Boundary discipline.** `better-result` stays inside the isolate per ADR-0035, so every Supervisor method returns a plain object with stable string codes. Pure decision functions are separated from SQLite writes per ADR-0036, following the shape already used in `src/supervisor/generations/decisions.ts`.
5. **The gate.** `pnpm verify` passes, including the new tests, with no edits to existing generation, relay or recovery files beyond the wiring the slice needs.
6. **Reader load.** Small surface. New files justified one by one, no new abstraction layer, no config object, no event bus. The Laziness Protocol decides ties.

**Runner output paths.** `/tmp/arena-sessions/candidate-{1,2,3,4}`, each a git worktree on its own branch, so no two candidates share mutable state.

## Phase B: Fan out

- [x] Four candidates spawned in parallel, each with the brief path, its own worktree, and a mandatory rationale naming what it rejected.

## Phase C: Cross-judge

- [x] One read-only judge on `gpt-5.6-sol` scores all four against the rubric by path label and recommends a base.

## Phase D: Pick a base

- [x] Parent reads all four end to end, scores criterion by criterion, compares with the judge, records the pick and the disagreements.

## Phase E: Graft

- [x] Port the one or two strongest ideas from each loser by hand. Record grafts, sources, and rejections with reasons.

## Phase F: Verify

- [x] `pnpm verify` on the synthesized result, plus a read of the tests to confirm they fail when the invariant is broken rather than passing vacuously.

## Result

Base candidate 1, judge `gpt-5.6-sol` at 29 against 28, 27 and 25. Committed as `7a0e3e2`. Synthesis, judgment, four rationales and four patches are under `.audit/evidence/sessions-arena/`.

I leaned candidate 3 and changed my mind on the judge's argument that a standalone `write` lets a caller save while another client holds the turn. Grafted candidate 3's storage-level stale-save test and added a turn lease that no candidate had. Verified with two deliberate mutations, four tests fail under each.
