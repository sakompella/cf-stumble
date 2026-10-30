# Status

What runs in production, what was decided outside an ADR, and what is still open. Edit it in place when the state changes; Git keeps the history.

## What is deployed

Production is the Worker `cf-stumble`, deployed only with `cf deploy`. Run `pnpm exec cf workers deployments list` before you assume that production matches a commit.

On 2026-10-30 production runs `b93531c` (Worker version deployed about 14:10Z), with generation 0 (`e6e4a6e`) active at epoch 3. The container image is unchanged since 2026-10-16 because `containers/` has not changed.

The Worker has no authentication: every request reaches one Supervisor named `owner`. GitHub is connected through the `GH_TOKEN` secret, and only the harness project exists. A Workers AI turn on the harness ran a `bash` tool call and saved. ChatGPT is not connected, so turns answer from Workers AI.

## Decided outside an ADR

- **No authentication** (Aditya, 2026-10-30). Anyone who finds the URL can run turns, which use the GitHub token and cost container time. State under the old per-identity Supervisor name was abandoned, and `GH_TOKEN` reinstalls the GitHub credential on the fresh workspace.
- **No Bombadil for now** (owner, 2026-09-28). Do not add it to `pnpm verify` or run a pilot.
- **Skip Cloudflare Artifacts for now** (owner, 2026-10-02). See `design/computer-integration.md`, "Artifacts (deferred)".
- **Per-instance values are Worker secrets that no file declares.** See `docs/deploy.md`, "Instance secrets".

## Open items

1. **A polling client still costs money.** A client that repeats the connection refresh, a turn, or any other route that reaches the workspace keeps the container running. Status reads answer from the Supervisor's record and do not. See the incident record, "Not fixed".
2. **Early platform stops with an unknown reason.** On 2026-10-02 the container stopped after a transport close while `running` was `true`, at about 16:03Z, 16:32Z, and 21:25Z. These were not Host stops. Their cause is unverified, and production's processes were never sampled.
3. **Live Computer paths are not proved.** Two staging runs on 2026-09-28 connected and disconnected a public repository. They did not induce `sync.status: "pending"` or skipped entries, so the `workspace-sync-incomplete` branch is tested only with fakes. No run proved a partial copy across Workspace Host eviction, or that the clone was absent from the store after removal. See `design/github-connection.md`, "Partial copies".
4. **ChatGPT is unproved end to end.** No real ChatGPT answer has streamed yet. Reconnect from the owner page, run one turn, and check the Worker log for the call.
5. **Token usage can be undercounted.** When a provider reports no usage, or a negative or fractional count, the model route estimates usage from bytes.
6. **Pi Durable is unproved on a full deployment.** The serving facet's storage, the alarm relay and run resume were measured on a staging probe (`~/scratch/pi-durable-probe/STAGING.md`), not on this Worker. Production still runs generation 0 and its thread store; deploying this Worker drops that thread, and generation 0 answers no messages until a harness commit from the migration onward is activated.
7. **Rollback can reach a generation from before Pi Durable.** Preparation refuses such a generation, but rollback does not repeat the startup check, so rolling back to generation 0 serves code that answers every message with `generation-failed`.
8. **The Computer `ExecutionEnv` has not run against a real container.** Its conformance suite runs over a local shell and filesystem.
