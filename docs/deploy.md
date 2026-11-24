# Deploy cf-stumble

How to deploy and operate a cf-stumble instance on Cloudflare. Agents follow the same procedures, with completion checks, in `.agents/skills/cf-operations/SKILL.md`.

Every request except `GET /health` needs HTTP Basic auth with the user name `aditya` and the `OWNER_PASSWORD` secret. Until that secret is set, the Worker answers 503.

## Before you start

You need:

- A Cloudflare account on the Workers Paid plan, for Durable Objects with SQLite, Containers and Worker Loaders.
- A GitHub account.
- A domain in the same Cloudflare account. The production route is `productionRoute` in `infra/worker-settings.ts`; change it for your zone.
- Docker, to deploy from a machine.

The workspace runs commands and calls Workers AI, so use an account where you can control the charges.

## Configuration files

`infra/alchemy.run.ts` is the only description of the Worker: an [Alchemy](https://alchemy.run) stack, pinned in `infra/package.json`, that declares the Worker, its route, the `Supervisor` and `WorkspaceHost` Durable Objects, the container, the module-map R2 bucket and the bindings. There is no Wrangler config. `infra/worker-settings.ts` holds the values that the stack, the test Worker and the Worker code share, such as Worker names, compatibility flags, the route, the container size and `CHATGPT_MODEL`. Change shared values there, and keep `node:` imports out of it, because the Worker bundle includes it.

The stack sets `legacy_module_registry` on purpose; without it, Alchemy turns on `new_module_registry`. `tools/worker-startup.test.ts`, part of `pnpm verify`, starts the exact bundle Alchemy uploads in Miniflare with the production settings, so a Worker that cannot start, or an upload over 700 KiB gzip, fails before merge.

Stages:

- `prod` is the Worker `cf-stumble` on the production route, with traces on.
- Any other stage is a separate Worker `cf-stumble-<stage>` with its own container application, no route, and traces off.
- Every stage has a `workers.dev` subdomain without preview URLs and runs the production container size, `standard-3` (2 vCPU, 8 GiB memory, 16 GB disk).

Commands, run from the repository root:

- `pnpm run deploy [<stage>] [flags]` runs `infra/deploy.sh`: `install:infra`, `build:page`, `build:shell-modules`, then `alchemy deploy` for the stage (`prod` by default) with any flags such as `--yes` or `--force`. Alchemy runs no build of its own, so always deploy through this script.
- `pnpm alchemy plan --config infra/alchemy.run.ts --stage <stage>` shows what a deploy would change.
- `pnpm alchemy logs --config infra/alchemy.run.ts --stage <stage> --tail` streams logs (needs Workers Tail Read).
- `pnpm alchemy destroy --config infra/alchemy.run.ts --stage <stage>` deletes a stage's Worker and container application.
- `pnpm exec cf` handles secrets, container applications, registry images, deployment lists and auth. `pnpm exec cf auth whoami` shows the account and refreshes the `cf` login.

Alchemy reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, or a profile from `pnpm alchemy profile edit --profile default --add Cloudflare`. The `cf` login's OAuth token (`oauth_token` in `~/.config/cloudflare/config/default.json`) also works.

### Alchemy state

Alchemy records each stage's resources in a Worker named `alchemy-state-store` in the account. The first `plan` or `deploy` on an account creates it, with two secrets in the account's Secrets Store. Every machine and CI run with credentials for the account reads the same state.

- Never delete `alchemy-state-store` while a stage exists. If it is lost, the next deploy needs `--adopt` to take the existing resources back.
- Alchemy does not see changes made outside it, such as a dashboard edit, `cf deploy` or Workers Builds; the next plain deploy is a no-op. Deploy with `--force` to write the stack's settings again, and disable Workers Builds if it is connected.
- Deploy a stage from one place at a time. CI serializes its own deploys, but a deploy from a machine does not wait for CI.
- Do not rename or remove `Supervisor`, `WorkspaceHost` or their bindings. Alchemy writes the Durable Object migrations, and a class that leaves the stack can lose its data.

## Instance secrets

Per-instance values are Worker secrets. No file declares them, and a deploy keeps them.

| Secret                   | Required | Purpose                                          |
| ------------------------ | -------- | ------------------------------------------------ |
| `OWNER_PASSWORD`         | Yes      | The HTTP Basic auth password.                    |
| `HARNESS_REPOSITORY_URL` | No       | The fork the harness is built from.              |
| `GITHUB_OAUTH_CLIENT_ID` | No       | The GitHub OAuth app for the device flow.        |
| `GH_TOKEN`               | No       | A GitHub credential for unattended runs.         |
| `ORB_PROVIDER_TOKEN`     | No       | The token a workspace provider machine presents. |

The stack sets one plain-text variable, `CHATGPT_MODEL`: `gpt-6.1-sol` on `prod` and the cheaper `gpt-6.1-terra` elsewhere.

Set a secret once the Worker exists:

```sh
pnpm exec cf workers secrets update <NAME> --worker <worker> --type secret_text --text '<value>'
```

`--text` leaves the value in shell history. For a credential, omit `--text` and pipe in a file kept outside the repository:

```sh
openssl rand -base64 24 > ~/cf-stumble-owner-password
pnpm exec cf workers secrets update OWNER_PASSWORD --worker cf-stumble --type secret_text < ~/cf-stumble-owner-password
```

Keep the password in a password manager and delete the file. For `curl`, export it as `CF_STUMBLE_PASSWORD` and pass `-u "aditya:$CF_STUMBLE_PASSWORD"`. Set `OWNER_PASSWORD` on `cf-stumble` before you push to `main`, because that push deploys. A changed secret reaches the Durable Objects only after they restart (see "Durable Objects and new versions").

A request that changes state (any method but `GET` and `HEAD`) is refused with 403 `cross-origin-request` if its `Origin` header names another origin or its `Sec-Fetch-Site` is not `same-origin`. `curl` sends neither header.

## Set up a new instance

1. Set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (see "Credentials") and run `pnpm exec cf auth whoami`.
2. Run `pnpm alchemy plan --config infra/alchemy.run.ts --stage prod`. On a new account this creates the state store.
3. Run `pnpm run deploy`.
4. Set `OWNER_PASSWORD` and any other secrets, then run `pnpm run deploy --force` so the Durable Objects see them.
5. For CI, set `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `OWNER_PASSWORD` in the GitHub repository.
6. Submit and activate the first generation ("First run"), then connect GitHub and ChatGPT.

`prod` answers on its route and on `https://cf-stumble.<account subdomain>.workers.dev`.

## Durable Objects and new versions

By default, Cloudflare lets an active Durable Object keep its old code for up to 300 seconds after a deploy ([code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/)). The stack sets `codeUpdateStrategy: { mode: "immediate" }`, so every `pnpm run deploy` restarts `Supervisor` and `WorkspaceHost` on the new version within seconds. The restart interrupts their work: a running tool call ends as interrupted and the agent retries it.

A Durable Object reads secrets once, when it starts, and `cf workers secrets update` creates a version with the default strategy. After a secret change, restart the objects with `pnpm run deploy <stage> --force`, or redeploy the latest version without a build:

```sh
pnpm exec cf workers deployments create --worker <worker> --strategy percentage \
  --versions '[{"version_id":"<latest version id>","percentage":100}]' \
  --code-update-strategy-mode immediate
```

`pnpm ops:check` reports `do-version-skew` when a Durable Object still served on an older version five minutes after the latest deployment.

A restart or platform fault can interrupt a generation build, with errors such as `Durable Object reset because its code was updated.` or `Internal error while starting up Durable Object storage caused object to be reset`. This can happen a minute after a deploy, or on a cold Workspace Host with no deploy at all. The build then ends with `build-workspace-unavailable`, or the submit answers 503 `infrastructure-interrupted`. Either way, submit the same commit again; that is safe and returns the same label. Only the release step retries by itself; from the owner page or `stumble gen prepare`, resubmit yourself. `build-step-failed`, `build-output-invalid` and `build-output-missing` are real build failures.

## Deploying from CI

GitHub Actions deploys production:

- `.github/workflows/verify.yml` runs `nix develop -c pnpm verify` on every push and pull request.
- `.github/workflows/deploy.yml` runs when Verify passes on a push to `main`: it builds or finds the workspace image, then runs `pnpm run deploy prod --yes` on the tested commit. If a newer commit is already on `main`, it skips, because that commit deploys on its own run. One deploy per stage runs at a time.

To deploy by hand, run `gh workflow run deploy.yml --ref main`. Add `-f stage=<stage>` to deploy a staging copy, and destroy it from a machine afterwards.

`--yes` approves Alchemy's plan unread, so a push to `main` applies whatever the plan contains. Review `infra/` changes in the pull request and read the plan in the job log.

### Release of main as a generation

After a production deploy, the job runs `tools/release-generation.mts` to make main's commit the active generation. It does nothing when that commit is already active, or when nothing the facet bundles changed (the module map's sources, `package.json`, `pnpm-lock.yaml` and the module map build scripts). Otherwise it submits the commit and, once the startup check answers `ready`, activates it:

