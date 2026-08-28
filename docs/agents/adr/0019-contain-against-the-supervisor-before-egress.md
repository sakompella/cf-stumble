# Contain the agent against the supervisor first, network egress second

This architecture first stops the agent from reaching the supervisor and disabling its own rollback; stopping data exfiltration comes second. Both matter, but the ranking follows the damage. An agent that leaks a file causes a bounded loss. An agent that can promote itself or quarantine its predecessor removes the mechanism that could undo anything else it does.

## Consequences

The design keeps `globalOutbound: null` for ambient egress by default. We can give the facet more room to risk data exfiltration over time because it is a bounded loss. Any path to the supervisor's registry, materialization records, validation evidence, live pointer, rollback, or genesis recovery must instead use a sanctioned control path that the supervisor validates and attests; the facet never gets direct access. A broader facet workspace or runtime is not a containment concession unless it can reach supervisor authority directly.

Research against Cloudflare's documentation and the `workerd` source sharpened how this is enforced.
An empty `env` genuinely isolates the guest: workerd populates a dynamically loaded Worker's
environment only from the `env` it is given, so host Durable Object namespaces, secrets, service
bindings, and the loader itself are not inherited. `globalOutbound: null` blocks ambient global
`fetch()` and `connect()`. Neither, however, constrains a capability passed in deliberately - an
explicit RPC stub runs host code and can hand back further stubs. So the rule this ADR implies is
narrower than "no egress": **promotion is unreachable only while no capability passed to the facet
exposes it.** That is the invariant to check when the facet gains a model-gateway stub, since a
gateway is exactly such a capability.

Cloudflare's own products enforce the same shape, keeping credentials in private `props` the guest
cannot read and mediating privileged work behind trusted code. Their sandboxing claim is also
weaker than it first appears - Dynamic Workers is open beta and `workerd` is documented as "not a
hardened sandbox" - which supports this ADR's ranking rather than undermining it: containment
against the supervisor cannot rest on isolate integrity alone.
