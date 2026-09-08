# Baseline smoke deploy, real paid account

Date 2026-09-08T02:00:08 on hp. Account
`Adityakompella@outlook.com's Account` (`0817758e93f2d197d0c512d94f276650`), tree at `main`
`e769586` plus the container image change below.

## What deployed

`https://cf-stumble.adityakompella.workers.dev`, version `cd2b4964-831f-4d0a-ae3c-d13215426364`.
Bindings reported by wrangler: SUPERVISOR and WORKSPACE_HOST Durable Objects, MODULE_MAPS R2
bucket, AI, LOADER Worker Loader. Container application `cf-stumble-workspacehost`
(`a03b9a60-62d5-4520-beb6-7fa5fa23e348`), instance type `basic`, max 1 instance.

## Smoke result

- `/ -> 401 'Unauthorized'`
- `/api/state -> 401 'Unauthorized'`
- `/ (with bogus CF_Authorization) -> 500 'Unauthorized'`

An unauthenticated request is refused with 401. A request that carries a credential while
`CF_ACCESS_*` is unset is refused with 500, which is the `invalid-configuration` refusal. So the
deployed Worker fails closed before configuration, which is what the fresh-account bootstrap
section of the handoff requires. Cloudflare Access itself is not configured yet, so this is not
yet proof that Access admits the owner.

## What the deploy taught us about container images

1. `wrangler deploy` with `image` set to `ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:...`
   fails with `IMAGE_REGISTRY_NOT_CONFIGURED`. Cloudflare containers only pull from the account's
   managed registry or from a registry the account has configured with credentials. The pinned
   public ghcr reference cannot be deployed as written. This is exactly the residue the handoff
   predicted for the deploy button (containers are not in the button's provisioning list).
2. The fix that works from any account is a one-line Dockerfile, `containers/computerd.Dockerfile`,
   whose `FROM` keeps the pinned digest. wrangler then builds it and pushes the result to the
   deploying account's own managed registry.
3. On hp there is no docker, only podman. `WRANGLER_DOCKER_BIN` can point at podman, but two
   podman gaps break the flow: podman rejects `--provenance`, and podman cannot read the
   Dockerfile from stdin. `/home/aditya/bin/docker-podman-shim` strips the flag and materializes
   stdin, which makes the build work.
4. The remaining podman gap is not shimmable. Podman rewrites the image manifest when it pushes,
   so the digest podman reports locally (`sha256:98d6f552...`) is not the digest the registry
   stores (`sha256:f54e9e6d...`), and wrangler asks Cloudflare for the local one. Cloudflare then
   answers `IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE`. Verified against the registry API directly with
   both Docker and OCI accept headers, and with a manual `podman push --format v2s2`, which
   produced a third digest.
5. So hp deploys with `/tmp/wrangler-hp.jsonc`, a copy of `wrangler.jsonc` whose only differences
   are an absolute `main` and an `image` that names the managed-registry digest the push actually
   created. The tracked config keeps the Dockerfile, because a docker host and Workers Builds CI
   (which the deploy button uses) do not have the podman digest problem.

Command for a repeat deploy from hp:

```
pnpm exec wrangler deploy -c /tmp/wrangler-hp.jsonc
```
