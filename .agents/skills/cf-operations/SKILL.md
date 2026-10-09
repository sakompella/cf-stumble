---
name: cf-operations
description: Operate a cf-stumble instance on Cloudflare with `cf`. Use when deploying with `cf deploy`, checking a deployment or runtime with `pnpm ops:check`, staging a risky change on a throwaway Worker, or diagnosing container cost, idle stops, and container lifecycle events.
---

# Operate a cf-stumble instance

Placeholders: `<worker>` is `worker.name` in `cloudflare.config.ts`. `<account-id>` comes from `pnpm exec cf accounts list`. `<container-app-id>` is the `id` of the application named `<worker>-workspacehost` in `GET /accounts/<account-id>/containers/applications`. Look each one up; never copy one from another instance.

Run `cf` under Node as `pnpm exec cf`. Run `pnpm exec cf auth whoami` before any live `cf` or `wrangler` call: it shows the account and refreshes the login that `cf` keeps in its config. `pnpm ops:check` does not use that login by itself; see the Check branch.

## Choose the branch

- **Deploy:** an update to an instance that already exists.
- **Check:** is a deployment or the running container healthy.
- **Stage:** try a risky change on a throwaway Worker before it reaches the instance.
- **Diagnose:** container cost, a run that never stopped, or a stop nobody asked for.

## Deploy

### 1. Prepare

Work from a clean tree on `main`. Run `pnpm verify`, then `pnpm exec cf auth whoami` (it shows the account). List the secrets with `npx wrangler secret list --name <worker>`. Check that the last container rollout finished: `npx wrangler containers info <container-app-id>`, and the instance state from the instances call in `docs/agents/design/observability.md`, "Query recipes".

**Complete when:** `pnpm verify` passed on this exact commit, the account is the intended one, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, and `CF_ACCESS_OWNER_SUB` are listed, `CF_ACCESS_PUBLIC_KEYS` is not, and no rollout is in progress.

### 2. Deploy

Run `pnpm exec cf deploy --dry-run` and read the bindings it lists. Then run `pnpm exec cf deploy`. Never alternate `wrangler deploy` and `cf deploy` on one Worker. Never pass `--var`: `cf deploy` removes plain-text variables that `cloudflare.config.ts` does not declare.

`cf deploy` can print "Deploy complete" after it aborted on a conflict (the live Worker was last edited in the dashboard or through the script API). Trust the exit code.

**Complete when:** the exit code is 0 and the deployment list (`pnpm exec cf workers deployments list`) shows a new version at 100%.

### 3. Compare

Compare against what you recorded before step 2. The container application keeps its `<container-app-id>` and its version rises (modified, not created). The Durable Object namespace ids for `Supervisor` and `WorkspaceHost` are unchanged. The secret names are unchanged. The Observability settings still show logs, traces, and Issues on. Then run `pnpm ops:check --since 1h`.

**Complete when:** each of the four comparisons holds, or you can explain the difference, and `ops:check` prints a check mark or only explained findings. Read `docs/deploy.md`, "Deploy an update", for what each difference means.

## Check

### 1. Run the command

Give `ops:check` a credential: it reads only `CLOUDFLARE_API_TOKEN` or the file named by `--token-file` (the `cf` login JSON, `~/.config/cloudflare/config/default.json`, works after `pnpm exec cf auth whoami` refreshed it; an API token with Account Analytics Read is better for repeated runs). See `docs/agents/design/observability.md`, "Checking a running deployment", "Credentials". Then run `pnpm ops:check --token-file <file>` (or without the flag when the variable is set). The account is `--account`, then `CLOUDFLARE_ACCOUNT_ID`, then the only account the token sees. Use `--worker <worker>` for another Worker, `--since 90m|2h|1d` or `--from <ISO> [--to <ISO>]` for the window, and `--json` for parsing.

### 2. Read the result

A line starting with a check mark means all is well. A cross names a rule, the measured value against its threshold, the window, and up to three evidence ids. A line saying `unknown` means a source failed, hit its row limit, or returned nothing; it exits 1 because the command cannot say all is well. Missing data is never zero.

**Complete when:** every cross and every `unknown` line is explained from its evidence ids or reported as open. The rules and their thresholds are in `docs/agents/design/observability.md`, "Checking a running deployment".

## Stage

Stage a change that touches the container image, the Durable Object lifecycle, the idle stop, or anything else you cannot cover with unit tests. Follow [`references/staging.md`](references/staging.md) for the directory contents and commands.

### 1. Record the baseline

List the account's Workers, container applications, Durable Object namespaces, and registry images before you create anything.

**Complete when:** the four lists are saved, so cleanup can prove that nothing of yours remains and nothing else was touched.

### 2. Build the staging copy

Create a worktree and a staging directory with a unique Worker name and container name. `cf` has no `--config` flag, so the directory holds its own `cloudflare.config.ts`.

**Complete when:** the configuration has a unique `name` that differs from `<worker>`, `workersDev: true`, no `triggers`, a container named `<name>-workspacehost`, and instance type `standard-1`; and you printed these values and checked them before the deploy.

### 3. Deploy and exercise

Set the secrets with `--secrets-file`. Deploy with `pnpm exec cf deploy` from the staging directory. For the owner API, authenticate with a local Access session: `pnpm local:access-session` writes a throwaway signing key and the staging Worker trusts its public key. Exercise the change, then read the events with the Query recipes and `pnpm ops:check --worker <name>`.

**Complete when:** the change did what you claim, with timestamps and event names as evidence, and you recorded the container minutes used (the instances API, start to `inactive`).

### 4. Clean up and prove it

Delete the Worker, the container application, the registry images you pushed, and the worktree and staging directory. Then list again.

**Complete when:** the Workers, applications, namespaces, and images lists equal the baseline from step 1, and `<worker>` and every resource you did not create are untouched.

## Diagnose

### 1. Establish what ran

Run the Check branch over the window. Then follow `docs/agents/design/observability.md`, "Query recipes", "Cost check", to turn usage buckets into running minutes per day.

**Complete when:** you have running minutes per day, the stop events for each run, and who owned the work (`route.settled`, canceled invocations, `turn.*`).

### 2. Match the known causes

`docs/agents/incident-2026-09-container-cost.md` lists the causes found so far: a client that polls a route that touches the workspace, a Durable Object kept active by an open request, and the shim's disk walk. Compare your evidence with each.

**Complete when:** each known cause is confirmed or excluded with a number, or the remainder is recorded as unknown. Billing data needs an API token with Billing Read; the `cf` login cannot read it.
