# Model generations as materialization attempts

A commit is ordinary content and ancestry; a generation is one numbered attempt to materialize that commit as a running agent. Numbers come from a never-reused counter, failed attempts keep their number, and the same commit may have several generations. Materialization records an immutable outcome, while a separate append-only activation ledger records repeated promotions and rollbacks; a turn pins its generation when it starts.

## Consequences

The initial design made each commit a generation and numbered it by its depth in the commit DAG, keeping content, lineage, and generation naming all in Git. That model turned exploratory commits into unintended activation attempts, since committing was the only way to make progress and every commit became a generation whether or not it was meant to run. It also let two branches built after a rollback claim the same depth-derived number, because depth is a property of a position in the graph, not of a specific attempt. Both failures are why generations get their own counter and their own record, separate from Git.
