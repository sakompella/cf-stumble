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
- **Self-modification.** The startup check proves compatibility and a scripted tool sequence. Probation rolls back a generation only when its first real run fails because of the generation or stalls before its first model turn; a generation whose tools all return errors completes that run and is proven, and a model error leaves it unjudged, so the owner rolls those back by hand (staging check on 2026-11-14). Neither undoes an edit that returns successfully, so a lasting change goes through a pull request that the owner reviews.
- **Rollback.** A rollback loads stored code. It does not restore project files, conversation history or the Supervisor's database, and it refuses a generation whose facet compatibility differs from the current one.
- **Reset.** A workspace reset or a project disconnect destroys uncommitted work on purpose. Commit and push first. An ordinary stop or restart must not lose acknowledged writes.
- **Cost.** The idle stop and run budgets bound one run chain, not a day's spend. Nothing caps the account's bill. The owner checks `pnpm ops:check`, billing alerts and the container's state.
- **Cold starts and sign-in.** A cold container delays the first command that needs Linux. In the harness project it also delays the start of every run (ADR-0052, amendment of 2026-11-17). The page says what a run waits for before the model is asked ("preparing the workspace", a cold container start among the causes), so a start is not silent. The ChatGPT login expires and needs a reconnect now and then. A hang with no end, lost accepted work or an unreadable error is unfinished work.

## What is deployed

Production is the Worker `cf-stumble`, deployed by Alchemy since 2026-11-03: the Deploy workflow deploys the stage `prod` after Verify passes on a push to `main`, and `pnpm run deploy` does the same by hand. The switch from `cf deploy` deleted the old platform-scheduled container application `cf-stumble-workspacehost` and ran the Deploy workflow with `adopt=true` (run 41582489113). Alchemy kept the Worker, its route, its secrets `GH_TOKEN`, `GITHUB_OAUTH_CLIENT_ID` and `HARNESS_REPOSITORY_URL`, and both Durable Object namespaces, so the Supervisor's storage survived. The container application is now `cf-stumble-workspacehost-containers-prod-yu6dq3g5qsw57h7u`, scheduled by the `WorkspaceHost` namespace. Run `pnpm exec cf workers deployments list --worker cf-stumble` before you assume that production matches a commit.

The workspace image is published to GHCR by CI and pulled by the deploy and by the provider machines; no machine builds it. The isolate backend exists beside the container: a `bash` call goes to the isolate when the isolate can run every program in it, and to the container otherwise or when the model asks for the container.

The deployed commit, the active generation, its epoch and its compatibility key change with every deploy, so this file does not record them. Read the live values instead: `GET /api/status` (with Basic auth) returns the active generation's label, commit and status and its epoch; `stumble gen status` prints the same status from inside a conversation; `pnpm exec cf workers deployments list --worker cf-stumble` lists the Worker's deployments. For what merged, read `git log --first-parent` on `main`. Do not take the active generation from R2 history: `wasActive` in `history/generations/<n>.json` means that the generation was active at some point, not that it is active now.

The stack sets `codeUpdateStrategy: { mode: "immediate" }` (`infra/alchemy.run.ts`), so every `pnpm run deploy`, locally and in CI, restarts both Durable Object classes on the new version within seconds. A restart interrupts what the object is serving, so the release step that follows a production deploy repeats its calls under one 10-minute deadline (`docs/deploy.md`, "Release of main as a generation"). `cf workers secrets update` still creates its version with the default `deferred` strategy, so after a secret change an active object can keep its old code for up to 300 seconds; run `pnpm run deploy <stage> --force` to apply the new version at once. See `docs/deploy.md`, "Durable Objects and new versions". `ops:check` reports a Durable Object that still runs an old version with the `do-version-skew` rule.

Every request except `GET /health` needs HTTP Basic auth with the `OWNER_PASSWORD` secret (ADR-0051), and then reaches one Supervisor named `owner`. On 2026-11-03 GitHub was connected through the `GH_TOKEN` secret and only the harness project existed. Checked on production on 2026-11-03: a run with a `bash` tool call saved; a retried `requestId` returned the same submission; an abort answered in 0.9 s and killed a running `sleep 120` within about 2 s; the container stopped 600 s after the last run settled.

