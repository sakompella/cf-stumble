# Deploy cf-stumble

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sakompella/cf-stumble)

Deploy a private, owner-only cf-stumble instance to your Cloudflare account.

cf-stumble is an owner-only coding agent. It runs in your Cloudflare account and uses Cloudflare Access to identify its one owner.

## Before you start

You need:

- A Cloudflare account on the Workers Paid plan. This project uses Durable Objects with SQLite storage, Containers, and Worker Loaders. They are not available on the free plan.
- A GitHub account.
- A domain in the same Cloudflare account if you want Cloudflare Access in front of the Worker. Access needs a hostname in an active Cloudflare zone.

The workspace runs project commands and can make Workers AI requests. Use an account where you can control the resulting charges.

## Deploy with the button

Select the button at the top of this page. Cloudflare copies the public source repository into your GitHub account, lets you choose names, provisions the resources declared in `wrangler.jsonc`, sets up Workers Builds, builds the project, and deploys it.

The button does not configure Cloudflare Access. It also does not provision Containers. Workers Builds builds the Container image, but Cloudflare must create the Container application as part of the deployment. The button declares no secrets, so the first deploy works without them. Until you set the Access secrets below, the Worker refuses every request. Complete the Access setup before you use the app.

Cloudflare reads `wrangler.jsonc` to provision supported bindings. In this project, that includes the Durable Objects, Workers AI binding, and Worker Loader. A Durable Object is Cloudflare's stateful Worker component. The configuration also declares the workspace Container, but Containers are outside the button's provisioning list.

## Configuration files

`cloudflare.config.ts` is the source of truth for the Worker. It declares the Worker name, the route, the bindings, the two Durable Object classes, the Container, and the Workers AI and loader bindings. It declares one plain-text variable, the deployment-wide `CHATGPT_MODEL` (see "Connect ChatGPT"), and no per-instance values or secrets: instance values are secrets set per instance (see "Instance secrets"). `cf build` reads it and passes. `cf deploy` passed on staging (see below). `cf dev` does not work yet.

Two Wrangler files repeat these settings, because the tools that read them do not read `cloudflare.config.ts`:

- `wrangler.jsonc` is what the Deploy to Cloudflare flow and `wrangler deploy` read.
- `wrangler.test.jsonc` is what the test runner reads. It leaves out the Workers AI binding.

Both Wrangler files declare the Durable Objects with `exports`, not `migrations`, so a Wrangler deployment and a `cf` deployment state the same lifecycle. `test/docs/cloudflare-config-drift.test.ts` fails when either file differs from `cloudflare.config.ts`. When you change a setting, change all three files.

`cf deploy` was tested on a staging Worker on 2026-10-01 (cf 1.0.0-beta.9, Wrangler 4.145). `cf deploy --dry-run` passed twice, and a real `cf deploy` to an existing staging Worker succeeded with no `script_name` error. Afterward the Durable Object namespace IDs, the container application ID, the `v2` migration tag, and the Supervisor's SQLite state were unchanged. The staging WorkspaceHost data was not checked, because its new container never got an instance. A `wrangler deploy` of the `exports` configuration onto a Worker that was on `migrations` v1 and v2 also succeeded: it kept the namespace IDs and the container application, and it reported no export changes. The earlier suspicion that `cf deploy` fails like `cf dev` was wrong. The production instance of this project deploys with `cf deploy` (see "Deploy an update").

`cf dev` still fails on the Durable Object binding that points at the Worker itself when a Container is attached to that Durable Object. `cf` has no `--config` flag, so a staging copy needs its own directory with `cloudflare.config.ts`, `wrangler.config.ts`, a `package.json` that declares `wrangler` and `cf`, and a `node_modules` link. Use Wrangler for the other commands `cf` lacks: `npx wrangler tail cf-stumble` streams logs, and `npx wrangler secret put <NAME> --name cf-stumble` sets one secret. `scripts/local/dev.sh` also stays on `wrangler dev`.

Use one deploy path for the Worker. Never alternate `wrangler deploy` and `cf deploy` on the same Worker. If you switch, disable or reconfigure Workers Builds first, so that an automatic build does not deploy through the other path.

