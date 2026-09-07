# Rationale

## Data shape

One table, `sessions`, keyed by the caller's `session_id`. Columns: `document` (JSON text),
`revision` (integer), `turn_active` (0 or 1). No column names a generation, an activation, or a
harness commit, so a generation change cannot touch a session row.

`SessionDocument` is a recursive JSON type: string, number, boolean, null, array, or string-keyed
map of itself. The Supervisor never reads a key inside it. The array and map arms are interfaces,
not inline recursive type literals, because a Durable Object RPC parameter type gets walked by a
mapped type that mirrors its structure. Doing that over a self-referential type alias made `tsc`
report "type instantiation is excessively deep". An interface stays a named, lazily-resolved
reference at every level, so the same recursion type-checks across the RPC boundary.

## Rejected alternatives

A combined `finishTurn(sessionId, expectedRevision, document)` that writes and releases in one
call. I kept `write` and the turn release separate. A caller composes them for a real turn:
`startTurn`, then `write`, then `finishTurn` or `abandonTurn`. The cost is a crash window between
the write and the release that leaves a slot held. Version 0 has no crash-recovery requirement
for sessions, so I accepted that window over an atomic primitive the brief never asked for.

I did not gate `write` on holding an active turn. The brief states the revision rule and the
turn-conflict rule as independent requirements, and a session with no turn history still needs to
be writable to be created.

## Pure and imperative halves

`decisions.ts` holds three pure functions over a `SessionSnapshot` (`revision`, `turnActive`):
`decideWrite`, `decideStartTurn`, `decideReleaseTurn`. Each takes a plain snapshot or `undefined`
and returns a decision, never touching SQL. `store.ts` is the shell: `SessionStore` creates the
table in its constructor, reads a row inside `transactionSync`, calls a decider, and applies the
effect it names. `row.ts` decodes a `SessionRow` into a `Session` or a `SessionSnapshot`, throwing
on a corrupt persisted value, matching the generations module's row decoders.

## What I think is wrong in the brief

"Two different sessions run at the same time" reads like a concurrency requirement, but a Durable
Object is single-threaded. The test shows two `sessionId`s are independent, not simultaneous.
