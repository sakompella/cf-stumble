# Status

What runs in production, what was decided outside an ADR, and what is still open. The deployed values change with every deploy, so this file says how to read them instead of recording them. Edit it in place when a decision or an open item changes; Git keeps the history.

## What done means

Done means the single-owner product: one owner uses one cf-stumble instance for real coding work. It does not mean the multi-person, multi-project service that the README describes as a long-term aspiration. The owner can:

1. connect a project and use it for real coding work;
2. close and reopen the browser without losing accepted work, because a run outlives its browser and the page watches the conversation again after a reload;
3. cancel a run;
4. activate a harness change and undo it, by rolling back to a generation that already ran;
5. stop or restart the container, or restart the Workspace Host, without losing an acknowledged workspace write silently: the write persists, or an error such as `workspace-sync-incomplete` says that it may not have;
6. deploy an update and recover from a failed one; and
7. stop paying for the container when work ends, through the ten-minute idle stop and the finite run budgets.

Done does not need a public service, a harness that is hostile, a complete coding environment, or an aggregate dollar cap. Public signup, guest shell access, teams and roles, concurrent editing by several people, security isolation between projects, owner-selected models, steering a running turn, automatic repair agents, automatic merging of the agent's pull requests, and compatibility with every old generation are outside it.

Several limits are part of this contract and are not unfinished work:

- **Trust.** The system trusts the owner and a harness the owner approved. It is one shared development machine without isolation between repositories. See `design/overview.md`, "Who is trusted".
- **Self-modification.** The startup check proves compatibility and a scripted tool sequence. Probation rolls back a generation that fails its first real turns. Neither undoes an edit that returns successfully, so a lasting change goes through a pull request that the owner reviews.
- **Rollback.** A rollback loads stored code. It does not restore project files, conversation history or the Supervisor's database, and it refuses a generation whose facet compatibility differs from the current one.
- **Reset.** A workspace reset or a project disconnect destroys uncommitted work on purpose. Commit and push first. An ordinary stop or restart must not lose acknowledged writes.
- **Cost.** The idle stop and run budgets bound one run chain, not a day's spend. Nothing caps the account's bill. The owner checks `pnpm ops:check`, billing alerts and the container's state.
- **Cold starts and sign-in.** A cold container delays the first command that needs Linux, and the ChatGPT login expires and needs a reconnect now and then. A hang with no end, lost accepted work or an unreadable error is unfinished work.

## What is deployed

Production is the Worker `cf-stumble`, deployed by Alchemy since 2026-11-03: the Deploy workflow deploys the stage `prod` after Verify passes on a push to `main`, and `pnpm run deploy` does the same by hand. The switch from `cf deploy` deleted the old platform-scheduled container application `cf-stumble-workspacehost` and ran the Deploy workflow with `adopt=true` (run 41582489113). Alchemy kept the Worker, its route, its secrets `GH_TOKEN`, `GITHUB_OAUTH_CLIENT_ID` and `HARNESS_REPOSITORY_URL`, and both Durable Object namespaces, so the Supervisor's storage survived. The container application is now `cf-stumble-workspacehost-containers-prod-yu6dq3g5qsw57h7u`, scheduled by the `WorkspaceHost` namespace. Run `pnpm exec cf workers deployments list --worker cf-stumble` before you assume that production matches a commit.

The workspace image is published to GHCR by CI and pulled by the deploy and by the provider machines; no machine builds it. The isolate backend exists beside the container: a `bash` call goes to the isolate when the isolate can run every program in it, and to the container otherwise or when the model asks for the container.

The deployed commit, the active generation, its epoch and its compatibility key change with every deploy, so this file does not record them. Read the live values instead: `GET /api/status` (with Basic auth) returns the active generation's label, commit and status and its epoch; `stumble gen status` prints the same status from inside a conversation; `pnpm exec cf workers deployments list --worker cf-stumble` lists the Worker's deployments. For what merged, read `git log --first-parent` on `main`. Do not take the active generation from R2 history: `wasActive` in `history/generations/<n>.json` means that the generation was active at some point, not that it is active now.

