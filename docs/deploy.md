# Deploy cf-stumble

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sakompella/cf-stumble)

Deploy a cf-stumble instance to your Cloudflare account.

cf-stumble is a coding agent that runs in your Cloudflare account. It has no authentication: anyone who can reach its hostname can use it.

## Before you start

You need:

- A Cloudflare account on the Workers Paid plan. This project uses Durable Objects with SQLite storage, Containers, and Worker Loaders. They are not available on the free plan.
- A GitHub account.
- A domain in the same Cloudflare account for the Worker's route.

The workspace runs project commands and can make Workers AI requests. Use an account where you can control the resulting charges.

## Deploy with the button

Select the button at the top of this page. Cloudflare copies the public source repository into your GitHub account, lets you choose names, provisions the resources declared in `wrangler.jsonc`, sets up Workers Builds, builds the project, and deploys it.

The button does not provision Containers. Workers Builds builds the Container image, but Cloudflare must create the Container application as part of the deployment. The button declares no secrets, so the first deploy works without them.

Cloudflare reads `wrangler.jsonc` to provision supported bindings. In this project, that includes the Durable Objects, Workers AI binding, and Worker Loader. A Durable Object is Cloudflare's stateful Worker component. The configuration also declares the workspace Container, but Containers are outside the button's provisioning list.

## Configuration files

`cloudflare.config.ts` is the source of truth for the Worker. It declares the Worker name, the route, the bindings, the two Durable Object classes, the Container, and the Workers AI and loader bindings. It declares one plain-text variable, the deployment-wide `CHATGPT_MODEL` (see "Connect ChatGPT"), and no per-instance values or secrets: instance values are secrets set per instance (see "Instance secrets"). `cf build` and `cf deploy` read it. `cf dev` does not work yet.

Two Wrangler files repeat these settings, because the tools that read them do not read `cloudflare.config.ts`:

- `wrangler.jsonc` is what the Deploy to Cloudflare flow and `wrangler deploy` read.
- `wrangler.test.jsonc` is what the test runner reads. It leaves out the Workers AI binding.

Both Wrangler files declare the Durable Objects with `exports`, not `migrations`, so a Wrangler deployment and a `cf` deployment state the same lifecycle. `test/docs/cloudflare-config-drift.test.ts` fails when either file differs from `cloudflare.config.ts`. When you change a setting, change all three files.

`cf dev` still fails on the Durable Object binding that points at the Worker itself when a Container is attached to that Durable Object. `cf` has no `--config` flag, so a staging copy needs its own directory with `cloudflare.config.ts`, `wrangler.config.ts`, a `package.json` that declares `wrangler` and `cf`, and a `node_modules` link. Use Wrangler for the other commands `cf` lacks: `npx wrangler tail cf-stumble` streams logs, and `npx wrangler secret put <NAME> --name cf-stumble` sets one secret. `scripts/local/dev.sh` also stays on `wrangler dev`.

Use one deploy path for the Worker. Never alternate `wrangler deploy` and `cf deploy` on the same Worker. If you switch, disable or reconfigure Workers Builds first, so that an automatic build does not deploy through the other path.

Do not remove `Supervisor` or `WorkspaceHost` from `exports`, and do not change their `storage` value. A missing or mismatched class can orphan that class's stored data. Cloudflare cannot roll a Durable Object lifecycle change back to a version from before the change, so do not rely on a rollback across the first deployment that uses `exports`.

## Instance secrets

Values that differ per instance are Worker secrets, set once per instance and never committed. `cloudflare.config.ts`, `wrangler.jsonc`, and `wrangler.test.jsonc` declare none of them. The only plain-text variable they declare is `CHATGPT_MODEL`, which is the same for every deployment and which `cf deploy` keeps because it is declared. `cf deploy` keeps undeclared secrets but removes undeclared plain-text variables, so a per-instance value cannot live in `vars` or in a `--var` flag. Do not pass `--var` to `cf deploy`. A declared secret would also be required, and a required secret makes the first deploy of a new Worker fail.

| Secret                   | Required by the Worker | Purpose                                        |
| ------------------------ | ---------------------- | ---------------------------------------------- |
| `HARNESS_REPOSITORY_URL` | No                     | The fork the instance builds its harness from. |
| `GITHUB_OAUTH_CLIENT_ID` | No                     | The GitHub OAuth app for the device flow.      |
| `GH_TOKEN`               | No                     | An unattended-run GitHub credential.           |

Set them in one of two ways:

- Put them in a JSON or `.env` file outside the repository and run `pnpm exec cf deploy --secrets-file <file>`. Delete the file afterward.
- Run `npx wrangler secret put <NAME> --name <worker>` for each name.

