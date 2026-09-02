# Worker Previews

Cloudflare Worker Previews creates a separate Preview deployment from the current branch. The command is `wrangler preview`, while `wrangler deploy` targets production. A Preview has a workers.dev URL such as `<preview-name>-<worker-name>.<subdomain>.workers.dev`. Worker Previews is a private beta. (`.audit/evidence/previews/facts.md`)

## What the account probe proved

### Verified

- `wrangler preview --name probe0` created Worker `cf-stumble`, Preview `probe0`, and `https://probe0-cf-stumble.adityakompella.workers.dev`. Its deployment ID was `7248eedb-73af-4419-bac7-231e8d89a2ed`. (`.audit/evidence/previews/probe/deploy.txt`)
- `GET /` returned `HTTP/2 200` and `main facet ready`. That body exists only as module source inside the fixture map at `src/facet/fixture.ts:24`, `src/worker.ts:7` offers no other route, and `src/supervisor/supervisor.ts:176` mounts the facet through `this.env.LOADER` on every request. Reading those three together, the response means the request reached the Supervisor Durable Object, the runtime accepted the module map through `LOADER`, the loaded facet's own Durable Object class started, and the relay returned its response. The 200 alone does not prove the chain. The code path is what carries it. (`.audit/evidence/previews/probe/curl-root.txt`, `.audit/evidence/previews/repo-fit.md`)
- `GET /facet/ping` returned `pong`, which proved that the module map loaded more than one module. `GET /facet/bindings` returned `[]`. (`.audit/evidence/previews/probe/curl-root.txt`)
- `probe0` retained Durable Object state across two deployments of the same Preview. Deployment `7248eedb` served four relayed requests. Deployment `0d6ae53d` then read `attemptCount` `4` before taking any traffic of its own, and three further requests took it to `7`. (`.audit/evidence/previews/probe/deploy.txt`, `deploy-2.txt`, `isolation-probe0.txt`)
- `probe1` started with `attemptCount` `0`, went to `1` on its own traffic, and `probe0` stayed at `7`. Both Previews address the same Durable Object name, `facet-spike` in `src/worker.ts:7`. So two Previews of this Worker did not share this Supervisor's storage, which is consistent with the documented per-Preview namespace. One counter in one class is the extent of the measurement. Production was never deployed, so nothing here tests the production namespace. (`.audit/evidence/previews/probe/isolation-probe0.txt`, `isolation-probe1.txt`, `cleanup.txt`)
- Deleting `probe0` and `probe1` succeeded. Both URLs returned `404` afterward, and `wrangler containers list` found no containers. (`.audit/evidence/previews/probe/cleanup.txt`)
- R2 was disabled on the account with error `10042`. The Preview still deployed because the Preview configuration omitted R2. Wrangler warned that `MODULE_MAPS` diverged. (`.audit/evidence/previews/baseline/r2.txt`, `.audit/evidence/previews/probe/deploy.txt`)

### Not verified

- The probe did not start or call a Computer container. That probe is designed but was not run, because a container app bills on a paid plan and this account's Workers plan is unconfirmed. (`.audit/worker-previews-adoption.md`, section C12)
- The probe did not run the candidate startup-check RPC. `GET /` mounts the fixture but cannot reach `checkGenerationStartup`. (`.audit/evidence/previews/repo-fit.md`)
- The probe did not verify R2, the model route, or the complete P0 paid-runtime path. P0 still requires all of those checks. (`docs/agents/design/feature-map.md`)

### Inconclusive

- Cloudflare documents that Access can protect a Preview workers.dev URL without a custom domain. This OAuth token had no Access scope, so the probe could not verify that configuration. This remains INCONCLUSIVE. (`.audit/evidence/previews/facts.md`, `.audit/worker-previews-adoption.tsv`)

## Recommendation

Use Previews as disposable test infrastructure for P0, under three conditions from the verdict: name the Preview manually rather than letting it default to a branch, put it behind Cloudflare Access before it serves anything real, and deploy it from a trusted operator or CI context rather than from the mutable coding workspace. Do not make Previews version 0 product machinery. A generation candidate should NOT become a Preview for version 0. A Preview releases the whole Worker, so it forks the Supervisor and the Computer workspace with the candidate. Production cannot internally activate a Preview. (`.audit/evidence/previews/sol-verdict.md`)

Keep the Supervisor's candidate logic. A Preview can host candidate code at a stable URL, but it does not supply commit identity, authorization, request journaling, candidate status, or tenant candidate history. Keep the startup check. A Preview provides a target, not a gate, so the Supervisor must still run and record its bounded cold `GET /` check. (`.audit/evidence/previews/sol-verdict.md`)

