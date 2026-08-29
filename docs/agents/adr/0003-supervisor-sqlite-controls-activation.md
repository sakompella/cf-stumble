# Let the supervisor decide generation state changes and recovery

The Supervisor Durable Object is the primary Durable Object for a cf-stumble instance. It contains the immutable recovery harness and protects the state that records generations and recovery.

The user or mutable main harness may request creation, activation, or rollback and may name a specific target generation. The supervisor validates each request and alone performs or rejects the state change. Mutable code cannot write protected generation state directly, replace the recovery harness, or bypass its checks.

The interface between the supervisor and a main facet, the transport for generation requests, and the detailed recovery policy remain open. Ordinary Worker `fetch` forwarding is a tested option, not part of this decision.
