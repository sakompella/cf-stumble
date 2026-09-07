# T1a — the local half of roadmap task T1

Task: T1a. Local half of roadmap task T1 (acceptance criteria 1, 2, 3, plus the regression proof
the dispatch brief added). Criteria 4, 5, and the pin-replacement half of 6 are blocked.

Commit: `4bdd6dca7f2bc938f6ad1db962a339974aaad772` on branch `work/T1a`, based on
`d6ff2380487a60f410c568272635d99f30560d14`.
Worktree: `/private/tmp/cf-stumble-wt/T1a`.

`pnpm verify` passes at that commit: 94 test files, 650 tests, and the tracked pre-commit hook ran
the same gate before the commit was written.

## Changed paths

| Path | Change |
| --- | --- |
| `package.json` | Adds `build:artifact` and `probe:clean-build`. |
| `src/harness-build.ts` | Build command names `build:artifact`; provision obtains the commit and no longer erases an existing checkout; checkout propagates an archive failure; records the install location and the T3 race. |
| `scripts/probe/clean-build.sh` | New committed clean-build probe. |
| `test/supervisor/artifacts/build-command.test.ts` | New. Checks the build command names a defined script, that the script installs then builds Pi then the module map, and that the probe stays committed. |
| `test/workspace/harness-build.test.ts` | Checkout source, plus the provision fetch, the actionable absent-commit message, and the clone-then-replace order. |
| `test/supervisor/artifacts/module-map-build.test.ts` | Checkout assertion, plus a failed archive reported as the checkout step. |
| `test/supervisor/artifacts/build-workspace.test.ts` | Clone target renamed to the incoming directory. |
| `docs/agents/design/computer-integration.md` | Adds "Harness build preconditions" and "Clean-build checklist". The workspace layout decision is unchanged. |

## Acceptance criteria

### T1.1 — build a labeled commit from a clean checkout. HOLDS.

Reproduced first. A clean `git archive` of the commit, with an isolated `HOME`, installed from the
lockfile and then ran the old command `pnpm run build:module-map`. It failed exactly as E1
describes:

```
src/facet/generation-0/execution-env-exec.ts:1:45: ERROR: Could not resolve "@cf-stumble/pi"
... 5 errors, all in src/facet/generation-0/
```

Full output: `.audit/v0/tasks/T1a-e1-reproduction.log`. The same log shows
`vendor/pi-v0.84.4/dist` absent both before and after the install, which is the cause.

Repaired. `HARNESS_BUILD_CONFIGURATION.buildCommand` is now `pnpm run build:artifact`, and
`package.json` defines:

```
"build:artifact": "pnpm install --frozen-lockfile && pnpm run build:pi && pnpm run build:module-map"
```

The build obtains the named commit in the provision step, installs from `pnpm-lock.yaml`, builds
Pi, and then builds the module map, all inside the directory `git archive` wrote. Nothing is
borrowed: the probe below runs each build in a temporary directory outside the repository with a
fresh `HOME`, so no parent `node_modules`, no generated Pi output, and no uncommitted source is
reachable. The probe also fails outright if the extracted tree already contains `node_modules` or
`vendor/pi-v0.84.4/dist`, so it cannot quietly stop proving anything.

Archive failures now propagate. `git archive | tar -x` reported tar's exit code, so a failed
archive reached the build step as an empty directory and a misleading compilation error. The
checkout step writes the archive first and extracts it as a second command under `set -eu`, so an
archive failure is the checkout step's own failure.
`test/supervisor/artifacts/module-map-build.test.ts` asserts that a failing archive returns
`{ code: "build-step-failed", step: "checkout", exitCode: 3 }`. Compilation failures already
propagated through the same path and still do.

### T1.2 — a commit submitted after provisioning, an absent commit, an interrupted provision. HOLDS.

The provision step now takes the requested commit. Interpolation stays safe because
`HarnessCommit` accepts only lower-case hexadecimal object IDs, and the value is passed through
`shellQuote`.

- Found locally or fetched: the step runs `git cat-file -e "${commit}^{commit}"` and, on a miss,
  `git fetch --no-tags --quiet origin "$commit"`, then falls back to fetching the remote's branches
  for a server that refuses a request for a bare object.
