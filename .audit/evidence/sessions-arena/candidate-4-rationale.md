# Rationale

## Data shape

`sessions` has four columns: `session_id` (primary key), `revision`, `turn_active`, `document`.
One row is one session. `revision` is a single counter every mutating op advances, whether it
changes the document or only the turn flag. That counter separates the two required errors: a
start against the current revision fails on `turn-conflict`; only an outdated revision fails on
`stale-revision`.

`document` is a plain `string`, not `unknown`. This repo's oxlint plugin bans `unknown` on
parameters, returns, and type aliases, so an opaque value could not cross this store's methods.
A `string` also matches the brief literally: the Supervisor stores and returns the caller's bytes
without parsing them. Generation code serializes its own document before writing.

## Alternatives rejected

I rejected coupling document writes to turn lifecycle, where `finishTurn` both saves and frees the
slot. The store would then decide when a caller may write, a policy the brief never asks for.
`write`, `startTurn`, `finishTurn`, `abandonTurn` stay four small revisioned ops on one row.

I rejected branding `SessionId` like `GenerationLabel`; a session ID has no format beyond
"non-empty," so a brand would add ceremony without closing a real gap. I also skipped
`better-result` inside the store, matching `attempts.ts` rather than `generations/index.ts`: every
decision here is a two-branch union with no chaining need, so a wrapped and unwrapped `Result`
would add a layer that did nothing.

## Pure and imperative halves

`decisions.ts` holds three pure functions, one per operation, each taking the sessionId, the
expected revision, and a plain `{ revision, turnActive } | undefined` snapshot. None touch SQL.
`index.ts` is the shell: it reads the row, calls a decider inside one `storage.transactionSync`,
and applies the write the decision names. `finishTurn` and `abandonTurn` share one decider.

## What I think is wrong in the brief

The brief does not say whether starting a turn needs a revision. I required it: "every write
carries the caller's expected revision" reads as a blanket rule, and it is what separates the
two errors. A stale caller has not seen the current row; a conflicting caller has, and is
refused for a different reason.