Every later deploy keeps them. An instance whose values are still plain-text variables must convert them with `--secrets-file`; that turns them into secrets. Running `wrangler secret put` for a name that is already a plain variable is untested.

`scripts/deploy/check-config.sh` checks that `CF_STUMBLE_HARNESS_COMMIT` is in your shell.

## Deploy an update

Deploy with `cf deploy`, run under Node through `pnpm exec cf`. It builds the Container image, which needs Docker. `cf` cannot load `cloudflare.config.ts` under Bun. Agents follow the same steps with their completion checks in `.agents/skills/cf-operations/SKILL.md`.

Before you deploy:

1. Start from a clean tree on `main` and run `pnpm verify`. The commit gate runs it too, but a deploy should start from a tree you verified.
2. Run `pnpm exec cf auth whoami`. It shows the account and refreshes the login that `cf` keeps in its config. `ops:check` does not read that config by itself: pass `--token-file ~/.config/cloudflare/config/default.json` or set `CLOUDFLARE_API_TOKEN` (see `docs/agents/design/observability.md`, "Credentials"). If more than one account is visible, set `CLOUDFLARE_ACCOUNT_ID`.
3. Check that the instance secrets you rely on exist: `npx wrangler secret list --name <worker>`. A deploy keeps secrets, so a missing one stays missing.
4. Check that the last container rollout finished. `npx wrangler containers info <container-app-id>` shows the application, and the instances call in `docs/agents/design/observability.md`, "Checking a running deployment", shows each instance's state. Find `<container-app-id>` in the applications list: the Worker's application is named `<worker>-workspacehost`.
5. Run `pnpm exec cf deploy --dry-run` first. It builds the image and lists the bindings, and it uploads nothing.

Then run `pnpm exec cf deploy`. A deploy that rolls the Container image replaces the container. The first request afterward starts a fresh one, and files outside `/workspace` are gone, as after any restart.

`cf deploy` can print "Deploy complete" and still have aborted with "Aborting the upload operation because of conflicts ... remove the --strict flag". That happens when someone last changed the live Worker in the dashboard or through the script API. Check the exit code and the deployment list, not the final line. Fix it by deploying once with the settings you want, or by re-applying the dashboard change in `cloudflare.config.ts`.

After the deploy, compare against what you had before:

- The deployment list (`pnpm exec cf workers deployments list`, with the Worker name) shows a new version at 100%.
- The container application keeps its id, and its version goes up. A new application id means the deploy created a second application instead of updating the first. Check that the `name` in `cloudflare.config.ts` still equals `<worker>-workspacehost`.
- The Durable Object namespace ids for `Supervisor` and `WorkspaceHost` are unchanged, and the secret names are the same as before.
- The Worker's Observability settings still show logs, traces, and Issues on. A configuration without `observability.issues` turns Issues off.
- `pnpm ops:check --since 1h` prints a check mark, or only findings you can explain. The idle stop fires ten minutes after the last work (`workspace.container.idle-stop`).

For a risky change, stage it first on a separate Worker with its own name and container, then delete everything you created. The procedure, with the cleanup list and the proof that only the production Worker remains, is in `.agents/skills/cf-operations/SKILL.md`, "Stage a risky change".

Workers Logs keeps events for 7 days. After a deploy that changes lifecycle behavior, copy out the events you need as evidence before they expire.

## Container image

`cloudflare.config.ts` points to `containers/computerd.Dockerfile`, not to a registry image. The Dockerfile builds `computerd`, Cloudflare Computer's container daemon, from a pinned public source commit with one small patch, then copies it into a Debian and Node image. The first image build fetches that source and its npm packages, so it takes a few minutes longer than copying a prebuilt binary.

This indirection is required. Cloudflare Containers only pull images from the deploying account's managed registry or from a registry that account has configured. A direct reference to the public image fails with `IMAGE_REGISTRY_NOT_CONFIGURED`. Workers Builds has Docker, so it builds this Dockerfile and pushes the result to the deploying account's managed registry.

If you deploy by hand, use Docker. Podman does not work for this deployment because it can rewrite the image manifest when it pushes, leaving Wrangler with a local digest that Cloudflare cannot find in the registry. The resulting deployment error is `IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE`.

The image also carries the packages your harness build needs, fetched from the lockfile. That makes it about a gigabyte larger and your first build several minutes faster, because the build reads packages from the image instead of the network.

## What to expect the first time

Your first submission is slow. Installing packages and bundling the harness takes most of that time. It is not stuck.

The workspace container is `standard-3` (2 vCPU, 8 GiB memory, 16 GB disk). Activating or rolling back a generation takes under a second.

