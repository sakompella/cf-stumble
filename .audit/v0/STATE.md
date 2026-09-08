# cf-stumble v0 — run state

Written at the end of the 2026-09-08 overnight finishing run on hp. Durable home `.audit/v0/`
(gitignored). The checklist is `.audit/v0/overnight.md`; read it first.

## Head of main

`2849183`, pushed. `pnpm verify` green: 109 test files, 778 tests, about 56 s.
`pnpm harness:browser` green: 41 cases, 41 passed.

## The deployment

`https://cf-stumble.adityakompella.workers.dev`, account `0817758e93f2d197d0c512d94f276650`.
Deploy from hp with `pnpm exec wrangler deploy -c /tmp/wrangler-hp.jsonc`; that file is a copy of
`wrangler.jsonc` with an absolute `main`, the managed-registry image digest, observability, and the
probe `vars`. Rebuild it from the tracked config after any change to `wrangler.jsonc`.

The container image is built and pushed by hand on hp, because podman rewrites the manifest on push
and wrangler then asks Cloudflare for a digest the registry does not have (D76):

```
podman build --platform linux/amd64 -f containers/computerd.Dockerfile \
  -t registry.cloudflare.com/<account>/cf-stumble-workspacehost:vN .
pnpm exec wrangler containers push registry.cloudflare.com/<account>/cf-stumble-workspacehost:vN \
  --path-to-docker "$(command -v podman)"
```

Then read the digest the registry actually stored from
`https://registry.cloudflare.com/v2/<account>/cf-stumble-workspacehost/manifests/vN` with
credentials from `wrangler containers registries credentials registry.cloudflare.com --pull --json`,
and put that digest in the override config.

Deployed probes authenticate with the disposable token in `.audit/local/access-session.json`, sent
as `Cf-Access-Jwt-Assertion`. The Worker verifies it through its ordinary path against an injected
JWKS (D77). Mint a new one with `pnpm local:access-session`; `LOCAL_ACCESS_AUD` chooses the
audience, and a new audience means a new Supervisor and a new empty workspace.

## What is proved deployed

The whole demo path except the parts that need a browser and a human: the owner page, the
refusals, both Durable Objects, the tenant's own Computer container, a commit built into a stored
module map, a candidate cold-checked through the Worker Loader, activation, a stale epoch refused,
a real coding turn that read and edited a file and ran a command with its diff and thread saved, a
deliberately broken candidate that failed while the active generation kept serving, and a rollback
in 0.26 s with no build. `.audit/v0/evidence/deployed-generation-loop.md` quotes every response;
`deployed-plumbing-probe.md` has the raw timings and the failures on the way.

## What is blocked

- The Cloudflare Access application (D81). One owner action: create the application, add the owner
  policy, read the `sub` claim from the first login. `docs/deploy.md` has the steps.
- The deploy button end to end. Needs a browser login and a second clean account.
- The workspace `write` tool returns a backend error (D82). A turn works around it with `bash`.

## Rules earned in this run

- Wrap every podman, computerd or foreground server command in `timeout` and redirect its output.
  One unbounded `podman run` blocked the session for about three hours.
- A deployed failure is worth more than a local one. Five faults in this repository were invisible
  to `pnpm verify`, to the local container preflight, and to the browser harness.
- Never deploy immediately before a long probe. A deploy rolls the container out and kills whatever
  it was doing: two probe failures were nothing but that.
- Give a worker the verified fault with file and line, and an explicit way to report the brief
  wrong. Three workers corrected their briefs, and each correction was right.
- A test the review calls decorative may still bind real behavior. Mutate the production line
  before deleting it: five such tests turned red under the right mutation and were kept.
