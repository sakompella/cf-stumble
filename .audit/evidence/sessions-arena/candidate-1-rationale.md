# Rationale

## Data shape

One table, `sessions`, keyed by the caller's `session_id`. Columns: `document` (nullable TEXT), `revision` (INTEGER), `turn_active` (INTEGER 0/1). No column names a generation, an activation, or a harness commit. The row is the whole session.

`document` is a plain string, not `unknown` or JSON I parse. The brief says the Supervisor does not parse a session's contents. Storing a string and returning it unread is the literal reading of that rule. Generation code can put JSON, a length-prefixed format, or anything else inside that string; the Supervisor never looks.

`revision` and `turn_active` live on the same row as the document, not in a separate table. A turn is a property of one session, and a Durable Object transaction already serializes reads and writes to one row, so splitting them would add a join for no isolation benefit.

## Rejected alternatives

A `turns` table keyed by a generated turn ID, matching `relay_attempts`. Rejected because the brief needs exactly one active turn per session, not a history of turns; a boolean column expresses that directly, and a history the caller never queries is unbuilt scope.

Treating `document` as JSON and parsing it to validate shape. Rejected because that is exactly the parsing the brief forbids the Supervisor from doing.

A single `writeSession` RPC with no turn concept, layering the turn lock in the facet instead. Rejected because the conflict error has to come from the same durable state the revision check reads, inside one transaction, or two racing starts could both pass.

## Pure and imperative halves

`decisions.ts` holds three pure functions, `decideStartTurn`, `decideFinishTurn`, `decideAbandonTurn`. Each takes the current record (or undefined) and returns a plain decision; none touches SQL. `index.ts` is the shell: it reads the row, calls a decider inside `transactionSync`, and applies the one effect the decision names. This mirrors `generations/decisions.ts` and `generations/index.ts`.

Supervisor RPC methods return the store's plain `{ ok, session }` / `{ ok, problem }` union directly. No `better-result` value crosses `sessions/index.ts`; the store never needed the chaining that pushed `Generations` and `GenerationControl` toward `Result`, so I left it out rather than added it to look consistent.

## Where the brief is off

"A second start for the same sessionId fails with a conflict error that a caller can distinguish from a stale revision" only makes sense if starting a turn itself carries an expected revision. The brief never says that explicitly. I read `startTurn(sessionId, expectedRevision)` as the intended shape, since without it there is no revision to be stale against, but a reviewer expecting a revision-free start method would find this a real design choice, not a detail.