The Workspace Host stops the container after ten minutes with no workspace work (ADR-0043), so the first request after that gap pays a cold start. An idle stop loses what a platform restart loses: files the sync does not copy into the durable store, such as `node_modules` and `/tmp`. The `workspace.container.idle-stop` event records it (`docs/agents/design/observability.md`).

## Troubleshooting a hostname that serves another site

The hostname can answer another site instead of cf-stumble.

A deployed Worker does not claim a hostname on its own. A proxied DNS record on the zone may already point that hostname somewhere else. This is often a wildcard record such as `*.example.com`.

Check the hostname in the dashboard:

- Open **Websites** > your zone > **DNS** > **Records**. Look for a record for the hostname and for a proxied wildcard record.
- Open **Workers & Pages** > your Worker > **Settings** > **Domains & Routes**. Check whether the hostname has a Worker route or custom domain.
- Run `curl -I https://<your-hostname>`. The response shows whether another site answers it.

Use a Worker route when a proxied record already covers the hostname. Add a route for `<your-hostname>/*` in the zone. A route sends matching requests to the Worker and does not write DNS.

Use a custom domain when the hostname has no record and you want Cloudflare to create one. A custom domain writes a DNS record for the hostname.

## Troubleshooting a wedged workspace

If workspace operations hang, runs fail their tool calls, routes answer `internal-error`, or GitHub status times out after a large `npm install`, a large dependency tree may be inside the durable workspace. Installing one there makes the workspace unresponsive because its files live in Durable Object storage. The managed instructions steer the agent to copy projects to container-local scratch before installing dependencies or running checks.

As the owner, send `POST /api/workspace/reset` to recover. Projects and the harness re-clone on the next use. The reset loses uncommitted work in the workspace.

## One entry point

`cloudflare.config.ts` sets `workersDev: false`, and `wrangler.jsonc` sets `"workers_dev": false`. Your instance answers on the hostname you gave the
Worker a route for, and nowhere else.

If you want the subdomain as well, set `"workers_dev": true`.

## Connect a project

The workspace is a development machine. It has `git` and `gh`. Authorize GitHub inside the workspace, then connect one GitHub repository from there. The `gh` credential stays in the workspace's local GitHub configuration. The repository keeps its own files and Git history. Your browser does not receive the GitHub credential.

Set `GITHUB_OAUTH_CLIENT_ID` as a Worker secret before you authorize (see "Instance secrets"). It names the GitHub OAuth app the device flow uses. The value is public, but it is stored as a secret so that a deploy keeps it. Without it, starting the device flow answers `not-configured`.

Set the `GH_TOKEN` secret if you want an unattended run to authorize without a person at a browser. cf-stumble installs `GH_TOKEN` as the workspace credential whenever the workspace has no usable one, and treats it as a test and development path, not a second production login. A deployment with neither value set reports `disconnected`.

The page checks the GitHub connection when it loads and when you press **Check again**, and shows when the last check ran. `GET /api/github/connection` answers the last check and when it ran (`checkedAt`, in milliseconds since the epoch) without waking the workspace container. `POST /api/github/connection/refresh` runs a new check in the container. Do not poll the refresh: each one counts as workspace work, so a client that repeats it keeps the container running.

The sidebar also contains the harness project. It selects `/workspace/harness`, which is a Git clone of the harness repository. It is not a second connected repository or a separate workspace.

A connection is refused when the repository is over the size limits in `docs/agents/design/github-connection.md`, "Connecting a repository". Set `GH_TOKEN` so the preflight can read private repositories.

To remove a connected project, send `POST /api/projects/{id}/disconnect`. The request refuses an unknown project, the harness, or any request while a run is active (`run-active`). Otherwise it drops the project's conversation pointer, then its catalog entry, then its workspace clone, and disconnecting loses any uncommitted work in that clone. The conversation itself stays in storage, unused. The clone removal is best-effort: it can fail after the catalog entry is already gone, leaving the project's files on disk with no project that owns them.

## Connect ChatGPT

The model route answers from the fixed Workers AI model until you connect a ChatGPT account. After that it answers from OpenAI's Responses API with your ChatGPT subscription, using the model that `CHATGPT_MODEL` names in `cloudflare.config.ts` (`gpt-6.1-sol`). The Supervisor keeps the access and refresh tokens in its SQLite and refreshes them itself, so you connect once per instance. Your browser and the harness never receive a token. See ADR-0047.

Connect from the owner page:

