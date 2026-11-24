# Domain docs

cf-stumble has one context. Its glossary is `docs/agents/CONTEXT.md` and its decisions are in `docs/agents/adr/`. The domain-modeling skill expects `CONTEXT.md` at the repo root and ADRs in `docs/adr/`; use the paths here instead.

## Before exploring

1. Read `docs/agents/design/overview.md` for the product and who has authority over what.
2. Read `docs/agents/CONTEXT.md` in full.
3. Read `docs/agents/adr/README.md`, then the ADRs for the area you will change. ADR-0045 governs host code outside the mutable harness.
4. When the change touches the workspace or the harness build, read `docs/agents/design/computer-integration.md`.

## Other records

Everything in `docs/agents/` is agent-written. Read these when their topic comes up:

- `design/github-connection.md`: connecting a repository, and where the GitHub credential lives.
- `design/observability.md`: the structured log events and how to query them. Read it before you add a log line or diagnose a deployed fault.

## Rules

- Name project concepts with the terms in `CONTEXT.md`. If a term is missing, reconsider the wording first; add a term only when the project needs the distinction.
- When a proposed change conflicts with an ADR, say so, then either keep the ADR or replace it.
- Add an ADR only for a decision that is expensive to reverse, had a real alternative, and would surprise a reader of the code. Delete an ADR when it no longer applies; Git keeps the history.
