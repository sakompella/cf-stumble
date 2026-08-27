# Keep exactly one decision register, and keep it indexed

`docs/agents/adr/` is the only place a resolved position is recorded. A second register is not a backup, it is a fork: this project ran three at once — a numbered `decisions.md`, an append-only `decisions.tsv` journal, and the ADRs — with no rule for which won, and by the time anyone checked, the oldest one still asserted that a generation is a commit, a model two ADRs and the glossary had already replaced.

## Consequences

Narrative belongs in `docs/agents/design/`, which carries reasoning and findings but never states a position the ADRs don't. An index at `docs/agents/adr/README.md` makes "read the ADRs touching your area" a lookup rather than a directory listing, and `test/docs/adr-index.test.ts` fails when a file is missing from it — an unenforced index rots the same way the registers did.
