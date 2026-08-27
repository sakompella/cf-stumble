# Domain docs

Use this file to find and apply the repository's domain documentation. This is a single-context repository: it has one glossary at `docs/agents/CONTEXT.md` and one ADR directory at `docs/agents/adr/`.

## Before exploring

1. Read `docs/agents/CONTEXT.md` in full. It defines the terms used in this project.
2. Read `docs/agents/adr/README.md`, then the ADRs for the area you will change. The index groups decisions by owner.

When the glossary or ADRs lack a resolved term or decision, use `/domain-modeling` through `/grill-with-docs` or `/improve-codebase-architecture` after the issue is resolved.

## Read the design docs too

Everything in `docs/agents/` is agent-authored. `docs/` outside it is for human-authored documentation and is empty. Put new agent-authored documentation here.

`adr/` records current decisions. `design/` records the reasoning and findings behind them. Loose files in this directory configure skills.

- `docs/agents/design/generations.md` defines the generation data model. A commit is an ordinary commit; a generation is one attempted facet materialization. Materialization is immutable and activation uses an append-only ledger.
- `docs/agents/design/design-history.md` records what changed the project's mind and what it cost. Read corrections as well as conclusions.
- `docs/agents/design/review-findings.md` records what a green suite does _not_ prove. Read it before relying on a guarantee.
- `docs/agents/design/prior-art.md` compares existing systems and records the lessons used here.
- `docs/agents/design/slices.md` is the work plan. Each slice has a command that exits 0 or non-zero.

The old `docs/decisions.md` was consolidated into `docs/agents/adr/`, which is the only decision register. Add a resolved decision there and put its reasoning in `docs/agents/design/design-history.md`. New ADRs also need an entry in `docs/agents/adr/README.md`; `test/docs/adr-index.test.ts` checks the index.

## File structure

```
/
├── docs/                              ← hand-written human docs only
│   └── agents/                        ← everything agent-generated
│       ├── CONTEXT.md                 ← the glossary
│       ├── adr/                       ← resolved positions
│       │   ├── README.md             ← the ADR index
│       │   ├── 0001-....md
│       │   └── 0002-....md
│       ├── design/                    ← reasoning and findings
│       │   ├── design-history.md
│       │   ├── generations.md
│       │   └── ...
│       ├── domain.md                 ← skill config; this file
│       ├── issue-tracker.md
│       └── triage-labels.md
└── src/
```

The `/domain-modeling` skill normally looks for `CONTEXT.md` at the repository root and ADRs in `docs/adr/`. This repository puts them in `docs/agents/CONTEXT.md` and `docs/agents/adr/`, so that all agent-authored documentation stays together. Use the paths in this file, not the skill defaults.

A root `CONTEXT-MAP.md` would indicate a multi-context repository with per-context glossaries. This repository has none and is not a monorepo. `pnpm-workspace.yaml` only approves build scripts for esbuild and workerd; it does not define workspace packages.

## Use the glossary

Use terms from `docs/agents/CONTEXT.md` whenever you name a domain concept in an issue title, refactor proposal, hypothesis, or test name. Do not substitute words listed under `_Avoid_:`.

A missing concept means either the project does not use that language or the glossary needs a new term. Reconsider the wording first; record a real gap for `/domain-modeling`.

The distinction between a generation and a commit, for example, affects the data model. A registry identifies attempts; Git tags name revisions. This vocabulary prevents those concepts from collapsing into one another.

## Flag ADR conflicts

State an ADR conflict instead of silently overriding it:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
