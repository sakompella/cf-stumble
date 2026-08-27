# Contain the agent against the supervisor first, network egress second

The threat this architecture is built to stop is the agent reaching the supervisor and disabling its own rollback, not the agent exfiltrating data. Both matter, and the ranking is deliberate: an agent that leaks a file has caused a bounded loss, while an agent that can promote itself or quarantine its own predecessor has removed the mechanism that would undo anything else it does.

## Consequences

This is why the design keeps `globalOutbound: null` for ambient egress by default: exfiltration is a bounded loss the facet can be given more room to risk over time, while any path that reaches the supervisor's registry, materialization records, validation evidence, live pointer, rollback, or genesis recovery has to go through a sanctioned control path the supervisor validates and attests itself, never through direct facet access. Ranking the threats this way is what keeps a broader facet workspace or runtime from reading as a containment concession — it isn't one, unless it also reaches supervisor authority directly.