Do not remove `Supervisor` or `WorkspaceHost` from `exports`, and do not change their `storage` value. A missing or mismatched class can orphan that class's stored data. Cloudflare cannot roll a Durable Object lifecycle change back to a version from before the change, so do not rely on a rollback across the first deployment that uses `exports`.

## Instance secrets

Values that differ per instance are Worker secrets, set once per instance and never committed. `cloudflare.config.ts`, `wrangler.jsonc`, and `wrangler.test.jsonc` declare none of them. The only plain-text variable they declare is `CHATGPT_MODEL`, which is the same for every deployment and which `cf deploy` keeps because it is declared. `cf deploy` keeps undeclared secrets but removes undeclared plain-text variables, so a per-instance value cannot live in `vars` or in a `--var` flag. Do not pass `--var` to `cf deploy`. A declared secret would also be required, and a required secret makes the first deploy of a new Worker fail.

| Secret                                                          | Required by the Worker       | Purpose                                                                                         |
| --------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `CF_ACCESS_OWNER_SUB` | Yes                          | The Access check. Without them the Worker refuses every request.                                |
| `CF_ACCESS_AGENT_CLIENT_ID`                                     | No                           | The Client ID of the service token admitted as the owner. See "Agent access without a sign-in". |
| `HARNESS_REPOSITORY_URL`                                        | No                           | The fork the instance builds its harness from.                                                  |
| `GITHUB_OAUTH_CLIENT_ID`                                        | No                           | The GitHub OAuth app for the device flow.                                                       |
| `GH_TOKEN`                                                      | No                           | An unattended-run GitHub credential.                                                            |
| `CF_ACCESS_PUBLIC_KEYS`                                         | Must be absent in production | Replaces the Access signing keys with local ones. Staging and local development only.           |

Set them in one of two ways, after the Access login for the three Access values:

- Put them in a JSON or `.env` file outside the repository and run `pnpm exec cf deploy --secrets-file <file>`. Delete the file afterward.
- Run `npx wrangler secret put <NAME> --name <worker>` for each name.

Every later deploy keeps them. An instance whose values are still plain-text variables must convert them with `--secrets-file`; that turns them into secrets. Running `wrangler secret put` for a name that is already a plain variable is untested.

`cf deploy` stops with "Aborting the upload operation because of conflicts ... remove the --strict flag" when someone last changed the live Worker through the dashboard or the script API, and it still prints "Deploy complete". Check the exit code. `wrangler secret put` does not cause this. A Worker last deployed by Wrangler or `cf` does not hit it either. The one-path rule still applies: do not alternate `wrangler deploy` and `cf deploy` on one Worker.

`scripts/deploy/check-config.sh` checks that the three Access values and `CF_STUMBLE_HARNESS_COMMIT` are in your shell before you write the secrets file.

## Deploy an update

Deploy with `cf deploy`, run under Node through `pnpm exec cf`. It builds the Container image, which needs Docker. `cf` cannot load `cloudflare.config.ts` under Bun. Agents follow the same steps with their completion checks in `.agents/skills/cf-operations/SKILL.md`.

Before you deploy:

