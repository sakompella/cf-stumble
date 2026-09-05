# Limit the generation-control epoch to generation-control state

> **Review:** Human-approved

The generation-control epoch is a compare-and-swap version for activation and rollback. A requester includes the epoch it observed. The Supervisor rejects the request when a later generation-control change has advanced the epoch, so a delayed request cannot overwrite a newer decision.

The epoch advances once for each committed change to generation rows, the active label, or preparation checks. These are the facts that activation and rollback use to decide whether a request remains valid. Relay observations and recovery records do not advance the epoch because activation and rollback do not use them as decision inputs.

The alternative is a version of all Supervisor state. That would advance the epoch for ordinary relay traffic, so a request could become stale while it waits even though no generation-control decision changed. Under continuous traffic, activation and rollback could fail repeatedly. It would also let mutable serving code delay control by causing more relay writes.

ADR-0030 applies each generation request directly. The epoch remains the stale-request check for
activation and rollback; it is independent of response replay or request journaling.
