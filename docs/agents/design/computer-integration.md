# Computer integration

cf-stumble uses Cloudflare Computer source commit `12336475c9fd03f5280a4537a707797fc0131fbd` with image `ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11b5c9235ecd7ba7a4d9a4bbad52e8fd4366d76ee3dbfa1099c9295c6f`. ADR-0026 records the decision.

## Pinned pair

Both pins must change and be retested together. The source contains unreleased `@cloudflare/computer` and `@cloudflare/computerd` 0.3.0, while npm `latest` remains 0.2.1; changing only one pin could combine incompatible versions.

## Verified capabilities

Worker-shell handles text operations and host-forwarded Git. The container handles Node, pnpm, TypeScript compilation, tests, and project commands.

The paired source and image ran on a paid Cloudflare account on 2026-08-29. Container commands worked after cold starts of about 2.6–2.9 seconds. Files persisted across requests and stayed isolated by workspace identity. The stock example provided Node 22.23.2, pnpm 11.24.0, Git, and FUSE. `pnpm add is-odd@3.0.1` installed and ran through network package access.

Computer issue [#114](https://github.com/cloudflare/computer/issues/114) reports a deployed WebSocket failure in 0.2.1. The exact 0.2.1 reproduction was not deployed, so the issue is neither disproved nor known to be fixed. Repeated warm and cold requests using the pinned 0.3.0 pair did not show the failure.

## Upgrade follow-up

Before version 0 relies on the pinned pair, check whether Cloudflare has published a supported
Computer release that provides the required Worker-shell, container, and Durable Object behavior.
Prefer that release if the full application workflow passes against it. Until then, retain the
source and image pair that the paid-account test exercised; do not update one without the other.

## Workspace layout

Version 0 uses one durable Computer workspace for the owner's harness repository and connected
GitHub project repositories. Each repository has its own directory and Git history. The page selects
a project directory in which the main facet starts work, but the shared filesystem is not a security
boundary between the owner's repositories.

Each project also has one current Pi thread stored outside the workspace and outside generation
state. Starting a fresh thread replaces conversation and compacted context without changing project
files. Both the project thread and shared workspace survive main-harness generation changes.

The workspace behaves like an ordinary development machine. It has unrestricted outbound internet
access, `git`, `gh`, and repository toolchains. GitHub credentials live in local configuration
outside the repositories.

The workspace name comes from the tenant and from nothing else. The Worker turns a verified Access
token into the Supervisor's name, and the Supervisor derives its one workspace name from that name,
so harness builds and every project of one owner reach the same container and a different verified
identity reaches a different one. No request supplies the name.

`src/workspace-layout.ts` owns the layout:

| Path                               | Holds                                                         |
| ---------------------------------- | ------------------------------------------------------------- |
| `/workspace`                       | The workspace root. Every addressed path lives beneath it.    |
| `/workspace/AGENTS.md`             | The managed instructions, above every repository.             |
| `/workspace/harness`               | The owner's editable harness checkout.                        |
| `/workspace/projects/<project id>` | One connected project's clone.                                |
| `/workspace/.builds/<commit>`      | Build scratch for one labeled commit. It holds no repository. |

Selecting a project sets the working directory a turn starts in. The project capability addresses
the whole workspace, so the agent can read a sibling repository or the managed instructions, and
the path guard is the workspace root. Both the guard and the addressed-path translation read
`WORKSPACE_ROOT` from that one module, so they cannot drift into disagreeing about what is inside
the workspace.

## Harness execution

The harness source is TypeScript, while Dynamic Workers require Worker-executable modules. Computer
builds a canonical module map for a labeled harness commit. The Supervisor validates it and stores
it in its own Durable Object SQLite under that commit, so nothing rebuilds to serve or to roll
back. Computer supplies the environment in which compilation and tests run, and ADR-0028 defines
the artifact.

Worker Loader names are cached. The Supervisor uses the labeled harness commit ID as the Loader name, so a changed harness commit does not silently reuse old code.

## Harness build isolation

A build extracts its commit into `/workspace/.builds/<commit>` and clears that directory first.
Nothing else lives there, so clearing it can destroy no checkout. The harness directory is the
owner's editable clone: a build reconciles it and fetches into it, and refuses rather than deletes
when it finds a populated directory that is not that repository.

Two builds of one commit cannot delete each other's files. The owner builds in one workspace
container. `WorkspaceHostModuleMapBuilder` admits one build per commit at a time, so a second request
for a commit already building joins that build. Nothing is queued, deferred, or retried. Whether
Computer permits overlapping container operations at all is a separate paid question.

## Harness build preconditions

The Supervisor's build runs `HARNESS_BUILD_CONFIGURATION.buildCommand` in a directory that
`git archive` has just written. That directory contains tracked files only, so it has no
`node_modules` and no `vendor/pi-v0.84.4/dist/`. The build command is therefore the single script
`pnpm run build:artifact`, which installs from `pnpm-lock.yaml`, builds the vendored Pi package,
and then builds the module map. `test/supervisor/artifacts/build-command.test.ts` checks that the
configured command names a script `package.json` defines, so the deployed command and the local
gate cannot drift apart again.

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
   with slower storage and a possible FUSE-backed filesystem will be considerably slower, so the
   recommended cold-build timeout is 900 seconds for the whole chain until a paid run measures it.
6. **git and tar.** The provision step runs `git rev-parse`, `git clone --no-checkout`,
   `git config`, `git cat-file`, and `git fetch`, and the checkout step runs `git archive` and
   `tar`. The recorded container toolchain includes Git. It does not record `tar`, and the recorded
   network evidence does not cover outbound HTTPS to `github.com`, which the clone and fetch need.

## Clean-build checklist

Run `pnpm probe:clean-build` before a release and before any paid build probe. The script extracts
a commit into a temporary directory outside the repository, isolates `HOME` so pnpm starts from an
empty store, builds the commit twice, and compares the two module maps byte for byte. Keep its
output with the release evidence.

The script is a pre-check, not the proof goal criterion 7 asks for. Criterion 7 requires two clean
Computer builds of one labeled commit, and this script never starts a container.

If `scripts/probe/clean-build.sh` or the `probe:clean-build` script is missing, this checklist
fails and the release stops. `test/supervisor/artifacts/build-command.test.ts` checks that both are
present, so `pnpm verify` fails before the checklist is reached.

## Generation requests

A harness commit becomes a generation when the Supervisor gives that specific commit a generation label; a commit alone does not activate it. The user or mutable main harness may submit a harness revision as a generation candidate and may request activation or rollback of a specific existing generation. The immutable supervisor validates and performs or rejects those requests directly, without a request ID or request journal. The exact command, transport, and authentication mechanism remain open.

## Owner approval for a paid environment

The owner has approved a disposable paid Cloudflare account for the probes listed here and in
`.audit/v0/q7-request.md`. That approval was always in force; nothing in this integration waits on
it. The rules that stay:

- The account is disposable. Nothing depends on it surviving, and it holds no data the project needs.
- Local container results are local evidence. A probe run under Podman on an x86-64 box proves tool
  availability and build behaviour; it is not deployed-platform proof, and a report may not claim it is.
- A probe that cannot run states the blocker. It never reports a simulated result as a real one.
- Every paid run keeps its output with the release evidence, so the next reader sees the measurement
  rather than the claim.

## Deployment risk

Dynamic Workers and Durable Object facets are beta, and Computer is preview software. Paid-account tests must exercise the exact Worker Loader, facet, Computer, and workspace-capability path before the project treats the integration as deployable.
