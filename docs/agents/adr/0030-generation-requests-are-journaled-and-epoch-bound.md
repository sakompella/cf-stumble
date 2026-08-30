# Check generation requests against an epoch and journal every outcome

> **Review:** Agent-only

A generation request carries a request ID, a principal, and a command. The Supervisor decides it and writes its terminal outcome to a durable journal keyed by the request ID, inside the same synchronous transaction that applies the state change. Replaying a request ID with the same command returns the recorded outcome and applies nothing; reusing it with a different command is rejected. Rejections are journaled too, so a replayed rejection stays a rejection.

Activation and rollback carry the epoch the requester believed was current. The Supervisor rejects them when that epoch is not the current one, so a requester deciding from a stale view of the world does not get to act on it. A request from the main harness is rejected outright unless the harness's own generation is the active one, which is what stops a replaced generation, or a leaked reference to one, from steering the system after it has been superseded.

The alternative was to let each request apply directly and rely on the caller not to retry. That loses on both sides: a retry after a lost response would activate twice, and a request built from a stale read would silently undo a concurrent change.

Two things this decision does not settle. Nothing authenticates the principal yet, because the transport that would carry a request from a browser or from the main facet is still an open question and the platform constrains it: an earlier prototype found that passing an `RpcTarget`, a function, or a `WorkerLoader` through Dynamic Worker loader `env` fails with `DataCloneError`, so a capability can only arrive as an RPC argument. And rollback currently requires only that its target has been active before, which stands in for known-good evidence until the project decides what makes a generation known good.
