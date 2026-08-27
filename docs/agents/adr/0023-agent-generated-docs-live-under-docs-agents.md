# Put every agent-generated document under `docs/agents/`

Everything agents wrote lives under `docs/agents/`: the glossary, ADRs, design narrative, and skill configuration. `docs/` outside it is for hand-written human documentation. In a repository where a human set direction and agents wrote nearly all the prose, the directory makes provenance visible at a glance without a per-file convention nobody would maintain.

## Consequences

This overrides the engineering skills' expected layout twice: they expect `CONTEXT.md` at the repo root and ADRs in `docs/adr/`. `AGENTS.md` and `docs/agents/domain.md` state both overrides, so a skill that reads repo config sees them. A skill that looks at the root by habit will report no glossary rather than fail loudly. The glossary move carries more risk, so it was committed separately and can be reverted on its own.
