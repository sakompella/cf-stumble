---
Status: proposed
---

# Adopt Computer for the supervisor working tree and Git

Adopt the exact `@cloudflare/computer@0.2.1` release for a supervisor-owned working tree and ordinary isomorphic-git workflow, replacing the hand-written codec and object store after the planned containment, compatibility, and performance slices succeed. The generation registry, activation ledger, validation gate, and live pointer remain supervisor SQLite authority; only the Git storage and workspace implementation move. A facet receives a narrow four-method proxy rather than Computer's broad Workspace, and ADR-0009 remains current until this migration is complete.
