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

## Configure Cloudflare Access

The Worker rejects every route until you configure Access. Set up Access after the deployment and before the first normal use.

1. Create your Zero Trust team if you do not already have one.
2. In the Cloudflare dashboard, open **Zero Trust** > **Access controls** > **Applications**. Create a new application, choose **Self-hosted and private**, and add the public hostname that serves this Worker. Choose a hostname in the Cloudflare zone in your account.
3. Add one Allow policy for your own identity. Access denies requests that do not match an Allow policy.
4. Save the application and sign in to that hostname once. Read the token that Access issues for your own login. Set the Worker values below in the deployed Worker's settings.

| Worker value            | Value to set                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `CF_ACCESS_TEAM_DOMAIN` | Your Zero Trust team domain. It is the domain that identifies the Zero Trust team. |
| `CF_ACCESS_AUD`         | The `aud` claim in the Access token for this application.                          |
| `CF_ACCESS_OWNER_SUB`   | The `sub` claim in your own Access token after your first login.                   |

Do not use another person's token to set `CF_ACCESS_OWNER_SUB`. The Worker accepts only the identity whose `sub` claim matches this value.

The deployed smoke test verified the safe order. A request with no credential receives 401. A request that carries a credential while the Access values are missing receives 500 for `invalid-configuration`. This is deliberate. The Worker does not choose a default owner while configuration is incomplete.

## Connect a project

The workspace is a development machine. It has `git` and `gh`. Authorize GitHub inside the workspace, then connect one GitHub repository from there. The `gh` credential stays in the workspace's local GitHub configuration. The repository keeps its own files and Git history. Your browser does not receive the GitHub credential.

The sidebar also contains the harness project. It selects `/workspace/harness`, which is a Git clone of the harness repository. It is not a second connected repository or a separate workspace.

## First run

Before the first generation exists, the deployed Worker serves the page, but there is no active generation to show. On the first authenticated owner request, the Supervisor creates the workspace, clones the configured harness repository into `/workspace/harness`, and labels that clone's HEAD commit as the first candidate.

It then uses the normal generation path. It runs `pnpm run build:artifact`, stores the module map in the Supervisor's SQLite storage, cold-checks `GET /`, and activates the candidate when the check passes. A failed bootstrap build leaves the deployed Worker serving. Repeating a submission for the same commit returns the existing generation.

## Fork configuration gap: `HARNESS_REPOSITORY_URL`

A fork does not yet bootstrap from itself. `src/harness-build.ts` hardcodes `HARNESS_BUILD_CONFIGURATION.harnessGitRemote` to `https://github.com/sakompella/cf-stumble.git`. A forked deployment would therefore build the owner's repository.

After you fork the repository, edit that one constant to the HTTPS URL of your fork before you deploy. This is a product gap. The deploy button cannot correct it.

## Known untested areas

- Compaction across a reload has not been tested. Pi owns compaction, and this project has no forced-compaction test.
- The Deploy to Cloudflare button flow has not yet been recorded against a clean account with empty cf-stumble storage.
- The deployed probe tested Access token verification with an injected key. It did not prove that a real Cloudflare Access application admits the configured owner.

## Cost and cleanup

Workers Paid, Container time, and Workers AI requests can cost money. Delete the Worker and delete the Container application when you no longer need the instance.
