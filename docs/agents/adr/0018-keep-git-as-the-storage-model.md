# Keep Git as the storage model

The agent's authored history uses real Git objects and commits, not two SQL tables for module text and a parent column. We rejected dropping Git. The object model gives us ancestry, content-addressed deduplication of unchanged modules across generations, and history we can inspect with ordinary tools. A schema that looks simpler would need to rebuild each of those, badly.

## Consequences

ADR-0009 and ADR-0011 follow from this decision: they decide how to hold Git objects; this ADR decides to hold them at all. The cost appears in those ADRs: a project-owned codec, or whatever replaces it later.
