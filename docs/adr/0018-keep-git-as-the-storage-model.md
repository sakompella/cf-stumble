# Keep Git as the storage model

The agent's authored history is real Git objects and commits, not two SQL tables holding module text and a parent column. Dropping Git was proposed and rejected: ancestry, content-addressed deduplication of unchanged modules across many generations, and the ability to inspect the history with ordinary tools are all free from the object model and would each have to be rebuilt, badly, on top of a schema that started out looking simpler.

## Consequences

This is what ADR-0009, ADR-0010 and ADR-0011 are downstream of — they argue about _how_ to hold Git objects, and this is the decision to hold them at all. The cost is a real one and is paid in those ADRs: either a project-owned codec or a dependency on `@cloudflare/computer`.
