# Let the supervisor decide generation state changes and recovery

> **Review:** Human-approved

The Supervisor Durable Object is the primary Durable Object for a cf-stumble instance. It protects the state that records generations and their activation.

The user or mutable main harness may request creation, activation, or rollback and may name a specific target generation. The supervisor validates each request and alone performs or rejects the state change. Mutable code cannot write protected generation state directly or bypass the Supervisor's checks.

**Storage note (2026-11-09).** SQLite stays the authority for activation: the active label, the epoch, each generation's status, `was_active` and facet compatibility, and probation. Module maps moved to R2 (ADR-0028), and an append-only history of generation outcomes goes to a Cloudflare Artifacts repository after each transaction commits. Neither is read to decide a state change, and neither holds module map bytes in Artifacts.

The interface between the supervisor and a main facet and the transport for generation requests remain open. Ordinary Worker `fetch` forwarding is a tested option, not part of this decision.
