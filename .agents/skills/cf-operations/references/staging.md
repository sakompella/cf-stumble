# Staging a risky change

Used by the Stage branch of `../SKILL.md`. `<stage>` is a unique name such as `cfs-<topic>-<4 random letters>`.

## Layout

```sh
git worktree add --detach /tmp/<stage> HEAD
cd /tmp/<stage>
pnpm install --offline --ignore-scripts
mkdir -p .audit/stage        # `.audit/` is ignored by Git
```

`cf` finds `cloudflare.config.ts` only in the working directory and has no `--config` flag, so the staging directory needs its own copy of everything `cf` reads:

- `cloudflare.config.ts`: a copy of the repository file with the Worker name (`workerName`) set to `<stage>`, `workersDev: true`, no `triggers`, `containers[0].name: "<stage>-workspacehost"`, `instanceType: "standard-1"`, and every relative path (`entrypoint`, `image.dockerfile`, `image.buildContext`) prefixed with `../../`. Keep the worker name in the Durable Object bindings equal to `<stage>`.
- `wrangler.config.ts`: a copy of the repository file.
- `package.json`: declares `wrangler` and `cf` as dependencies, so `cf` finds its bundler and itself.
- `node_modules`: a symlink to `../../node_modules`.

Turn traces off in the staging copy, because one cold start writes about 12,600 spans that drown the events.

Without these files `cf` stops with "No Cloudflare dev server is installed" or "wrangler is declared ... but is not installed".

## Before each deploy

Print the configuration's name and check that it equals `<stage>`, that it is not `<worker>`, and that it has no routes or triggers. A staging deploy to the production name is the one mistake that cannot be undone.

## Secrets and requests

Write the secrets to a file outside the repository and pass it with `pnpm exec cf deploy --secrets-file <file>`. Delete the file afterward.

An HTTP client with a default user agent may get 403 from the API; set your own `User-Agent`.

## Expect

- A docker deploy takes about 10 minutes the first time. A change to a trailing `ENV` line rebuilds in about a minute because layers are cached.
- A new container application can take minutes to place its first instance, and the first launches often fail with "no container instance can be provided"; retry the request.
- The generation build clones `HARNESS_REPOSITORY_URL`, so only commits on a public GitHub repository can build.
- `wrangler delete` removes the Worker and its Durable Object namespaces but leaves the container application.

## Prove self-modification

Deploying a Worker that bumps the facet compatibility key (for example to `host-3`) makes every generation that is already prepared refuse activation and rollback, so first submit and activate the staging Worker's own commit as the baseline. Then:

1. In a harness conversation, ask the agent for a small change you can see in its answers. It commits in `/workspace/harness`, pushes that exact commit to `self-modify/<change>`, runs `stumble gen prepare <sha>`, and continues only when the preparation reports `ready`. The commit must be on the public repository the Worker builds from.
2. The agent reads the epoch with `stumble gen status` and runs `stumble gen activate <label> --epoch <n>`. Its facet ends. Within about a minute the Supervisor's alarm resumes the conversation under the new generation, which reports "already active". A fresh turn must show the changed behavior.
3. Push a commit that loads but fails every message, and prepare it. Preparation must answer `conversation-failed`, and `GET /api/status` must show the same active generation and epoch.
4. Make the workspace unavailable (stop its container), then roll back to the baseline with `stumble gen rollback <label> --epoch <n>` or `POST /api/generations/rollback`. Rollback loads the stored module map and must not need the workspace.
5. Run `pnpm ops:check`.

Record each label, epoch and the time each preparation took; the 90-second conversation deadline was sized without a staging measurement.

## Clean up

```sh
npx wrangler delete --name <stage>
pnpm exec cf containers applications delete <stage-container-app-id>
pnpm exec cf containers images list                 # find the repository:tag you pushed
pnpm exec cf containers images delete <stage>-workspacehost:<tag>
cd / && git -C <repo> worktree remove --force /tmp/<stage>
```

Look up `<stage-container-app-id>` in the applications list by the name `<stage>-workspacehost`. Delete only resources whose names start with `<stage>`.

## Prove it

List again and compare with the baseline: Workers (`GET /accounts/<account-id>/workers/scripts`), container applications, Durable Object namespaces (`GET /accounts/<account-id>/workers/durable_objects/namespaces`), and `pnpm exec cf containers images list`. The lists must equal the baseline. Anything that was already there and is not yours stays untouched, including old images that are rollback history.