1. Start from a clean tree on `main` and run `pnpm verify`. The commit gate runs it too, but a deploy should start from a tree you verified.
2. Run `pnpm exec cf auth whoami`. It shows the account and refreshes the login that `cf` keeps in its config. `ops:check` does not read that config by itself: pass `--token-file ~/.config/cloudflare/config/default.json` or set `CLOUDFLARE_API_TOKEN` (see `docs/agents/design/observability.md`, "Credentials"). If more than one account is visible, set `CLOUDFLARE_ACCOUNT_ID`.
3. Check that the instance secrets exist: `npx wrangler secret list --name <worker>` shows `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, and `CF_ACCESS_OWNER_SUB`, and does not show `CF_ACCESS_PUBLIC_KEYS`. It shows `CF_ACCESS_AGENT_CLIENT_ID` if agents reach the instance with a service token. A deploy keeps secrets, so a missing one stays missing and the Worker refuses every request. `CF_ACCESS_PUBLIC_KEYS` replaces the Access signing keys, so anyone who holds the matching private key could sign in as the owner.
4. Check that the last container rollout finished. `npx wrangler containers info <container-app-id>` shows the application, and the instances call in `docs/agents/design/observability.md`, "Query recipes", shows each instance's state. Find `<container-app-id>` in the applications list: the Worker's application is named `<worker>-workspacehost`.
5. Run `pnpm exec cf deploy --dry-run` first. It builds the image and lists the bindings, and it uploads nothing.

Then run `pnpm exec cf deploy`. A deploy that rolls the Container image replaces the container. The first request afterward starts a fresh one, and files outside `/workspace` are gone, as after any restart.

`cf deploy` can print "Deploy complete" and still have aborted with "Aborting the upload operation because of conflicts ... remove the --strict flag". That happens when someone last changed the live Worker in the dashboard or through the script API. Check the exit code and the deployment list, not the final line. Fix it by deploying once with the settings you want, or by re-applying the dashboard change in `cloudflare.config.ts`.

After the deploy, compare against what you had before:

- The deployment list (`pnpm exec cf workers deployments list`, with the Worker name) shows a new version at 100%.
- The container application keeps its id, and its version goes up. A new application id means the deploy created a second application instead of updating the first. Check that the `name` in `cloudflare.config.ts` still equals `<worker>-workspacehost`.
- The Durable Object namespace ids for `Supervisor` and `WorkspaceHost` are unchanged, and the secret names are the same as before.
- The Worker's Observability settings still show logs, traces, and Issues on. A configuration without `observability.issues` turns Issues off.
- `pnpm ops:check --since 1h` prints a check mark, or only findings you can explain. A cold start can write two to four `placement-unavailable` rows. The idle stop fires ten minutes after the last work (`workspace.container.idle-stop`).

If an instance first runs a version that moved the GitHub credential under `/workspace` (commits `3adf75c` to `fad987a`), the credential on that instance's old container is lost once. Authorize GitHub again from the page, or let `GH_TOKEN` reinstall it. Later deploys keep it.

For a risky change, stage it first on a separate Worker with its own name and container, then delete everything you created. The procedure, with the cleanup list and the proof that only the production Worker remains, is in `.agents/skills/cf-operations/SKILL.md`, "Stage a risky change".

Workers Logs keeps events for 7 days. After a deploy that changes lifecycle behavior, copy out the events you need as evidence before they expire.

## Container image

`cloudflare.config.ts` points to `containers/computerd.Dockerfile`, not to a registry image. The Dockerfile builds `computerd`, Cloudflare Computer's container daemon, from a pinned public source commit with one small patch, then copies it into a Debian and Node image. The first image build fetches that source and its npm packages, so it takes a few minutes longer than copying a prebuilt binary.

This indirection is required. Cloudflare Containers only pull images from the deploying account's managed registry or from a registry that account has configured. A direct reference to the public image fails with `IMAGE_REGISTRY_NOT_CONFIGURED`. Workers Builds has Docker, so it builds this Dockerfile and pushes the result to the deploying account's managed registry.

If you deploy by hand, use Docker. Podman does not work for this deployment because it can rewrite the image manifest when it pushes, leaving Wrangler with a local digest that Cloudflare cannot find in the registry. The resulting deployment error is `IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE`.

The image also carries the packages your harness build needs, fetched from the lockfile. That makes it about a gigabyte larger and your first build several minutes faster, because the build reads packages from the image instead of the network.

## What to expect the first time

Your first submission is slow. Installing packages and bundling the harness takes most of that time. It is not stuck.

The workspace container is `standard-3` (2 vCPU, 8 GiB memory, 16 GB disk). The times below are historical: they were measured on the smaller `standard-1` container (0.5 vCPU) before this project moved to `standard-3`, and have not been re-measured on the current size. A submission took between five and eight minutes end to end. Activating a generation took under a second, rolling back to an earlier one took a quarter of a second, and a coding turn with three tool calls took ten seconds.

On the earlier `standard-1` container, a cold start added ten to sixty seconds to the first request after an idle period. That time has not been re-measured on `standard-3`.

The Workspace Host stops the container after ten minutes with no workspace work (ADR-0043), so the first request after that gap pays a cold start. An idle stop loses what a platform restart loses: files the sync does not copy into the durable store, such as `node_modules` and `/tmp`. The `workspace.container.idle-stop` event records it (`docs/agents/design/observability.md`).

## Configure Cloudflare Access

The Worker rejects every route until you configure Access. Set up Access after the deployment and before the first normal use.

1. Create your Zero Trust team if you do not already have one.
2. In the Cloudflare dashboard, open **Zero Trust** > **Access controls** > **Applications**. Create a new application, choose **Self-hosted and private**, and add the public hostname that serves this Worker. Choose a hostname in the Cloudflare zone in your account.
3. Add one Allow policy for your own identity. Access denies requests that do not match an Allow policy.
4. Save the application and sign in to that hostname once. Then read your own `sub` claim. The simplest way is to open `https://<your-hostname>/cdn-cgi/access/get-identity` in the same browser, which returns your Access identity as JSON. The other way is to decode the `CF_Authorization` cookie, which is an ordinary JWT whose payload carries `sub` and `aud`.
5. Set the three values below as Worker secrets (see "Instance secrets"), then deploy or save so the Worker picks them up.

