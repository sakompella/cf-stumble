# E8 — What the paid account has already proved, and what T1 must not re-buy

Status: CONFIRMED from `docs/agents/design/computer-integration.md`.
CORRECTS one line of the architecture critique. Scopes roadmap task T1.

## Already proved on a paid account (2026-08-29), pinned pair

Computer source `12336475c9fd03f5280a4537a707797fc0131fbd` with image
`ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11...`:

- Container commands ran after cold starts of 2.6-2.9 s.
- Files persisted across requests and stayed isolated by workspace identity.
- Toolchain present: Node 22.23.2, pnpm 11.24.0, Git, FUSE.
- Network package access worked (`pnpm add is-odd@3.0.1`).
- Repeated warm and cold requests did not reproduce Computer issue #114
  (a deployed WebSocket failure reported against 0.2.1, never reproduced on 0.3.0).

## Correction to the critique

The critique says existing paid evidence "proves only R2 and Workers AI, not Computer
build/load or the full capability path". The first half is too strong: Computer container
execution, persistence, workspace isolation, cold-start timing, and network installs ARE
already paid-verified. T1 should not spend budget re-proving them.

## What is genuinely unproved

The document's own "Deployment risk" section states the gap:

> "Paid-account tests must exercise the exact Worker Loader, facet, Computer, and
> workspace-capability path before the project treats the integration as deployable."

So T1's paid probe should target exactly that chain and nothing else:
1. Computer builds a canonical module map for a labeled harness commit — which cannot work
   today, see E1.
2. The Supervisor validates it and caches it in R2 under that commit.
3. Worker Loader loads it under the commit id as the Loader name.
4. A facet cold-starts and answers, with the workspace capability arriving as an argument
   of `startTurn` rather than through the loader environment.

Two clean builds of the same commit must also produce identical module maps (goal
criterion 7), so run step 1 twice.

## The document independently confirms E3

> "The current implementation still derives a separate Computer workspace name for each
> project and a separate name for harness builds. It must be simplified to use the shared
> workspace before version 0 is complete."

## Open risk, not a blocker

The same file records an upgrade follow-up: check whether Cloudflare has published a
supported Computer release providing the required Worker-shell, container and Durable
Object behaviour, and prefer it if the full workflow passes. Both pins must move together;
the source carries unreleased 0.3.0 while npm `latest` is 0.2.1. Tonight's run keeps the
pinned pair. Revisit only if T1 fails against it.