- Bounded and actionable: at most two fetch attempts, then
  `printf "harness commit %s is not in %s\n" "$commit" "$expected_remote" >&2` and `exit 1`. The
  builder turns that exit code into
  `{ code: "build-step-failed", step: "provision", exitCode: 1 }`, so a wrong commit stops the
  build with the commit and the repository named instead of failing later inside esbuild.
- An interrupted provision erases nothing: the replacement clone lands in
  `${repository}.incoming.$$` and moves into place only after `git clone` returns. The old code ran
  `rm -rf "$repository"` before cloning, so an interruption left the owner with neither the
  editable checkout nor a replacement.

Evidence: three tests in `test/workspace/harness-build.test.ts` ("the provision step obtains the
requested commit before the build reads it", "an interrupted provision leaves an existing harness
checkout in place", and the checkout test), plus the updated clone assertion in
`test/supervisor/artifacts/build-workspace.test.ts`. These are checks on the planned command text,
which is what this module produces; the shell itself runs only inside the container.

### T1.3 — two clean builds produce identical maps. HOLDS LOCALLY, AND IS ONLY A PRE-CHECK.

`pnpm probe:clean-build` at commit `4bdd6dc`:

```
Clean build of 4bdd6dca7f2bc938f6ad1db962a339974aaad772
Archive bytes: 5785600
Build 1: 12 seconds, module map 905270 bytes, build directory 491M, cold store 536M
Build 2: 15 seconds, module map 905270 bytes, build directory 491M, cold store 536M
Module map sha256 (build 1): 387ed749d810edbabdea95e3078d4f5e3714fbb8007cbe7b989ee4b903b8da00
Module map sha256 (build 2): 387ed749d810edbabdea95e3078d4f5e3714fbb8007cbe7b989ee4b903b8da00
Two clean builds of 4bdd6dca7f2bc938f6ad1db962a339974aaad772 produced identical module maps
```

Retained at `.audit/v0/tasks/T1a-clean-build.log`. Each build extracts the commit into its own
directory with its own `HOME`, so each starts from an empty pnpm store and downloads every package
again.

**Wording correction, stated plainly.** The roadmap says "two independent clean builds produce
byte-identical canonical maps". Goal criterion 7 says two clean **Computer** builds. This local run
is a fast pre-check on a developer machine. It does not close goal criterion 7, and nobody should
later cite this log as that proof. Two builds inside Computer remain unproved and are blocked on
paid approval.

The script compares the build output byte for byte rather than the canonical form. The canonical
map is a function of that output and the commit the Supervisor asked for
(`canonicalModuleMap` in `src/supervisor/artifacts/module-map.ts`), so equal output means equal
canonical maps. `test/supervisor/artifacts/module-map-build.test.ts` already proves the
canonicalization side with a fake workspace, and that test is not this check.

### T1.4 — paid facet capability probe. BLOCKED: awaiting owner approval for a paid probe.

Not attempted. No workspace was created, no Worker was deployed, and no billing API was called.

### T1.5 — Computer build, Loader load, cold `GET /`, restart and eviction. BLOCKED: awaiting owner approval for a paid probe.

Not attempted, for the same reason.

### T1.6 — Computer source/image pin check. PARTLY DONE, REPLACEMENT HALF BLOCKED.

The pinned pair is retained unchanged: source `12336475c9fd03f5280a4537a707797fc0131fbd` with image
`ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11...`. No pin moved in this commit.
Checking a candidate replacement requires running the same paid checks that T1.4 and T1.5 need, so
that half is **blocked: awaiting owner approval for a paid probe**. T1's own criterion 6 says
missing paid authorization is blocked, not passed, and this report follows it.

## The four deliverables the brief added

(a) **One `build:artifact` script.** `package.json` defines
`pnpm install --frozen-lockfile && pnpm run build:pi && pnpm run build:module-map`.

(b) **The build command is exactly that script name.**
`HARNESS_BUILD_CONFIGURATION.buildCommand` is `pnpm run build:artifact`.

(c) **A test inside `pnpm verify` that the command names a real script.**
`test/supervisor/artifacts/build-command.test.ts` reads `package.json` through a build-time Vite
glob, so it runs in workerd with no filesystem access. It checks that the build command matches
`pnpm run <script>`, that `package.json` defines that script, and that the script installs from the
lockfile before it builds Pi and builds Pi before the module map. A rename on either side fails the
gate.

(d) **A committed clean-build test.** `scripts/probe/clean-build.sh`, run by
`pnpm probe:clean-build`. It takes about 30 seconds for two builds on a warm network, which is too
slow for an 11-second gate, so it is a separate committed script rather than a test. The same
verify-time test asserts that the script and the `probe:clean-build` entry both still exist, so
deleting either fails `pnpm verify` before the checklist in
`docs/agents/design/computer-integration.md` is ever reached. That checklist tells T12 and CI to
run it before a release and before a paid build probe.

`dist/` is still untracked. `git ls-files "vendor/**/dist"` returns nothing, and nothing in this
commit adds build output to the index.

## Container preconditions, as named findings

Each is labelled with what settles it. The local machine has a warm store, Node 26.7.0, and
pnpm 11.18.0, so it hides most of these.

1. **pnpm.** SETTLED LOCALLY, with one residual. `pnpm-lock.yaml` declares
   `lockfileVersion: '9.0'`; `package.json` pins `"packageManager": "pnpm@11.18.0"`. The container's
   recorded pnpm 11.24.0 reads that lockfile. Residual, BLOCKED: pnpm honours the pin, so the
   container's first run downloads pnpm 11.18.0 from the registry before `pnpm install` starts.
   That download has never run in a container.
2. **Node.** SETTLED LOCALLY. Container Node 22.23.2 satisfies every `engines` entry in the
   lockfile. The tightest are `^20.19.0 || >=22.12.0` (57 packages), `>=22.0.0` (wrangler, miniflare,
   `@cloudflare/kv-asset-handler`) and vitest's `^20.0.0 || ^22.0.0 || >=24.0.0`. `tsx` needs
   `>=18.0.0`, `esbuild` `>=18`, `typescript@7.0.2` `>=16.20.0`. `@cf-stumble/pi` declares no
   `engines`. `@types/node` is pinned to `22.19.19`, matching the container rather than this
   machine. No incompatibility found. The local Node 26.7.0 run is more permissive than the
   container, so it cannot disprove a Node 22 specific failure.
3. **npm registry reachability.** BLOCKED. The install needs `registry.npmjs.org` and no other host:
   the lockfile has no Git or CDN resolution, and the single file dependency
   `vendor/cloudflare-computer-0.3.0.tgz` is tracked, so it arrives with `git archive`. Prebuilt
   native binaries are ordinary registry packages (`@esbuild/linux-x64`,
   `@cloudflare/workerd-linux-64`, `@koromix/koffi-linux-x64`, and so on). The recorded paid
   evidence is one `pnpm add is-odd@3.0.1`. That proves one small package from one host once. It
   does not prove 186 packages and about 145 MB compressed, and it is a narrower claim than
   T1.4's "arbitrary ordinary internet destination". Sustained registry throughput in the container
   is unproved.
4. **Lifecycle and native install scripts.** SETTLED LOCALLY. `pnpm-workspace.yaml` allows builds
   for `esbuild`, `koffi`, and `workerd`, and refuses `@mongodb-js/zstd` and `node-liblzma`. None of
   the allowed three is needed by the artifact build: `tsx` declares no scripts; `esbuild` and
   `workerd` ship their binaries as platform optional dependencies that the lockfile names for
   linux-x64, so `--ignore-scripts` would still yield a working `tsx` and `esbuild`; `koffi` serves
   the Hegel property tests, which run under `pnpm verify` in Node, never in a harness build. So a
   build container needs no compiler, node-gyp, CMake, or Python. `--ignore-scripts` is therefore a
   documented fallback, not the current setting: the clean-build probe ran with scripts enabled,
   and `koffi` took its prebuilt path rather than compiling.
5. **Cold-store install time and disk.** MEASURED LOCALLY, NOT IN A CONTAINER. With an isolated
   `HOME`, so an empty content-addressable store, the whole chain took 12 and 15 seconds on this
   machine on a fast home network. It downloaded all 183 resolved packages. Disk: the build
   directory is 491 MB and the cold store 536 MB, so budget roughly 1 GB per concurrent build plus
   one shared store. On linux-x64 the lockfile installs 186 packages, about 145 MB compressed and
   496 MB unpacked, with `@cloudflare/workerd-linux-64` alone at 38 MB compressed and 152 MB
   unpacked. **Recommended cold-build timeout for T9 and T12: 900 seconds for the whole chain.**
   That is far above the local 15 seconds on purpose: container storage may be FUSE-backed,
   registry throughput is unmeasured, and the pnpm self-download from finding 1 comes first. The
   real number is BLOCKED on a paid run; treat 900 s as a ceiling that fails fast enough to be
   useful, not as a measurement.
6. **git, and tar.** git is SETTLED by the recorded paid evidence: the container toolchain
   lists Node 22.23.2, pnpm 11.24.0, Git, and FUSE. The provision step already assumes it, and now
   assumes more of it: `git rev-parse`, `git clone --no-checkout`, `git config --get-all`,
   `git cat-file -e`, and `git fetch`. BLOCKED: nothing on record shows `tar` in the container,
   which the checkout step needs, and the recorded network evidence does not cover outbound HTTPS
   to `github.com`, which the clone and the new fetch need.

## Install location, and the race handed to T3

Stated policy: the build step runs with `cwd` set to the extracted per-commit directory, so
`pnpm install` writes `node_modules` **inside** `${buildRoot}/${commit}`. Nothing is shared between
builds except pnpm's content-addressable store, which is keyed by package content and is the
package manager's concurrency problem, not this plan's.

Handed to T3, not absorbed. `planHarnessBuild` still emits
`rm -rf ${directory} && mkdir -p ${directory}` for a directory keyed only by the commit, so two
same-commit builds delete each other's tree (T3.4). Putting the install inside that directory grows
the blast radius: a partly installed `node_modules` can now be deleted under a running esbuild.
This commit does not narrow or widen the isolate step; it records the exposure in the
`planHarnessBuild` documentation.

Interface T3 needs to close it:

- Give the isolate step a directory that identifies the build, not only the commit, or take a lock
  for the whole build rather than for provisioning alone.
- Whatever directory the isolate step creates must be the same directory the checkout and build
  steps use. Today all three derive it from `planHarnessBuild`, so change that one function and the
  three steps stay consistent.
- Keep the pnpm store outside the per-build directory. Deleting a build directory must never delete
  the store, or every concurrent build pays a cold install again.
- The provision lock is separate and stays: it protects `/harness`, not `${buildRoot}`.

## What I deliberately did not do

- No paid action of any kind: no `wrangler deploy`, no workspace creation or start, no billing API
  call, no use of the owner's account credentials. Criteria 4, 5, and the pin-replacement half of 6
  are recorded as blocked rather than argued around.
- I did not simulate, mock, or infer any paid result to close a criterion.
- I did not commit `dist/` or any build output.
- I did not touch `README.md`, and I created or edited no GitHub issue. I pushed nothing.
- I did not fix the T3.4 isolate race, the separate harness build workspace name, or anything else
  outside this task's scope.
- I did not change the Computer source or image pins.
- I did not add the clean-build probe to `pnpm verify`. Two clean builds take about 30 seconds even
  on a warm network, which would triple the gate.

## Things I noticed and left alone

- The provision lock waits with `sleep 1` in a loop with no upper bound. If a live process holds the
  lock and never exits, the provision step waits forever rather than failing. It steals the lock
  only from a dead owner. That is a bounded-failure question for T3, which owns this step's
  concurrency.
- Every artifact build prints `prepare: fatal: not in a git directory` because the root `prepare`
  script runs `git config core.hooksPath .githooks || true` and the extracted directory has no
  `.git`. It is guarded and harmless, but it is noise in every build log.
- `docs/agents/design/computer-integration.md` still records that a separate Computer workspace name
  is derived for each project and for harness builds. That is E3 and T3's work, not mine.
- `.gitignore` contains `*.log`, so probe output written inside the repository would be untracked by
  default. This task's evidence logs live under `.audit/v0/tasks/` instead.

## Remaining blockers

1. **Paid probe approval.** T1.4, T1.5, the pin-replacement half of T1.6, and goal criterion 7's two
   clean **Computer** builds all need an approved disposable paid environment. Nothing here
   substitutes for them.
2. **Unproved container facts**, listed above as findings 1, 3, 5, and 6: the pnpm 11.18.0
   self-download, sustained `registry.npmjs.org` throughput, real cold install time and disk use,
   `tar` presence, and outbound HTTPS to `github.com`. The first Computer build settles all of them
   at once, and each has a named symptom to look for in that log.