| Worker value            | Value to set                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `CF_ACCESS_TEAM_DOMAIN` | Your Zero Trust team domain. It is the domain that identifies the Zero Trust team.                               |
| `CF_ACCESS_AUD`         | The application audience tag. The dashboard shows it on the application, and it is the `aud` claim in the token. |
| `CF_ACCESS_OWNER_SUB`   | The `sub` claim in your own Access token after your first login.                                                 |

These three are not declared in the configuration, so the first deploy works before you have them. Set them after you sign in to the deployed hostname, because `CF_ACCESS_OWNER_SUB` only exists then. A request with a valid Access credential gets 500 `invalid-configuration` until all three are set; a request with no credential, or with one the Worker cannot verify, gets 401.

Do not use another person's token to set `CF_ACCESS_OWNER_SUB`. The Worker accepts only the identity whose `sub` claim matches this value.

The deployed smoke test verified the safe order. A request with no credential receives 401. A request that carries a credential while the Access values are missing receives 500 for `invalid-configuration`. This is deliberate. The Worker does not choose a default owner while configuration is incomplete.

## Agent access without a sign-in

An agent can read and operate the production owner API without the owner signing in to Access. It sends a Cloudflare Access service token. Access checks the token against a Service Auth policy and passes the request to the Worker with a signed assertion. A service token's assertion has an empty `sub` and carries the token's Client ID in `common_name`. The Worker checks the signature, issuer, audience, and expiry as for a person's token. Then it admits the token as the owner when `common_name` equals the `CF_ACCESS_AGENT_CLIENT_ID` secret. The agent reaches the owner's own Supervisor, so it sees the same projects and generations as the owner. Any other service token is refused with 401 (`missing-identity`), and so is every service token while the secret is unset or blank.

Production was set up this way on 2026-10-12:

- The service token `cf-stumble-agent` (id `4972e490-1b5d-41b8-aa0f-a688cc76b8ee`) was created with a duration of one year. The id is not a secret. The Client Secret is, and Cloudflare shows it only once, when the token is created.
- The reusable policy "cf-stumble agent service token" (id `b9d78057-3a03-4c96-9e48-6a2fc138f3f0`) has the decision `non_identity`, which the dashboard calls Service Auth. It includes only that service token. It is attached to the `stumble` Access application at precedence 2, after the owner's Allow policy.
- The application's session duration is 730 hours.
- The token's values are in `.audit/local/access-service-token.json` in the owner's checkout, with mode 600. The file holds `clientId`, `clientSecret`, `tokenId`, and `expiresAt`. `.audit/` is ignored by Git, so the file is never committed.

On 2026-10-12 a request with the token passed Access, and Access set a `CF_Authorization` cookie. The assertion it sent had `sub` set to `""` and `common_name` set to the Client ID. The Worker deployed then answered 401 with `missing-identity`, because it did not yet read `common_name`. A deploy that includes the agent token check fixes that.

To set this up on another instance:

1. Create a service token: **Zero Trust** > **Access controls** > **Service credentials** > **Service Tokens** > **Create Service Token**, or `pnpm exec cf zero-trust access service-tokens create`. Copy the Client ID and Client Secret into a local file outside Git.
2. Add a policy to the Access application with the action Service Auth (`non_identity` in the API) and one Include rule for that service token. Without a Service Auth policy, Access sends the caller to the identity provider login.
3. Set the Worker secret to the token's Client ID, which is also the value Access puts in `common_name`: `jq -r .clientId <file> | npx wrangler secret put CF_ACCESS_AGENT_CLIENT_ID --name <worker>`. A deploy keeps it.