- 409 `run-active`: it retries every 30 seconds for 15 minutes, then stops without failing and writes "Not activated" in the job summary.
- 409 `stale-epoch`: it rereads the epoch and resends. If an earlier activation's answer was lost and the active generation has changed since, for example by a rollback, it leaves that change alone and reports "Not activated".
- 409 `drops-active-commit`: `main` lacks the active generation's commit, usually an agent change whose pull request is not merged. Merge it, or activate with `"force":true` to drop that change.
- An interrupted submit (`build-workspace-unavailable`, 503 `infrastructure-interrupted`, or a request that does not complete) is retried. The pause starts at 5 seconds and doubles up to 60, and all retries share one 10-minute deadline.

The release logs in with the repository secret `OWNER_PASSWORD` (same value as the Worker secret; `gh secret set OWNER_PASSWORD --repo <owner>/<repository>`). It calls the Worker's `workers.dev` URL, because the zone's Bot Fight Mode challenges GitHub runners on the routed hostname.

If the release job fails, the deploy has already finished and the previous generation still serves:

- `the infrastructure interrupted the release of <sha> <n> times within 10 minutes; last: <reason>`: rerun the job. A rerun stops if the commit is already active and otherwise resubmits under the same label. If a second run fails the same way, read the `[retryable=... overloaded=...]` lines in the Worker's logs (`docs/agents/design/observability.md`, "Querying") and run `pnpm ops:check`.
- `generation <n> for <sha> is not ready: <reason>`: the commit failed to build or failed its startup check; fix the commit. A `mount-failed` or `conversation-failed` stage whose reason names nothing in the commit, such as `the candidate did not answer compatibility`, can be a platform fault, so rerun once first.
- `activating generation <n> answered <code>`: fix the cause, then activate from the owner page or rerun.

