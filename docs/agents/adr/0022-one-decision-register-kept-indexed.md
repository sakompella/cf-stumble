# Keep exactly one decision register, and keep it indexed

`docs/agents/adr/` is the only place that records a resolved position. A second register creates a fork, not a backup. This project once ran three: numbered `decisions.md`, an append-only `decisions.tsv` journal, and the ADRs. No rule decided which won, and the oldest still said a generation was a commit after two ADRs and the glossary replaced that model.

## Consequences

`docs/agents/design/` holds reasoning and findings but never resolves a position the ADRs do not. The index in `docs/agents/adr/README.md` turns "read the ADRs touching your area" into a lookup instead of a directory listing. `test/docs/adr-index.test.ts` fails when a file is missing because an unenforced index rots just as the registers did.