An agent sends the token in two headers on every request, `CF-Access-Client-Id` and `CF-Access-Client-Secret`. This command reads them from the file and pipes them to curl, so the secret does not appear in the process list:

```sh
jq -r '"CF-Access-Client-Id: \(.clientId)\nCF-Access-Client-Secret: \(.clientSecret)"' \
  .audit/local/access-service-token.json |
  curl -sS -H @- https://stumble.akompella.dev/api/status
```

When the token is refused, the response says which side refused it. A 401 with the body `Unauthorized` comes from the Worker: `CF_ACCESS_AGENT_CLIENT_ID` is unset or differs from the Client ID, or the deployed Worker has no agent token check. The Worker logs it as `access.refused` with `reason: "missing-identity"`. Any other refusal, such as a 403 or a redirect to the login page, comes from Access: the token is expired, revoked, or not included in the Service Auth policy, or the Client Secret is wrong.

The owner API refuses a `POST` whose `Origin` header is not the page's own origin, and a service token does not change that. Add `-H 'Origin: https://stumble.akompella.dev'` to every `POST`. The Worker removes the two service token headers, like the Access assertion and cookie, before it relays a request to a generation.

To replace the Client Secret, run `pnpm exec cf zero-trust access service-tokens rotate <token-id>` and write the new secret into the file. The Client ID stays the same, so the Worker secret does not change. To withdraw the token, run `pnpm exec cf zero-trust access service-tokens delete <token-id>` and delete the Worker secret. `pnpm exec cf zero-trust access applications revoke-tokens <app-id>` ends every session issued for the application, the owner's browser session included. The token expires after one year (`expiresAt` in the file). Before then, run `pnpm exec cf zero-trust access service-tokens refresh <token-id>` to extend it, and update `expiresAt`.

## Troubleshooting a hostname that serves another site

Access can accept your login and then show a page that is not cf-stumble. The hostname can also answer another site before Access appears.

A deployed Worker does not claim a hostname on its own. A proxied DNS record on the zone may already point that hostname somewhere else. This is often a wildcard record such as `*.example.com`.

Check the hostname in the dashboard:

- Open **Websites** > your zone > **DNS** > **Records**. Look for a record for the hostname and for a proxied wildcard record.
- Open **Workers & Pages** > your Worker > **Settings** > **Domains & Routes**. Check whether the hostname has a Worker route or custom domain.
- Run `curl -I https://<your-hostname>`. The response shows whether Access redirects the request or another site answers it.

Use a Worker route when a proxied record already covers the hostname. Add a route for `<your-hostname>/*` in the zone. A route sends matching requests to the Worker and does not write DNS.

Use a custom domain when the hostname has no record and you want Cloudflare to create one. A custom domain writes a DNS record for the hostname.

## Troubleshooting a wedged workspace

If workspace operations hang, turns end with `turn-not-started` or `internal-error`, or GitHub status times out after a large `npm install`, a large dependency tree may be inside the durable workspace. Installing one there makes the workspace unresponsive because its files live in Durable Object storage. The managed instructions steer the agent to copy projects to container-local scratch before installing dependencies or running checks.

As the owner, send `POST /api/workspace/reset` to recover. Projects and the harness re-clone on the next use. The reset loses uncommitted work in the workspace.

## One entry point

`cloudflare.config.ts` sets `workersDev: false`, and `wrangler.jsonc` sets `"workers_dev": false`. Your instance answers on the hostname you gave the
Worker a route for, and nowhere else.

This is deliberate. A `workers.dev` subdomain is reachable without Cloudflare Access, so leaving it
on would put a second door on the same Worker with nothing watching it, and the Worker's own
refusal would be the only thing standing there. One door, behind Access, is easier to reason about
and easier to check.

If you want the subdomain as well, set `"workers_dev": true`. Know what you are choosing: anything
that reaches that address skips Access, and only the `CF_ACCESS_*` check inside the Worker refuses
it.

## Connect a project

The workspace is a development machine. It has `git` and `gh`. Authorize GitHub inside the workspace, then connect one GitHub repository from there. The `gh` credential stays in the workspace's local GitHub configuration. The repository keeps its own files and Git history. Your browser does not receive the GitHub credential.