ChatGPT is connected on production and is the default model. The model route answers each call from the owner's ChatGPT subscription (`CHATGPT_MODEL`, `gpt-6.1-sol` on `prod`, `gpt-6.1-terra` on every other stage, `infra/worker-settings.ts`). It answers from Workers AI only when ChatGPT is not connected, or when ChatGPT refused the call for a usage limit before any output reached the caller. A refused refresh or a repeated 401 fails the call with `chatgpt-reconnect-required` and does not fall back (ADR-0047). Read the connection with `GET /api/chatgpt/connection`. Prompt caching was broken until `4542ce55` (merged in `afa53612`): the route sent `prompt_cache_key` without the `session_id` and `x-client-request-id` headers, so calls missed the cached prefix. After the fix a 30k-token thread on the preview went from 47% to 97% cached prompt tokens on terra and from 6% to 86% on sol, and the ChatGPT turn of `pnpm ci:local` cached 87.4%. `pnpm ops:check` prints the ChatGPT call count and cache hit rate for a window.

## Decided outside an ADR

- **No Cloudflare Access** (Aditya, 2026-10-30; Basic auth added 2026-11-03, ADR-0051). State under the old per-identity Supervisor name was abandoned, and `GH_TOKEN` reinstalls the GitHub credential on the fresh workspace.
- **The formal models are an audit tool, not part of CI.** On 2026-11-18 seven small TLA+ models of the activation, run, exec-abort, idle-stop, GitHub credential, page-outgoing and release logic were checked with everystate (`npx everystate@0.3.1`). They found real races, and five fixes followed (see "Open items"). The models and their reports sit in `.audit/session-2026-11-02/formal/`, which Git ignores. Nothing in `pnpm verify`, `package.json` or the workflows runs them. A model is a hand-written copy of the code's logic and nothing ties it to the code, so a model in CI would keep passing after the code changed under it. Run one by hand after you change the logic it describes; `pnpm test:mutation` and the Vitest property tests remain the checks in the repository (`AGENTS.md`, "Verification").
- **Skip Cloudflare Artifacts for now** (Aditya, 2026-10-02). See `design/computer-integration.md`, "Artifacts (deferred)".
- **Per-instance values are Worker secrets that no file declares.** See `docs/deploy.md`, "Instance secrets".
- **Old generation tables are not converted** (Aditya, 2026-11-02). Production migrated its generation table in place on the 2026-10-31 deploy, and the Supervisor no longer carries that migration: it creates only the current schema. Rows prepared before that deploy have no recorded compatibility or a bare Pi Durable version such as `1.4.0`, so activation and rollback refuse them with `facet-compatibility-mismatch`. Submitting their harness commit again re-runs the startup check under the same label, and only a commit that reports the current key passes it.
- **Generations built before per-conversation runs cannot use a project workspace.** The Supervisor hands a capability only to a conversation whose run the facet reported, and older generations do not report runs. Their startup check fails, so activation and rollback refuse them with `facet-compatibility-mismatch`. The Supervisor no longer reads the old `conversations.run-deadline` key; it stays in storage unused.

## Earlier open items, classified

Each item that this file used to list as open is now classified: **resolved** (with the commit that did it), **accepted limitation** (a known weakness that the contract in "What done means" tolerates, with what bounds it), or **reproduced** (a failure seen today that someone must fix). The 2026-11-14 classification checked each item against the code, not against other documents.

**Resolved**

