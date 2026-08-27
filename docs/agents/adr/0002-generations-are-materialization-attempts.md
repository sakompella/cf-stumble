# Model generations as materialization attempts

A commit is ordinary content and ancestry; a generation is one numbered attempt to materialize that commit as a running agent. Numbers come from a never-reused counter, failed attempts keep their number, and the same commit may have several generations. Materialization records an immutable outcome, while a separate append-only activation ledger records repeated promotions and rollbacks; a turn pins its generation when it starts.
