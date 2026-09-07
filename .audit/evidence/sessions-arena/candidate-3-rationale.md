# Rationale

## Data shape

One `sessions` table: `session_id` primary key, `document` (opaque TEXT), `revision`
(INTEGER, starts at 0), `turn_active` (0/1). No column names a generation, activation,
or harness commit, so the table cannot drift toward coupling session state to
generation state. A row is created lazily on first write or turn start.

`document` is a plain string the Supervisor never parses, the same treatment
`harnessCommit` gets elsewhere. `revision` is a plain counter: the caller echoes the
revision it last saw, and a mismatch fails without touching the stored document.

## Alternatives rejected

A `session_turns` history table, mirroring `relay_attempts`, would let a caller inspect
past turns. Nothing in the brief asks for that and version 0 has no reader for it. One
boolean column enforces the invariant without unused history.

A single `endTurn(sessionId, reason)` RPC would remove a method, but `finishSessionTurn`
and `abandonSessionTurn` name different caller intents, matching how `activate` and
`rollback` stay separate even when their storage effect coincides.

`better-result` chained through the store, as `control/index.ts` does, buys nothing
here: each decision has one problem code, so there is no `.map`/`.mapError` chain
worth writing. `generations/decisions.ts` shows the plainer style this store follows.

## Pure and imperative halves

`sessions/decisions.ts` holds three pure functions (`decideWrite`, `decideStartTurn`,
`decideEndTurn`) over a `SessionState` value. `sessions/index.ts` is the only place
that touches SQLite: it reads the current row, or a default for an unseen session,
calls a decider, and applies the effect it names inside one transaction.

## A judgment call the brief left open

The brief lists revision-guarded writes and turn admission as separate testable
properties, not one coupled invariant. I kept them independent: a write does not
require an active turn. A real caller will likely wrap a write inside a turn, but the
store does not assume that shape.
