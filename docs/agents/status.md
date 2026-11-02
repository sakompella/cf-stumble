# Status

What runs in production, what was decided outside an ADR, and what is still open. Edit it in place when the state changes; Git keeps the history.

## What is deployed

Production is the Worker `cf-stumble`. Until someone runs the procedure in `docs/deploy.md`, "Switch production from `cf deploy` to Alchemy", it is a `cf deploy` deployment from before `infra/alchemy.run.ts` existed; after the switch, only `pnpm run deploy` deploys it. Run `pnpm exec cf workers deployments list --worker cf-stumble` before you assume that production matches a commit.

On 2026-10-31 production runs `96d3607` (Worker version `cea854d2`, container image updated), with generation 6 (`96d3607`) active at epoch 22. Older generations report no or an older facet compatibility key, so activation and rollback refuse them (checked on production: rollback to generation 4 answered 409 `facet-compatibility-mismatch`). A `bash` tool call ran and a page send was answered.

The Worker has no authentication: every request reaches one Supervisor named `owner`. GitHub is connected through the `GH_TOKEN` secret, and only the harness project exists. ChatGPT is not connected, so runs answer from Workers AI. Checked on production that day: a run with a `bash` tool call saved; a retried `requestId` returned the same submission; an abort answered in 0.9 s and killed a running `sleep 120` within about 2 s; the container stopped 600 s after the last run settled.

## Decided outside an ADR

- **No authentication** (Aditya, 2026-10-30). Anyone who finds the URL can run turns, which use the GitHub token and cost container time. State under the old per-identity Supervisor name was abandoned, and `GH_TOKEN` reinstalls the GitHub credential on the fresh workspace.
- **No Bombadil for now** (Aditya, 2026-09-28). Do not add it to `pnpm verify` or run a pilot.
- **Skip Cloudflare Artifacts for now** (Aditya, 2026-10-02). See `design/computer-integration.md`, "Artifacts (deferred)".
- **Per-instance values are Worker secrets that no file declares.** See `docs/deploy.md`, "Instance secrets".
- **Old generation tables are not converted** (Aditya, 2026-11-02). Production migrated its generation table in place on the 2026-10-31 deploy, and the Supervisor no longer carries that migration: it creates only the current schema. Rows prepared before that deploy have no recorded compatibility or a bare Pi Durable version such as `1.4.0`, so activation and rollback refuse them with `facet-compatibility-mismatch`. Submitting their harness commit again re-runs the startup check under the same label, and only a commit that reports the current key passes it.
- **Generations built before per-conversation runs cannot use a project workspace, and the Supervisor now refuses them.** The Supervisor hands a capability only to a conversation whose run the facet reported, and older generations do not report runs, so their tool calls fail. Those generations report no `compatibility()` or a key other than `FACET_COMPATIBILITY`, so their startup check fails and activation and rollback refuse them with `facet-compatibility-mismatch` (HTTP 409). After deploying this change, submit and activate a generation from the deployed commit before running turns; the generation that is serving at deploy time keeps serving until you do. The Supervisor no longer reads the old `conversations.run-deadline` key; it stays in storage unused.

## Open items

1. **A polling client still costs money.** A client that repeats the connection refresh, a turn, or any other route that reaches the workspace keeps the container running. Status reads answer from the Supervisor's record and do not. See the incident record, "Not fixed".
2. **Early platform stops with an unknown reason.** On 2026-10-02 the container stopped after a transport close while `running` was `true`, at about 16:03Z, 16:32Z, and 21:25Z. These were not Host stops. Their cause is unverified, and production's processes were never sampled.
3. **Live Computer paths are not proved.** Two staging runs on 2026-09-28 connected and disconnected a public repository. They did not induce `sync.status: "pending"` or skipped entries, so the `workspace-sync-incomplete` branch is tested only with fakes. No run proved a partial copy across Workspace Host eviction, or that the clone was absent from the store after removal. See `design/github-connection.md`, "Partial copies".
4. **ChatGPT is unproved end to end.** No real ChatGPT answer has streamed yet. Reconnect from the owner page, run one turn, and check the Worker log for the call.
5. **Token usage can be undercounted.** When a provider reports no usage, or a negative or fractional count, the model route estimates usage from bytes.
6. **The Computer `ExecutionEnv` conformance suite has not run against a real container.** It runs over a local shell and filesystem; production runs use the real one.