Set `GITHUB_OAUTH_CLIENT_ID` as a Worker secret before you authorize (see "Instance secrets"). It names the GitHub OAuth app the device flow uses. The value is public, but it is stored as a secret so that a deploy keeps it. Without it, starting the device flow answers `not-configured`.

Set the `GH_TOKEN` secret if you want an unattended run to authorize without a person at a browser. cf-stumble installs `GH_TOKEN` as the workspace credential whenever the workspace has no usable one, and treats it as a test and development path, not a second production login. A deployment with neither value set reports `disconnected`.

The sidebar also contains the harness project. It selects `/workspace/harness`, which is a Git clone of the harness repository. It is not a second connected repository or a separate workspace.

A connection is refused when GitHub's complete tree reports more than 3,000 files or 150 MB of current-tree blobs. The existing truncated-tree and 5,000,000 KB repository-history limits still apply. This check queries GitHub's API with the `GH_TOKEN` secret. If you authorize only through the interactive device flow and never set `GH_TOKEN`, the query runs unauthenticated. GitHub answers an unauthenticated request for a private repository the same way it answers one that does not exist, so the check cannot read the repository and skips it. The clone step then measures the repository again with the workspace's own `gh` credential and refuses one over a ceiling. A repository it cannot measure is cloned anyway. See `docs/agents/design/github-connection.md`, "Connecting a repository".

To remove a connected project, send the owner-only `POST /api/projects/{id}/disconnect` request with the page's exact `Origin`. The request refuses an unknown project, the harness, or a project with a live turn. After the turn lease expires, it removes the project's thread, then its catalog entry, then its workspace clone, and disconnecting loses any uncommitted work in that clone. The clone removal is best-effort: it can fail after the thread and catalog entry are already gone, leaving the project's files on disk with no project that owns them.

## Connect ChatGPT

The model route answers from the fixed Workers AI model until you connect a ChatGPT account. After that it answers from OpenAI's Responses API with your ChatGPT subscription, using the model that `CHATGPT_MODEL` names in `cloudflare.config.ts` (`gpt-6.1-sol`). The Supervisor keeps the access and refresh tokens in its SQLite and refreshes them itself, so you connect once per instance. Your browser and the harness never receive a token. See ADR-0047.

Connect from the owner page:

1. Select **Connect ChatGPT** in the sidebar, then open the sign-in link it shows.
2. Sign in to ChatGPT and approve cf-stumble.
3. OpenAI sends the browser to `http://127.0.0.1:1455/auth/callback?...`. Nothing listens there, so the browser shows a connection error. That is expected. Copy the whole address from the address bar.
4. Paste it into the sidebar and select **Finish**. The panel says the account is connected.

A sign-in expires after 10 minutes, and only the most recent one can be finished. The address holds a one-time code; it is useless without the verifier the Supervisor kept.

An agent can do the same with `tools/chatgpt-connect.mts`. It starts a sign-in through the owner API with the agent service token (see "Agent access without a sign-in"), drives a temporary copy of a Firefox profile that is already signed in to ChatGPT, catches the redirect, and finishes the sign-in:

```sh
pnpm exec tsx tools/chatgpt-connect.mts --origin https://<host> \
  --profile "<Firefox profile directory>" [--account <email or exact name>]
```

The tool reads the service token from `--token-file`, which defaults to `.audit/local/access-service-token.json` relative to the directory you run it in. Run it from the owner's checkout, or pass `--token-file <path>` from anywhere else. `--account` is required when OpenAI's account chooser lists more than one account. The tool never changes the original profile and deletes its copy when it exits. OpenAI may answer a headless browser with a Cloudflare challenge or a route error; the tool then stops and saves the page text and a screenshot under `/tmp/chatgpt-connect-*`. Run it again with `--headed` to show the window, or connect from the owner page. `--inspect` stops before the approval page and calls no owner API.

The page shows one of three states:

- **connected** (with the model name): model calls use your subscription. When OpenAI refuses a call for the plan's usage limit, the page adds **usage limit reached**, with the time the limit ends when OpenAI gave one. A call the limit refuses before it sends any output is answered by Workers AI instead, and the saved conversation shows a notice before that answer. The connection stays connected.
- **reconnect required** (with the reason): OpenAI refused the refresh token or the access token. Every model call fails with `chatgpt-reconnect-required` until you connect again or disconnect. The route does not fall back to Workers AI here, so a broken subscription is visible.
- **not connected (Workers AI fallback)**: model calls use Workers AI.