- **ChatGPT was unproved end to end.** Resolved. ChatGPT is connected and streams real answers. `a6ff28b9` made each ChatGPT call log `chatgpt.model-call` with its outcome and token counts, and made `ops:check` print call counts and the cache hit rate per provider. `4542ce55` (merged in `afa53612`) fixed the cache misses. `tools/e2e/chatgpt.mts` runs a real ChatGPT turn in `pnpm ci:local` and skips when ChatGPT is disconnected, so a green run that skipped it proves nothing about ChatGPT.
- **Live Computer paths were not proved.** Resolved on staging stage `e2e-v1dur` on 2026-11-14 with a disposable project and throwaway branches. Container writes, including a file that a background process wrote 45 seconds after its command, were in the store after an idle stop and after a `--force` deploy that restarted the Workspace Host; the new Host adopted the running container and pulled the background write before its stop. A container edit that the store had not pulled yet (a changed file, a new file, a deleted file) survived a Host restart and reached the store with the next command, so the reconnect did not push stale store content over it. A Host restart during a project clone made the connect answer 500 `internal-error` and left no catalog entry and no directory; the next connect cloned a clean repository. A Host restart during a removal made the disconnect answer `workspace: "failed"` and left 8 entries of the clone in the store; a connect right after answered 503 `workspace-unavailable` (the earlier clone is still being removed), and the next one finished the removal and cloned again. After a completed disconnect the store had no clone. No run induced `sync.status: "pending"` itself, so the `workspace-sync-incomplete` branch is still tested only with fakes. A command interrupted during its sync can leave part of its files in the store (see "Early platform stops" below); the error tells the agent, and nothing rolls the files back.
- **The Computer `ExecutionEnv` conformance suite had not run against a real container.** Resolved on 2026-11-14: a throwaway generation on staging stage `e2e-v1dur` ran Pi Durable's `createEnvConformance`, the same 11 cases as `test/facet/generation-1/execution-env-conformance.shell.test.ts`, through the run's real project capability. All 11 passed with the routed backend (18 seconds) and with every command forced to the container (17 seconds). The runner is not kept in the repository.
- **The e2e and preview workflows could not run.** Resolved on 2026-11-14 (`55f04763`, `f604b477`, `5f868932`). `.github/workflows/preview.yml` gives its e2e step the job's `GITHUB_TOKEN` with contents write: on the `preview` stage the step only lists and deletes the run's branches, and the agent pushes with the preview Worker's own `GH_TOKEN`. `.github/workflows/e2e.yml` was deleted: a fresh stage needs a user token as its `GH_TOKEN`, because the Workspace's credential check calls `GET /user`, and the repository holds none; a throwaway stage runs from a machine with `pnpm ci:local --stage <stage>`. Preview run 43583952242 passed every step, with a real ChatGPT turn (4 answers, 94.5% of prompt tokens cached). A run cancelled during the e2e step now deletes its branches, disconnects its project, stops the harness run and rolls the preview back to the generation it found (run 43587493739).

**Accepted limitations**

- **A polling client still costs money.** A route that reaches the workspace counts as work, so a client that repeats `POST /api/github/connection/refresh`, a turn or a generation request keeps the container running. `src/api/endpoints.ts` lists which endpoints are `record-only` and answer from the Supervisor's record: status reads, the project list and the connection views are among them, so polling those costs nothing (`89fd845`). The idle stop (`WORKSPACE_IDLE_STOP_MS`, ten minutes) fires once the client goes away, and `ops:check` does not flag the poller. The owner is the only client, so the owner does not leave a script polling a workspace route. See `incident-2026-09-container-cost.md`. `docs/deploy.md`, "Stop paying for the container", gives the owner's stop procedure.
- **Early platform stops with an unknown reason.** On 2026-10-02 the container stopped after a transport close while `running` was `true`, at about 16:03Z, 16:32Z and 21:25Z. Those were not Host stops, and nobody sampled production's processes. This repository records no later case. The code cannot prevent a platform stop; it bounds the loss. `/workspace` comes from the Durable Object's store, and every `exec` pulls its changes into the store before it settles (`design/computer-integration.md`, "Container lifetime"), so an early stop loses what the sync does not copy, such as `node_modules` and `/tmp`, and the changes of a command whose sync had not finished. On staging stage `e2e-v1dur` (2026-11-14) a `kill -9` of `computerd` inside the container stood in for a platform stop. Between commands, the next container command answered `container-restarted` after 40 seconds and the one after it ran on a new container. During the sync of a command that had written 20,000 files, the command answered its output followed by `container-restarted` as an error, and the store kept 18,923 of the files (killed after 240 seconds) or none (killed after 60 seconds). The owner sees an error, never a success, and the files that reached the store stay.
- **The run that crosses the request size limit still fails.** When the route refuses a request over 1 MiB, Pi compacts and tries once more, but it keeps the newest tool round, so a round that alone is over the limit fails that run. The owner's next message compacts the round away and answers (`test/facet/generation-1/request-size-limit.test.ts`).
- **Token usage can be undercounted.** When the Workers AI stream reports no usage, or a count that is negative or not an integer, the model route estimates tokens from the request and reply bytes at three bytes per token and marks the usage `estimated` (`src/model-route-stream.ts`).

