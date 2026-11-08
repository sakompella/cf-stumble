# Deploy cf-stumble

Deploy a cf-stumble instance to your Cloudflare account.

cf-stumble is a coding agent that runs in your Cloudflare account. Every request except `GET /health` needs HTTP Basic auth: the user name `aditya` and the password in the `OWNER_PASSWORD` secret. The Worker answers 503 until that secret is set.

## Before you start

You need:

- A Cloudflare account on the Workers Paid plan. This project uses Durable Objects with SQLite storage, Containers, and Worker Loaders. They are not available on the free plan.
- A GitHub account.
- A domain in the same Cloudflare account for the Worker's route.
- Docker, to pull the Container image and push it to Cloudflare's registry.

The workspace runs project commands and can make Workers AI requests. Use an account where you can control the resulting charges.

## Configuration files

`infra/alchemy.run.ts` deploys the Worker. `cloudflare.config.ts` describes the same Worker for `cf` and the test runner. `infra/alchemy.run.ts` is an [Alchemy](https://alchemy.run) stack, pinned to Alchemy 2.0.0-beta.85, that declares the Worker, its route, the two Durable Object classes, the Container, and the Workers AI and loader bindings. `infra/worker-settings.ts` holds the values that both files read, so they cannot drift: the Worker name for a stage, the compatibility date and flags, the Durable Object class names, the entry point, the route, the container image, the static assets settings (`runWorkerFirst`), the cache setting, the observability settings, and the one plain-text variable, the deployment-wide `CHATGPT_MODEL` (see "Connect ChatGPT"). Neither file declares per-instance values or secrets (see "Instance secrets").

The stack is a function of the stage:

- The stage `prod` is production: the Worker `cf-stumble` on the route `stumble.akompella.dev/*`, no `workers.dev` subdomain, a `standard-3` container, and traces on.
- Any other stage `<stage>` is a separate Worker, `cf-stumble-<stage>`, with its own container application attached to its `WorkspaceHost` namespace, a `workers.dev` subdomain without preview URLs, no route, and traces off. Every stage boots the production instance size, which the Durable Object requests at launch.
- Vitest builds its Worker, `cf-stumble-test`, from `cloudflare.config.ts` in mode `test` and leaves out the Workers AI binding and the container, because the test runtime has no AI service to reach. The stack and `cloudflare.config.ts` also differ in what only one tool needs: the stack sets `workersDev` per stage and the container through `Cloudflare.Container`, while `cloudflare.config.ts` sets the container name, `maxInstances` and instance size (which the Durable Object scheduling policy refuses in the stack).

Alchemy is its own pnpm project in `infra/`, with its own lockfile, because the Worker's dependency tree, which the Container image copies, should not change for Alchemy. `pnpm install:infra` installs it; `pnpm verify` and `pnpm run deploy` run that first.

Run Alchemy from the repository root, because the stack names its files relative to it: `pnpm alchemy <command> --config infra/alchemy.run.ts --stage <stage>`. The commands you need:

- `pnpm run deploy` writes the owner page's script with `pnpm run build:page`, writes the shell module set for the isolate with `pnpm run build:shell-modules`, and deploys the stage `prod`. Alchemy does not run a build command of its own, so a deploy of another stage needs both first.
- `pnpm alchemy plan --config infra/alchemy.run.ts --stage prod` lists what a deploy would change, and changes nothing.
- `pnpm alchemy logs --config infra/alchemy.run.ts --stage prod --tail` streams the Worker's logs.
- `pnpm alchemy destroy --config infra/alchemy.run.ts --stage <stage>` deletes a stage's Worker and container application.

Alchemy keeps what it deployed for each stage in the account, in a Worker named `alchemy-state-store` (ADR-0049). The first `plan` or `deploy` on an account creates that Worker and two secrets in the account's default Secrets Store, and saves its address and token under `~/.alchemy/profiles/`. Any machine with credentials for the account reads the same state. Do not delete the state store while a stage exists: Alchemy then forgets what it deployed, and the next deploy must pass `--adopt` to take the existing resources back.

Alchemy reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, or a profile that `pnpm alchemy profile edit --profile default --add Cloudflare` writes. The staging rehearsal used the OAuth token of the `cf` login (`oauth_token` in `~/.config/cloudflare/config/default.json`, after `pnpm exec cf auth whoami` refreshed it). `cf` stays for secrets, container applications, registry images, and deployment lists, and `wrangler` stays for `wrangler tail`, the bundle size check, and the test runner.

Alchemy changes two things that `cf deploy` did not. It adds plain-text variables named `ALCHEMY_*` to the Worker. It also turns on the `new_module_registry` compatibility flag unless the Worker sets `legacy_module_registry`, so the stack sets that flag to keep the module registry that `cf deploy` used.

Use `pnpm run deploy` as the only deploy path for the Worker. If Workers Builds is connected to the Worker, disable or reconfigure it first, so that an automatic build does not deploy through another path. Alchemy does not see changes made outside it, such as a dashboard edit or a `cf deploy`: the next deploy is a no-op unless the stack changed. Deploy with `--force` to write the stack's settings again.

Do not rename or remove `Supervisor` or `WorkspaceHost`, or their bindings. Alchemy writes the Durable Object migrations, and a class that disappears from the stack can orphan or delete that class's stored data.

## Instance secrets

Values that differ per instance are Worker secrets, set once per instance and never committed. No file declares them, and an Alchemy deploy keeps secrets that the stack does not declare: the staging rehearsal set `HARNESS_REPOSITORY_URL`, `GITHUB_OAUTH_CLIENT_ID` and `GH_TOKEN`, deployed a changed Worker, and found all three afterwards. The only plain-text variable the stack declares is `CHATGPT_MODEL`, which is the same for every deployment.

| Secret                   | Required by the Worker | Purpose                                        |
| ------------------------ | ---------------------- | ---------------------------------------------- |
| `OWNER_PASSWORD`         | Yes                    | The password for HTTP Basic auth.              |
| `HARNESS_REPOSITORY_URL` | No                     | The fork the instance builds its harness from. |
| `GITHUB_OAUTH_CLIENT_ID` | No                     | The GitHub OAuth app for the device flow.      |
| `GH_TOKEN`               | No                     | An unattended-run GitHub credential.           |
| `ORB_PROVIDER_TOKEN`     | No                     | The token a workspace provider presents.       |

Set each one after the first deploy, when the Worker exists:

```sh
pnpm exec cf workers secrets update <NAME> --worker <worker> --type secret_text --text '<value>'
```

The value appears in the command line and the shell history. For a credential such as `GH_TOKEN`, keep the value in a file outside the repository, pass `--text "$(cat <file>)"`, and delete the file afterward.

Every later deploy keeps them.

Set `OWNER_PASSWORD` right after the first deploy, because until then every request but `GET /health` answers 503. Push to `main` only after the secret exists on `cf-stumble`, because that push deploys. Generate the password into a file outside the repository and pipe the file into `cf`, which reads the value from standard input when you omit `--text`:

```sh
openssl rand -base64 24 > ~/cf-stumble-owner-password
pnpm exec cf workers secrets update OWNER_PASSWORD --worker cf-stumble --type secret_text < ~/cf-stumble-owner-password
```

Keep the file in a password manager or delete it. The browser asks for the user name `aditya` and this password. For `curl` and scripts, export the password as `CF_STUMBLE_PASSWORD` and pass `-u "aditya:$CF_STUMBLE_PASSWORD"`.

A request that changes state (any method but `GET` and `HEAD`) must also come from the instance's own page: if its `Origin` header names another origin, or its `Sec-Fetch-Site` header is anything but `same-origin`, the Worker answers 403 `cross-origin-request`. `curl` sends neither header, so the Basic credential is enough.

## Deploying from CI

GitHub Actions deploys production. Two workflows in `.github/workflows/` do the work:

- `verify.yml` runs `pnpm verify` on Ubuntu for every push and every pull request.
- `deploy.yml` runs the same steps as `pnpm run deploy --yes` for the stage `prod` when Verify passes on a push to `main`. It checks out the commit that Verify tested. A concurrency group per stage lets only one deploy of a stage run at a time; a second deploy waits for the first to finish.

The normal deploy path is therefore a push or merge to `main`. The runner has Docker, so it pulls the Container image that CI published and pushes it to the account's registry. Pushing that image from the Mac through OrbStack failed with "use of closed network connection" during the staging rehearsal, which is why deploys moved to CI.

You can also start a deploy by hand from `main`: open **Actions** > **Deploy** > **Run workflow**, or run `gh workflow run deploy.yml --ref main`. Set `stage` (`-f stage=<stage>`) to deploy a staging copy, the Worker `cf-stumble-<stage>`, from CI; destroy it from a machine afterwards, which needs no Docker. The workflow skips the job when you start it from any other branch.

A runner has no terminal, so Alchemy cannot ask you to approve its plan. `--yes` approves it, and a push to `main` applies whatever the plan contains. Review changes to `infra/` in the pull request, and read the plan in the job log afterwards.

### Credentials

The deploy job reads two values from the repository settings (**Settings** > **Secrets and variables** > **Actions**):

- The secret `CLOUDFLARE_API_TOKEN`: an account API token with the permissions in the table below.
- The variable `CLOUDFLARE_ACCOUNT_ID`: the account ID. It is not secret.

| Permission group         | Scope                               | Used for                                                                                                    |
| ------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Workers Scripts Write    | Account                             | The Worker, its settings and versions, Durable Object migrations, the state store Worker, preview sessions. |
| Workers Containers Write | Account                             | The container application, its rollouts, and the registry credentials for the image push.                   |
| Secrets Store Write      | Account                             | Reading the state store's token through a preview Worker that binds the secret; Read cannot bind it.        |
| Workers Routes Write     | Zone: the zone that holds the route | The route `stumble.akompella.dev/*`.                                                                        |
| Zone Read                | Zone: the zone that holds the route | Looking up the zone ID from the zone name in the stack.                                                     |

`pnpm alchemy logs` also needs Workers Tail Read; the deploy does not.

Create the token as an account API token: **Manage Account** > **Account API Tokens** > **Create Token** > **Create Custom Token**. Add the five permissions, limit the zone permissions to the route's zone, then copy the value into the secret with `gh secret set CLOUDFLARE_API_TOKEN --repo <owner>/<repository>`, which reads it from standard input. The `cf` login cannot create tokens: its OAuth scopes do not include token management, and `pnpm exec cf accounts tokens create` answers 403 with code 9109.

### State in CI

GitHub Actions sets `CI=true`, and Alchemy then keeps no state store credentials on disk. On every run it finds the account's single Secrets Store and reads the state store's bearer token from it through a short-lived preview Worker that binds the secret. It then derives the address of the `alchemy-state-store` Worker from the account's `workers.dev` subdomain. A CI run therefore reads the same state as any machine that deploys to the account, because each one finds the store from the account. Nothing about the state is kept in GitHub. Keep exactly one Secrets Store on the account: Alchemy takes the first one it lists.

In CI, Alchemy refuses to create a missing state store or upgrade an outdated one unless the command has `--yes`. The deploy passes `--yes` to approve its plan, so it can also create or upgrade the store. Create the store from a machine before the first CI deploy, so that you see it happen: the first `pnpm alchemy plan` on the account creates it (step 3 of the switch).

## Deploy an update

A push to `main` deploys through CI (see "Deploying from CI"). To deploy from a machine instead, run `pnpm run deploy`. It pulls the published Container image, which needs Docker, and pushes it to the account's registry. On the Mac, Alchemy's push of the image's 1 GB layer through OrbStack failed with "use of closed network connection" during the staging rehearsal, so deploy from a machine only when CI cannot. Agents follow the same steps with their completion checks in `.agents/skills/cf-operations/SKILL.md`.

The checks below apply to both paths. For a deploy from CI, do steps 1 to 5 before you merge to `main`; the Deploy workflow then takes the place of `pnpm run deploy`, and the checks after the deploy stay the same.

Before you deploy:

1. Start from a clean tree on `main` and run `pnpm verify`. The commit gate runs it too, but a deploy should start from a tree you verified.
2. Set the credentials (see "Configuration files") and run `pnpm exec cf auth whoami`. It shows the account and refreshes the login that `cf` keeps in its config. `ops:check` reads `CLOUDFLARE_API_TOKEN`, else that login (see `docs/agents/design/observability.md`, "Credentials").
3. Check that the instance secrets you rely on exist: `pnpm exec cf workers secrets list --worker <worker>`. A deploy keeps secrets, so a missing one stays missing.
4. Check that the last container rollout finished. `pnpm exec cf containers applications get <container-app-id>` shows the application, and the instances call in `docs/agents/design/observability.md`, "Checking a running deployment", shows each instance's state. Find `<container-app-id>` in the applications list: it is the application whose `durable_objects.namespace_id` is the Worker's `WorkspaceHost` namespace id (`GET /accounts/<account-id>/workers/durable_objects/namespaces`). Alchemy generates the application's name.
5. Run `pnpm run build:page` and `pnpm run build:shell-modules`, then `pnpm alchemy plan --config infra/alchemy.run.ts --stage prod`, and read what it would change.

Then run `pnpm run deploy`. A deploy that rolls the Container image replaces the container. The first request afterward starts a fresh one, and files outside `/workspace` are gone, as after any restart.

After the deploy, compare against what you had before:

- The deployment list (`pnpm exec cf workers deployments list --worker <worker>`) shows a new version at 100%.
- The container application keeps its id, and its version goes up. A new application id means the deploy created a second application instead of updating the first.
- The Durable Object namespace ids for `Supervisor` and `WorkspaceHost` are unchanged, and the secret names are the same as before.
- The Worker's Observability settings still show logs, traces, and Issues on.
- `pnpm ops:check --since 1h` prints a check mark, or only findings you can explain. The idle stop fires ten minutes after the last work (`workspace.container.idle-stop`).

For a risky change, stage it first on a separate stage with its own Worker and container, then destroy it. The procedure, with the cleanup list and the proof that only the production Worker remains, is in `.agents/skills/cf-operations/SKILL.md`, "Stage a risky change".

Workers Logs keeps events for 7 days. After a deploy that changes lifecycle behavior, copy out the events you need as evidence before they expire.

## Container image

CI builds the image once. `.github/workflows/workspace-image.yml` builds `containers/computerd.Dockerfile` for linux/amd64 and pushes it to GitHub Container Registry as `ghcr.io/sakompella/cf-stumble-workspace:<hash>`, where `<hash>` is `containers/image-tag.sh`: a hash of `.dockerignore`, the Dockerfile and the patch. It skips the build when that tag exists, and on `main` it moves `latest` to it. The Deploy workflow runs it first, so a deploy always finds its image. Nothing else builds the image, and no machine builds it locally: a change to those files is the only reason to rebuild, and CI does it. The package is public (the first publish from this public repository was pullable without a login), so machines pull without credentials.

`infra/worker-settings.ts` holds that reference as `workspaceImage`, for the stack and for `cloudflare.config.ts`. Cloudflare Containers only pull images from the deploying account's managed registry or from a registry that account has configured, so a direct reference to a ghcr.io image fails with `IMAGE_REGISTRY_NOT_CONFIGURED`. Alchemy's `image` option pulls the image and pushes it to the account's registry on deploy, so the deploy needs Docker and a pull of about a gigabyte, not a build.

If you deploy by hand, use Docker. Podman does not work for this deployment because it can rewrite the image manifest when it pushes, leaving the deploy with a local digest that Cloudflare cannot find in the registry. The resulting deployment error is `IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE`.

The image also carries the packages your harness build needs, fetched from the lockfile. That makes it about a gigabyte larger and your first build several minutes faster, because the build reads packages from the image instead of the network.

## Isolate backend

The workspace also has an isolate backend, which runs shell commands in a Dynamic Worker with no container. The model picks the backend for each `bash` call through the tool's optional `backend` parameter (`isolate` or `container`); a call that names none runs in the container. The isolate has no Node, pnpm, `gh` or network, so those commands need the container. `pnpm run deploy` ships the isolate's shell modules as a static asset (the `ASSETS` binding).

## What to expect the first time

Your first submission is slow. Installing packages and bundling the harness takes most of that time. It is not stuck.

The workspace container is `standard-3` (2 vCPU, 8 GiB memory, 16 GB disk), set by `WORKSPACE_CONTAINER_INSTANCE` in `src/workspace/container-instance.ts`. Activating or rolling back a generation takes under a second.

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

The stage `prod` has no `workers.dev` subdomain. Your instance answers on the hostname you gave the Worker a route for, and nowhere else.

If you want the subdomain as well, set `workersDev` for production in `infra/alchemy.run.ts`.

## Connect a project

The workspace is a development machine. It has `git` and `gh`. Authorize GitHub inside the workspace, then connect one GitHub repository from there. The `gh` credential stays in the workspace's local GitHub configuration. The repository keeps its own files and Git history. Your browser does not receive the GitHub credential.

Set `GITHUB_OAUTH_CLIENT_ID` as a Worker secret before you authorize (see "Instance secrets"). It names the GitHub OAuth app the device flow uses. The value is public, but it is stored as a secret so that a deploy keeps it. Without it, starting the device flow answers `not-configured`.

Set the `GH_TOKEN` secret if you want an unattended run to authorize without a person at a browser. cf-stumble installs `GH_TOKEN` as the workspace credential whenever the workspace has no usable one, and treats it as a test and development path, not a second production login. A deployment with neither value set reports `disconnected`.

The page checks the GitHub connection when it loads and when you press **Check again**, and shows when the last check ran. `GET /api/github/connection` answers the last check and when it ran (`checkedAt`, in milliseconds since the epoch) without waking the workspace container. `POST /api/github/connection/refresh` runs a new check in the container. Do not poll the refresh: each one counts as workspace work, so a client that repeats it keeps the container running.

The sidebar also contains the harness project. It selects `/workspace/harness`, which is a Git clone of the harness repository. It is not a second connected repository or a separate workspace.

A connection is refused when the repository is over the size limits in `docs/agents/design/github-connection.md`, "Connecting a repository". The clone measures the repository inside the workspace, with the workspace's GitHub credential.

To remove a connected project, send `POST /api/projects/{id}/disconnect`. The request refuses an unknown project, the harness, or any request while a run is active (`run-active`). Otherwise it drops the project's conversation pointer, then its catalog entry, then its workspace clone, and disconnecting loses any uncommitted work in that clone. The conversation itself stays in storage, unused. The clone removal is best-effort: it can fail after the catalog entry is already gone, leaving the project's files on disk with no project that owns them.

## Connect ChatGPT

The model route answers from the fixed Workers AI model until you connect a ChatGPT account. After that it answers from OpenAI's Responses API with your ChatGPT subscription, using the model that `CHATGPT_MODEL` names in `infra/worker-settings.ts` (`gpt-6.1-sol`). The Supervisor keeps the access and refresh tokens in its SQLite and refreshes them itself, so you connect once per instance. Your browser and the harness never receive a token. See ADR-0047.

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

Before you submit a generation, `GET /api/status` returns `{"activeGeneration":{"generation":null,"epoch":0}}`, and a message answers 503 `no-active-generation`. That is normal on a new instance. It does not mean that the deployment failed. `GET /` serves the owner page and `GET /health` returns `{"ok":true}` before any generation exists. Any path that is not the page or the owner API answers 404.

The first generation does not happen by itself. Submit it, then activate it. With `curl`, send each request as `curl -u "aditya:$CF_STUMBLE_PASSWORD" -H 'content-type: application/json' -d '<body>' https://<your-hostname>/api/generations/submit`:

1. Send `POST /api/generations/submit` with `{"harnessCommit":"<full commit ID>"}`. Read `outcome.generation.label` from its response. The Supervisor creates the workspace as part of this submission and clones or reconciles the harness repository in `/workspace/harness`.
2. Read the epoch from `GET /api/status`, then send `POST /api/generations/activate` with `{"observedEpoch":<epoch>,"label":<label>}`. Use the label from the submission response and the epoch from the status response. A refused activation answers with a 4xx status and `{"ok":false,"problem":{"code":...}}`: 409 `stale-epoch` means the epoch moved, so read it again and resend; 409 `not-ready` means that generation has not passed its startup check; 404 `unknown-generation` means no generation has that label.

One submission extracts the requested commit, installs dependencies, bundles the module map, and stores that map in the Supervisor's SQLite storage. These are separate build steps, so a failure reports its phase. The startup check then cold-starts the candidate and asks it for its facet compatibility key. It fails the candidate unless the answer equals the key the deployed Worker holds: the pinned Pi Durable version and the host protocol revision (ADR-0048). The candidate must then answer one scripted conversation: a scripted model asks it to run one command in a scratch directory of the workspace, then the candidate must finish with the scripted reply. That conversation never reaches ChatGPT or Workers AI. A failed candidate leaves the generation that was already serving in place. Repeating a submission for a commit the Supervisor already knows returns the existing generation, so retrying it is safe.

## Point the instance at your own fork

Your instance builds its own harness from a Git repository, and it has to be told which one. Set the `HARNESS_REPOSITORY_URL` secret to the HTTPS URL of your fork (see "Instance secrets"):

```sh
pnpm exec cf workers secrets update HARNESS_REPOSITORY_URL --worker cf-stumble --type secret_text --text 'https://github.com/your-name/cf-stumble.git'
```

An empty value means the repository named in `src/harness-build.ts`, which is this project's own. Leave it empty and your instance will build this repository rather than your fork, so your own harness commits will never be reachable from it. Nothing else about a fork needs changing.

A wrong URL fails safely. The first build step tries to clone it, fails, and reports a failed candidate; the generation that was serving keeps serving.

## Run the workspace container on your own machine

An x86_64 Linux machine you own can run the workspace container instead of Cloudflare
(ADR-0050). The machine opens every connection itself, so it needs no inbound port. While no
provider is connected, the instance uses the Cloudflare container.

The page's "Workspace container" control (`GET`/`POST /api/workspace/backend`) picks the backend.
`provider` is the default: use a connected provider, else Cloudflare. `cloudflare` always uses the
Cloudflare container, even while a provider is connected. A change stops a running container, so the
next command starts on the chosen backend. It is refused while a run is active.

1. Make a random token and keep it in a file outside the repository, for example
   `openssl rand -hex 32 > ~/.config/cf-stumble/orb-token`.
2. Set it as the `ORB_PROVIDER_TOKEN` secret (see "Instance secrets"):

   ```sh
   pnpm exec cf workers secrets update ORB_PROVIDER_TOKEN --worker cf-stumble --type secret_text < ~/.config/cf-stumble/orb-token
   ```

   `cf` reads the value from stdin, so the token stays out of the command line.

3. The provider and its dispatch scripts support x86_64 Linux only for now, because the workspace
   image is linux/amd64. `stumble orb provider` logs a warning on any other platform and carries on. On the
   machine, do nothing to build the image: CI publishes it as `ghcr.io/sakompella/cf-stumble-workspace`
   (see "Container image"). The dispatch scripts default `STUMBLE_IMAGE` to the tag for the checkout's
   `containers/image-tag.sh` and pull it when it is missing; set `STUMBLE_IMAGE` to use another image.
4. Run the provider from a checkout:

   ```sh
   STUMBLE_ORB_URL=https://stumble.akompella.dev \
   STUMBLE_ORB_TOKEN="$(cat ~/.config/cf-stumble/orb-token)" \
   pnpm stumble orb provider src/stumble-cli/orb/docker-dispatch.sh
   ```

The provider reconnects by itself after a deploy. It stops its container on SIGINT or SIGTERM.

### Rootless podman on Linux (hp)

hp runs the provider with `podman-dispatch.sh`. Rootless podman's host gateway is not the host's
loopback, so the script runs the container on `pasta` with `--map-host-loopback`, and
`computer.internal` reaches the provider's `127.0.0.1` listener.

1. Pull the image once so the first start does not wait: `podman pull --platform linux/amd64 ghcr.io/sakompella/cf-stumble-workspace:$(containers/image-tag.sh)`. Never build it on hp.
2. Keep the token in `~/.config/cf-stumble/orb-provider-token` (mode 0600), and a wrapper
   `~/.config/cf-stumble/orb-provider.sh` that reads it, so the token never appears in the unit or
   the journal:

   ```sh
   #!/usr/bin/env bash
   set -euo pipefail
   STUMBLE_ORB_TOKEN="$(cat "$HOME/.config/cf-stumble/orb-provider-token")"
   export STUMBLE_ORB_TOKEN
   cd /path/to/cf-stumble
   exec pnpm stumble orb provider src/stumble-cli/orb/podman-dispatch.sh
   ```

3. Run it as a user service. Put this in `~/.config/systemd/user/stumble-orb.service`, run
   `systemctl --user enable --now stumble-orb`, and check that `journalctl --user -u stumble-orb`
   logs `connected to the Workspace Host`:

   ```ini
   [Service]
   Environment="PATH=%h/.nix-profile/bin:/etc/profiles/per-user/%u/bin:/run/wrappers/bin:/run/current-system/sw/bin"
   Environment="STUMBLE_ORB_URL=https://stumble.akompella.dev"
   ExecStart=%h/.config/cf-stumble/orb-provider.sh
   Restart=always
   RestartSec=5s

   [Install]
   WantedBy=default.target
   ```

The user needs lingering (`loginctl show-user $USER -p Linger`) for the service to start at boot
and outlive a logout. Stop it with `systemctl --user stop stumble-orb`; the instance then uses the
Cloudflare container.

Without the secret, `/orb/provider` and `/orb/computerd` answer 401 to every request. No route
mints or shows the token, and a workspace reset leaves it in place. To revoke a machine, set a new
value; the provider's socket closes when the new Worker version starts, and the old value no longer
connects. Delete the secret to turn the feature off.

The provider receives the whole workspace, including the GitHub credential. Give the token only to
a machine you trust with that.

## Cost and cleanup

Workers Paid, Container time, and Workers AI requests can cost money. The Workspace Host stops the container ten minutes after the last work (ADR-0043), so an unused instance costs little. A client that keeps calling a route that touches the workspace keeps the container running, and `pnpm ops:check` counts each call as work, so it does not report it (`docs/agents/incident-2026-09-container-cost.md`).

Delete the Worker and the Container application with `pnpm alchemy destroy --config infra/alchemy.run.ts --stage prod`, and delete the old images in the account's registry, when you no longer need the instance. Delete the `alchemy-state-store` Worker and its two Secrets Store secrets only when no stage on the account remains. Each deploy of a new image leaves the previous one in the registry as rollback history; list them with `pnpm exec cf containers images list` and remove the ones you will not roll back to with `pnpm exec cf containers images delete <repository>:<tag>`.