"Not activated" in a successful job means the generation is ready and you decide whether it serves.

### Credentials

The workflows read the repository secret `CLOUDFLARE_API_TOKEN` and the variable `CLOUDFLARE_ACCOUNT_ID`. Create an account API token (**Manage Account** > **Account API Tokens** > **Create Custom Token**) with these permissions, and store it with `gh secret set CLOUDFLARE_API_TOKEN --repo <owner>/<repository>`:

| Permission group         | Scope             | Used for                                              |
| ------------------------ | ----------------- | ----------------------------------------------------- |
| Workers Scripts Write    | Account           | The Worker, migrations and the state store Worker.    |
| Workers Containers Write | Account           | The container application and image push.             |
| Secrets Store Write      | Account           | Reading the state store's token (Read is not enough). |
| Workers Routes Write     | Zone of the route | The production route.                                 |
| Zone Read                | Zone of the route | Looking up the zone ID.                               |

The `cf` login cannot create tokens (`pnpm exec cf accounts tokens create` answers 403, code 9109).

In CI, Alchemy finds the state store through the account's Secrets Store and `workers.dev` subdomain, so keep exactly one Secrets Store on the account. It creates or upgrades the store only with `--yes`, so create it from a machine first (see "Set up a new instance").

## Deploy an update

The normal path is a push to `main`. Deploy from a machine with `pnpm run deploy` only when CI cannot: it pulls the roughly 1 GB container image and pushes it to the account's registry, and that push has failed through OrbStack on the Mac with "use of closed network connection". Retry on a steady network.