Keep activation and rollback. A Preview cannot replace production routes or atomically select a generation at the tenant endpoint. An old deployment URL is not an epoch-checked rollback and does not restore the Supervisor's active-generation record. (`.audit/evidence/previews/sol-verdict.md`)

Keep the current isolation logic, and keep the reason straight. Per-Preview Durable Object isolation is not by itself fatal to a candidate-as-Preview design. Session state could live in R2 or D1 shared through bindings, or in a Durable Object owned by another Worker through `script_name`. What is fatal is the current packaging. cf-stumble needs a boundary between replaceable main-harness code and shared tenant state, and this Worker puts the Supervisor and the workspace on the Preview side of it, so a Preview forks both. Moving conversation storage alone would fix none of activation, workspace continuity, or the control boundary. (`.audit/evidence/previews/sol-verdict.md`)

## Version 0 plan

Nothing in `docs/agents/design/feature-map.md` changes. P0 already requires a temporary paid-runtime probe and preserved raw evidence. Previews do not implement the generation activation, rollback, workspace continuity, or control boundary that version 0 needs. This document records the command, result, and limits without changing the version 0 cut line. (`docs/agents/design/feature-map.md`, `.audit/evidence/previews/sol-verdict.md`)

## Reproduce the probe

Use a scratch worktree. Do not run these commands against a tenant Preview because deleting a Preview deletes its Durable Object state. (`.audit/evidence/previews/facts.md`)

1. Create the scratch worktree and install dependencies.

   ```sh
   git worktree add /tmp/cfs-previews-probe -b probe/worker-previews
   cd /tmp/cfs-previews-probe
   pnpm install
   ```

2. Confirm the `previews` block is present in `wrangler.jsonc`. It is committed to this repository as of the change that added this file, and it intentionally omits R2. A worktree taken from an earlier commit does not have it, and deploying without it produces a 1101 error page instead of `main facet ready`, because `env.SUPERVISOR` and `env.LOADER` will not exist.

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

3. Create the Preview and copy its URL from Wrangler output.

   ```sh
   pnpm exec wrangler preview --name probe0
   ```

4. Send the three requests. Expect `main facet ready`, `pong`, and `[]`.

   ```sh
   curl -s https://probe0-cf-stumble.adityakompella.workers.dev/
   curl -s https://probe0-cf-stumble.adityakompella.workers.dev/facet/ping
   curl -s https://probe0-cf-stumble.adityakompella.workers.dev/facet/bindings
   ```

5. To repeat the isolation measurement, copy `.audit/evidence/previews/probe/probe-state-route.ts.txt` over `src/worker.ts` in the scratch worktree, deploy again, then read `/probe/state` before and after traffic. That route is not in the repository, and the numbers in this document come from it.

   ```sh
   cp .audit/evidence/previews/probe/probe-state-route.ts.txt src/worker.ts
   pnpm exec wrangler preview --name probe0
   curl -s https://probe0-cf-stumble.adityakompella.workers.dev/probe/state
   ```

6. Delete the disposable Preview and inspect for leftover container apps.

   ```sh
   pnpm exec wrangler preview delete --name probe0 --skip-confirmation
   pnpm exec wrangler containers list
   ```

The `previews` block supplies the `env.SUPERVISOR` and `env.LOADER` bindings that this Worker reads. The missing `MODULE_MAPS` binding produces the documented divergence warning, but the deployed Worker does not read that R2 binding. (`.audit/evidence/previews/repo-fit.md`, `.audit/evidence/previews/probe/deploy.txt`)

## Sharp edges

- The R2 omission produces a `MODULE_MAPS` configuration-divergence warning. Add a separate Preview-safe bucket before code reads that binding. (`.audit/evidence/previews/probe/deploy.txt`, `.audit/evidence/previews/facts.md`)
- A container app can remain after Preview deletion. List apps after deletion and delete the Preview-named app by application ID when one remains. (`.audit/evidence/previews/facts.md`)
- A service binding in a Preview resolves to the production Worker, not a matching Preview. (`.audit/evidence/previews/facts.md`)
- Previews cannot consume Queue messages. Cron triggers do not invoke Preview `scheduled()` handlers. (`.audit/evidence/previews/facts.md`)
- Deleting a Preview deletes its Durable Object state. Treat every tenant-like Preview as throwaway. (`.audit/evidence/previews/facts.md`)
- The Access configuration gap remains INCONCLUSIVE until an operator with Access scope tests it. (`.audit/evidence/previews/facts.md`, `.audit/worker-previews-adoption.tsv`)
