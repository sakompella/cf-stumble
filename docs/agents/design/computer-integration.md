# Computer integration

cf-stumble uses Cloudflare Computer source commit `12336475c9fd03f5280a4537a707797fc0131fbd` with image `ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11b5c9235ecd7ba7a4d9a4bbad52e8fd4366d76ee3dbfa1099c9295c6f`. ADR-0026 records the decision. The workspace image builds `computerd` from that commit with `containers/computerd-walk.patch` and `containers/computerd-exec.patch` applied, and checks that an unpatched build reproduces the image's binary; ADR-0042 records why the walk is patched. The exec patch waits for the child's `close` event before recording exit, so paused stdout and stderr drain before the command log closes. Normal exits have a bounded drain grace for inherited pipes; explicit kills close the pipes at once. A paused reader can keep draining until the command timeout, without losing output at the grace boundary. The regression tests run in the image build.

## Pinned pair

Both pins must change and be retested together. The source contains unreleased `@cloudflare/computer` and `@cloudflare/computerd` 0.3.0, while npm `latest` remains 0.2.1; changing only one pin could combine incompatible versions.

## Verified capabilities

Worker-shell handles text operations and host-forwarded Git. The container handles Node, pnpm, TypeScript compilation, tests, and project commands.

The paired source and image ran on a paid Cloudflare account on 2026-08-29. Container commands worked after cold starts of about 2.6–2.9 seconds. Files persisted across requests and stayed isolated by workspace identity. The stock example provided Node 22.23.2, pnpm 11.24.0, Git, and FUSE. `pnpm add is-odd@3.0.1` installed and ran through network package access.

