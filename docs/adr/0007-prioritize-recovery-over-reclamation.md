# Prioritize recovery over reclamation

Generation 0 is pinned and reset reaches it through supervisor code rather than candidate code or quarantine. Rollback deliberately needs no fresh attestation so recovery still works when validation is unavailable, although it is limited to previously live, non-quarantined generations. Objects are retained until a separately designed collector can prove its roots, because deleting a rollback target is worse than accepting storage growth without present pressure.

## Consequences

Reset competes for the live pointer like any other writer, so its compare-and-swap retry is bounded at 16 attempts and reports a typed `contended` outcome rather than looping until something gives. An escape hatch that can hang is not an escape hatch; `test/genesis/reset-bounded.test.ts` holds that bound.
