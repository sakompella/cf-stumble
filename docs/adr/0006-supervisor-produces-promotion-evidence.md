# Have the supervisor produce promotion evidence

A promotion request names a candidate; it cannot submit an attestation. The supervisor runs the gate itself and retains an attestation bound to the candidate, loaded artifact, baseline, corpus, and gate version, then verifies it in the same transaction as promotion. A caller-supplied attestation could be well-formed but fabricated, so binding its fields alone would prove only the shape of the check.

## Consequences

The corpus and gate versions in an attestation are content-derived hashes rather than hand-maintained numbers, so nobody can forget to bump one and leave a stale binding that still verifies. The corpus hash covers case content, the recorded sessions, and which cases are marked as canaries — that last part matters, because a candidate that quietly unmarked the canary catching its own regression would otherwise change what it is measured against.