Computer issue [#114](https://github.com/cloudflare/computer/issues/114) reports a deployed WebSocket failure in 0.2.1. The exact 0.2.1 reproduction was not deployed, so the issue is neither disproved nor known to be fixed. Repeated warm and cold requests using the pinned 0.3.0 pair did not show the failure.

## Upgrade follow-up

This section records pre-release research: the check it describes ran before the `v0` tag, when
no Computer release had shipped a supported Worker-shell, container, and Durable Object path.
`v0` shipped on the pinned pair below, and the pin is unchanged at this commit
(`package.json`). Before adopting any newer Computer release, check whether Cloudflare has
published one that provides the required Worker-shell, container, and Durable Object behavior,
and prefer it only if the full application workflow passes against it. Until then, retain the
source and image pair that the paid-account test exercised; do not update one without the other.

## Workspace layout

Version 0 uses one durable Computer workspace for the owner's harness repository and connected
GitHub project repositories. Each repository has its own directory and Git history. The page selects
a project directory in which the main facet starts work, but the shared filesystem is not a security
boundary between the owner's repositories.

Each project also has one current Pi thread stored outside the workspace and outside generation
state. Starting a fresh thread replaces conversation and compacted context without changing project
files. Both the project thread and shared workspace survive main-harness generation changes.

Neither a fresh thread nor a workspace reset stops a turn that is running, so both refuse instead
of racing it. The Supervisor answers a fresh thread with HTTP 409 `turn-active` while that project's
turn lease is live, and a workspace reset with the same answer while any project's or the harness's
lease is live. A lease is live until its turn releases it or its deadline passes. A fresh thread
would stop the running turn from saving but not from editing files, and a later turn could start
beside it; a reset would delete the files under it and kill its commands halfway through a change.
The Workspace Host also refuses a reset with HTTP 409 `workspace-busy` while it runs a build,
provision, or removal, which the reset would otherwise cut off.

The workspace behaves like an ordinary development machine. It has unrestricted outbound internet
access, `git`, `gh`, and repository toolchains. GitHub credentials live in `gh` and Git
configuration under `/workspace`, outside the repositories, so they survive a container replacement.

The workspace name comes from the tenant and from nothing else. The Worker turns a verified Access
token into the Supervisor's name, and the Supervisor derives its one workspace name from that name,
so harness builds and every project of one owner reach the same container and a different verified
identity reaches a different one. No request supplies the name.

`src/workspace-layout.ts` owns the layout:

| Path                               | Holds                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `/workspace`                       | The workspace root. Every addressed path lives beneath it.                          |
| `/workspace/AGENTS.md`             | The managed instructions, above every repository.                                   |
| `/workspace/harness`               | The owner's editable harness checkout.                                              |
| `/workspace/.config/gh`            | `gh` configuration, including the GitHub credential (`hosts.yml`).                  |
| `/workspace/.gitconfig`            | Git's global configuration, including the `gh` credential helper.                   |
| `/workspace/projects/<project id>` | One connected project's clone.                                                      |
| `/tmp/cf-stumble-builds/<commit>`  | Build scratch for one labeled commit, outside `/workspace`. It holds no repository. |

Selecting a project sets the working directory a turn starts in. The project capability addresses
the whole workspace, so the agent can read a sibling repository or the managed instructions, and
the path guard is the workspace root. Both the guard and the addressed-path translation read
`WORKSPACE_ROOT` from that one module, so they cannot drift into disagreeing about what is inside
the workspace.

A turn's project capability lasts only as long as the turn. The Supervisor asks the Workspace Host
for it with the admitted turn's remaining budget, so the Host ends it at the turn's deadline, and the
Supervisor ends it again when the turn settles. Once it has ended, `lstat`, `readFile`, `writeFile`,
`listFiles`, and `startExec` answer `turn-ended`, also through a duplicate that the generation kept,
so a generation that ignores the end of its turn cannot keep editing the shared workspace while a
later turn runs. `kill` and `endTurn` still answer, so cleanup can run more than once. A container
replacement refuses only the next command, with `container-restarted`; file calls go on, because the
files are durable (`src/workspace/project/target.ts`).

## Harness execution

The harness source is TypeScript, while Dynamic Workers require Worker-executable modules. Computer
builds a canonical module map for a labeled harness commit. The Supervisor validates it and stores
it in its own Durable Object SQLite under that commit, so nothing rebuilds to serve or to roll
back. Computer supplies the environment in which compilation and tests run, and ADR-0028 defines
the artifact.

Worker Loader names are cached. The Supervisor uses the labeled harness commit ID as the Loader name, so a changed harness commit does not silently reuse old code.

## Harness build isolation

A build extracts its commit into `/tmp/cf-stumble-builds/<commit>` and clears that directory
first. That path is container-local, not durable: it sits outside `/workspace` and outside
Computer's Durable Object, and a cache miss on a container restart rebuilds it from scratch
(`src/workspace-layout.ts`). Nothing else lives there, so clearing it can destroy no checkout. The
harness directory is the owner's editable clone: a build reconciles it and fetches into it, and
refuses rather than deletes when it finds a populated directory that is not that repository.

Two builds of one commit cannot delete each other's files. The owner builds in one workspace
container. `WorkspaceHostModuleMapBuilder` admits one build per commit at a time, so a second request
for a commit already building joins that build. Nothing is queued, deferred, or retried. Whether
Computer permits overlapping container operations at all is a separate paid question.

## Harness build preconditions

The Supervisor's build runs `HARNESS_BUILD_CONFIGURATION.buildPhases` in a directory that
`git archive` has just written. That directory contains tracked files only, so it has no
`node_modules` and no `vendor/pi-v0.84.4/dist/`. The phases are therefore an install from
`pnpm-lock.yaml`, a build of the vendored Pi package, and a build of the module map, in that
order.

Each phase is a step of its own, so it is one Durable Object RPC, one exit code and one bounded
output tail. One command was not survivable: three deployed builds of one commit died at 671 s,
692 s and 696 s, two of them losing the Durable Object and one exiting 1 with an empty stdout and
an empty stderr, and none of them said which phase had been running. Every build that ever
succeeded on that account took 527 s or less, and the install alone measures 39 s in the deployed
container.

`pnpm run build:artifact` runs the same phases in the same order, and is what a developer and
`scripts/probe/clean-build.sh` run locally.
`test/supervisor/artifacts/build-command.test.ts` checks that every phase names a script
`package.json` defines, or installs with flags only, and that the phases in order are exactly what
`build:artifact` runs, so the deployed build and the local gate cannot drift apart again.

The list below records what a fresh build container must provide. A developer machine hides most
of these, because it has a warm pnpm store, a newer Node, and generated output already in place.

1. **pnpm.** `pnpm-lock.yaml` declares `lockfileVersion: '9.0'`, and `package.json` pins
   `"packageManager": "pnpm@11.18.0"`. The recorded container pnpm 11.24.0 reads that lockfile, but
   it honours the pin, so its first run downloads pnpm 11.18.0 before `pnpm install` starts. That
   download is unproved in the container.
2. **Node.** The container ships Node 22.23.2. The tightest `engines` entries in the lockfile are
   `^20.19.0 || >=22.12.0`, `>=22.0.0`, and vitest's `^20.0.0 || ^22.0.0 || >=24.0.0`, so 22.23.2
   satisfies every one of them, and `@types/node` is pinned to 22.19.19 to match. A local run on
   Node 26.7.0 is more permissive than the container, so it cannot disprove a Node 22 failure.
3. **Registry reachability.** The install needs `registry.npmjs.org` and nothing else: the lockfile
   has no Git or CDN resolution, and the one file dependency,
   `vendor/cloudflare-computer-0.3.0.tgz`, is tracked and arrives with the archive. The recorded
   paid evidence for network package access is one `pnpm add is-odd@3.0.1`. That is a much smaller
   claim than 186 packages and about 145 MB, and a much smaller claim than reaching an arbitrary
   internet destination.
4. **Install scripts.** `pnpm-workspace.yaml` allows builds for `esbuild`, `koffi`, and `workerd`,
   and refuses them for `@mongodb-js/zstd` and `node-liblzma`. None of the three is needed for the
   artifact build. `tsx` declares no scripts, and esbuild and workerd ship their binaries as
   platform optional dependencies that the lockfile already names for linux-x64, so an install run
   with `--ignore-scripts` still yields a working `tsx` and `esbuild`. `koffi` serves the Hegel
   property tests, which run in Node under `pnpm verify` and not in a harness build. A build
   container therefore needs no compiler, node-gyp, CMake, or Python.
5. **Cold install cost.** On linux-x64 the lockfile installs 186 packages: about 145 MB compressed
   and about 496 MB unpacked, with `@cloudflare/workerd-linux-64` alone at 38 MB compressed and
   152 MB unpacked. A local clean build with an isolated `HOME`, and therefore an empty
   content-addressable store, downloaded all 183 resolved packages and finished
   install, Pi build, and module-map build in about 13 seconds on a fast home network. A container
   with slower storage and a possible FUSE-backed filesystem will be considerably slower. The
   configured timeout, `WORKSPACE_COMMAND_TIMEOUT_MS` (`src/workspace-command-timeout.ts`), is
   900 seconds and applies to each build step (install, Pi build, module-map build) separately,
   not once for the whole chain: `HARNESS_BUILD_CONFIGURATION.stepTimeoutMs`
   (`src/harness-build.ts`) sets each phase's own step budget to that value.
6. **git and tar.** The provision step runs `git rev-parse`, `git clone --no-checkout`,
   `git config`, `git cat-file`, and `git fetch`, and the checkout step runs `git archive` and
   `tar`. The recorded container toolchain includes Git. It does not record `tar`, and the recorded
   network evidence does not cover outbound HTTPS to `github.com`, which the clone and fetch need.

## Clean-build checklist

Run `pnpm probe:clean-build` before a release and before any paid build probe. The script extracts
a commit into a temporary directory outside the repository, isolates `HOME` so pnpm starts from an
empty store, builds the commit twice, and compares the two module maps byte for byte. Keep its
output with the release evidence.

The script is a pre-check, not the release proof. The proof is two clean Computer builds of one
labeled commit, and this script never starts a container.

If `scripts/probe/clean-build.sh` or the `probe:clean-build` script is missing, this checklist
fails and the release stops. `test/supervisor/artifacts/build-command.test.ts` checks that both are
present, so `pnpm verify` fails before the checklist is reached.

## Generation requests

A harness commit becomes a generation when the Supervisor gives that specific commit a generation label; a commit alone does not activate it. The user or mutable main harness may submit a harness revision as a generation candidate and may request activation or rollback of a specific existing generation. The immutable supervisor validates and performs or rejects those requests directly, without a request ID or request journal. The current implementation exposes `POST /api/generations/submit`, `/activate`, and `/rollback` (`src/routes/owner-api.ts`, `src/routes/generations.ts`), and the Worker sets the owner principal from a verified Cloudflare Access token before routing to those handlers (`src/worker.ts`). ADR-0003 does not fix this command, transport, or authentication mechanism as a durable commitment, so a future redesign may still change them.

## Owner approval for a paid environment

The owner has approved a disposable paid Cloudflare account for the probes listed here. That
approval was always in force; nothing in this integration waits on it. The rules that stay:

- The account is disposable. Nothing depends on it surviving, and it holds no data the project needs.
- Local container results are local evidence. A probe run under Podman on an x86-64 box proves tool
  availability and build behaviour; it is not deployed-platform proof, and a report may not claim it is.
- A probe that cannot run states the blocker. It never reports a simulated result as a real one.
- Every paid run keeps its output with the release evidence, so the next reader sees the measurement
  rather than the claim.

## Container lifetime

The container does not stop by itself while the Workspace Host exists. Computer's backend accepts the WebSocket that computerd opens back to the Host, and nothing closes it, so the open request keeps the Durable Object active and the platform never sees it as inactive. The Host therefore stops an idle container itself: after ten minutes with no Host RPC in flight, no `exec` in flight, and no turn lease open, an alarm closes the `Workspace` and destroys the container (ADR-0043). An idle stop loses what a platform restart loses: files the sync does not copy into the durable store, such as `node_modules`, `/tmp`, and paths outside `/workspace`. Every `exec` pulls its changes into the store before it settles. The container's idle CPU is the shim's disk walk, which polls every five seconds (ADR-0044).

## Artifacts (deferred)

Cloudflare Artifacts is a Git server per repository. The owner decided on 2026-10-02 to skip it for now. It does not fit the current stores: the workspace is a live POSIX working tree that a container needs, a container cannot mount the FUSE filesystem Artifacts' mount tool uses (ADR-0042), and module maps must load with no network call. One gap would fit it: cf-stumble keeps no copy of uncommitted work outside the workspace, so a reset or a project disconnect destroys it. A pilot could checkpoint uncommitted work to Artifacts before those two operations. It would need a new paid product (in open beta, billing from 2026-10-14), a Git client inside the Worker (the binding cannot write files), and a remote simulator for tests, because Artifacts has no local one. Revisit it only after the owner approves that cost.

## Deployment risk

Dynamic Workers and Durable Object facets are beta, and Computer is preview software. Paid-account tests must exercise the exact Worker Loader, facet, Computer, and workspace-capability path before the project treats the integration as deployable.
