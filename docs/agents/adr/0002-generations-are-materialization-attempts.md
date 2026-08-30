# Keep generations distinct from Git commits

> **Review:** Human-approved

A Git commit records source history. A generation records one numbered attempt to prepare a main-harness version and make it available to run. The supervisor assigns generation identities before each attempt, so failed attempts remain identifiable and numbers do not repeat. Generation 0 is the first mutable main harness, not the immutable recovery harness.

The source of a generation may be a harness commit, but commits in any repository remain ordinary Git commits and do not create generations automatically. The checks required before a generation runs or becomes known good are separate decisions.
