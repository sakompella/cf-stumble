# Contain the agent against the supervisor first, network egress second

This architecture first stops the agent from reaching the supervisor and disabling its own rollback; stopping data exfiltration comes second. Both matter, but the ranking follows the damage. An agent that leaks a file causes a bounded loss. An agent that can promote itself or quarantine its predecessor removes the mechanism that could undo anything else it does.

## Consequences

The design keeps `globalOutbound: null` for ambient egress by default. We can give the facet more room to risk data exfiltration over time because it is a bounded loss. Any path to the supervisor's registry, materialization records, validation evidence, live pointer, rollback, or genesis recovery must instead use a sanctioned control path that the supervisor validates and attests; the facet never gets direct access. A broader facet workspace or runtime is not a containment concession unless it can reach supervisor authority directly.
