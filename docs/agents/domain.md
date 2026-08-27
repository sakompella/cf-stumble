# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase. This repo is **single-context**: one `docs/agents/CONTEXT.md` and one
`docs/agents/adr/`.

## Before exploring, read these

- **`docs/agents/CONTEXT.md`** — the glossary of domain terms. Not at the repo root; see the
  override note below.
- **`docs/agents/adr/README.md`** — the ADR index, grouped by area. Start here to find which ADRs touch
  the area you are about to work in, then read those.

Both exist in this repo. Read `docs/agents/CONTEXT.md` in full, and read the ADRs touching the area you are
about to work in. When a term or a decision is missing, the `/domain-modeling` skill (reached via
`/grill-with-docs` and `/improve-codebase-architecture`) adds it lazily, when that term or decision
actually gets resolved.

## Also read the design docs

Everything under `docs/agents/` is agent-generated, including the ADRs. `docs/` outside this
directory is reserved for hand-written human documentation and is currently empty. Write new
agent-authored documentation here, not there.

The directory splits three ways: `adr/` holds resolved positions, `design/` holds the reasoning
and findings behind them, and the loose files at this level are skill configuration. New design
writing goes in `design/`.

These carry the reasoning the ADRs compress away:

- **`docs/agents/design/generations.md`** — the generation data model. A commit is an ordinary commit; a
  generation is one attempted facet materialization. Materialization is immutable, activation is
  an append-only ledger.
- **`docs/agents/design/design-history.md`** — the reasoning behind the ADRs: what we thought, what changed our
  mind, and what the change cost. Retractions are left visible rather than quietly edited, so read
  the corrections as well as the conclusions.
- **`docs/agents/design/review-findings.md`** — what a green test suite does _not_ prove. Read this before
  trusting any guarantee.
- **`docs/agents/design/prior-art.md`** — what already exists in this space and what it teaches.
- **`docs/agents/design/slices.md`** — the work breakdown, each slice with a command that exits 0 or non-zero.

The decisions that used to live in a single `docs/decisions.md` have been merged into `docs/agents/adr/`,
which is now the only register of resolved positions. Nothing else should grow into a second one:
when a decision is made or revisited, it goes in `docs/agents/adr/` and the reasoning behind it goes in
`docs/agents/design/design-history.md`. A new ADR also needs a line in `docs/agents/adr/README.md`, and
`test/docs/adr-index.test.ts` fails until it has one.

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

The `/domain-modeling` skill's default layout puts `CONTEXT.md` at the repo root and ADRs at
`docs/adr/`. This repo overrides both, to `docs/agents/CONTEXT.md` and `docs/agents/adr/`, so that
everything agents generate sits under one directory. Read these paths from here rather than from
the skill, which will otherwise look at the root and find nothing.

The glossary override is the sharper of the two, because several skills name `CONTEXT.md` at the
repo root as a one-line habit rather than reading it from this config. If one of them reports no
glossary, this is why.

A `CONTEXT-MAP.md` at the root would signal a multi-context repo with per-context `CONTEXT.md`
files (that signal is still read from the root). This repo has none and is not a monorepo — the
`pnpm-workspace.yaml` present here only carries build-script approvals for esbuild and workerd,
not workspace packages.

## Use the glossary's vocabulary

When your output names a domain concept — an issue title, a refactor proposal, a hypothesis, a
test name — use the term as defined in `docs/agents/CONTEXT.md`. Don't drift to synonyms the glossary
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
