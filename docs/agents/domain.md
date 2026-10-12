# Domain docs

Use this file to find the repository's agent-authored domain documentation. cf-stumble has one context: the glossary is `docs/agents/CONTEXT.md`, and current architecture decisions live in `docs/agents/adr/`.

## Before exploring

1. Read `docs/agents/design/overview.md` for the product and its authority boundaries.
2. Read `docs/agents/CONTEXT.md` in full for the project's terms.
3. Read `docs/agents/adr/README.md`, then the ADRs for the area you will change. ADR-0045 governs all host code outside the mutable harness, and ADR-0046 the owner page.
4. Read `docs/agents/design/computer-integration.md` when the change touches the workspace or the build.
5. Read `docs/agents/status.md` for what is deployed, what was decided outside an ADR, and what is still open.

The ignored files `docs/agents/_original-vision-audit.md` and `docs/agents/_cloudflare-viability.md` are evidence notes. They provide historical and platform research, not current decisions.

## Records and decisions

Everything in `docs/agents/` is agent-authored. `docs/` outside that directory is for human-written documentation.

- `adr/` records current durable decisions.
- `design/overview.md` describes the product, its two harnesses, the workspace, and the self-improvement loop.
- `design/computer-integration.md` records the verified Computer pair and backend roles.
- `design/github-connection.md` records how a repository is connected, where the GitHub credential
  lives, and which credential source an automated run uses.
- `status.md` records what is deployed and what is still open. Refresh it in place.
- `docs/release/v0/` records what the `v0` tag shipped, with its deployed evidence. It is history,
  not current scope.
- `incident-2026-09-container-cost.md` records the 2026-09 container cost incident, its causes, and
  how to detect a recurrence.
- `design/observability.md` lists the structured operational log events, their fields, and how to
  query them. Read it before you add a log line or diagnose a deployed fault.

Add an ADR only when a decision will be expensive to reverse, has a meaningful alternative, and would surprise a future reader. Add every surviving ADR to `docs/agents/adr/README.md`; `test/docs/adr-index.test.ts` checks the index. Delete ADRs that no longer apply instead of preserving obsolete architecture as current guidance.

## File structure

Agent-authored records live under `docs/agents/`. Run `git ls-files docs/agents` for the current file list; the reading order above identifies the records needed for architecture work.

The domain-modeling skill normally expects `CONTEXT.md` at the repository root and ADRs in `docs/adr/`. This repository keeps both under `docs/agents/`, so use the paths in this file.

## Use the glossary

Use terms from `docs/agents/CONTEXT.md` when naming project concepts in an issue, plan, or test. If a needed term is missing, reconsider the wording first and add it only when the project needs the distinction.

When an existing ADR conflicts with a proposed change, state the conflict and either preserve the ADR or replace it. Do not let a design document silently override a current decision.
