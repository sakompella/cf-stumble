# Have the supervisor produce promotion evidence

A promotion request names a candidate; it cannot submit an attestation. The supervisor runs the gate itself and retains an attestation bound to the candidate, loaded artifact, baseline, corpus, and gate version, then verifies it in the same transaction as promotion. A caller-supplied attestation could be well-formed but fabricated, so binding its fields alone would prove only the shape of the check.