1. Select **Connect ChatGPT** in the sidebar, then open the sign-in link it shows.
2. Sign in to ChatGPT and approve cf-stumble.
3. OpenAI sends the browser to `http://127.0.0.1:1455/auth/callback?...`. Nothing listens there, so the browser shows a connection error. That is expected. Copy the whole address from the address bar.
4. Paste it into the sidebar and select **Finish**. The panel says the account is connected.

A sign-in expires after 10 minutes, and only the most recent one can be finished. The address holds a one-time code; it is useless without the verifier the Supervisor kept.

The page shows one of three states:

- **connected** (with the model name): model calls use your subscription. When OpenAI refuses a call for the plan's usage limit, the page adds **usage limit reached**, with the time the limit ends when OpenAI gave one. A call the limit refuses before it sends any output is answered by Workers AI instead, and the saved conversation shows a notice before that answer. The connection stays connected.
- **reconnect required** (with the reason): OpenAI refused the refresh token or the access token. Every model call fails with `chatgpt-reconnect-required` until you connect again or disconnect. The route does not fall back to Workers AI here, so a broken subscription is visible.
- **not connected (Workers AI fallback)**: model calls use Workers AI.

**Disconnect** deletes the stored tokens and returns the route to Workers AI. It does not revoke the grant at OpenAI. To revoke it, remove cf-stumble from your ChatGPT account's settings.

## First run

Before you submit a generation, `GET /api/status` returns `{"activeGeneration":{"generation":null,"epoch":0}}`. `GET /`, `/status`, `/generations`, and `/projects` relay to a generation and return HTTP 503 with `{"ok":false,"problem":{"code":"no-active-generation"}}`. That response is normal on a new instance. It does not mean that the deployment failed. A browser request for `/` with `Accept: text/html` still receives the owner page. `GET /health` is answered by the Worker itself, so it returns `{"ok":true}` before any generation exists.

The first generation does not happen by itself. Submit it, then activate it:

1. Send `POST /api/generations/submit` with `{"harnessCommit":"<full commit ID>"}`. Read `outcome.generation.label` from its response. The Supervisor creates the workspace as part of this submission and clones or reconciles the harness repository in `/workspace/harness`.
2. Read the epoch from `GET /api/status`, then send `POST /api/generations/activate` with `{"observedEpoch":<epoch>,"label":<label>}`. Use the label from the submission response and the epoch from the status response. A refused activation answers with a 4xx status and `{"ok":false,"problem":{"code":...}}`: 409 `stale-epoch` means the epoch moved, so read it again and resend; 409 `not-ready` means that generation has not passed its startup check; 404 `unknown-generation` means no generation has that label.

One submission extracts the requested commit, installs dependencies, bundles the module map, and stores that map in the Supervisor's SQLite storage. It cold-starts the candidate and runs `GET /` against it before it reports the candidate ready. These are separate build steps, so a failure reports its phase. The startup check also asks the candidate for its Pi Durable version and fails it unless it equals the exact version the deployed Worker pins (ADR-0048). A failed candidate leaves the generation that was already serving in place. Repeating a submission for a commit the Supervisor already knows returns the existing generation, so retrying it is safe.

A generation built before the Pi Durable migration has no conversation methods. After you deploy a Worker from the migration onward, submit and activate a harness commit from the migration onward before you send a message; until then messages answer 503 `generation-failed`. Do not roll back to an older generation: rollback does not repeat the startup check. Turn history from before the migration is not carried over.

## Point the instance at your own fork

Your instance builds its own harness from a Git repository, and it has to be told which one. Set the `HARNESS_REPOSITORY_URL` secret to the HTTPS URL of your fork (see "Instance secrets"):

```sh
printf '%s' 'https://github.com/your-name/cf-stumble.git' | npx wrangler secret put HARNESS_REPOSITORY_URL --name cf-stumble
```

An empty value means the repository named in `src/harness-build.ts`, which is this project's own. Leave it empty and your instance will build this repository rather than your fork, so your own harness commits will never be reachable from it. Nothing else about a fork needs changing.

A wrong URL fails safely. The first build step tries to clone it, fails, and reports a failed candidate; the generation that was serving keeps serving.

## Cost and cleanup

Workers Paid, Container time, and Workers AI requests can cost money. The Workspace Host stops the container ten minutes after the last work (ADR-0043), so an unused instance costs little. A client that keeps calling a route that touches the workspace keeps the container running, and `pnpm ops:check` counts each call as work, so it does not report it (`docs/agents/incident-2026-09-container-cost.md`).

Delete the Worker, the Container application, and the old images in the account's registry when you no longer need the instance. Each deploy of a new image leaves the previous one in the registry as rollback history; list them with `npx wrangler containers images list` and remove the ones you will not roll back to with `npx wrangler containers images delete <repository>:<tag>`.
