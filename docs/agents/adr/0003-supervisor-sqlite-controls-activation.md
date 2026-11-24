# Let the supervisor decide generation state changes and recovery

> **Review:** Human-approved

The Supervisor Durable Object is the primary Durable Object for a cf-stumble instance. It protects the state that records generations and their activation.

The user or mutable main harness may request creation, activation, or rollback and may name a specific target generation. The supervisor validates each request and alone performs or rejects the state change. Mutable code cannot write protected generation state directly or bypass the Supervisor's checks, so a generation that breaks itself cannot also break the record the owner rolls back with.

The Supervisor's SQLite is the authority for activation: the active label, the epoch, each generation's status, `was_active` and facet compatibility, the serving instance number (`serving_instance`, which counts the facet replacements), and probation (`proven_label`). Module maps live in R2 (`module-maps/<harnessCommit>.json`, written once per commit), and after each transaction commits the Supervisor appends the generation outcomes to the same bucket under `history/`. Neither is read to decide a state change, and the history holds no module map bytes. On startup the Supervisor moves a leftover `serving-instance` KV value into its column; the old `generations.proven` and `generations.probation` KV keys stay in storage unread.

The interface between the supervisor and a main facet and the transport for generation requests remain open. Ordinary Worker `fetch` forwarding is a tested option, not part of this decision.