The stack sets `codeUpdateStrategy: { mode: "immediate" }` (`infra/alchemy.run.ts`), so every `pnpm run deploy`, locally and in CI, restarts both Durable Object classes on the new version within seconds. A restart interrupts what the object is serving. `cf workers secrets update` still creates its version with the default `deferred` strategy, so after a secret change an active object can keep its old code for up to 300 seconds; run `pnpm run deploy <stage> --force` to apply the new version at once. See `docs/deploy.md`, "Durable Objects and new versions". `ops:check` reports a Durable Object that still runs an old version with the `do-version-skew` rule.

Every request except `GET /health` needs HTTP Basic auth with the `OWNER_PASSWORD` secret (ADR-0051), and then reaches one Supervisor named `owner`. On 2026-11-03 GitHub was connected through the `GH_TOKEN` secret and only the harness project existed. Checked on production on 2026-11-03: a run with a `bash` tool call saved; a retried `requestId` returned the same submission; an abort answered in 0.9 s and killed a running `sleep 120` within about 2 s; the container stopped 600 s after the last run settled.

ChatGPT is connected on production and is the default model. The model route answers each call from the owner's ChatGPT subscription (`CHATGPT_MODEL`, `gpt-6.1-sol` on `prod`, `gpt-6.1-terra` on every other stage, `infra/worker-settings.ts`). It answers from Workers AI only when ChatGPT is not connected, or when ChatGPT refused the call for a usage limit before any output reached the caller. A refused refresh or a repeated 401 fails the call with `chatgpt-reconnect-required` and does not fall back (ADR-0047). Read the connection with `GET /api/chatgpt/connection`. Prompt caching was broken until `4542ce55` (merged in `afa53612`): the route sent `prompt_cache_key` without the `session_id` and `x-client-request-id` headers, so calls missed the cached prefix. After the fix a 30k-token thread on the preview went from 47% to 97% cached prompt tokens on terra and from 6% to 86% on sol, and the ChatGPT turn of `pnpm ci:local` cached 87.4%. `pnpm ops:check` prints the ChatGPT call count and cache hit rate for a window.

## Decided outside an ADR

- **No Cloudflare Access** (Aditya, 2026-10-30; Basic auth added 2026-11-03, ADR-0051). State under the old per-identity Supervisor name was abandoned, and `GH_TOKEN` reinstalls the GitHub credential on the fresh workspace.
- **Bombadil stays out of `pnpm verify`** (Aditya, 2026-09-28). `@antithesishq/bombadil` is a devDependency used by the manual page fuzz (`tools/e2e/fuzz/page/`, `pnpm e2e:fuzz --area page`); it is not in `pnpm verify`.
- **Skip Cloudflare Artifacts for now** (Aditya, 2026-10-02). See `design/computer-integration.md`, "Artifacts (deferred)".
- **Per-instance values are Worker secrets that no file declares.** See `docs/deploy.md`, "Instance secrets".
- **Old generation tables are not converted** (Aditya, 2026-11-02). Production migrated its generation table in place on the 2026-10-31 deploy, and the Supervisor no longer carries that migration: it creates only the current schema. Rows prepared before that deploy have no recorded compatibility or a bare Pi Durable version such as `1.4.0`, so activation and rollback refuse them with `facet-compatibility-mismatch`. Submitting their harness commit again re-runs the startup check under the same label, and only a commit that reports the current key passes it.
- **Generations built before per-conversation runs cannot use a project workspace.** The Supervisor hands a capability only to a conversation whose run the facet reported, and older generations do not report runs. Their startup check fails, so activation and rollback refuse them with `facet-compatibility-mismatch`. The Supervisor no longer reads the old `conversations.run-deadline` key; it stays in storage unused.

## Earlier open items, classified

Each item that this file used to list as open is now classified: **resolved** (with the commit that did it), **accepted limitation** (a known weakness that the contract in "What done means" tolerates, with what bounds it), or **reproduced** (a failure seen today that someone must fix). The 2026-11-14 classification checked each item against the code, not against other documents.

