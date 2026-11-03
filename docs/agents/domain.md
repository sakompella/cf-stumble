# Domain docs

Use this file to find the repository's agent-authored domain documentation. cf-stumble has one context: the glossary is `docs/agents/CONTEXT.md`, and current architecture decisions live in `docs/agents/adr/`.

## Before exploring

1. Read `docs/agents/design/overview.md` for the product and its authority boundaries.
2. Read `docs/agents/CONTEXT.md` in full for the project's terms.
3. Read `docs/agents/adr/README.md`, then the ADRs for the area you will change. ADR-0045 governs host code outside the mutable harness, and ADR-0046 the owner page.
4. Read `docs/agents/design/computer-integration.md` when the change touches the workspace or the build.
5. Read `docs/agents/status.md` for what is deployed, what was decided outside an ADR, and what is still open.

Read the other files below when their topic comes up.

## Records

Everything in `docs/agents/` is agent-authored. `docs/` outside that directory is for human-written documentation.

- `adr/` records current durable decisions. Add an ADR only when a decision is expensive to reverse, has a real alternative, and would surprise a future reader. Delete an ADR when it no longer applies.
- `design/overview.md` describes the product, its two harnesses, the workspace, and the self-improvement loop.
- `design/computer-integration.md` records the pinned Computer pair, the workspace layout, and the harness build.
- `design/github-connection.md` records how a repository is connected and where the GitHub credential lives.
- `design/observability.md` lists the structured log events and how to query them. Read it before you add a log line or diagnose a deployed fault.
- `incident-2026-09-container-cost.md` records the 2026-09 container cost incident, its causes, and how to detect a recurrence.
- `status.md` is edited in place.

Use terms from `docs/agents/CONTEXT.md` when naming project concepts in an issue, plan, or test. If a needed term is missing, reconsider the wording first and add it only when the project needs the distinction. When an existing ADR conflicts with a proposed change, state the conflict and either preserve the ADR or replace it.

The domain-modeling skill expects `CONTEXT.md` at the repository root and ADRs in `docs/adr/`. This repository keeps both under `docs/agents/`, so use the paths in this file.
