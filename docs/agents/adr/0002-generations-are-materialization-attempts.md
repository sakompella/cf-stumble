# Model generations as materialization attempts

A commit is ordinary content and ancestry. A generation is one numbered attempt to materialize that commit as a running agent. Numbers come from a never-reused counter, failed attempts keep their number, and one commit may have several generations. Materialization records one immutable outcome; the separate append-only activation ledger records repeated promotions and rollbacks. A turn pins its generation when it starts.

## Why not numbering by commit depth

The initial design made each commit a generation and used commit-DAG depth as its number, so Git held content, lineage, and generation naming. That made exploratory commits unintended materialization attempts: committing was the only way to make progress, and every commit became a generation whether anyone meant to run it or not. It also let two branches made after a rollback claim the same depth-derived number, because depth describes a position in the graph rather than a specific attempt. Generations need their own counter and record, separate from Git.
