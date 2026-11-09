# Let the supervisor decide generation state changes and recovery

> **Review:** Human-approved

The Supervisor Durable Object is the primary Durable Object for a cf-stumble instance. It protects the state that records generations and their activation.

The user or mutable main harness may request creation, activation, or rollback and may name a specific target generation. The supervisor validates each request and alone performs or rejects the state change. Mutable code cannot write protected generation state directly or bypass the Supervisor's checks.

**Storage note (2026-11-09).** SQLite stays the authority for activation: the active label, the epoch, each generation's status, `was_active` and facet compatibility, and probation (`proven_label`, since the state-machine change; it replaced the `generations.proven` and `generations.probation` KV keys, whose one-time copy ran on production, and the Supervisor now deletes them on startup). Module maps moved to R2 (ADR-0028), and an append-only history of generation outcomes goes to the same R2 bucket under `history/` after each transaction commits. Neither is read to decide a state change, and the history holds no module map bytes.

The interface between the supervisor and a main facet and the transport for generation requests remain open. Ordinary Worker `fetch` forwarding is a tested option, not part of this decision.
