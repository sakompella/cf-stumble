# Preview repo fit: cf-stumble

Task C2. Read-only on `src/` and `wrangler.jsonc`. Every claim below is checked against the
current file contents, the Worker Previews docs dump, and the live `probe0` deploy already
recorded in `.audit/evidence/previews/probe/`.

## 1. The `previews` block

Append this to `wrangler.jsonc`, inside the top-level object, after `r2_buckets`. It omits R2
entirely and keeps SUPERVISOR and LOADER because `src/worker.ts` reads `env.SUPERVISOR` and
`src/supervisor/supervisor.ts` reads `this.env.LOADER`.

```jsonc
"previews": {
  "durable_objects": {
    "bindings": [
      {
        "name": "SUPERVISOR",
        "class_name": "Supervisor",
      },
    ],
  },
  "worker_loaders": [{ "binding": "LOADER" }],
},
```

`compatibility_date`, `compatibility_flags`, `migrations`, and `r2_buckets` all stay at the top
level and need no edit. The docs are explicit that a Cloudflare API binding such as
`worker_loaders` and a same-Worker Durable Object binding both need a `previews` entry only when
the code reads them from `env`; nothing else in the file needs mirroring. This is the same shape
the already-deployed probe used (`.audit/evidence/previews/probe/deploy.txt`), except that probe
warned about the missing `MODULE_MAPS` binding, which this fragment intentionally still omits.

## 2. Every place `src/` reads `env.MODULE_MAPS` or another R2 binding

None. `src/supervisor/env.d.ts:9` declares `readonly MODULE_MAPS: R2Bucket;` on the ambient
`Cloudflare.Env` type, but no file under `src/` ever reads `env.MODULE_MAPS` or imports an
`R2Bucket` value. The only place that touches `env.MODULE_MAPS` at all is a test,
`test/supervisor/artifacts/r2-binding.test.ts:12` and `:14`, which runs against
`vitest-pool-workers`' local Miniflare simulation and never calls the real Cloudflare account.

Since nothing in the deployed Worker calls `env.MODULE_MAPS`, dropping the binding from the
`previews` block cannot crash or degrade anything at runtime. Probe 1 can pass without R2. The
live probe confirms this: `wrangler preview` deployed successfully and only printed a
configuration-divergence warning about `MODULE_MAPS`, not an error
(`.audit/evidence/previews/probe/deploy.txt`).

## 3. Does `compatibility_date: 2025-01-01` block anything the docs require?

No hard block. The docs' recommended automatic Durable Object isolation path uses `ctx.exports`,
which needs the `enable_ctx_exports` compatibility flag, on by default only for
`compatibility_date` `2025-11-17` or later. `cf-stumble` is pinned to `2025-01-01`, so that
automatic path is unavailable. That is not a problem because `src/supervisor/supervisor.ts`
already uses the older, always-supported path: a `durable_objects.bindings` entry plus a
`migrations` entry, mirrored under `previews.durable_objects.bindings` per item 1. That path has
no compatibility-date floor.

## 4. What `GET /` returns today, and the smallest proof

`src/worker.ts:6-8` forwards every request unconditionally to
`env.SUPERVISOR.getByName("facet-spike").fetch(request)`. The Durable Object's own `fetch`
override, `src/supervisor/supervisor.ts:170-182`, calls `this.artifacts.mount(...)`. On a
freshly deployed Preview there is no active generation yet, so `mount` retains and loads the
built-in fixture artifact (`src/facet/fixture.ts`) through the `LOADER` binding
(`src/supervisor/artifacts/index.ts:95` onward) and relays the request to it. The fixture's own
handler, `src/facet/fixture.ts:24`, returns `new Response("main facet ready")` for path `/`, with
status 200.

The already-deployed `probe0` Preview proves this on the real runtime:
`.audit/evidence/previews/probe/curl-root.txt` shows `HTTP/2 200` and a body of exactly
`main facet ready`. I re-checked it live just now and it still returns `200`.

Smallest proof command:

```
curl -s https://<preview-host>/
```

Expected output: the literal line `main facet ready`. Anything else (a 1101 error page, an empty
body, a non-200 status) means the Supervisor never mounted, most likely from a missing
`SUPERVISOR` or `LOADER` Preview binding (see item 6).

