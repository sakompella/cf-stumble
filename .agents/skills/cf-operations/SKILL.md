---
name: cf-operations
description: Operate a cf-stumble instance on Cloudflare with Alchemy and `cf`. Use when deploying (a push to `main`, or `pnpm run deploy`), checking a deployment or runtime with `pnpm ops:check`, staging a risky change on a throwaway Worker, or diagnosing container cost and idle stops.
---

# Operate a cf-stumble instance

Placeholders: `<worker>` is `cf-stumble` for the stage `prod` and `cf-stumble-<stage>` for any other stage (`workerName` in `infra/worker-settings.ts`). `<account-id>` comes from `pnpm exec cf accounts list`. `<container-app-id>` is the `id` of the container application whose `durable_objects.namespace_id` is the id of the `<worker>` `WorkspaceHost` namespace in `GET /accounts/<account-id>/workers/durable_objects/namespaces`; Alchemy generates the application's name, so search `GET /accounts/<account-id>/containers/applications` by namespace, not by name. Look each one up; never copy one from another instance.

Run Alchemy from the repository root as `pnpm alchemy <command> --config infra/alchemy.run.ts --stage <stage>`, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set (`docs/deploy.md`, "Configuration files"). Run `cf` under Node as `pnpm exec cf`. Run `pnpm exec cf auth whoami` before any live `cf` or Alchemy call: it shows the account and refreshes the login that `cf` keeps in its config. `pnpm ops:check` reads the same login when `CLOUDFLARE_API_TOKEN` is unset.

Every request except `GET /health` needs HTTP Basic auth with the user name `aditya` and the `OWNER_PASSWORD` secret. Read the password from the environment, never from a tracked file: `curl -u "aditya:$CF_STUMBLE_PASSWORD" https://<hostname>/api/status`. A Worker without `OWNER_PASSWORD` answers 503.

## Choose the branch

- **Deploy:** an update to an instance that already exists.
- **Check:** is a deployment or the running container healthy.
- **Stage:** try a risky change on a throwaway Worker before it reaches the instance.
- **Diagnose:** container cost, a run that never stopped, or a stop nobody asked for.

## Deploy

### 1. Prepare

Work from a clean tree on `main`. Run `pnpm verify` (CI runs it again before it deploys), then `pnpm exec cf auth whoami` (it shows the account). List the secrets with `pnpm exec cf workers secrets list --worker <worker>`. Check that the last container rollout finished: `pnpm exec cf containers applications get <container-app-id>`, and the instance state from the instances call at the end of `docs/agents/design/observability.md`, "Checking a running deployment".

**Complete when:** `pnpm verify` passed on this exact commit, the account is the intended one, and no rollout is in progress.

### 2. Deploy

The normal path for production is a push or merge to `main`. GitHub Actions runs Verify on the commit, and when it passes, the Deploy workflow runs `pnpm run deploy prod --yes` (`docs/deploy.md`, "Deploying from CI"). Before you merge, run `pnpm run build:page` and `pnpm run build:shell-modules`, then `pnpm alchemy plan --config infra/alchemy.run.ts --stage prod`, and read what it would change: CI approves the plan without showing it to anyone. After the push, follow the run with `gh run watch` and read the plan in the job log.

Deploy from a machine with `pnpm run deploy` only when CI cannot. Never deploy the Worker with another tool. If anything changed the Worker outside Alchemy (the dashboard, `cf deploy`), run `pnpm run deploy --force` from a machine: a plain deploy is then a no-op. If the image push fails with "use of closed network connection", run the deploy again on a steady network.

**Complete when:** the Deploy run (or the local command) succeeded and the deployment list (`pnpm exec cf workers deployments list --worker <worker>`) shows a new version at 100%.

### 3. Compare

Compare against what you recorded before step 2. The container application keeps its `<container-app-id>` and its version rises (modified, not created). The Durable Object namespace ids for `Supervisor` and `WorkspaceHost` are unchanged. The secret names are unchanged. The Observability settings still show logs, traces, and Issues on. Then run `pnpm ops:check --since 1h`.

