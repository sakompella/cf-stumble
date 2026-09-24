# Let the supervisor decide generation state changes and recovery

> **Review:** Human-approved

> **Amendment (2026-09-23):** Recovery-harness removal under handoff decision 7, owner-approved 2026-09-08.

The Supervisor Durable Object is the primary Durable Object for a cf-stumble instance. It protects the state that records generations and their activation.

The user or mutable main harness may request creation, activation, or rollback and may name a specific target generation. The supervisor validates each request and alone performs or rejects the state change. Mutable code cannot write protected generation state directly or bypass the Supervisor's checks.

The interface between the supervisor and a main facet and the transport for generation requests remain open. Ordinary Worker `fetch` forwarding is a tested option, not part of this decision.