Existing test that exercises the same startup-check machinery in miniflare:
`test/supervisor/startup-check/startup-check.test.ts:18`,
`"records a generation as ready when its candidate completes an ordinary request"`.

## 5. Smallest way to exercise the `LOADER` binding over HTTP

A route already exists: `GET /` itself, and in fact every path, because
`src/supervisor/supervisor.ts:176` calls `this.artifacts.mount(...)` on every incoming request
regardless of path, and `mount` always calls `loadMainFacet` (`src/facet/index.ts:30-45`), which
always calls `loader.get(...)` (`src/facet/index.ts:21`). No temporary handler is needed to prove
the `LOADER` binding works end to end; the live `probe0` curl trace already proves it
(`.audit/evidence/previews/probe/curl-root.txt`).

What `GET /` cannot reach is the *candidate* startup-check RPC,
`checkGenerationStartup` (`src/supervisor/startup-check/index.ts`). That method is only callable
as a Durable Object RPC (see `test/supervisor/rpc-surface.test.ts`), never through `fetch`. If a
future probe needs to drive that specific path over HTTP against a deployed Preview, it would
need a temporary route. This is a proposal only, not written to `src/`:

```ts
// src/worker.ts, temporary, do not commit
import { fixtureMainHarnessArtifact } from "./facet/index.js";

export default {
  fetch(request: Request, env: { SUPERVISOR: DurableObjectNamespace }): Promise<Response> {
    const url = new URL(request.url);
    const supervisor = env.SUPERVISOR.getByName("facet-spike");
    if (url.pathname === "/debug/startup-check") {
      return supervisor
        .checkGenerationStartup(0, fixtureMainHarnessArtifact)
        .then((result) => Response.json(result));
    }
    return supervisor.fetch(request);
  },
};
```

## 6. Risk list for `wrangler preview`, ranked

1. **Missing `SUPERVISOR` Preview binding.** `src/worker.ts:7` calls `env.SUPERVISOR.getByName(...)`.
   The docs say a missing `env` binding in the `previews` block returns a `1101` error. Symptom:
   the Preview URL loads but every request returns a Cloudflare `1101` error page instead of
   `main facet ready`.
2. **Missing `LOADER` Preview binding.** `src/facet/index.ts:21` calls `loader.get(...)` with no
   surrounding `try`/`catch`, and neither does `HarnessArtifacts.mount`
   (`src/supervisor/artifacts/index.ts:95`) or `Supervisor.fetch`
   (`src/supervisor/supervisor.ts:170-182`). If `LOADER` is undefined, that call throws a plain
   `TypeError` straight out of the Durable Object's `fetch`. Symptom: same as above, a `1101`
   page, but for a different reason, so the two are easy to conflate without checking which
   binding is actually missing.
3. **`wrangler preview settings` needs an existing Worker.** Ran
   `pnpm exec wrangler preview settings` here: it failed with
   `This Worker does not exist on your account. [code: 10007]`, because nothing is deployed yet
   (matches the given "0 workers" fact). The first `wrangler preview` deploy on a brand-new Worker
   name prompts interactively ("Would you like to create it for this Preview?"); the already-run
   probe answered that with a non-interactive fallback. A CI run without `--json`'s implicit
   fallback, or a shell that cannot answer prompts, can hang or fail here.
4. **`git branch` as the implicit Preview name.** `--name` defaults to the current git branch.
   The working branch here is `main`; deploying a Preview from `main` without `--name` would
   collide with a "production-looking" Preview name. Low risk (this repo's rule already forbids
   deploying), but worth naming explicitly in any run script.
5. **R2 disabled on the account.** Already checked empirically and downgraded: `r2_buckets` stays
   in `wrangler.jsonc`'s top level, and a real `wrangler preview` deploy in
   `.audit/evidence/previews/probe/deploy.txt` succeeded anyway, only printing a
   configuration-divergence warning about the missing `previews.r2_buckets` entry. This is not a
   blocker as long as `MODULE_MAPS` stays out of the `previews` block (item 1's fragment already
   does this).
6. **Private-beta command surface.** `wrangler preview`, `wrangler preview settings`, and
   `wrangler preview delete` all print a `🚧 private beta` warning. An unrelated Wrangler upgrade
   (4.126.0 to the available 4.128.0) could change flags or behavior between the probe and any
   later run.
