# Let the main facet own the mutable harness

> **Review:** Human-approved

A main-facet generation may replace all main-harness code, including its model loop, prompts, tools, policies, runtime, and use of files.

The mutable harness may submit a generation candidate or request activation or rollback of a specific generation. The supervisor checks and performs those requests; the facet cannot alter protected generation state directly.

The facet sends these requests through the generation control the Supervisor attaches to the serving facet, which the `stumble gen` command calls. It shares validation and decisions with the owner's HTTP routes, and a change names the epoch it observed, so a stale request is refused. A candidate in its startup check gets no generation control. The harness may activate a generation without the owner's approval, and the startup check, which runs one scripted conversation in the candidate, is the only check before it does.
