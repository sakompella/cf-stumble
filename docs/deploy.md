# Deploy cf-stumble

cf-stumble is an owner-only coding agent. It runs in your Cloudflare account and uses Cloudflare Access to identify its one owner.

## Before you start

You need:

- A Cloudflare account on the Workers Paid plan. This project uses Durable Objects with SQLite storage, Containers, and Worker Loaders. They are not available on the free plan.
- A GitHub account.
- A domain in the same Cloudflare account if you want Cloudflare Access in front of the Worker. Access needs a hostname in an active Cloudflare zone.

The workspace runs project commands and can make Workers AI requests. Use an account where you can control the resulting charges.

## Deploy with the button

Select the button in the README. Cloudflare copies the public source repository into your GitHub account, lets you choose names, provisions the resources declared in `wrangler.jsonc`, sets up Workers Builds, builds the project, and deploys it.

The button does not configure Cloudflare Access. It also does not provision Containers. Workers Builds builds the Container image, but Cloudflare must create the Container application as part of the deployment. Complete the Access setup below before you use the app.

Cloudflare reads `wrangler.jsonc` to provision supported bindings. In this project, that includes the Durable Objects, Workers AI binding, and Worker Loader. A Durable Object is Cloudflare's stateful Worker component. The configuration also declares the workspace Container, but Containers are outside the button's provisioning list.

## Container image

`wrangler.jsonc` points to `containers/computerd.Dockerfile`, not to a registry image. The Dockerfile starts from the pinned public Cloudflare Computer image.

This indirection is required. Cloudflare Containers only pull images from the deploying account's managed registry or from a registry that account has configured. A direct reference to the public image fails with `IMAGE_REGISTRY_NOT_CONFIGURED`. Workers Builds has Docker, so it builds this Dockerfile and pushes the result to the deploying account's managed registry.

If you deploy by hand, use Docker. Podman does not work for this deployment because it can rewrite the image manifest when it pushes, leaving Wrangler with a local digest that Cloudflare cannot find in the registry. The resulting deployment error is `IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE`.

The image also carries the packages your harness build needs, fetched from the lockfile. That makes it about a gigabyte larger and your first build several minutes faster, because the build reads packages from the image instead of the network.

## What to expect the first time

Your first submission is slow. On a container with half a virtual CPU, a submission took between five and eight minutes end to end, and most of that is installing packages and bundling the harness. It is not stuck. Everything after that is fast. Activating a generation took under a second, rolling back to an earlier one took a quarter of a second, and a coding turn with three tool calls took ten seconds.

Cold starting the workspace container adds ten to sixty seconds to the first request after an idle period.

## Configure Cloudflare Access

The Worker rejects every route until you configure Access. Set up Access after the deployment and before the first normal use.

1. Create your Zero Trust team if you do not already have one.
2. In the Cloudflare dashboard, open **Zero Trust** > **Access controls** > **Applications**. Create a new application, choose **Self-hosted and private**, and add the public hostname that serves this Worker. Choose a hostname in the Cloudflare zone in your account.
3. Add one Allow policy for your own identity. Access denies requests that do not match an Allow policy.
4. Save the application and sign in to that hostname once. Then read your own `sub` claim. The simplest way is to open `https://<your-hostname>/cdn-cgi/access/get-identity` in the same browser, which returns your Access identity as JSON. The other way is to decode the `CF_Authorization` cookie, which is an ordinary JWT whose payload carries `sub` and `aud`.
5. Set the three values below in the deployed Worker's settings, then redeploy or save so the Worker picks them up.

| Worker value            | Value to set                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `CF_ACCESS_TEAM_DOMAIN` | Your Zero Trust team domain. It is the domain that identifies the Zero Trust team.                               |
| `CF_ACCESS_AUD`         | The application audience tag. The dashboard shows it on the application, and it is the `aud` claim in the token. |
| `CF_ACCESS_OWNER_SUB`   | The `sub` claim in your own Access token after your first login.                                                 |

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

## Connect a project

The workspace is a development machine. It has `git` and `gh`. Authorize GitHub inside the workspace, then connect one GitHub repository from there. The `gh` credential stays in the workspace's local GitHub configuration. The repository keeps its own files and Git history. Your browser does not receive the GitHub credential.

The sidebar also contains the harness project. It selects `/workspace/harness`, which is a Git clone of the harness repository. It is not a second connected repository or a separate workspace.

## First run

Before you submit a generation, `GET /api/status` returns `{"activeGeneration":{"epoch":0}}`. `GET /`, `/status`, `/generations`, `/projects`, and `/health` relay to a generation and return HTTP 503 with `{"ok":false,"problem":{"code":"no-active-generation"}}`. That response is normal on a new instance. It does not mean that the deployment failed. A browser request for `/` with `Accept: text/html` still receives the owner page.

The first generation does not happen by itself. Submit it as the verified owner, then activate it:

1. Send `POST /api/generations/submit` with `{"harnessCommit":"<full commit ID>"}`. Read `outcome.generation.label` from its response. The Supervisor creates the workspace as part of this submission and clones or reconciles the harness repository in `/workspace/harness`.
2. Read the epoch from `GET /api/status`, then send `POST /api/generations/activate` with `{"observedEpoch":<epoch>,"label":<label>}`. Use the label from the submission response and the epoch from the status response.

One submission extracts the requested commit, installs dependencies, builds the vendored Pi package, bundles the module map, and stores that map in the Supervisor's SQLite storage. It cold-starts the candidate and runs `GET /` against it before it reports the candidate ready. These are separate build steps, so a failure reports its phase. On the measured first cold run, submission took 321 seconds. Activation took 0.4 seconds, and the ready generation answered `GET /` in 0.3 seconds. A failed candidate leaves the generation that was already serving in place. Repeating a submission for a commit the Supervisor already knows returns the existing generation, so retrying it is safe.

Each verified Access identity gets its own Supervisor, workspace, and instance. If you sign in as another identity, you see a separate empty instance.

## Point the instance at your own fork

Your instance builds its own harness from a Git repository, and it has to be told which one. Set the `HARNESS_REPOSITORY_URL` variable in `wrangler.jsonc` to the HTTPS URL of your fork:

```jsonc
"vars": { "HARNESS_REPOSITORY_URL": "https://github.com/your-name/cf-stumble.git" },
```

An empty value means the repository named in `src/harness-build.ts`, which is this project's own. Leave it empty and your instance will build this repository rather than your fork, so your own harness commits will never be reachable from it. Nothing else about a fork needs changing.

A wrong URL fails safely. The first build step tries to clone it, fails, and reports a failed candidate; the generation that was serving keeps serving. This was checked against a deployment. A URL naming a repository that does not exist failed in about 17 seconds and left the active generation untouched.

## Known untested areas

- Compaction across a reload has not been tested. Pi owns compaction, and this project has no forced-compaction test.
- The Deploy to Cloudflare button flow has not been recorded against a clean account. The deployed instance has been tested after the button flow. On an empty instance, the owner submitted and activated a generation, then served it, ran a coding turn, failed a broken candidate without disturbing the active generation, and rolled back in a quarter of a second.
- The deployed probe tested Access token verification with an injected key. It did not prove that a real Cloudflare Access application admits the configured owner.

## Cost and cleanup

Workers Paid, Container time, and Workers AI requests can cost money. Delete the Worker and delete the Container application when you no longer need the instance.
