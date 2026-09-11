# Access, the route, and the owner's own identity

Recorded 2026-09-10 against the paid account.

## The fault

The instance was deployed and healthy for hours and was never reachable. The zone `akompella.dev`
has a proxied wildcard record pointing at another machine, so `stumble.akompella.dev` resolved to
that machine's web server. The Worker had no route and no custom domain, so it never saw a request
for the hostname. Cloudflare Access was correctly configured and sat in front of the hostname,
which made the symptom confusing: Access accepts the login and the page that appears belongs to
somebody else.

```
GET zones/<zone>/workers/routes    []
GET accounts/<account>/workers/domains    []
```

## The fix

One route, deployed from `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "stumble.akompella.dev/*", "zone_name": "akompella.dev" }],
```

A route rather than a custom domain, because a custom domain writes a DNS record and a route does
not, and the wildcard already makes the hostname proxied.

```
GET zones/<zone>/workers/routes
[{"id":"ac3cf9f8f79e460d99b3c68d6ea03512","pattern":"stumble.akompella.dev/*","script":"cf-stumble"}]
```

## Access, for real this time

The probe values are gone. The deployed Worker now carries the owner's real settings, and
`CF_ACCESS_PUBLIC_KEYS` is removed entirely, so it fetches the signing keys from the team domain:

```
CF_ACCESS_TEAM_DOMAIN   adityakompella.cloudflareaccess.com
CF_ACCESS_AUD           7eb624596cdec12cbada1f5334b8720f92172bc2e546eb179e79154c30b321fd
CF_ACCESS_OWNER_SUB     3eb1d2b2-2e13-5243-ba1b-147f5bd3c2a1
HARNESS_REPOSITORY_URL  https://github.com/sakompella/cf-stumble
```

Unauthenticated, the hostname now answers 302 to
`adityakompella.cloudflareaccess.com/cdn-cgi/access/login/stumble.akompella.dev`, and the redirect
carries the application's own audience tag and `hostname: stumble.akompella.dev`.

## What the Worker received when the owner loaded the page

`wrangler tail` redacts `cf-access-jwt-assertion`, so a temporary diagnostic decoded the presented
token and logged its claims and the admit-or-refuse decision. It was removed and the Worker
redeployed as soon as this was read. Two requests, the page and its favicon, both to
`https://stumble.akompella.dev/`:

```
PROBE access admitted {
  "aud": ["7eb624596cdec12cbada1f5334b8720f92172bc2e546eb179e79154c30b321fd"],
  "email": "kompella.sa@northeastern.edu",
  "iss": "https://adityakompella.cloudflareaccess.com",
  "sub": "3eb1d2b2-2e13-5243-ba1b-147f5bd3c2a1",
  "type": "app",
  "policy_id": "1a676465-04f8-48e6-81b0-8248b92b1c54"
}
```

Three things this settles.

1. **The `sub` is the `user_uuid`.** `3eb1d2b2-2e13-5243-ba1b-147f5bd3c2a1`, unchanged, so
   `CF_ACCESS_OWNER_SUB` needed no correction.
2. **The Worker serves the hostname.** The requests reached this script, so the page behind Access
   is cf-stumble and not the other machine's site.
3. **Access admits the owner, deployed and for real.** Not the injected JWKS this run used until
   now. A real Access application, the real team domain's signing key, the real audience, and the
   owner's own identity, and the boundary answered `admitted`.

An unauthenticated request in the same window never reached the Worker at all, because Access
turned it away at the edge.

## One side effect

Adding a route turns off the `workers.dev` subdomain, which is wrangler's default once routes
exist. `cf-stumble.adityakompella.workers.dev` now answers 404 and the owner hostname is the only
entry point. Set `"workers_dev": true` to keep both.

## Bootstrapping the owner's own instance

The owner's real identity is a different tenant from the probe identity this run used, because the
Supervisor's name comes from the verified identity and audience. So his instance had never run
anything: `/api/status` answered `{"activeGeneration":{"epoch":0}}` and every relayed route
answered 503 `no-active-generation`.

**Bootstrap is an explicit owner action, not a side effect of the first request.** Nothing
provisions or labels a first generation on its own. The Supervisor waits for
`POST /api/generations/submit`. Anyone following `docs/deploy.md` reaches the same 503 and has to
be told to submit, which is now in the guide.

### Three faults found while bootstrapping it

1. **The seeded package store was never used.** A command Computer runs in the container inherits
   `PATH` and nothing else, so `PNPM_HOME` never arrives and pnpm falls back to its default store
   under `$HOME`, which was empty. Every build downloaded all 182 packages, and the native install
   script that follows was killed for memory, exit 137. Neither `/root/.npmrc` nor
   `~/.config/pnpm/rc` moves pnpm's store; only `PNPM_HOME` does. So the seeded store is linked
   into the default location, and the install also skips package scripts.
   **Install went from about 300 s and an OOM to 39 s**, measured in the container.
2. **A build only ever sees committed, pushed code.** The build extracts the submitted commit from
   the remote, so a fix in the working tree cannot affect it. Two probe rounds were wasted on this.
3. **One command could not survive the whole build.** With install at 39 s the build still died at
   about 690 s, three times: two Durable Object resets and one exit 1 with empty stdout and stderr.
   Everything that ever succeeded was 527 s or shorter. A single command also loses its output when
   it is killed, so the failing phase was invisible.

### The fix, and the bootstrap

A build is now one step per phase: `provision`, `isolate`, `checkout`, `install`, `build-pi`,
`build-module-map`. Each is its own Durable Object RPC with its own exit code, its own bounded log
and its own time budget, and a failure names the phase instead of the build.

The owner's instance then bootstrapped on the first attempt:

```
POST /api/generations/submit  {"harnessCommit": "dd4ba4e46883f887d7dbc6978188da677b32f693"}
  -> candidate labeled generation 2, epoch 3
  -> preparation ok, stage "ready", "response body completed in 29 bytes", status 200
  321 s total; two phases visible in the tail at 131 s and 72.7 s
POST /api/generations/activate  {"label": 2, "observedEpoch": 4}
  -> activated, epoch 5, activationId 1                                    0.4 s
GET /api/status
  -> active generation 2, dd4ba4e, ready, epoch 5
GET /
  -> 200 "generation-0 main facet ready"                                   0.3 s
GET / with Accept: text/html
  -> 200, 42483 bytes, the owner page with its generation drawer
```

### Afterwards

The two temporary holes are closed. `workers.dev` is off again, so `cf-stumble.adityakompella.workers.dev`
answers 404, and `CF_ACCESS_PUBLIC_KEYS` is gone, so only Cloudflare's own signing keys are
accepted. Bindings on the deployed Worker: AI, LOADER, SUPERVISOR, WORKSPACE_HOST, GH_TOKEN,
CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, CF_ACCESS_OWNER_SUB, HARNESS_REPOSITORY_URL. An
unauthenticated request to the hostname answers 302 to Access, and a token this run minted is now
refused there, because Access turns it away before the Worker sees it.

## Two surfaces worth knowing about

- `/api/status` omits `generation` entirely when none is active rather than zeroing it, so a client
  tests for that field's presence. The `epoch` is the control epoch and legitimately starts at 0,
  which reads like an active generation at a glance and is not one.
- `/health` has no special case. Anything that is not `/api/...` and is not a browser navigation
  relays to the active generation, so before the first generation exists `/health` inherits the
  same 503. A forker has no generation-independent way to check that their Worker is alive.