For a CI deploy, do steps 1 to 5 before you merge; the Deploy workflow replaces step 6.

1. Start from a clean tree on `main` and run `pnpm verify`.
2. Set the credentials and run `pnpm exec cf auth whoami`.
3. Run `pnpm exec cf workers secrets list --worker <worker>`. A deploy keeps secrets, so a missing one stays missing.
4. Check that the last rollout finished: `pnpm exec cf containers applications get <container-app-id>`. The application is the one whose `durable_objects.namespace_id` is the Worker's `WorkspaceHost` namespace; Alchemy generates its name.
5. Run `pnpm run build:page` and `pnpm run build:shell-modules`, then `pnpm alchemy plan --config infra/alchemy.run.ts --stage prod`, and read the plan.
6. Run `pnpm run deploy`.

A new image replaces the container, so files outside `/workspace` are lost. If the deploy stops at "Loading stack state" with `... so it was left untouched: Rate limited`, too many deploys ran in a few minutes; nothing changed, so wait ten minutes and rerun.

After the deploy, check:

- `pnpm exec cf workers deployments list --worker <worker>` shows a new version at 100%.
- The container application kept its id and its version went up; a new id means a second application.
- The Durable Object namespace ids and secret names are unchanged.
- Observability still shows logs, traces (on `prod`) and Issues on.
- `pnpm ops:check --since 1h` prints a check mark, or only findings you can explain.

Try a risky change on its own stage first (`.agents/skills/cf-operations/SKILL.md`, "Stage"). Workers Logs keeps events for 7 days.

## Roll back a generation

A rollback switches only the harness code that serves conversations. Send `POST /api/generations/rollback` with `{"label":<n>,"observedEpoch":<epoch>}`, or run `stumble gen rollback <n> --epoch <epoch>` in a conversation. The stored module map is loaded and nothing is rebuilt. Files and conversations are untouched, so undo a bad file change with Git.

- The target must have served before (`not-previously-active`).
- A target that does not contain the serving generation's commit is refused with `drops-active-commit`; add `"force":true` to switch anyway.
- During an active run the API answers 409 `run-active`, unless the run is past its 8-minute deadline, in which case the rollback ends it.
- Probation rolls back by itself only when the first run on a new generation fails because of the generation or stalls before its first model turn. Tool errors and model errors keep it serving.

### When the host protocol changes

`FACET_COMPATIBILITY` (`src/facet/runtime-contract.ts`) is compiled into the Worker and every generation. Activation, rollback and the startup check refuse a generation with a different key (`facet-compatibility-mismatch`), but the serving generation is not rechecked, so after a deploy that changes the key it keeps serving and may fail.

- Deploy a key change together with a generation that has the new key. For `main` the release step does this; if it did not activate, submit and activate main's commit by hand.
- To return to an older host, deploy the older Worker commit, then activate a generation recorded under its key, or submit that commit.
- Generations cannot be converted to another key. Prepare a new commit.

## Container image

`.github/workflows/workspace-image.yml` builds `infra/workspace-image/computerd.Dockerfile` for linux/amd64 and pushes `ghcr.io/sakompella/cf-stumble-workspace:<hash>`, a hash of the Dockerfile and `computerd-walk.patch` (`infra/workspace-image/image-ref.sh` prints it). It skips existing tags and moves `latest` on `main`. The Deploy and Preview workflows run it first. The package is public, so pulls need no login. Do not build the image by hand; `pnpm ci:local` builds it only when the tag is not published.