**Disconnect** deletes the stored tokens and returns the route to Workers AI. It does not revoke the grant at OpenAI. To revoke it, remove cf-stumble from your ChatGPT account's settings.

## First run

Before you submit a generation, `GET /api/status` returns `{"activeGeneration":{"generation":null,"epoch":0,"activationId":null}}`. `GET /`, `/status`, `/generations`, and `/projects` relay to a generation and return HTTP 503 with `{"ok":false,"problem":{"code":"no-active-generation"}}`. That response is normal on a new instance. It does not mean that the deployment failed. A browser request for `/` with `Accept: text/html` still receives the owner page. `GET /health` is answered by the Worker itself, so it returns `{"ok":true}` before any generation exists. It still sits behind Access.

The first generation does not happen by itself. Submit it as the verified owner, then activate it:

1. Send `POST /api/generations/submit` with `{"harnessCommit":"<full commit ID>"}`. Read `outcome.generation.label` from its response. The Supervisor creates the workspace as part of this submission and clones or reconciles the harness repository in `/workspace/harness`.
2. Read the epoch from `GET /api/status`, then send `POST /api/generations/activate` with `{"observedEpoch":<epoch>,"label":<label>}`. Use the label from the submission response and the epoch from the status response. A refused activation answers with a 4xx status and `{"ok":false,"problem":{"code":...}}`: 409 `stale-epoch` means the epoch moved, so read it again and resend; 409 `not-ready` means that generation has not passed its startup check; 404 `unknown-generation` means no generation has that label.

One submission extracts the requested commit, installs dependencies, builds the vendored Pi package, bundles the module map, and stores that map in the Supervisor's SQLite storage. It cold-starts the candidate and runs `GET /` against it before it reports the candidate ready. These are separate build steps, so a failure reports its phase. On the measured first cold run, submission took 321 seconds. Activation took 0.4 seconds, and the ready generation answered `GET /` in 0.3 seconds. A failed candidate leaves the generation that was already serving in place. Repeating a submission for a commit the Supervisor already knows returns the existing generation, so retrying it is safe.

Each verified Access identity gets its own Supervisor, workspace, and instance. If you sign in as another identity, you see a separate empty instance.

## Point the instance at your own fork

Your instance builds its own harness from a Git repository, and it has to be told which one. Set the `HARNESS_REPOSITORY_URL` secret to the HTTPS URL of your fork (see "Instance secrets"):

```sh
printf '%s' 'https://github.com/your-name/cf-stumble.git' | npx wrangler secret put HARNESS_REPOSITORY_URL --name cf-stumble
```

An empty value means the repository named in `src/harness-build.ts`, which is this project's own. Leave it empty and your instance will build this repository rather than your fork, so your own harness commits will never be reachable from it. Nothing else about a fork needs changing.

A wrong URL fails safely. The first build step tries to clone it, fails, and reports a failed candidate; the generation that was serving keeps serving. This was checked against a deployment. A URL naming a repository that does not exist failed in about 17 seconds and left the active generation untouched.

## Known untested areas

- Compaction across a reload is tested locally (`test/facet/generation-0/compaction.test.ts`), not on a deployment. Pi owns compaction.
- The Deploy to Cloudflare button flow has not been recorded against a clean account. The deployed instance has been tested after the button flow. On an empty instance, the owner submitted and activated a generation, then served it, ran a coding turn, failed a broken candidate without disturbing the active generation, and rolled back in a quarter of a second.
- The deployed probe tested Access token verification with an injected key. It did not prove that a real Cloudflare Access application admits the configured owner.

## Cost and cleanup

Workers Paid, Container time, and Workers AI requests can cost money. The Workspace Host stops the container ten minutes after the last work (ADR-0043), so an unused instance costs little. A client that keeps calling a route that touches the workspace keeps the container running; `pnpm ops:check` reports it (`docs/agents/incident-2026-09-container-cost.md`).

Delete the Worker, the Container application, and the old images in the account's registry when you no longer need the instance. Each deploy of a new image leaves the previous one in the registry as rollback history; list them with `npx wrangler containers images list` and remove the ones you will not roll back to with `npx wrangler containers images delete <repository>:<tag>`.
