# Contain the agent against the supervisor first, network egress second

The threat this architecture is built to stop is the agent reaching the supervisor and disabling its own rollback, not the agent exfiltrating data. Both matter, and the ranking is deliberate: an agent that leaks a file has caused a bounded loss, while an agent that can promote itself or quarantine its own predecessor has removed the mechanism that would undo anything else it does.

## Consequences

This is why the design keeps `globalOutbound: null` for ambient egress and still accepts a narrow `WORKSPACE` binding, and why host-side git — which bypasses `globalOutbound` entirely — is a tolerable risk when proxied but not when handed over whole. Without the ranking stated, those two positions read as an inconsistency rather than a choice.
