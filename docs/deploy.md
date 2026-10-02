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

Select the button in the README. Cloudflare copies the public source repository into your GitHub account, lets you choose names, provisions the resources declared in `wrangler.jsonc`, sets up Workers Builds, builds the project, and deploys it.

The button does not configure Cloudflare Access. It also does not provision Containers. Workers Builds builds the Container image, but Cloudflare must create the Container application as part of the deployment. The button declares no secrets, so the first deploy works without them. Until you set the Access secrets below, the Worker refuses every request. Complete the Access setup before you use the app.

Cloudflare reads `wrangler.jsonc` to provision supported bindings. In this project, that includes the Durable Objects, Workers AI binding, and Worker Loader. A Durable Object is Cloudflare's stateful Worker component. The configuration also declares the workspace Container, but Containers are outside the button's provisioning list.

## Configuration files

`cloudflare.config.ts` is the source of truth for the Worker. It declares the Worker name, the route, the bindings, the two Durable Object classes, the Container, and the Workers AI and loader bindings. It declares no variables or secrets: instance values are secrets set per instance (see "Instance secrets"). `cf build` reads it and passes. `cf deploy` passed on staging (see below). `cf dev` does not work yet.

Two Wrangler files repeat these settings, because the tools that read them do not read `cloudflare.config.ts`:

- `wrangler.jsonc` is what the Deploy to Cloudflare flow and `wrangler deploy` read.
- `wrangler.test.jsonc` is what the test runner reads. It leaves out the Workers AI binding.

Both Wrangler files declare the Durable Objects with `exports`, not `migrations`, so a Wrangler deployment and a `cf` deployment state the same lifecycle. `test/docs/cloudflare-config-drift.test.ts` fails when either file differs from `cloudflare.config.ts`. When you change a setting, change all three files.

`cf deploy` was tested on a staging Worker on 2026-10-01 (cf 1.0.0-beta.9, Wrangler 4.145). `cf deploy --dry-run` passed twice, and a real `cf deploy` to an existing staging Worker succeeded with no `script_name` error. Afterward the Durable Object namespace IDs, the container application ID, the `v2` migration tag, and the Supervisor's SQLite state were unchanged. The staging WorkspaceHost data was not checked, because its new container never got an instance. A `wrangler deploy` of the `exports` configuration onto a Worker that was on `migrations` v1 and v2 also succeeded: it kept the namespace IDs and the container application, and it reported no export changes. The earlier suspicion that `cf deploy` fails like `cf dev` was wrong. Which path deploys production is the owner's decision.

`cf dev` still fails on the Durable Object binding that points at the Worker itself when a Container is attached to that Durable Object. `cf` has no `--config` flag, so a staging copy needs its own directory with `cloudflare.config.ts`, `wrangler.config.ts`, a `package.json` that declares `wrangler` and `cf`, and a `node_modules` link. Use Wrangler for the other commands `cf` lacks: `npx wrangler tail cf-stumble` streams logs, and `npx wrangler secret put <NAME> --name cf-stumble` sets one secret. `scripts/local/dev.sh` also stays on `wrangler dev`.

Use one deploy path for the Worker. Never alternate `wrangler deploy` and `cf deploy` on the same Worker. If you switch, disable or reconfigure Workers Builds first, so that an automatic build does not deploy through the other path.

Do not remove `Supervisor` or `WorkspaceHost` from `exports`, and do not change their `storage` value. A missing or mismatched class can orphan that class's stored data. Cloudflare cannot roll a Durable Object lifecycle change back to a version from before the change, so do not rely on a rollback across the first deployment that uses `exports`.

## Instance secrets

Values that differ per instance are Worker secrets, set once per instance and never committed. `cloudflare.config.ts`, `wrangler.jsonc`, and `wrangler.test.jsonc` declare none of them and no plain-text variables. `cf deploy` keeps undeclared secrets but removes undeclared plain-text variables, so a per-instance value cannot live in `vars` or in a `--var` flag. Do not pass `--var` to `cf deploy`. A declared secret would also be required, and a required secret makes the first deploy of a new Worker fail.

| Secret                                                          | Required by the Worker | Purpose                                                          |
| --------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------- |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `CF_ACCESS_OWNER_SUB` | Yes                    | The Access check. Without them the Worker refuses every request. |
| `HARNESS_REPOSITORY_URL`                                        | No                     | The fork the instance builds its harness from.                   |
| `GITHUB_OAUTH_CLIENT_ID`                                        | No                     | The GitHub OAuth app for the device flow.                        |
| `GH_TOKEN`                                                      | No                     | An unattended-run GitHub credential.                             |

Set them in one of two ways, after the Access login for the three Access values:

- Put them in a JSON or `.env` file outside the repository and run `pnpm exec cf deploy --secrets-file <file>`. Delete the file afterward.
- Run `npx wrangler secret put <NAME> --name <worker>` for each name.

Every later deploy keeps them. An instance whose values are still plain-text variables must convert them with `--secrets-file`; that turns them into secrets. Running `wrangler secret put` for a name that is already a plain variable is untested.

