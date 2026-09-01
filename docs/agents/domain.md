# Domain docs

Use this file to find the repository's agent-authored domain documentation. cf-stumble has one context: the glossary is `docs/agents/CONTEXT.md`, and current architecture decisions live in `docs/agents/adr/`.

## Before exploring

1. Read `docs/agents/design/overview.md` for the product and its authority boundaries.
2. Read `docs/agents/CONTEXT.md` in full for the project's terms.
3. Read `docs/agents/adr/README.md`, then the ADRs for the area you will change.
4. Read `docs/agents/design/feature-map.md` for the version 0 completion scope, `docs/agents/design/slices.md` for earlier implementation status, and `docs/agents/design/computer-integration.md` for the pinned Computer integration.

The ignored files `docs/agents/_original-vision-audit.md` and `docs/agents/_cloudflare-viability.md` are evidence notes. They provide historical and platform research, not current decisions.

## Records and decisions

Everything in `docs/agents/` is agent-authored. `docs/` outside that directory is for human-written documentation.

- `adr/` records current durable decisions.
- `design/overview.md` describes the product, its two harnesses, the workspace, and the self-improvement loop.
- `design/feature-map.md` defines the current version 0 completion scope and cut line.
- `design/slices.md` records the earlier implementation sequence and local evidence.
- `design/computer-integration.md` records the verified Computer pair and backend roles.

Add an ADR only when a decision will be expensive to reverse, has a meaningful alternative, and would surprise a future reader. Add every surviving ADR to `docs/agents/adr/README.md`; `test/docs/adr-index.test.ts` checks the index. Delete ADRs that no longer apply instead of preserving obsolete architecture as current guidance.

## File structure

```
/
├── docs/
│   └── agents/
│       ├── CONTEXT.md
│       ├── adr/
│       │   ├── README.md
│       │   └── 0002-....md
│       ├── design/
│       │   ├── overview.md
│       │   ├── feature-map.md
│       │   ├── computer-integration.md
│       │   └── slices.md
│       └── domain.md
└── src/
```

The domain-modeling skill normally expects `CONTEXT.md` at the repository root and ADRs in `docs/adr/`. This repository keeps both under `docs/agents/`, so use the paths in this file.

## Use the glossary

Use terms from `docs/agents/CONTEXT.md` when naming project concepts in an issue, plan, or test. If a needed term is missing, reconsider the wording first and add it only when the project needs the distinction.

When an existing ADR conflicts with a proposed change, state the conflict and either preserve the ADR or replace it. Do not let a design document silently override a current decision.