**Resolved**

- **ChatGPT was unproved end to end.** Resolved. ChatGPT is connected and streams real answers. `a6ff28b9` made each ChatGPT call log `chatgpt.model-call` with its outcome and token counts, and made `ops:check` print call counts and the cache hit rate per provider. `4542ce55` (merged in `afa53612`) fixed the cache misses. `tools/e2e/chatgpt.mts` runs a real ChatGPT turn in `pnpm ci:local` and skips when ChatGPT is disconnected, so a green run that skipped it proves nothing about ChatGPT.
- **The e2e and preview workflows could not run.** Resolved on 2026-11-14 (`55f04763`, `f604b477`, `5f868932`). `.github/workflows/preview.yml` gives its e2e step the job's `GITHUB_TOKEN` with contents write: on the `preview` stage the step only lists and deletes the run's branches, and the agent pushes with the preview Worker's own `GH_TOKEN`. `.github/workflows/e2e.yml` was deleted: a fresh stage needs a user token as its `GH_TOKEN`, because the Workspace's credential check calls `GET /user`, and the repository holds none; a throwaway stage runs from a machine with `pnpm ci:local --stage <stage>`. Preview run 43583952242 passed every step, with a real ChatGPT turn (4 answers, 94.5% of prompt tokens cached). A run cancelled during the e2e step now deletes its branches, disconnects its project, stops the harness run and rolls the preview back to the generation it found (run 43587493739).

**Accepted limitations**

- **A polling client still costs money.** A route that reaches the workspace counts as work, so a client that repeats `POST /api/github/connection/refresh`, a turn or a generation request keeps the container running. `src/routes/route-pattern.ts` lists which routes are `record-only` and answer from the Supervisor's record: status reads, the project list and the connection views are among them, so polling those costs nothing (`89fd845`). The idle stop (`WORKSPACE_IDLE_STOP_MS`, ten minutes) fires once the client goes away, and `ops:check` does not flag the poller. The owner is the only client, so the owner does not leave a script polling a workspace route. See `incident-2026-09-container-cost.md`.
- **Early platform stops with an unknown reason.** On 2026-10-02 the container stopped after a transport close while `running` was `true`, at about 16:03Z, 16:32Z and 21:25Z. Those were not Host stops, and nobody sampled production's processes. This repository records no later case, and no run has reproduced one. The code cannot prevent a platform stop; it bounds the loss. `/workspace` comes from the Durable Object's store, and every `exec` pulls its changes into the store before it settles (`design/computer-integration.md`, "Container lifetime"), so an early stop loses only what the sync does not copy, such as `node_modules` and `/tmp`. The contract is that the owner sees recovery or an error. The owner-procedure check (cold start, cancel, idle stop, an early stop) is where a recurrence would show.
- **Live Computer paths are not proved.** Two staging runs on 2026-09-28 connected and disconnected a public repository. No run induced `sync.status: "pending"` or skipped entries. A command whose post-command sync is not complete, or that skipped entries, fails with `workspace-sync-incomplete` instead of reporting success (`src/workspace/computer-operations.ts`), and only fakes have exercised that branch. A copy that ends `pending` can leave a partial clone after a Workspace Host eviction, and nothing in cf-stumble detects it; `design/github-connection.md`, "Partial copies", gives the manual repair, and cf-stumble never deletes a populated clone itself. No run has proved that a clone is absent from the store after a removal. This limitation stands until a check on a disposable project exercises these cases, and the owner pushes important work before a reset or a disconnect.
- **Token usage can be undercounted.** When the Workers AI stream reports no usage, or a count that is negative or not an integer, the model route estimates tokens from the request and reply bytes at three bytes per token and marks the usage `estimated` (`src/model-route-stream.ts`).
- **The Computer `ExecutionEnv` conformance suite has not run against a real container.** `test/facet/generation-1/execution-env-conformance.shell.test.ts` runs it over a local shell and filesystem; production uses the real one. The startup check runs real commands in the container, but it is not this suite. The gap stands until someone runs the suite against a real container.

**Reproduced**

None.