`cf deploy` stops with "Aborting the upload operation because of conflicts ... remove the --strict flag" when someone last changed the live Worker through the dashboard or the script API, and it still prints "Deploy complete". Check the exit code. `wrangler secret put` does not cause this. A Worker last deployed by Wrangler or `cf` does not hit it either. The one-path rule still applies: do not alternate `wrangler deploy` and `cf deploy` on one Worker.

`scripts/deploy/check-config.sh` checks that the three Access values and `CF_STUMBLE_HARNESS_COMMIT` are in your shell before you write the secrets file.

## Container image

`cloudflare.config.ts` points to `containers/computerd.Dockerfile`, not to a registry image. The Dockerfile builds `computerd`, Cloudflare Computer's container daemon, from a pinned public source commit with one small patch, then copies it into a Debian and Node image. The first image build fetches that source and its npm packages, so it takes a few minutes longer than copying a prebuilt binary.

This indirection is required. Cloudflare Containers only pull images from the deploying account's managed registry or from a registry that account has configured. A direct reference to the public image fails with `IMAGE_REGISTRY_NOT_CONFIGURED`. Workers Builds has Docker, so it builds this Dockerfile and pushes the result to the deploying account's managed registry.

If you deploy by hand, use Docker. Podman does not work for this deployment because it can rewrite the image manifest when it pushes, leaving Wrangler with a local digest that Cloudflare cannot find in the registry. The resulting deployment error is `IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE`.

The image also carries the packages your harness build needs, fetched from the lockfile. That makes it about a gigabyte larger and your first build several minutes faster, because the build reads packages from the image instead of the network.

## What to expect the first time

Your first submission is slow. Installing packages and bundling the harness takes most of that time. It is not stuck.

The workspace container is `standard-3` (2 vCPU, 8 GiB memory, 16 GB disk). The times below are historical: they were measured on the smaller `standard-1` container (0.5 vCPU) before this project moved to `standard-3`, and have not been re-measured on the current size. A submission took between five and eight minutes end to end. Activating a generation took under a second, rolling back to an earlier one took a quarter of a second, and a coding turn with three tool calls took ten seconds.

On the earlier `standard-1` container, a cold start added ten to sixty seconds to the first request after an idle period. That time has not been re-measured on `standard-3`.

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

A connection is refused when GitHub's complete tree reports more than 3,000 files or 150 MB of current-tree blobs. The existing truncated-tree and 5,000,000 KB repository-history limits still apply. This check queries GitHub's API with the `GH_TOKEN` secret. If you authorize only through the interactive device flow and never set `GH_TOKEN`, the query runs unauthenticated. GitHub answers an unauthenticated request for a private repository the same way it answers one that does not exist, so the check cannot read the repository and skips it. The clone that follows does not enforce the file-count or byte ceiling: it only fails when the workspace runs out of disk space. A private repository connected without `GH_TOKEN` can exceed both ceilings and still connect.

To remove a connected project, send the owner-only `POST /api/projects/{id}/disconnect` request with the page's exact `Origin`. The request refuses an unknown project, the harness, or a project with a live turn. After the turn lease expires, it removes the project's thread, then its catalog entry, then its workspace clone, and disconnecting loses any uncommitted work in that clone. The clone removal is best-effort: it can fail after the thread and catalog entry are already gone, leaving the project's files on disk with no project that owns them.

## First run

Before you submit a generation, `GET /api/status` returns `{"activeGeneration":{"generation":null,"epoch":0,"activationId":null}}`. `GET /`, `/status`, `/generations`, and `/projects` relay to a generation and return HTTP 503 with `{"ok":false,"problem":{"code":"no-active-generation"}}`. That response is normal on a new instance. It does not mean that the deployment failed. A browser request for `/` with `Accept: text/html` still receives the owner page. `GET /health` is answered by the Worker itself, so it returns `{"ok":true}` before any generation exists. It still sits behind Access.

The first generation does not happen by itself. Submit it as the verified owner, then activate it:

1. Send `POST /api/generations/submit` with `{"harnessCommit":"<full commit ID>"}`. Read `outcome.generation.label` from its response. The Supervisor creates the workspace as part of this submission and clones or reconciles the harness repository in `/workspace/harness`.
2. Read the epoch from `GET /api/status`, then send `POST /api/generations/activate` with `{"observedEpoch":<epoch>,"label":<label>}`. Use the label from the submission response and the epoch from the status response.

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

- Compaction across a reload has not been tested. Pi owns compaction, and this project has no forced-compaction test.
- The Deploy to Cloudflare button flow has not been recorded against a clean account. The deployed instance has been tested after the button flow. On an empty instance, the owner submitted and activated a generation, then served it, ran a coding turn, failed a broken candidate without disturbing the active generation, and rolled back in a quarter of a second.
- The deployed probe tested Access token verification with an injected key. It did not prove that a real Cloudflare Access application admits the configured owner.

## Cost and cleanup

Workers Paid, Container time, and Workers AI requests can cost money. Delete the Worker and delete the Container application when you no longer need the instance.
