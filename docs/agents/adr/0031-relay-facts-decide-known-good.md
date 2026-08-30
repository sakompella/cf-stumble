# Record raw relay facts and derive eligibility from them

> **Review:** Agent-only

The Supervisor relays each request to the main facet rather than handing back the facet's response object, and records what it observes as separate facts: the facet failed before headers, headers arrived with a status, the body completed, the body failed after headers had gone out, the relay was cancelled, or the attempt was still unresolved when its bound expired. The caller sees the same status, headers and bytes either way.

A completed body with a status below 400 is the only fact that earns credit. A completed 5xx, a pre-header failure and a mid-body failure are failure observations. A cancelled relay and a bounded abandonment earn neither credit nor blame, because nothing observed whether the work finished. This is the point `design/overview.md` insists on: a stream can fail after its headers arrive, so a status is not evidence that a turn completed.

Whether a generation is known good is derived at read time from those facts, never stored as a flag something writes. Every fact is bound to the generation, the activation epoch, and the passing preparation check that admitted the code, so a fact from a superseded activation stays on the record and earns nothing, and a fresh passing check starts a new evidence era. The alternative, a mutable `lastKnownGood` pointer, loses the ability to explain why a generation qualified and lets one bad write hide a failure.

Qualification requires both a count of credited turns and a span of time between the first and the qualifying one, so a burst of quick requests does not qualify a generation that has never survived being used. The numbers are placeholders. `overview.md` says the threshold is unsettled and that twenty successful turns was illustrative, so the policy is a value passed in, and choosing it is a product decision this ADR does not make.

Two limits worth stating. Nothing local proves a client disconnect reaches the Supervisor: an aborted request left the attempt pending until it was swept, which matches what a paid probe saw earlier. And the bound on an unresolved attempt is applied by an explicit sweep rather than a Durable Object alarm, because alarm survival across hibernation needs paid-runtime evidence this project does not have.
