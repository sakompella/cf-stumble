# Gate candidates on a capability floor before running the corpus

Preflight runs the real executor against a candidate to confirm it still loads and can still use its own `edit` primitive, and each capability must pass on its own rather than contributing to a score. A candidate that has lost the ability to edit code is a dead end whatever it scores, so the check is a floor placed before the compatibility ratchet rather than another input to it.

## Consequences

This follows a published finding that optimizing a single benchmark amplifies brittle and unsafe behaviour, so safety checks belong as a separate objective. The ratchet in ADR-0005 is score-shaped by nature; keeping the floor outside it is what stops a candidate from trading away a capability for a better ratchet result.