Cloudflare Containers pull only from registries the account has configured, so a direct ghcr.io reference fails with `IMAGE_REGISTRY_NOT_CONFIGURED`. Alchemy pulls the image and pushes it to the account's registry on deploy (`infra/workspace-image/image.ts`). Docker is preferred; Podman works through a `docker` shim (which `pnpm ci:local` creates when `docker` is missing), though Podman can occasionally rewrite a manifest on push and fail with `IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE`.

## First run

On a new instance, `GET /api/status` returns `{"activeGeneration":{"generation":null,"epoch":0}}` and a message answers 503 `no-active-generation`. That is normal: submit and activate the first generation by hand. With `curl`, send each request as `curl -u "aditya:$CF_STUMBLE_PASSWORD" -H 'content-type: application/json' -d '<body>' https://<your-hostname>/api/generations/<action>`:

1. `POST /api/generations/submit` with `{"harnessCommit":"<full commit ID>"}`. Note `outcome.generation.label`. This also creates the workspace and clones the harness into `/workspace/harness`.
2. Read the epoch from `GET /api/status`, then `POST /api/generations/activate` with `{"observedEpoch":<epoch>,"label":<label>}`.

Activation refusals:

- 409 `stale-epoch`: reread the epoch and resend.
- 409 `not-ready`: the generation has not passed its startup check.
- 404 `unknown-generation`: no generation has that label.
- 409 `run-active`: wait for the run or cancel it, then resend.
- 409 `drops-active-commit`: the new commit lacks the active generation's commit, so changes only there would stop being served. Add `"force":true` to activate anyway.

The first submission takes several minutes, mostly installing packages and bundling. A failed build names its step. The startup check then requires the candidate's facet compatibility key to match the Worker's (ADR-0048) and runs a scripted conversation that never calls a real model. A failed candidate leaves the serving generation in place, and resubmitting a commit returns its existing generation.

## Point the instance at your own fork

Set `HARNESS_REPOSITORY_URL` to your fork's HTTPS URL:

```sh
pnpm exec cf workers secrets update HARNESS_REPOSITORY_URL --worker cf-stumble --type secret_text --text 'https://github.com/your-name/cf-stumble.git'
```

Without it, the instance builds `sakompella/cf-stumble` (`src/harness-build.ts`), and commits in your fork never reach it. A wrong URL fails the first build step and leaves the serving generation in place.

## Connect a project

The workspace has `git` and `gh`. Authorize GitHub inside the workspace, then connect a repository. The credential stays in the workspace and never reaches the browser.

- Set `GITHUB_OAUTH_CLIENT_ID` first; without it the device flow answers `not-configured`.
- Set `GH_TOKEN` to let unattended runs work without a browser login. It is installed whenever the workspace has no usable credential, and is meant for tests and development.

`GET /api/github/connection` returns the last check (`checkedAt`, epoch milliseconds) without waking the container. `POST /api/github/connection/refresh` checks again in the container. Do not poll the refresh: each call counts as workspace work and keeps the container running.

The sidebar's harness project is `/workspace/harness`, not a connected repository. Repositories over the size limits in `docs/agents/design/github-connection.md`, "Connecting a repository", are refused.

To remove a project, press **Disconnect repository** or send `POST /api/projects/{id}/disconnect`. This deletes its workspace clone, including uncommitted work. It is refused for the harness or while that project's run is active (`run-active`).

## Connect ChatGPT

Without a ChatGPT account, the model route uses Workers AI. Connected, it uses your ChatGPT subscription with the `CHATGPT_MODEL` model. The Supervisor stores and refreshes the tokens, so you connect once per instance (ADR-0047).

1. Select **Log in with ChatGPT** in the sidebar and open the sign-in link.
2. Sign in and approve cf-stumble.
3. The browser lands on `http://127.0.0.1:1455/auth/callback?...` and shows a connection error. That is expected. Copy the whole address.
4. Paste it into the sidebar and select **Finish** within 10 minutes. Only the latest sign-in can be finished.

States on the page:

