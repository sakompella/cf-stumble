# Put every agent-generated document under `docs/agents/`

Everything agents wrote — the glossary, the ADRs, the design narrative and the skill configuration — lives under `docs/agents/`, and `docs/` outside it is reserved for hand-written human documentation. Provenance is the property worth being able to see at a glance in a repository where a human set direction and agents wrote nearly all the prose, and a single directory boundary shows it without a per-file convention nobody would maintain.

## Consequences

This overrides the engineering skills' expected layout twice: they assume `CONTEXT.md` at the repo root and ADRs at `docs/adr/`. Both overrides are stated in `AGENTS.md` and `docs/agents/domain.md`, which covers any skill that reads the repo config, but a skill that looks at the root by habit will report no glossary rather than failing loudly. The glossary move is the riskier of the two and was committed separately so it can be reverted on its own.
