# Computer materialization without durable artifacts

## Frame

Goal. Remove durable module-map retention from the Supervisor. Rebuild a module map from a labeled harness commit through Cloudflare Computer when the Supervisor needs to mount a facet.

Constraints. Keep ADR-0003 authority, ADR-0027 commit-only Worker Loader identity, ADR-0033 epoch scope, current relay and recovery behavior, local-only execution, no deployment or provider calls, no README change, and no dependency change unless explicitly approved.

Known blocker. The repository has no `@cloudflare/computer` dependency or runtime adapter. The pinned Computer evidence is paid-account evidence only. A local implementation therefore needs an abstraction and a local fake unless the plan identifies an existing supported adapter.

## Interrogate

1. [ ] Ground the current artifact, startup, and serving paths.
2. [ ] Run Claude Opus and GPT Sol as adversarial reviewers of the no-cache proposal.
3. [ ] Synthesize a minimal design or stop on a real platform boundary.
4. [ ] If viable, pin behavior and implement in small verified units.
5. [ ] Run `pnpm verify` and independent review.
