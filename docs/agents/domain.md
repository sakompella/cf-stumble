# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase. This repo is **single-context**: one `CONTEXT.md` and one `docs/adr/` at the root.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the glossary of domain terms.
- **`docs/adr/`** — read the ADRs that touch the area you are about to work in.

If these don't exist, **proceed silently**. Don't flag their absence and don't suggest creating
them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and
`/improve-codebase-architecture`) creates them lazily, when a term or a decision actually gets
resolved.

As of writing, neither exists yet. That is expected.

## Also read the design docs

This repo carries substantial design documentation that predates the ADR convention, and it is
the real source of truth for why things are shaped the way they are:

- **`docs/generations.md`** — the generation data model. A commit is an ordinary commit; a
  generation is one attempted facet materialization. Materialization is immutable, activation is
  an append-only ledger.
- **`docs/decisions.md`** — every resolved design decision with its reasoning, evidence and
  reversal cost. Retracted decisions are left visible with the retraction stated, rather than
  quietly edited, so read the corrections as well as the conclusions.
- **`docs/review-findings.md`** — what a green test suite does _not_ prove. Read this before
  trusting any guarantee.
- **`docs/prior-art.md`** — what already exists in this space and what it teaches.
- **`docs/slices.md`** — the work breakdown, each slice with a command that exits 0 or non-zero.

Several decisions recorded in `docs/decisions.md` would make reasonable ADRs. Converting them is
a job for `/domain-modeling` when a decision is next revisited, not a bulk migration.

## File structure

```
/
├── CONTEXT.md
├── docs/
│   ├── adr/
│   │   ├── 0001-....md
│   │   └── 0002-....md
│   ├── decisions.md
│   ├── generations.md
│   └── ...
└── src/
```

A `CONTEXT-MAP.md` at the root would signal a multi-context repo with per-context `CONTEXT.md`
files. This repo has none and is not a monorepo — the `pnpm-workspace.yaml` present here only
carries build-script approvals for esbuild and workerd, not workspace packages.

## Use the glossary's vocabulary

When your output names a domain concept — an issue title, a refactor proposal, a hypothesis, a
test name — use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary
explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing
language the project doesn't use (reconsider), or there's a real gap (note it for
`/domain-modeling`).

Note that this project's vocabulary has been deliberately sharpened at least once already:
"generation" means an _attempted facet materialization_, not a commit, and the registry is a
registry rather than "tags". Precision here is load-bearing, not pedantry.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently
overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