**Reproduced**

None. Every failure that the 2026-11-16 QA run, the 2026-11-16 root-cause plans, the 2026-11-18 scan and the 2026-11-18 formal verification reproduced is fixed; "Open items" lists the commits.

## Known and accepted

These were found while the fixes above were made. Each is a weakness that someone looked at, could not remove without more cost than the owner gets back, and wrote down. None is an open item.

- **Stalls seen once, with no cause shown.** While `fix-cancel-flake` reproduced the cancel flake on a throwaway stage with Workers AI, three slow moments appeared once each: an abort during a model call waited for the call and ran one more tool before the run settled (5.7 s); one `POST /messages` took 61 s while a Workspace Host alarm ran (25 s of wall time); and the Supervisor was unresponsive for about 70 s and restarted. No trace tied any of them to the code, and this repository records no later case. If one recurs, read `run.settled` and the Host's and Supervisor's `do.started` lines for the same minute.
- **A refused retry of an admitted message puts its text back in the prompt (finding E of the formal check of the page's outgoing messages).** When the Worker admitted a message, its answer was lost, and the retry meets `workspace-busy`, the page treats the refusal as "not kept" (`src/page/client/send-refusals.ts`) and restores the text although the conversation already holds the message. The owner can then send it a second time. It needs a workspace reset in progress at the retry. It was argued from the model and not run.
- **A reset plus a lost reply can still let `GH_TOKEN` replace the owner's device token.** `GitHubConnection` runs one credential operation at a time, so two installs no longer cross. The model that checked this still fails in one case: the device install's reply is lost after a Host reset, a status check reads the device credential, the reset clears the record so that check counts as stale, and the next repair installs `GH_TOKEN`. It needs a Host reset and a lost reply at once. It was found with the model and not reproduced against the code.
- **Cloudflare's cold storage start-up failure is unexplained.** Both attempts of Deploy run 44185631101 ran `Plan: no changes`, and the cold Workspace Host failed its first call after 33 and 45 seconds with `Internal error while starting up Durable Object storage caused object to be reset`, then started normally a few seconds later. The application code does not reach that point; the object used no CPU and made no RPC call. The release now recovers from it (`docs/deploy.md`, "Durable Objects and new versions"), but the cause stays with the platform. If cold starts keep failing, send Cloudflare the references from the log lines and the Host's object id. Do not reset production storage to test a theory.
- **The startup check can mistake an infrastructure fault for a failed candidate.** The check turns a candidate call that rejects into a failed stage (`mount-failed`, `conversation-failed`), so a rejected candidate call, such as one caused by a Host fault inside the check, ends the release as a failed check and not as an interruption. A rerun of the release prepares the same commit again and runs the check again.

## Open items

None. All 17 root-cause plans from 2026-11-16, the cancel flake, the release race, the 13 scan fixes and the 5 formal verification fixes are merged. The plans and reports are in `.audit/session-2026-11-02/` (kept out of Git). Commits are the merge commits on `main`.

**Root-cause plans (2026-11-16)**

- The first events connection failed on every page load: `2ad0da24`.
- Panels went stale in a second tab (F13): `29192fe7`.
- A cold start showed only `running` (F4): `33238bc8`.
- The GitHub panel kept four strings, not the Worker's state (F12): `af6b0fb4`.
- The workspace backend switch said nothing about its effect (F15): `032446df`.
- An idle stop could hang the Host (#25): `6eec8fa5`.
- The turn deadline was enforced in five places (#19): `e7cd5b5e`.
- Two ChatGPT account writes failed without a log line (#17): `96be4be1`.
- The route reported its own failures as `invalid-request` (#18): `47698b03`.
- Shell scripts took values by interpolation (#20): `9e034635`.
- A long command's output was saved twice (#23): `4415738b`.
- The e2e step limits did not stop the work, and the bundle budget measured another bundle (#26): `3c938ad6`.
- Dead config, members and prose (#28): `2d5d4c90`.
- The GitHub connection had dead fields and parsed the repository URL three times (#15): `d894d890`.
- The facet replacement was inferred from replies (#16): `cc9a0d92`.
- The Supervisor imported page code, and the CLI copied a label parser (#21): `8fbcd752`.
- Generation history was shaped like the old Git repository (#22): `242226da`.
- F14 (a reload shows fewer entries) is closed: the code is by design, and the `overview.md` sentence that invited the report is fixed (`40523a98`).

**Deploy and release race**

The CI release raced the deploy's Durable Object restart in five runs: 43934982845 (`22c80da9`), 44075948231 (`22c80da9`), 44114195991 and 44128047200 (`dd671905`) and 44185631101 (`fb3b9ac0`). Each earlier fix caught one shape of interruption in one layer. `fb3b9ac0` moved the repeat to the release step, under one deadline, and deleted the retries below it. See `docs/deploy.md`, "Durable Objects and new versions".

**Cancel flake**

The e2e cancel step flaked four times on 2026-11-16 and 2026-11-17 because a cancel that landed while a command was still starting found no operation to kill (`56e15f51`). The 97 cancel loops on a stage with the fix all settled within 2.9 s.

**Scan (2026-11-18)**

22 candidates: 16 real, 6 not an issue or not worth a fix (`supervisor-02`, which is by design, `github-02`, `github-03`, `github-04`, `tools-infra-03` and `tools-infra-04`). One branch fixed each real group:

- `supervisor-01`, a cold mount that served a replaced generation's code: `1ece1090`.
- `facet-01` and `model-chatgpt-01`, a request over 1 MiB that Pi did not compact: `33f901bb`.
- `workspace-01`, a read of `/nix` routed to the isolate: `a359e808`.
- `api-page-01`, identical prompts matched to the wrong stream entry: `82b854cb`.
- `github-01`, a stale credential check that overwrote a newer install: `41ab9d13` (its revision guard is replaced by the single permit of `b2135acd`).
- `workspace-02`, redirects in the isolate's egress gateway: `ffadade6`.
- `tools-infra-01`, the e2e run adopting the owner's connected project: `3f819f4f`.
- `api-page-02`, an unadmitted message sent into a fresh thread: `4b18bed6`.
- `workspace-03` and `workspace-04`, the orb provider reporting success for a refused stop: `7e8d33bb`.
- `tools-infra-02`, a grandchild that outlived its step: `379f0449`.
- `tools-infra-05`, the lifecycle fuzzer's status poller: `c568c891`.
- `tools-infra-06`, the browser stub's held run: `f7b99b3b`.
- `tools-infra-07`, fuzzer scratch directories left in the workspace: `0088a33e`.

**Formal verification (2026-11-18)**

Seven small TLA+ models checked with everystate. Five fixes followed; each fix passed its model again and the unfixed model still failed.

- A release could activate its generation twice after a lost activation answer: `427d44a4`.
- The page could send a message twice or lose one: `d8b0af1f`.
- The deadline continued a run the owner had cancelled: `c934d54b`.
- Two concurrent credential installs could leave the record wrong: `b2135acd`.
- A refused failure report settled a faulted run `completed`, and a cancel before the first running report was not stored: `6fb2d147`.
