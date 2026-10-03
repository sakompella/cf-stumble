# Staging a risky change

Used by the Stage branch of `../SKILL.md`. `<stage>` is a unique name such as `cfs-<topic>-<4 random letters>`.

## Layout

```sh
git worktree add --detach /tmp/<stage> HEAD
cd /tmp/<stage>
pnpm install --offline --ignore-scripts
pnpm build:pi
mkdir -p .audit/stage        # `.audit/` is ignored by Git
```

`cf` finds `cloudflare.config.ts` only in the working directory and has no `--config` flag, so the staging directory needs its own copy of everything `cf` reads:

- `cloudflare.config.ts`: a copy of the repository file with `name: "<stage>"`, `workersDev: true`, no `triggers`, `containers[0].name: "<stage>-workspacehost"`, `instanceType: "standard-1"`, and every relative path (`entrypoint`, `image.dockerfile`, `image.buildContext`) prefixed with `../../`. Keep the worker name in the Durable Object bindings equal to `<stage>`.
- `wrangler.config.ts`: a copy of the repository file.
- `package.json`: declares `wrangler` and `cf` as dependencies, so `cf` finds its bundler and itself.
- `node_modules`: a symlink to `../../node_modules`.

Turn traces off in the staging copy, because one cold start writes about 12,600 spans that drown the events.

Without these files `cf` stops with "No Cloudflare dev-server is installed" or "wrangler is declared ... but is not installed".

## Before each deploy

Print the configuration's name and check that it equals `<stage>`, that it is not `<worker>`, and that it has no routes or triggers. A staging deploy to the production name is the one mistake that cannot be undone.

## Secrets and requests

Write the Access values to a file outside the repository and pass it with `pnpm exec cf deploy --secrets-file <file>`. With `pnpm local:access-session` the script writes a throwaway signing key; set its public keys as `CF_ACCESS_PUBLIC_KEYS` in the same file. Send `Cf-Access-Jwt-Assertion` on each request and `Origin: <base-url>` on each POST. Delete the file afterward.

An HTTP client with a default user agent may get 403 from the API; set your own `User-Agent`.

## Expect

- A docker deploy takes about 10 minutes the first time. A change to a trailing `ENV` line rebuilds in about a minute because layers are cached.
- A new container application can take minutes to place its first instance, and the first launches often fail with "no container instance can be provided"; retry the request.
- The generation build clones `HARNESS_REPOSITORY_URL`, so only commits on a public GitHub repository can build.
- `wrangler delete` removes the Worker and its Durable Object namespaces but leaves the container application.

## Clean up

```sh
npx wrangler delete --name <stage>
npx wrangler containers delete <stage-container-app-id>
npx wrangler containers images list                 # find the repository:tag you pushed
npx wrangler containers images delete <stage>-workspacehost:<tag>
cd / && git -C <repo> worktree remove --force /tmp/<stage>
```

Look up `<stage-container-app-id>` in the applications list by the name `<stage>-workspacehost`. Delete only resources whose names start with `<stage>`.

## Prove it

List again and compare with the baseline: Workers (`GET /accounts/<account-id>/workers/scripts`), container applications, Durable Object namespaces (`GET /accounts/<account-id>/workers/durable_objects/namespaces`), and `npx wrangler containers images list`. The lists must equal the baseline. Anything that was already there and is not yours stays untouched, including old images that are rollback history.