**Complete when:** each of the four comparisons holds, or you can explain the difference, and `ops:check` prints a check mark or only explained findings. Read `docs/deploy.md`, "Deploy an update", for what each difference means.

## Check

### 1. Run the command

Give `ops:check` a credential: it reads `CLOUDFLARE_API_TOKEN`, else the `cf` login in `~/.config/cloudflare/config/default.json` (refreshed by `pnpm exec cf auth whoami`; an API token with Account Analytics Read is better for repeated runs). See `docs/agents/design/observability.md`, "Checking a running deployment", "Credentials". Then run `pnpm ops:check`. The account is `CLOUDFLARE_ACCOUNT_ID`, else the only account the token sees. Add `--worker <worker>` or `--since 90m|2h|1d` for another Worker or window.

### 2. Read the result

A line starting with a check mark means all is well. A cross (`ran-past-idle`) names a container run that went past the idle stop, by how much, and the routes and end times of the last three requests before it. A line saying `unknown` means a source failed, hit its row limit, or returned nothing; it exits 1 because the command cannot say all is well. Missing data is never zero.

**Complete when:** every cross and every `unknown` line is explained from its evidence or reported as open. The rule and its threshold are in `docs/agents/design/observability.md`, "Checking a running deployment".

## Stage

Stage a change that touches the container image, the Durable Object lifecycle, the idle stop, or anything else you cannot cover with unit tests. Follow [`references/staging.md`](references/staging.md) for the directory contents and commands.

### 1. Record the baseline

List the account's Workers, container applications, Durable Object namespaces, and registry images before you create anything.

**Complete when:** the four lists are saved, so cleanup can prove that nothing of yours remains and nothing else was touched.

### 2. Build the staging copy

Create a worktree and pick a unique stage name. The stack turns any stage other than `prod` into a Worker `cf-stumble-<stage>` with a `workers.dev` subdomain, no route, traces off, and its own container application attached to its `WorkspaceHost` namespace. Every stage boots the production instance size, `WORKSPACE_CONTAINER_INSTANCE` in `infra/worker-settings.ts`.

**Complete when:** the stage is unique and is not `prod`, and `pnpm alchemy plan` for it lists only resources named `cf-stumble-<stage>` (plus the state store on an account that has none).

### 3. Deploy and exercise

Deploy with `pnpm run deploy <stage>`. Set the secrets with `pnpm exec cf workers secrets update`. Exercise the change, then read the events (`docs/agents/design/observability.md`, "Querying") and `pnpm ops:check --worker <name>`.

**Complete when:** the change did what you claim, with timestamps and event names as evidence, and you recorded the container minutes used (the instances API, start to `inactive`).

### 4. Clean up and prove it

Run `pnpm alchemy destroy --config infra/alchemy.run.ts --stage <stage>`, delete the registry images you pushed, and remove the worktree. Then list again.

**Complete when:** the Workers, applications, namespaces, and images lists equal the baseline from step 1, and `<worker>` and every resource you did not create are untouched.

## Diagnose

### 1. Establish what ran

Run the Check branch over the window. Sum running minutes per day from the usage query in `tools/ops-check/fetch.mts` (byte-seconds divided by provisioned memory and 60) and compare them with the day's container charge.

**Complete when:** you have running minutes per day, how each run ended (`workspace.container.idle-stop`, `workspace.reset`), and who owned the work (the `ran-past-idle` evidence, canceled invocations, `turn.settled`).

### 2. Match the known causes

`docs/agents/incident-2026-09-container-cost.md` lists the causes found so far: a client that polls a route that touches the workspace, a Durable Object kept active by an open request, and the shim's disk walk. Compare your evidence with each.

**Complete when:** each known cause is confirmed or excluded with a number, or the remainder is recorded as unknown. Billing data needs an API token with Billing Read; the `cf` login cannot read it.
