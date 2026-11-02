# Staging a risky change

Used by the Stage branch of `../SKILL.md`. `<stage>` is a unique name such as `cfs-<topic>-<4 random letters>`. The stack names the Worker `cf-stumble-<stage>` and attaches a container application to its `WorkspaceHost` namespace; below, `<name>` is `cf-stumble-<stage>`.

## Layout

```sh
git worktree add --detach /tmp/<stage> HEAD
cd /tmp/<stage>
pnpm install --offline --ignore-scripts
pnpm install:infra
pnpm run build:page
mkdir -p .audit/stage        # `.audit/` is ignored by Git
```

Run every Alchemy command from the worktree root, because the stack names its files relative to it:

```sh
pnpm alchemy plan --config infra/alchemy.run.ts --stage <stage>
pnpm alchemy deploy --config infra/alchemy.run.ts --stage <stage>
```

A stage other than `prod` has a `workers.dev` subdomain without preview URLs, no route, traces off (one cold start writes about 12,600 spans that drown the events), and the same container instance size as production, which the Durable Object requests at launch.

## Before each deploy

Check that `--stage` is `<stage>` and never `prod`, and that the plan lists only resources named `<name>`. A staging deploy to production is the one mistake that cannot be undone.

The first plan on an account without a state store creates the Worker `alchemy-state-store` and two secrets in the default Secrets Store. Record that in the baseline notes: they are shared by every stage, and the cleanup removes them only if you created them and no other stage uses them.

## Secrets and requests

Set the secrets after the first deploy with `pnpm exec cf workers secrets update <NAME> --worker <name> --type secret_text --text "$(cat <file>)"`, with the value in a file outside the repository. Delete the file afterward.

An HTTP client with a default user agent may get 403 from the API; set your own `User-Agent`.

## Expect

- A deploy builds the image with Docker and takes about 10 minutes the first time. A change to a trailing `ENV` line rebuilds in about a minute because layers are cached.
- On the Mac, the push of the image's 1 GB layer through OrbStack can fail with "use of closed network connection"; run the deploy again.
- A new container application can take minutes to place its first instance, and the first launches often fail with "no container instance can be provided"; retry the request.
- The generation build clones `HARNESS_REPOSITORY_URL`, so only commits on a public GitHub repository can build.

## Clean up

```sh
pnpm alchemy destroy --config infra/alchemy.run.ts --stage <stage>
pnpm exec cf containers images list                 # find the repository:tag left behind
pnpm exec cf containers images delete <repository>:<tag>
cd / && git -C <repo> worktree remove --force /tmp/<stage>
```

`destroy` removes the Worker, its Durable Object namespaces, and the container application. Delete only images whose repository starts with `<name>`. If you created the state store, and no other stage on the account remains, delete the Worker `alchemy-state-store` and its two Secrets Store secrets as well.

## Prove it

List again and compare with the baseline: Workers (`GET /accounts/<account-id>/workers/scripts`), container applications, Durable Object namespaces (`GET /accounts/<account-id>/workers/durable_objects/namespaces`), `pnpm exec cf containers images list`, and the default Secrets Store's secrets if the state store was new. The lists must equal the baseline. Anything that was already there and is not yours stays untouched, including old images that are rollback history.
