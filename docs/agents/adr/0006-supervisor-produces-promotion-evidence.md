# Have the supervisor produce promotion evidence

A promotion request names a candidate; it cannot submit an attestation. The supervisor runs the gate, retains an attestation bound to the candidate, loaded artifact, baseline, compatibility corpus, and gate version, then verifies it in the promotion transaction. A caller-supplied attestation could be well-formed but fabricated, so binding its fields would prove only the shape of the check.

## Consequences

The compatibility corpus and gate versions in an attestation are content-derived hashes, not hand-maintained numbers, so nobody can forget to bump one and leave a stale binding that still verifies. The compatibility-corpus hash covers case content, recorded sessions, and which cases are canaries. That last part matters because a candidate that quietly unmarked the canary catching its own regression would otherwise change what measured it.
