# Cloudflare Worker Previews (private beta) facts

Sources: live docs on `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/*`, fetched and cross-checked against the `/tmp/previews-docs.txt` dump, plus `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/wrangler/commands/workers/` and local `pnpm exec wrangler preview --help` output. All pages listed in the task were fetched. One extra linked page, `test-and-debug`, was found by following links and is included where it answers a question.

## 1. What `wrangler preview` creates, and the workers.dev URL shape

The command help text:

> Create a Preview deployment of the current Worker for branch and pull request work. Use `wrangler deploy` for production.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/wrangler/commands/workers/#preview`

> Running `npx wrangler preview` creates or updates a Preview from your current branch.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/`

workers.dev URL shape, from the URL table:

> workers.dev | \<preview-name>-\<worker-name>.\<subdomain>.workers.dev | \<deployment-id>-\<worker-name>.\<subdomain>.workers.dev

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/` (Host type / Preview URL / Deployment URL table)

## 2. Durable Objects isolation, same Worker, with and without an `env` binding, and state on delete

> When a Durable Object class is defined in the same Worker with no `script_name`, each Preview gets its own isolated namespace and storage, separate from production and from other Previews. State persists across deployments within the same Preview and is deleted when the Preview is deleted.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/resources/`

Without an `env` binding (recommended path, `ctx.exports`):

> With `ctx.exports` (recommended, requires `enable_ctx_exports` compatibility flag, enabled by default for `compatibility_date` 2025-11-17 or later), the migration is enough for automatic Preview isolation... Production, feature-login, and redesign each get their own Durable Object namespace and storage. No `previews` block is needed.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/resources/`

With an `env` binding:

> If your code uses `env.COUNTER`, declare the binding in the `previews` block so the Preview has it.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/resources/`

Caution if the binding is missing:

> If you use `env.COUNTER` without declaring the binding in your `previews` block or in the Base configuration, the binding will not exist in the Preview and your Worker can return a **1101 error**.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/resources/`

Deleting the Preview:

State is "deleted when the Preview is deleted" per the first quote above. No separate retention or export step is documented.

## 3. `worker_loaders` binding support in the previews block

Supported. Quote:

> Bindings like `ai`, `browser`, `images`, `stream`, `media`, `worker_loaders`, and `version_metadata` give Preview code access to Cloudflare APIs. Unlike resource bindings, there is no staging resource to create — add the binding to the `previews` block if your code reads it from `env`.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/configuration/`

## 4. Containers: what must be declared, what is created per Preview, what cleanup is not automatic

What must be declared:

> Preview container configuration is not inherited from the top level. If both production and Previews need the container, declare the container in both places: Top-level `containers` for production. `previews.containers` for Previews.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/resources/`

> Every Durable Object setup requires a Durable Object class exported from your Worker and a `migration` in your Wrangler config.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/resources/` (Durable Objects section, the same rule Containers inherit since Containers are DO-backed)

Isolation and env binding caution for Containers:

> If you use `env.MY_CONTAINER` without declaring the Durable Object binding in your `previews` block or in the Base configuration, the binding will not exist in the Preview and your Worker can return a **1101 error**.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/resources/`

What gets created per Preview:

> When you run `wrangler preview`, Wrangler builds local images when needed, deploys the image for that Preview, and creates a container app owned by the Preview's Durable Object namespace. The generated container app name includes the Worker name, Preview name, and class name, for example: `my-worker_feature-login_MyContainer`

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/resources/`

Cleanup that is not automatic:

> Deleting the Preview deletes the Preview record. The Preview URL should stop serving after deletion propagates, and the backing Durable Object namespace is deleted with the Preview. However, the container app can remain visible in `wrangler containers list` after the Preview is gone.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/limitations/`

The docs give a manual/CI cleanup workaround (`wrangler preview delete` then `wrangler containers list` then `wrangler containers delete <APPLICATION_ID>`), and warn:

> Do not delete container apps by Worker name alone. A production container app for the same Worker can have a similar name but does not include the Preview name segment.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/limitations/`

Also relevant:

> Container support in Previews is partial. Same-Worker container namespaces and state are isolated per Preview, but you should still verify that the container process starts and responds in your deployment path before relying on the Preview for testing.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/resources/`