- **connected**: calls use your subscription. On **usage limit reached**, a call refused before any output falls back to Workers AI, with a notice in the conversation.
- **reconnect required**: OpenAI refused the tokens. Every call fails with `chatgpt-reconnect-required`, with no fallback. Log in again, or send `POST /api/chatgpt/disconnect` to use Workers AI meanwhile.
- **not connected (Workers AI fallback)**.

**Disconnect** deletes the stored tokens but does not revoke the grant; do that in your ChatGPT account settings.

## Run the workspace container on your own machine

An x86_64 Linux machine can run the workspace container instead of Cloudflare (ADR-0050). It opens all connections itself, so it needs no inbound port. Run the provider by hand while you work. It receives the whole workspace, including the GitHub credential, so use only a machine you trust with that.

1. Create a token: `openssl rand -hex 32 > .audit/local/orb-provider-token` (`.audit/` is gitignored).
2. Set it: `pnpm exec cf workers secrets update ORB_PROVIDER_TOKEN --worker cf-stumble --type secret_text < .audit/local/orb-provider-token`.
3. Start the provider from the checkout. It pulls the image named by `infra/workspace-image/image-ref.sh` if missing (`STUMBLE_IMAGE` overrides it). With rootless podman, use `podman-dispatch.sh` instead.

   ```sh
   STUMBLE_ORB_URL=https://stumble.akompella.dev \
   STUMBLE_ORB_TOKEN="$(cat .audit/local/orb-provider-token)" \
   pnpm stumble orb provider src/stumble-cli/orb/docker-dispatch.sh
   ```

4. When it logs `connected to the Workspace Host`, set the page's **Workspace container** control to `provider` (or `POST /api/workspace/backend` with `{"backend":"provider"}`). The change stops the running container and is refused during a run.
5. When you finish, switch back to `cloudflare`, then stop the provider with Ctrl-C.

The provider reconnects after a deploy. Without the secret, `/orb/provider` and `/orb/computerd` answer 401. To revoke a machine, set a new token; delete the secret to turn the feature off.

## Troubleshooting

**The hostname serves another site.** A Worker does not claim a hostname by itself, and a proxied DNS record, often a wildcard, may already send it elsewhere. Check the zone's DNS records, the Worker's **Domains & Routes**, and `curl -I https://<your-hostname>`. If a proxied record covers the hostname, add a Worker route for `<your-hostname>/*`; a route writes no DNS. If there is no record, a custom domain creates one.

**The workspace hangs.** If workspace operations hang, tool calls fail, routes answer `internal-error`, or the GitHub status times out after a large `npm install`, a big dependency tree is probably inside the durable workspace, whose files live in Durable Object storage. Send `POST /api/workspace/reset`. It deletes everything not pushed to GitHub: uncommitted and unpushed work, local branches, the GitHub login (`GH_TOKEN` is reinstalled), and the container with `/tmp`, `node_modules` and the Nix store. Conversations, projects, generations and the ChatGPT login stay, and projects re-clone on next use. Push first.

## End-to-end run

`pnpm e2e` (`tools/e2e/run.mts`) tests a real deployment. Run it before merging a risky change to the Worker, the Supervisor, the Workspace Host or the facet. It costs container time and model calls, and needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `GH_TOKEN` (contents write on the harness repository).

Steps, each with a time limit:

1. Deploy a fresh stage `e2e-<run id>`, set its secrets and deploy again with `--force`. Check that `/shell-modules.json` answers 401 without credentials, then submit and activate the tip of `main`.
2. Product loop: connect `sakompella/cf-stumble` and have the agent push a marker commit to `e2e/<run id>`. If the repository was already connected, the step fails and cleanup leaves it alone.
3. Self-modification: the agent commits a marker to the harness on `self-modify/<run id>-gen`, runs `stumble gen prepare` and activates it; the next turn must answer.
4. ChatGPT turn, skipped unless the stage has ChatGPT connected: every answer must come from `chatgpt` with the stage's `CHATGPT_MODEL`.
5. Cleanup: `ops:check`, delete the run's branches, destroy the stage and its images, and confirm nothing is left.

A timeout, Ctrl-C or a closed terminal starts cleanup. The script prints a pass or fail line per step and exits 1 on any failure.

