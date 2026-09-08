# Deployed plumbing probe notes

Raw timings and failures from the paid account, 2026-09-08. Account
`0817758e93f2d197d0c512d94f276650`, Worker `cf-stumble` at
`https://cf-stumble.adityakompella.workers.dev`. Access verification runs against an injected JWKS
(decision log D77), so these prove the Worker, the Durable Objects, the container and the module
route, not a Cloudflare Access application.

## What answers, and how fast

Measured after the four simplification commits landed, on the fresh Supervisor
(`probe-fresh-2026-09-08` audience, empty storage at the start of this section).

| request | result | time |
|---|---|---|
| `GET /` with no credential | 401 | 0.2 s |
| `GET /` with an unverifiable credential | 401 | 0.2 s |
| `GET /` with a verified credential, `Accept: text/html` | 200, the owner page | 0.4 s |
| `GET /` with a verified credential, no HTML accept | 503 `no-active-generation` | 0.4 s |
| `GET /api/status` | 200 `{"activeGeneration":{"epoch":3}}` | 0.33 s |
| `GET /api/projects` | 200, the harness entry, `github: disconnected` | 1.5 s warm, 10-58 s cold |
| `POST /api/generations/submit` | 200, candidate labeled, preparation failed | 36-1282 s |

Before `CF_ACCESS_*` was configured, the same deployment answered 401 with no credential and 500
`invalid-configuration` with a credential. The Worker fails closed before configuration, which is
what the fresh-account bootstrap requires.

## The workspace container

The container is the tenant's own: its instance is named
`tenant:access:18a751a7ee95bcc0068ed3d13c693f4e32dc154cce763c5845aa8ee3b5c10134`, derived from the
verified identity and audience. It runs in `sjc06`. Cold start plus the first `gh` status command
took 10 to 58 s; a warm workspace command takes about 2 s.

Container application `cf-stumble-workspacehost` as the platform reports it:
`vcpu: 0.5`, `memory: 4 GiB`, `disk: 8 GB`, `runtime: firecracker`, `max_instances: 1`.

## The build, step by step

Every step ran deployed. Times are the Workspace Host Durable Object's own wall times, from
`wrangler tail`:

| step | what it does | time |
|---|---|---|
| provision | clone or reconcile the harness repository, fetch the commit | 1.3 - 9.6 s |
| isolate | clear and recreate the commit's scratch directory | 1.3 - 6.9 s |
| checkout | `git archive` to a tar, extract it | 2.7 - 5.7 s |
| build | `pnpm run build:artifact` | 300 - 1200 s, never finished |

The build step is the whole failure. It has failed in five distinct ways, each fixed in turn except
the last:

1. `tar: src/github: Cannot utime: No such file or directory`, exit 2. Computer's userspace
   filesystem refuses `utime`, `chown` and `chmod`. Fixed: `tar -x -m --no-same-owner
   --no-same-permissions` (commit `787ae6f`).
2. The build step was killed at about 55 s with exit -1, mid `pnpm install`. Computer's default
   command timeout. Fixed: every planned command carries a 900 s budget (`787ae6f`).
3. `build-output-missing` after an eleven minute build that exited 0. The module map read went
   through the workspace filesystem API, which does not see what a container process wrote. Fixed:
   the build reads its own output with `cat` through the same shell (`79b9e69`).
4. `build-output-missing` again, this time carrying "Connection closed: this Durable Object instance
   is no longer active". The build held one Workspace Host stub for its whole length. Fixed: a
   fresh stub per call (`33d042e`).
5. **Unfixed.** With the build inside the workspace: "Durable Object connection closed because the
   object was reset", reported as `build-workspace-unavailable`. The workspace is durable, so
   installing about fifty thousand `node_modules` files pushed them through the Durable Object that
   hosts it; afterwards an ordinary two second workspace command took over five minutes. With the
   build in the container's own `/tmp` (commit `390e86b`) the Durable Object survives and the
   container exits instead: "Container exited with unexpected exit code: 1", about 300 s into
   `pnpm run build:artifact`.

## Why this is where it stopped

The container has half a vCPU. `pnpm run build:artifact` installs 186 packages, builds the vendored
Pi package and then bundles the module map, and on half a vCPU that is minutes of work whichever way
it is arranged. Seeding the pnpm store into the image (commit `2efcb75`) removed the registry from
the critical path and the container still exits 1 at about five minutes.

A larger container is not available on this account. `PATCH
/accounts/.../containers/applications/<id>` with `instance_type: standard-4` returns 200 and leaves
the configuration at `vcpu: 0.5, memory: 4 GiB, disk: 8 GB`.

There is a second, separate limit: a submission that does finish takes longer than the edge will
hold a request. One 1282 s submission returned 200; two others were cut with a 502 at 1083 s and
1127 s.

## Resolved

The build was fixed after these notes were written. The cause was the command's own output:
Computer holds it in memory, and an unbounded `pnpm install` log made the container exit 1. The
install now reports silently and the step keeps only the last 4000 bytes (`a199797`), the pnpm
store is a layer of the image (`2efcb75`), and the whole loop runs end to end. See
`.audit/v0/evidence/deployed-generation-loop.md`. The three experiments below were not needed.

## The three experiments this note had planned, in order

1. Ask Cloudflare to enable a larger container instance type on the account, then repeat the
   submission. Half a vCPU is the first suspect for the exit-1, and the cheapest thing to change.
2. Build the artifact in the image instead of in the container: a Workers Builds step, or a
   prebuilt `node_modules` layer the build hardlinks from, so the deployed build is a bundle step
   rather than an install.
3. Make submission asynchronous. Even a fast build should not have to fit inside one HTTP request,
   and the deployed evidence says an 18 minute one certainly does not.

Superseded by `deployed-generation-loop.md`, which records the loop completing.
