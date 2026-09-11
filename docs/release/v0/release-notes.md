# Version 0 release notes

This release is the tag `v0` on `main`. Resolve it to its commit with `git rev-parse v0`, which is
the exact tree every result below was measured against. The tag exists because these notes ship
inside the commit they describe, so no SHA written here could name it.

## Release check

Run this command against that commit:

```sh
pnpm verify
```

A green result reports 110 test files and 784 tests. It also completes type checking, the format check, and linting.

## What is pinned

Computer source is pinned to commit `12336475c9fd03f5280a4537a707797fc0131fbd`. Its base image is pinned to `ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11b5c9235ecd7ba7a4d9a4bbad52e8fd4366d76ee3dbfa1099c9295c6f`.

The deployment does not use that image directly. `containers/computerd.Dockerfile` starts with the pinned image, adds the required Debian and Node 22 userland, and Wrangler builds and pushes the result into the deploying account's managed registry.

The host chooses `@cf/zai-org/glm-5.3-flash` through its Workers AI binding. It uses low reasoning effort and a 4096-token output budget. A caller cannot choose a model, effort, or endpoint.

## Deploy

Run:

```sh
pnpm verify
pnpm exec wrangler deploy
```

A manual deployment needs Docker. Podman changes the pushed image manifest, which can make Wrangler ask Cloudflare for a digest the registry does not have. Workers Builds runs the equivalent deployment for the deploy button flow.

Set `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `CF_ACCESS_OWNER_SUB`, and `HARNESS_REPOSITORY_URL`. Set `GITHUB_OAUTH_CLIENT_ID` for the interactive GitHub route. Set the `GH_TOKEN` secret for the unattended route. If any `CF_ACCESS_*` value is absent, the Worker refuses every route. The full setup, costs, and cleanup steps are in [the deployment guide](../../deploy.md).

## Observed deployment behavior

The evidence records these results from the paid deployment:

- A cold submission built a commit into a stored module map, checked its candidate, and made it ready in 321 seconds. Activation took 0.4 seconds and the active generation answered `GET /` in 0.3 seconds. [Access, route, and bootstrap evidence](evidence/access-and-route.md) contains the raw responses.
- A real coding turn read a file, wrote through the product tool, ran a command, streamed a diff, and saved its thread in 9.8 seconds. [The deployed generation loop](evidence/deployed-generation-loop.md) contains the stream frames and output.
- A deliberately broken candidate failed its startup check while the active generation continued to answer. The failed submission took 510 seconds. The same evidence records the result.
- Rollback activated a stored module map in 0.26 seconds without a build or Workspace Host call. [The deployed generation loop](evidence/deployed-generation-loop.md) contains the tail evidence.
- Cloudflare Access admitted the owner's real identity at `stumble.akompella.dev`, and `workers.dev` is off. One GitHub repository was connected beside the harness clone in one workspace. [Access and route evidence](evidence/access-and-route.md) contains the Access result. [The deployed generation loop](evidence/deployed-generation-loop.md) contains the workspace result.

## Limits and unproven areas

The Deploy to Cloudflare button flow has never run against a clean account. The configuration it consumes was deployed in a probe, but the interactive fork and provisioning screen needs a browser login and was not exercised. [The deployed generation loop](evidence/deployed-generation-loop.md) records that distinction.

Compaction across a reload is untested.

The GitHub credential does not survive a container recycle. It lives in `gh` configuration inside
the container, not in the durable workspace, so a deploy or an idle eviction loses it and the
connection reports `reconnect-required`. Measured on the deployment: with the `GH_TOKEN` secret
set, the next request reinstalls it and the state returns to `connected` without anyone doing
anything. Without that secret, a person has to authorize again through the device flow. Anyone
relying on the interactive route alone should expect that.

On the measured half-CPU container, a first build takes five to eight minutes. A cold container request can add 10 to 60 seconds. See [the deployment guide](../../deploy.md).

## Demo recording

The demo recording is human work. It is not test evidence and it is not in this repository. The owner will choose where to publish it.

## Cost and cleanup

Workers Paid, Container time, and Workers AI requests can cost money. Follow [the deployment guide](../../deploy.md) to remove the Worker and Container application when the instance is no longer needed.