- `--keep` skips cleanup on a fresh stage and writes the owner password to the temporary directory.
- `--stage <stage>` or `--url <url>` targets an existing instance, which is never deployed or destroyed; set `E2E_OWNER_PASSWORD`. Cleanup disconnects the run's project and rolls back to the earlier generation.
- `--run-id <id> --cleanup` finishes a killed or kept run (the id is in the first output line). For an existing instance, run it on the same machine, because the restore state is in the temporary directory.

Prefer a fresh stage: a turn that failed in an earlier run stays in the harness conversation and can disturb the next run. No GitHub workflow runs e2e on a throwaway stage, because a fresh stage needs a user token as `GH_TOKEN`; use `pnpm ci:local --stage <stage>`.

### Preview stage and `pnpm ci:local`

The stage `preview` (Worker `cf-stumble-preview`) is never destroyed, so you connect ChatGPT on it once. `.github/workflows/preview.yml` runs on every pull request, one at a time: Verify and the image build on the head commit, deploy to `preview`, release with `tools/release-generation.mts --force` (so it can replace another branch's generation), then `pnpm e2e --stage preview --keep`. It reads the secrets `CLOUDFLARE_API_TOKEN` and `PREVIEW_OWNER_PASSWORD` and the variable `CLOUDFLARE_ACCOUNT_ID`. The agent on the preview pushes with the preview Worker's own `GH_TOKEN` secret.

`pnpm ci:local [--stage <stage>]` (`tools/ci-local.mts`) runs the same chain from a machine: Verify in `nix develop`, the image, deploy, release, e2e with the ChatGPT turn, and `ops:check`.

- Push HEAD first; the stage's harness fetches it from GitHub.
- Without `--stage` it targets `preview`, with the password from `.audit/local/preview-owner-password` in the main checkout.
- Any other stage is a throwaway with a generated password, destroyed at the end. `prod` is refused.
- Without `CLOUDFLARE_API_TOKEN` it uses the `cf` login. `GH_TOKEN` defaults to `gh auth token`.

## Stop paying for the container

The container costs money while it runs. The page, `GET /api/status`, the project list and the connection views never start it. Messages, project connect and disconnect, generation submit, activate and rollback, `POST /api/github/connection/refresh` and a workspace reset start it or keep it running. A client that keeps calling one of these routes keeps the container running, and `pnpm ops:check` does not flag it, because each call counts as work.

When you finish:

1. Let runs settle or press **Cancel turn**. A run holds the container until it settles or reaches its 8-minute deadline; a 30- or 60-minute budget continues it in new 8-minute runs.
2. Close scripts that send messages or refresh the GitHub connection. The page's event stream does not keep the container running.
3. Wait for the idle stop, ten minutes after the last workspace work (`workspace.container.idle-stop`, ADR-0043). To stop it now, switch **Workspace container** to **Provider** and back to **Cloudflare**, or send `POST /api/workspace/backend` with `{"backend":"provider"}`, then `{"backend":"cloudflare"}`.
4. Confirm with `pnpm ops:check --since 2h` (`ran-past-idle` means it ran too long) or `GET /accounts/<account-id>/containers/applications/<container-app-id>/instances` (`status.state` is `running` while it runs).

A stop loses files the sync does not keep, such as `node_modules` and `/tmp`, and the next request pays a cold start. Never use `POST /api/workspace/reset` to stop the container; it deletes the workspace. `.github/workflows/ops-check.yml` runs `ops:check` on production daily at 13:41 UTC.

## Cost and cleanup

Workers Paid, container time and Workers AI calls cost money; an idle instance costs little. To delete an instance:

1. `pnpm alchemy destroy --config infra/alchemy.run.ts --stage <stage>` deletes the Worker and container application.
2. Delete old images from the account's registry: `pnpm exec cf containers images list`, then `pnpm exec cf containers images delete <repository>:<tag>`. Each image deploy leaves the previous one there.
3. Delete `alchemy-state-store` and its two Secrets Store secrets only when no stage remains on the account.
