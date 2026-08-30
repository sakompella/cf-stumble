# Record raw relay facts and derive eligibility from them

> **Review:** Agent-only

The Supervisor relays each request to the main facet rather than handing back the facet's response object, and records what it observes as separate facts: the facet failed before headers, headers arrived with a status, the body completed, the body failed after headers had gone out, the relay was cancelled, or the attempt was still unresolved when its bound expired. The caller sees the same status, headers and bytes either way.

A completed body with a status below 400 is the only fact that earns credit. A completed 5xx, a pre-header failure and a mid-body failure are failure observations. A cancelled relay and a bounded abandonment earn neither credit nor blame, because nothing observed whether the work finished. This is the point `design/overview.md` insists on: a stream can fail after its headers arrive, so a status is not evidence that a turn completed.

Whether a generation is known good is derived at read time from those facts, never stored as a flag something writes. Every fact is bound to the generation, the activation identifier, and the passing preparation check that admitted the code, so a fact from a superseded activation stays on the record and earns nothing, and a fresh passing check starts a new evidence era. The activation identifier moves only when the supervisor activates a generation. The epoch versions only generation-control state read by activation and rollback: generation rows, the active label, and preparation checks; each committed change advances it once. Recording relay facts does not move the epoch, and neither do journal or recovery rows, because none of them is a decision input for activation or rollback. The alternative, a mutable `lastKnownGood` pointer, loses the ability to explain why a generation qualified and lets one bad write hide a failure.

Qualification requires both a count of credited turns and a span of time between the first and the qualifying one, so a burst of quick requests does not qualify a generation that has never survived being used. The numbers are placeholders. `overview.md` says the threshold is unsettled and that twenty successful turns was illustrative, so the policy is a value passed in, and choosing it is a product decision this ADR does not make.

Four limits, and the first one bounds how much any of this evidence is currently worth.

The facts are attributed to the generation the Supervisor records as active, but the Supervisor still serves every request from the one fixture artifact it mounts at construction, because wiring traffic to the active generation needs artifact bytes retained across a restart and that storage is still open. So a generation can accumulate credited turns, qualify, and be chosen as a recovery fallback on the strength of bytes some other code produced. Until activation moves traffic, treat eligibility as a tested mechanism rather than as a statement about a generation.

A body that completes early is only detected when the response declared a `content-length`. A streamed response does not, so a facet that closes its stream half way through a turn is recorded as a completed body. That is the case a coding agent's turns actually live in, and catching it needs something the response itself carries, which is a protocol question this decision does not answer.

Nothing local proves a client disconnect reaches the Supervisor: an aborted request left the attempt pending until it was swept, which matches what a paid probe saw earlier.

The bound on an unresolved attempt is applied by an explicit sweep rather than a Durable Object alarm, because alarm survival across hibernation needs paid-runtime evidence this project does not have. Nothing in production calls that sweep yet; only tests do.