## 5. R2, KV, D1 sharing rule; missing binding behavior; 1101 caution

Sharing rule:

> These bindings point at account-level resources by ID or name. Two Previews bound to the same resource share data or instances. Create a separate resource to isolate.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/resources/`

Per-binding detail:

> `r2_buckets` — Binds to an R2 bucket by `bucket_name`. Two Previews sharing the same `bucket_name` share objects. To isolate: bind to a different R2 bucket.
> `kv_namespaces` — Binds to a KV namespace by `id`. Two Previews sharing the same `id` share namespace data. To isolate: bind to a different KV namespace.
> `d1_databases` — Binds to a D1 database by `database_id`. Two Previews sharing the same `database_id` share rows. To isolate: bind to a different D1 database.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/resources/` (Resource bindings table)

Missing binding in the `previews` block, general case:

> If `wrangler preview` creates a Preview URL but warns that bindings are missing, the URL is live but the runtime configuration is incomplete. Copy the missing bindings into the `previews` block below, using Preview-safe values and test resources.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/configuration/`

The 1101 caution (this is written for Durable Objects and Containers specifically, not for R2/KV/D1; the docs did not state a 1101 caution for R2, KV, or D1):

> If you use `env.COUNTER` without declaring the binding in your `previews` block or in the Base configuration, the binding will not exist in the Preview and your Worker can return a **1101 error**.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/resources/`

not stated in docs: a 1101-specific caution phrased for R2, KV, or D1 bindings. The general "URL is live but the runtime configuration is incomplete" warning above is the closest documented statement for resource bindings.

## 6. Every `wrangler preview secret` and `base-config` command form

From `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/wrangler/commands/workers/#preview-secret-put` and neighboring sections, and confirmed locally with `pnpm exec wrangler preview secret --help` / `pnpm exec wrangler preview base-config --help`:

- `npx wrangler preview secret put SECRET_NAME --name <preview>`
- `npx wrangler preview secret delete SECRET_NAME --name <preview>`
- `npx wrangler preview secret list --name <preview>`
- `npx wrangler preview secret bulk secrets.json --name <preview>`
- `npx wrangler preview base-config secret put SECRET_NAME`
- `npx wrangler preview base-config secret delete SECRET_NAME`
- `npx wrangler preview base-config secret list`
- `npx wrangler preview base-config secret bulk secrets.json`

Local CLI confirms the same command tree and adds the private-beta marker:

```
wrangler preview secret

Manage secrets for Worker Previews [private beta]

COMMANDS
  wrangler preview secret put <key>     Create or update a secret variable on a Worker Preview and create a new deployment [private beta]
  wrangler preview secret delete <key>  Delete a secret variable from a Worker Preview and create a new deployment [private beta]
  wrangler preview secret list          List all secrets on a Worker Preview's latest deployment [private beta]
  wrangler preview secret bulk [file]   Upload multiple secrets to a Worker Preview and create a new deployment [private beta]
```

```
wrangler preview base-config

Manage the Preview base config shared by Worker Previews [private beta]

COMMANDS
  wrangler preview base-config secret  Manage secrets on the Preview base config [private beta]
```

For `bulk`, the docs note:

> setting a key to `null` deletes that secret.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/configuration/`

## 7. Cloudflare Access on Preview URLs; custom domain requirement

> Preview URLs are public by default. Use Cloudflare Access to require sign-in. You can protect all Previews on an account, one Worker's Previews, or specific hostnames.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/`

Custom domain not required:

> Use Cloudflare Access to require sign-in before visitors can reach a Preview URL. Configure Access for Previews in one place, whether the Preview URL uses `workers.dev` or a custom domain.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/custom-domains/`

## 8. Limits: Previews per Worker, deployments per Preview, free vs paid

> Previews per Worker | 100 | 500
> Deployments per Preview | 100 | 100

(columns: Limit, Free plan, Paid plans)

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/`

Eviction behavior when a limit is hit:

> When a limit is reached, Cloudflare automatically deletes the oldest to make room: Preview limit: the Preview that was deployed to least recently is deleted. Deployment limit: the oldest deployment in that Preview is deleted.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/`

## 9. Every documented limitation

> Service bindings — Today, if Worker A has a service binding to Worker B and you deploy a Preview of Worker A, the Preview of Worker A can only bind to the production Worker B. It does not automatically bind to a matching Preview of Worker B.

> Queue consumers — Previews can produce messages to Queues... Previews cannot consume messages from Queues today. A Queue can have only one consumer Worker, and the Queues service does not yet register a Preview as that consumer.

> Cron Triggers — Cron Triggers target production. Previews do not create separate scheduled invocations, and the scheduler does not call a Preview's `scheduled()` handler today.

> Routes — Production routes target production. Previews do not take over zone routes, production custom domains, queue consumers, or other production triggers.

> Container application cleanup — the container app can remain visible in `wrangler containers list` after the Preview is gone.

Source for all five: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/limitations/`

Two more limitations found on the `index` and `test-and-debug` pages while following links:

> Service bindings, routes, Cron Triggers, and Queue consumers currently target production or sit outside the Previews system.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/`

> `wrangler tail` does not currently support Previews — use a Tail Worker destination or Logpush instead.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/test-and-debug/`

## 10. Previews block overriding or not inheriting production config

> Previews do not inherit production configuration. Configure Preview variables, secrets, bindings, and runtime settings before you share a Preview URL.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/get-started/`

> Previews do not inherit production values. Configure each Preview independently, or set a Base configuration that new Previews start from.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/`

> Your Wrangler file has production settings and a `previews` block. Production settings stay outside the block... Set your `previews` block on your production branch (or wherever you branch from), so when you create a new branch it carries that configuration over. When you run `wrangler preview`, the `previews` block on that branch is always the source of truth.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/configuration/`

> Each Preview owns its copy, so you can add, remove, or update any setting — variables, secrets, bindings, observability, and runtime — without affecting other Previews.

Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/configuration/`

## Facts that matter for cf-stumble

cf-stumble's `wrangler.jsonc` has one SQLite Durable Object (`Supervisor`), a `worker_loaders` binding named `LOADER`, an R2 binding (`MODULE_MAPS`), and a planned Container (Cloudflare Computer). Against that shape:

- `worker_loaders` is explicitly supported in `previews`. `LOADER` needs a `previews.worker_loaders` entry only if code reads it from `env`; no staging resource to create. Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/configuration/`.
- `Supervisor` is a SQLite-backed Durable Object defined in the same Worker. If it uses `ctx.exports` (not `env.SUPERVISOR`), each Preview gets an isolated namespace automatically, no `previews` block entry needed. Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/resources/`.
- If Supervisor is accessed through `env.SUPERVISOR` instead, the binding must be repeated under `previews.durable_objects.bindings` or the Worker can return a 1101 error in Preview. This is a real risk for cf-stumble's tenant routing code (`SUPERVISOR.getByName(tenant key)`), since that call pattern reads from `env`. Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/resources/`.
- Deleting a Preview deletes its Durable Object state. Any Preview used to poke at Supervisor state is throwaway; it cannot be treated as a durable staging tenant. Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/resources/`.
- `MODULE_MAPS` (R2) is a resource binding shared by bucket name. Every Preview that keeps the same `bucket_name` reads and writes the same R2 objects as production and other Previews, which is a plausible way to accidentally cross-contaminate real module maps with Preview builds unless a separate bucket is bound. Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/resources/`.
- The planned Computer Container follows the Durable Object isolation rule, but Preview container config is not inherited from the top level; cf-stumble will need a separate `previews.containers` block once the Container ships, or Previews will have no container at all. Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/resources/`.
- Container app cleanup is not automatic on Preview delete; leftover `wrangler containers list` entries need explicit `wrangler containers delete`, relevant if cf-stumble automates PR Preview deletion. Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/limitations/`.
- P0's Computer/Worker Loader capability probe currently runs outside Previews; the docs make no claim that Worker Loader or Container builds behave identically under `wrangler preview`, so P0's paid-account probe results do not automatically transfer to a Preview deployment.
- cf-stumble is single-tenant with Access-derived identity; Preview URLs are public by default and need their own Access policy, separate from whatever policy currently protects production. Source: `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/` and `https://worker-previews-docs-2.preview.developers.cloudflare.com/workers/previews/custom-domains/`.
