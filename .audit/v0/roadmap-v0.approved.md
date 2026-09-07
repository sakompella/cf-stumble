# Roadmap to cf-stumble v0 — approved

Source: `.audit/v0/roadmap-v0.md`, revised against `.audit/v0/review-opus-round1.md` (verdict SHIP
WITH FIXES), the confirmed evidence notes `.audit/v0/evidence/E1..E8`, and binding decisions D24
through D35 in `.audit/v0/decision-log.md`. Every edit is listed in "Changes from roadmap-v0.md" at
the end with the objection id that caused it. This file supersedes `roadmap-v0.md` for dispatch.

## Dispatch contract

Start from `d6ff2380487a60f410c568272635d99f30560d14` plus the completed dependency commits. This is
an implementation plan, not evidence that v0 works. The oracle changed no tracked files. Baseline
`pnpm verify` passed 642 tests; the separate clean-archive module build failed on missing Pi
`dist/index.js` (E1).

Read `AGENTS.md` and follow `docs/agents/domain.md` before each task. Read the ADRs named by the
task. Read the evidence notes named by the task; they are confirmed source reads, so no worker
spends time rediscovering them. Use the repository's TypeScript, Cloudflare, and testing skills for
code changes. Preserve human-written `README.md`. Do not create or edit tracker issues without
explicit developer approval.

Each task is independently dispatchable with this file, its listed source paths, its named evidence
notes, and its dependency commits. Give each writer a separate worktree. A worker returns its
commit, changed paths, acceptance evidence, and any remaining blocker in `.audit/v0/tasks/<id>.md`.
Run `pnpm verify` in that worktree before handing off. An opus-manager may divide its task into
smaller verified commits, but owns the integrated result. S is a small bounded change, M is a
specified vertical slice, and L has several seams or an empirical design choice.

Owner tiers are `sonnet-implementer`, `opus-manager`, and `owner`. An `owner` task needs a human at
a browser or a paid account and cannot be run unsupervised.

Waves describe safe parallel work. Finish and integrate a wave before starting the next.
Dependencies are the minimum semantic prerequisites, not permission to write concurrently into a
shared worktree.

Existing approved choices are fixed. One tenant, one shared Computer workspace, separate project
threads, Pi, one Workers AI route, commit-keyed loading, direct generation commands, owner-only
generation controls, and manual rollback. No new automatic recovery, provider picker, subscription
login, public signup, event store, or repository security sandbox.

### File ownership and merge order

Scopes inside a wave do not overlap except where this table says they do. The manager merges the
named regions once and re-runs the gate; it does not merge the same file three times.

| wave | file | owner | rule |
| --- | --- | --- | --- |
| 0 | `src/supervisor/supervisor.ts` | T5, then T3a, then T2 | Serialize. T5 owns the thread RPC wrappers (lines ~226-265). T3a owns the constructor and workspace wiring (lines ~74-88). T2 owns only the `GenerationRequest` type edge (imports at 5-9, `controlGeneration` at 145). Merge in that order. |
| 0 | `src/facet/generation-0/capabilities.ts` | T4 | T4 owns the file for `ModelCapability`. `WorkspaceCapability` and its `WorkspaceRequest`/`WorkspaceResult` import (line 6) are frozen until T7 deletes them with the buffered path. T3a changes `src/workspace/` addressing without editing this file. |
| 0 | `test/facet/**` | T4 | T4 owns `test/facet/generation-0/` adapter tests. T3a's enumerated test list is in its scope and excludes `test/facet/generation-0/route-stream*`, `test/facet/generation-0/workers-ai-adapter*`, and `test/model-route.test.ts`. |
| 0 | `src/page/markup.ts`, `src/page/element-ids.ts`, `src/page/script-generations.ts` | T2 | T2 DELETES the request-id controls and their tests. No layout, naming, or polish work. T10 rewrites these files in wave 4. |
| 1 | `src/access/index.ts` | T3a | T3a makes the verified-scope change and the owner-only policy. T6a consumes the result and adds no tenant authority of its own. |
| 1 | managed-instructions path constant | T3a | One exported constant, owned by T3a, consumed by T6a and T7. `src/project-provision.ts` writes through it. |
| 2 | `src/workspace/host.ts` | T6a | T6a owns credential and provision wiring. T7 audits `WorkspaceHost.execute` callers and commits the deletion list as a file; T9 applies it. T7 does not edit this file. |
| 2-4 | `src/routes/index.ts` | sequenced | T6a, then T9, then T10 add routes in three waves. This is the hub file; each task adds and does not reorganise. |
| 4 | `test/routes/` | T10, T11 | T10 owns `test/routes/page.test.ts`. T11 owns everything else under `test/routes/`. |

### Paid-run preconditions

Every task marked paid stops before its first paid call until all of these are written down and
recorded in the task report. They answer Q7; the owner supplies them once.

1. **Named environment.** A named non-production Cloudflare account, or a run prefix applied to
   every Worker name, R2 bucket, Durable Object namespace, and Container name for this run, so no
   resource the owner cares about is overwritten. "An approved disposable paid environment" is not
   a name.
2. **Spend cap.** A per-task probe budget or a run-wide ceiling, recorded before the first paid
   call.
3. **Disposable GitHub repositories** under a throwaway owner for every clone or push test. No
   probe pushes to `sakompella/cf-stumble`. `HARNESS_BUILD_CONFIGURATION.harnessGitRemote`
   (`src/harness-build.ts`) names the real repository and the build path clones it: read-only clone
   is permitted, push is not.
4. **R2 deletions are prefix-scoped.** Any lifecycle rule is scoped to `module-maps/`, after
   enumerating the bucket and proving it holds nothing else.
5. **Deploy guard.** `scripts/deploy/check-config.sh` runs and passes before any deploy.
6. **Publication stays blocked** until Q5 names a destination.

Each paid task also carries this clause verbatim in its acceptance criteria: *stop on the first
paid failure and record it; missing paid authorization means BLOCKED, not passed — never fake or
simulate a paid result.*

### Scheduling notes

- T1b's paid gate runs beside wave 0, not in front of it. A missing paid authorization blocks
  T3b, T6b, T7's compaction evidence, T9's disconnect probe, T10's deployed harness, and T12; it
  blocks no local task.
- Start T3a as soon as T1a lands. Do not wait for T1b's Computer probe.
- T9's HTTP adapter skeleton may be written during wave 2 against frozen T5 and T7 interfaces,
  which shortens wave 3.

## Waves

| Wave | Parallel tasks | Outcome |
| --- | --- | --- |
| 0 | T1a, T2, T4, T5 (+ T1b beside them when paid authorization exists) | The labeled commit builds from clean state with a regression proof, generation control loses its journal, the model route gains a streaming interface, and thread completion is lease-fenced. T1b proves the paid capability, build, and load chain. |
| 1 | T3a (+ T3b when T1b passes) | One tenant workspace holds every repository, with an owner-only Access policy. T3b records the shared-container concurrency answer. |
| 2 | T6a, T7, T8 | Connected repositories with a testable credential, a Pi conversation that uses instructions and compaction and can produce a diff, and a bounded R2 cache. |
| 3 | T9 | One authenticated, server-owned, saved streamed turn. |
| 4 | T10, T11 | The user page and independent fault/race acceptance tests with fix authority. |
| 5 | T6b, T12a, T12b | Owner GitHub authorization, deployment of the exact candidate, paid re-probes, demo, recording, release. |

## Wave 0

### T1a. Make the clean-commit build correct and prove it stays correct

- **Why.** E1: `src/harness-build.ts:30` builds a labeled commit with `pnpm run build:module-map`
  alone, but `vendor/pi-v0.84.4/dist/` is untracked and only `pnpm build:pi` creates it. Every clean
  build of a harness commit fails to resolve `@cf-stumble/pi`. Local `pnpm verify` runs `build:pi`
  first, so every local signal stays green while the deployed build path is broken. Goal criteria 7
  and 8 both run through `buildCommand`.
- **Scope.** `src/harness-build.ts`, `src/supervisor/artifacts/{builder,build-workspace,build-plan}.ts`,
  `src/workspace/harness-build.ts`, `tools/build-generation-0.mts`, `package.json`,
  `vendor/pi-v0.84.4/package.json`, `scripts/probe/`, and tests in `test/supervisor/artifacts/` and
  `test/workspace/harness-build.test.ts`. Read `src/workspace/host.ts`, `src/facet/index.ts`, ADRs
  0026 through 0029 and 0034, and evidence E1 and E8. Update evidence in
  `docs/agents/design/computer-integration.md` without rewriting the layout decision. Do not check
  `vendor/**/dist/` into git; that trades a build fault for a staleness fault.
- **Acceptance criteria.**
  1. Reproduce the oracle's clean-archive failure before changing anything, and record the exact
     command and error. Then make the build operation explicitly obtain the named commit, install
     from the lockfile, build Pi, and produce the module map from a clean checkout. It must not
     borrow parent `node_modules`, generated Pi output, or the owner's uncommitted source.
     Propagate failures from archive extraction as well as compilation.
  2. Close the drift that created E1 with four artifacts, all four required:
     (a) one `build:artifact` script in `package.json` that performs install, then `build:pi`, then
     `build:module-map`;
     (b) `HARNESS_BUILD_CONFIGURATION.buildCommand` is exactly that script name and nothing else;
     (c) a test inside `pnpm verify` that asserts the `buildCommand` string names a script that
     exists in `package.json`, so a rename fails the gate;
     (d) a clean-build test that runs `git archive HEAD` into a temporary directory with `HOME` and
     the pnpm store isolated and `node_modules` unreachable, runs `build:artifact`, and asserts a
     module map is produced. If (d) exceeds the roughly eleven-second gate budget, commit it as a
     separate script that T12a's release checklist runs and whose absence fails a documented
     checklist item. A paragraph in an evidence file does not satisfy (d).
  3. A new commit submitted after the harness checkout was provisioned is fetched or found locally.
     A commit absent from the configured repository returns a bounded, actionable failure. An
     interrupted provision must not erase an existing editable harness checkout.
  4. Two independent clean local builds of one commit produce byte-identical canonical maps. This is
     a **pre-check only**. Goal criterion 7 requires two clean **Computer** builds; T1b owns that
     proof and this criterion does not substitute for it. The existing fake-module ordering test is
     not this check.
  5. Name and record the container preconditions the repair introduces, as a handoff list T1b
     answers in the real container. E8 already records, for the pinned Computer source/image pair,
     that Node 22.23.2, pnpm 11.24.0, Git and FUSE are present and that network package installs
     work; T1b confirms those cheaply rather than re-buying them. The genuinely open items are:
     whether the container's pnpm version accepts this `pnpm-lock.yaml`; whether lifecycle and
     native install scripts are permitted and can compile (`koffi` runs
     `node ./cnoke.cjs -P . -D src/koffi --prebuild --release`), or whether `--ignore-scripts` is
     required and still yields a working `tsx` and `esbuild`; cold-store install wall time and disk
     use, because that number sets the cold-build timeout T9 and T12a depend on; and `git`
     availability inside the build container, which the existing `provision` step already assumes.
     The local reproduction ran against a warm pnpm store (`resolved 183, reused 183, downloaded 0`)
     and cannot answer any of them.
  6. Decide where install output lands relative to the `isolate` step. `planHarnessBuild` emits
     `rm -rf ${directory} && mkdir -p ${directory}` for a directory keyed only by the commit, so two
     same-commit builds delete each other's tree. A partially installed `node_modules` must not be
     deleted under a running build. Write the chosen install location and the unresolved same-commit
     race into a committed handoff file for T3a; do not absorb the race into this task.
  7. Check whether Cloudflare has published a supported Computer source/image pair newer than the
     pinned one, and record the finding. Retain the current paired pins. Replacing a pin requires
     T1b's paid checks and is not this task's decision.
  8. This task spends nothing. No deploy, no Computer workspace, no billing API, no account
     credentials. A criterion needing paid access is recorded as blocked, not passed. Never fake or
     simulate a paid result.
- **Verification command.** `pnpm verify`. Also run the repeatable clean-build command from
  criterion 2(d) and record its exact invocation and output.
- **Dependencies.** None.
- **Size.** M.
- **Owner tier.** `opus-manager`. The review proposed `sonnet-implementer` for the original
  acceptance items 1-3; criteria 2, 5, and 6 add a gate design, a platform handoff, and a race
  interface, so D24 and D30 keep the manager tier.

### T1b. Prove the paid capability, build, and load chain

- **Why.** E8: Computer container execution, persistence, workspace isolation, 2.6-2.9 s cold starts
  and network installs are already paid-verified on the pinned pair. The unproved chain is exactly
  module-map build for a labeled commit, R2 cache under that commit, Worker Loader load by commit
  id, and facet cold start with the workspace capability passed to `startTurn`. Later work must use
  observed contracts, not assumptions.
- **Scope.** `scripts/probe/` and the paid probe procedure. Read `src/workspace/host.ts`,
  `src/facet/index.ts`, ADRs 0026 through 0029 and 0034, and evidence E5, E7, and E8. Update the
  evidence sections of `docs/agents/design/computer-integration.md`. Consume T1a's committed
  container-precondition list. Change production source only when a probe disproves an assumption
  the source encodes, and then only in the narrowest way that records the disproof.
- **Acceptance criteria.**
  1. Satisfy every item of the Paid-run preconditions in the dispatch contract before the first paid
     call, and record the named environment and spend cap in the task report. Stop on the first paid
     failure and record it; missing paid authorization means BLOCKED, not passed — never fake or
     simulate a paid result.
  2. In the approved paid environment, a loaded facet receives the model capability and a per-turn
     Computer RPC capability, reads and writes a durable file, runs a container command, and reaches
     an arbitrary ordinary internet destination. No capability is serialized into a cached
     project-specific Loader environment.
  3. Computer builds the map, the commit-named Loader accepts it, and a cold candidate passes
     bounded `GET /`. Restart or evict the host and facet and show the durable file again. Record
     cold and warm timings, image and source pins, input commit, and raw redacted failures.
  4. Two clean **Computer** builds of the same labeled commit produce byte-identical canonical maps.
     This is goal criterion 7's core. T1a's local two-build result is a pre-check and does not
     satisfy this criterion.
  5. Answer T1a's open container preconditions in the real container: lockfile compatibility with
     the container's pnpm, whether native install scripts run and compile or `--ignore-scripts` is
     required, cold-store install wall time and disk use, and `git` availability. Confirm E8's
     recorded toolchain at the pinned pair rather than re-proving container execution, persistence,
     isolation, or cold-start timing.
  6. Run the five-minute model streaming smoke probe that T4's design depends on:
     `env.AI.run("@cf/zai-org/glm-5.3-flash", { stream: true, tools: [...] })`. Record whether text
     deltas arrive incrementally and whether tool-call fragments arrive incrementally. Record the
     paid model-event probe for T4's adapter against the same route. If tool-call deltas do not
     arrive incrementally, record it as a concrete provider limitation and reopen Q6; do not
     substitute synthetic token chunks and do not add a provider picker.
  7. Check for a supported Computer source/image pair. Retain the current paired pins unless the
     replacement passes the same checks in this task. A mismatch or an unreproducible map stops this
     gate; record the disproof rather than adding a fake or a second cache identity.
- **Verification command.** `pnpm verify` for any source change. Run the paid probe commands
  separately and record their exact invocation and redacted output. They are mandatory evidence, not
  part of the local gate.
- **Dependencies.** T1a.
- **Size.** L.
- **Owner tier.** `opus-manager`. Paid.

### T2. Remove generation request journaling end to end

- **Why.** ADR-0030 already approves this subtraction. It reduces every control caller's interface
  before the conversation UI grows.
- **Scope.** `src/supervisor/control/`, `src/routes/generations.ts`, the `GenerationRequest` type
  edge in `src/supervisor/supervisor.ts` (imports at lines 5-9, `controlGeneration` at line 145),
  `src/page/script-generations.ts`, `src/page/markup.ts`, `src/page/element-ids.ts`, generation
  route and control tests, and `scripts/deploy/README.md`. Read ADRs 0030 and 0033. Preserve
  recovery operation keys and turn lease IDs. Page work is **delete only**: remove the request-id
  controls and their tests. No layout, naming, or polish work in `src/page/`; T10 rewrites those
  files in wave 4.
- **Acceptance criteria.**
  1. Production request bodies and RPC types contain principal plus command, without generation
     `requestId`, fingerprinting, or replay fields. `request.ts:13`'s `readonly requestId: string`
     goes, which changes the public `GenerationRequest` type that `supervisor.ts` imports. Delete
     `src/supervisor/control/journal.ts` and journal creation and writes. A fresh-schema test proves
     the table is absent. Handle any retained local journal table by an explicit documented cleanup,
     not a new compatibility journal.
  2. Candidate resubmission returns the existing label. Activation of the active label with the
     current epoch is a no-op. Activation and rollback with stale epochs reject. Rollback still
     requires a ready label that ran before.
  3. Generation rows, active selection, and preparation checks advance the epoch under existing
     rules. Relay observations and recovery records do not. Failed candidates leave active traffic
     unchanged.
  4. Duplicate candidate requests do not replay an old response. **An already-ready candidate
     returns its current status and is not implicitly re-prepared.** If preparation is pending,
     return its current status. If preparation failed, return that status; re-preparation is an
     explicit separate command with tested behavior, never an implicit side effect of resubmission.
     This is decided; do not choose another design. Preserve the direct-command semantics without
     inventing automatic retries.
  5. After uncertain transport failure, the page reads current status before another activation or
     rollback. Remove request-ID controls and all obsolete tests and deployment examples. Tests
     exercise repeated delivery with current state, not exact replay.
- **Verification command.** `pnpm verify`.
- **Dependencies.** None. The `Dependencies: T1` in `roadmap-v0.md` was fictional: nothing in this
  task reads a module map or a Computer capability. Merge the `supervisor.ts` type edge after T5 and
  T3a per the file-ownership table.
- **Size.** M.
- **Owner tier.** `sonnet-implementer`.

### T4. Add a streaming interface across route, facet, and RPC

- **Why.** E5: `src/model-route.ts` is request/response by type. `ModelRoute.run` awaits
  `this.env.AI.run(...)` and resolves one finished `AssistantMessage`; `ROUTE_MODEL` declares
  `contextWindow: 0`, `maxTokens: 0`, and `ZERO_USAGE`. There is no incremental interface to buffer.
  E7 locates the whole non-incremental surface at two hops: the route interface, and
  `route-stream.ts:streamOnce`, which awaits the complete reply and pushes one event into a fresh
  `AssistantMessageEventStream`. The facet boundary already returns
  `ReadableStream<Uint8Array>`, so the transport exists.
- **Scope.** `src/model-route.ts`, `src/facet/generation-0/{capabilities,route-stream,workers-ai-adapter}.ts`,
  `test/model-route.test.ts`, and `test/facet/generation-0/` adapter tests. Read the pinned Pi event
  types and current provider documentation, and evidence E5 and E7. Before writing any adapter, read
  the three helpers the vendored facade already exports —  `streamSimple`,
  `createAssistantMessageEventStream`, and `createGatewayBindingFetch`
  (`vendor/pi-v0.84.4/index.ts:33-40`) — and justify the chosen one in the report rather than
  writing a third adapter beside two that exist. T4 owns `capabilities.ts` in wave 0;
  `WorkspaceCapability` and its `WorkspaceRequest`/`WorkspaceResult` import are frozen. T7 owns
  `facet-turn.ts` and the Agent assembly.
- **Acceptance criteria.**
  1. Preserve one immutable model selection and credential holder. The paid proof that the selected
     route supports the required text and tool stream is T1b criterion 6, not this task. Record in
     the report exactly which streaming behavior the design assumes, and keep the design able to
     survive the opposite answer on incremental tool-call fragments. Do not substitute synthetic
     token chunks and do not add a provider picker. If T1b records a concrete provider limitation,
     record the disproof rather than adding a fake.
  2. The adapter delivers actual incremental text, tool-call assembly, terminal status, and model
     errors through Pi's event types. Test split UTF-8, split tool arguments, a truncated provider
     stream, provider error, and cancellation. Cancellation prevents further model calls and
     releases the reader; document whether it can stop an already-issued inference.
  3. Parse untrusted model request and tool definitions and provider outputs at this seam. No
     arbitrary endpoint, model, provider credential, or generation-control capability can pass
     through it. Keep `FORBIDDEN_FIELDS`. Bound input and event bytes using bytes rather than
     JavaScript string length.
  4. Expose fixed non-secret context and output limits needed by Pi, replacing `contextWindow: 0`
     and `maxTokens: 0`. Carry real usage if provided; otherwise represent unavailability and use a
     documented conservative estimate. Do not claim zero usage is a measurement. Existing text and
     tool history remains readable. T7's compaction reads these numbers, so record the values and
     their source.
  5. Keep transport envelopes plain across Workers RPC. Tests use the real loaded seam as well as a
     deterministic provider adapter.
- **Verification command.** `pnpm verify`.
- **Dependencies.** None. The paid model-event probe moved to T1b's probe list.
- **Size.** L.
- **Owner tier.** `opus-manager`.

### T5. Make thread completion require the lease that admitted it

- **Why.** E2: `store.ts` carries lease-aware `startTurnWithLease`, `finishTurnWithLease`, and
  `abandonTurnWithLease` with zero callers and zero tests, while `project-threads.ts` and
  `supervisor.ts` expose only the lease-discarding variants. A caller never receives a lease id, so
  it cannot return one, and a superseded turn can still finish or abandon the replacement turn's
  thread. Two browsers on one project is a supported v0 configuration, so this is reachable.
- **Scope.** `src/supervisor/threads/`, only the thread RPC wrappers in
  `src/supervisor/supervisor.ts` (lines ~226-265), and `test/supervisor/threads/`. Read ADRs 0035,
  0036, and 0038, and evidence E2 and E6. T3a owns Supervisor construction and workspace wiring.
  Merge this branch into `supervisor.ts` first, before T3a and T2.
- **Acceptance criteria.**
  1. Every finish or abandon operation requires the lease ID that admitted that turn. `startTurn`
     returns the lease id. Migrate the current RPC wrappers and tests and **delete** the unfenced
     `startTurn`, `finishTurn`, and `abandonTurn` variants in the same task, so the unsafe path
     cannot be reintroduced. Keep lease IDs server-owned; do not make the browser the save
     coordinator.
  2. A late finish or abandon from turn A cannot alter turn B after expiry or takeover at the same
     revision. Test both operations, not only successful finish.
  3. Fresh thread invalidates old leases even when revision zero recurs. A delayed start against a
     replaced thread must not be accepted solely because its old numeric revision matches. **Use a
     durable thread identity**, not a monotonic concurrency version; this is decided. Test the reset
     race through storage.
  4. Starting fresh clears Pi messages and compacted context without touching workspace files. It
     cannot let the old lease save into the replacement. The later turn coordinator receives enough
     identity to cancel or fence its old work.
  5. Reads, admission, and writes use the existing synchronous transactions and plain serialized Pi
     messages. Keep one active turn per project. An expired lease permits a new admission without
     needing an alarm.
- **Verification command.** `pnpm verify`.
- **Dependencies.** None. The `Dependencies: T1` in `roadmap-v0.md` was fictional: this is Durable
  Object SQLite and plain values, and no T1a or T1b outcome changes a line of it.
- **Size.** M.
- **Owner tier.** `sonnet-implementer`. Deciding criterion 3 removes the design choice that
  justified raising the tier in D26; a manager tier remains acceptable and is not a weakening.

## Wave 1

### T3a. Make one tenant workspace hold every repository

- **Why.** E3: three surviving encodings of the pre-ADR-0038 layout. The container name hashes
  `project.id` (`src/workspace-names.ts`), `HARNESS_BUILD_WORKSPACE_NAME` is a separate tenant-blind
  global build container, and `PROJECT_ROOT = "/project"` is hard-coded and defined twice
  (`src/workspace/project/resolve.ts:11` and `src/facet/generation-0/execution-env-paths.ts:12`,
  where the second is the path-escape guard). Renaming Workspace Hosts alone would put all clones at
  `/project`. Identity, directories, file access, and shared-container operations must change
  together. Goal criterion 2 also has no owner-only Access policy anywhere in the codebase today.
- **Scope.** `src/workspace-names.ts`, `src/project-provision.ts`,
  `src/workspace/{host,provisioning,project-provision}.ts`, `src/workspace/project/`,
  `src/facet/generation-0/execution-env*`, `src/supervisor/projects/`,
  `src/supervisor/artifacts/build-workspace.ts`, `src/access/index.ts`, workspace construction in
  `src/supervisor/supervisor.ts` (constructor region, lines ~74-88, including the catalog-less
  `new ProjectThreads(ctx.storage)` at line 87), and `tools/verify-project-protocol.mts` if the
  protocol changes. Read ADRs 0038 and 0039, and evidence E3, E6, and T1a's committed isolate-race
  handoff file.

  Tests owned by this task, enumerated so nothing reaches T4's files:
  `test/workspace-names.test.ts`, `test/workspace/**`, `test/supervisor/projects/**`,
  `test/supervisor/artifacts/build-workspace.test.ts`,
  `test/facet/generation-0/execution-env*.test.ts`, `test/access/**`, and any new test under those
  paths. This task does not edit `src/facet/generation-0/capabilities.ts`,
  `test/facet/generation-0/route-stream*`, `test/facet/generation-0/workers-ai-adapter*`, or
  `test/model-route.test.ts`.
- **Acceptance criteria.**
  1. One server-derived tenant key selects the same Workspace Host for harness builds and all that
     tenant's projects. Two verified identities select different hosts. Remove the global build-host
     name and the project ID from host hashing. A browser never supplies the authoritative tenant
     key, identity, or audience.
  2. Restrict the verified scope to the single owner. The Access policy admits exactly one
     configured owner identity and audience pair. Local tests prove that an unauthenticated request,
     a valid-token wrong-identity request, and a request carrying a caller-supplied tenant field are
     each rejected before any workspace selection or capability acquisition. Record the exact Access
     application and policy configuration that T12a must deploy. This is goal criterion 2's local
     half; T6a consumes the verified scope and adds no tenant authority of its own.
  3. Give harness and projects separate stable directories and Git histories inside that host.
     Project selection sets initial cwd only. Give the repository-relative root **one owning
     module**; both `src/workspace/project/resolve.ts` and
     `src/facet/generation-0/execution-env-paths.ts` read it, so the two current `PROJECT_ROOT`
     definitions become one and cannot drift. Pi's filesystem and shell adapters agree on addresses
     and can intentionally inspect a sibling repository or managed instructions. They cannot select
     another tenant's host. Keep malformed-input, byte-size, and symlink-cycle checks; remove the
     rejected project-as-security-barrier assumptions.
  4. Provisioning reuses a matching clone without resetting dirty files or unpushed commits. A
     remote mismatch or a populated non-repository directory fails without deleting it. Interrupted
     staging is recoverable. Restarting one project does not reclone or overwrite another.
  5. Build scratch directories never replace the editable harness checkout. Concurrent builds of the
     same commit cannot delete each other's files: `planHarnessBuild` emits
     `rm -rf ${directory} && mkdir -p ${directory}` for a directory keyed only by the commit. Fix
     that race deterministically here, using T1a's recorded install location. Whether Computer
     permits overlapping container operations at all is T3b's experiment, and this criterion does
     not wait for it.
  6. Keep one active-turn lease per project and Pi's default tool scheduling. `toolExecution`
     appears nowhere in `src` or the vendored Pi facade, so do not hunt for it. If the shared layout
     needs serialization, bound it at the operations that actually share mutable state.
  7. Re-run capability, exec cancellation and disposal, path mapping, and loaded workerd tests
     against the shared layout.
  8. Provide one server-resolved project-location result for T6a and T9. Export one managed-
     instructions path constant, owned by this task and consumed by T6a and T7. The current static
     catalog may remain only until T6a replaces it; the Supervisor's catalog-less `ProjectThreads`
     construction at `supervisor.ts:87` is the line T6a will pass a real catalog through, so leave
     it reachable. Update `computer-integration.md`'s implementation status after the shared path
     passes.
- **Verification command.** `pnpm verify`.
- **Dependencies.** T1a.
- **Size.** L.
- **Owner tier.** `opus-manager`.

### T3b. Record the shared-container concurrency answer

- **Why.** One shared container means project turns and harness builds now share a machine. What
  must serialize is an experiment, not a guess, and the answer sets bounds T9, T11, and T12a depend
  on.
- **Scope.** The concurrency probe procedure under `scripts/probe/`, plus the narrowest policy
  change in `src/workspace/` or `src/supervisor/artifacts/` that the observed answer requires. Read
  ADRs 0038 and 0039 and T3a's shipped layout.
- **Acceptance criteria.**
  1. Satisfy every item of the Paid-run preconditions in the dispatch contract before the first paid
     call. Stop on the first paid failure and record it; missing paid authorization means BLOCKED,
     not passed — never fake or simulate a paid result.
  2. Probe two project commands and a candidate build on the one container. Record whether Computer
     permits overlap, with the exact commands, timings, and any error.
  3. Enforce a bounded conflict or a narrow serialization policy for operations that actually share
     mutable state. Never silently overlap unsupported execution, and never queue without a bound.
  4. **No alarm, no scheduler, no queue framework.** The policy is a bound on operations that share
     mutable state, not a new subsystem.
  5. Repeat T1b's paid capability and file-survival probe against this layout and record the result.
  6. If Computer disproves the shared-container assumption, record the disproof rather than adding a
     fake or a second cache identity, and state the narrow proposed correction.
- **Verification command.** `pnpm verify` for any source change. Record the concurrency probe
  command and raw redacted output separately.
- **Dependencies.** T3a, T1b.
- **Size.** M.
- **Owner tier.** `opus-manager`. Paid.

## Wave 2

### T6a. Connect GitHub repositories with a testable credential

- **Why.** E4: `ProjectCatalog = readonly [Project, Project]` is a fixed-arity tuple **type**, not
  placeholder data. Its 17 references span 5 files (`src/project-catalog.ts`,
  `src/workspace-names.ts`, `src/workspace/project-provision.ts`,
  `src/supervisor/threads/project-threads.ts`, `test/project-catalog.test.ts`), and `resolveProject`
  is the single choke point every consumer already goes through. A two-tuple cannot hold three
  projects and no runtime connect flow can append to it. Access identity is not repository
  authorization.
- **Scope.** `src/project-catalog.ts`, new connected-project storage beside
  `src/supervisor/projects/`, catalog resolution in `src/supervisor/threads/project-threads.ts`
  including the Supervisor's `new ProjectThreads(ctx.storage)` call site, `src/worker.ts`, project
  list and connect routes under `src/routes/`, and credential and provision wiring in
  `src/workspace/host.ts` and `src/workspace/provisioning.ts`. Add focused route, ownership,
  storage, and provisioning tests. Read ADR-0039, evidence E4 and E6, and Q2. T3a owns
  `src/access/index.ts`; consume its verified scope. T7 owns facet and session code; T8 owns R2
  cache policy. `src/workspace/provisioning.ts:111` (`provisionProjectWorkspace`) is exported and
  currently has no caller in `src/`; this task gives it one.
- **Acceptance criteria.**
  1. Change `ProjectCatalog` from a fixed two-tuple type to a variable-length collection and follow
     it through every consumer, using `resolveProject` as the choke point. Store a tenant-owned list
     of connected GitHub repositories. Empty, one, two, and three projects all work. Stable project
     identity is independent of list order and display name. Duplicate connection converges on the
     same project. Delete the `example.invalid` production entries and the exact-two tuple
     restriction. Connecting a third repository must not create a third container, which is why this
     task follows T3a.
  2. Add a separate GitHub repository authorization flow: an owner-initiated gh device authorization
     in the workspace, per Q2. The app shows only a verification URL and code plus safe connection
     status, never an access token. Access sign-in alone grants no repository access. Bind
     authorization completion to the initiating owner and reject replay and cross-origin mutation as
     appropriate to the flow. The one live owner-run authorization is T6b; this task builds and
     tests the flow with a recognizable fake credential.
  3. Provide a documented credential source for automated tests and unsupervised runs — a
     `GH_TOKEN`-from-secret fallback — so T9, T10, and T11 are not blocked on a human. The fallback
     is a test and development path with the same redaction rules; it is not a second production
     authorization mechanism.
  4. Verify repository access before making a project usable. Install credentials in normal local gh
     configuration outside all repositories and establish ordinary git credential use. Keep
     credentials out of tracked files, URLs, browser responses, logs, R2 maps, and facet state. Test
     redaction with a recognizable fake token across every one of those surfaces. The live
     private-repository clone proof is T6b.
  5. Make git and gh available only if the pinned image lacks them; E8 records Git present on the
     pinned pair. After host or container restart, ordinary tools can still authenticate or the app
     reports a reconnect requirement. Never silently return a connected status with unusable
     credentials.
  6. Invoke idempotent provisioning on connection and use and after host recreation. Preserve dirty
     files and separate project threads. Resolve projects through the stored tenant catalog in both
     the thread and workspace paths. The host must not fall back to the old static catalog.
  7. Add list, connect and status, and read and fresh-thread routes needed by the page. T3a's
     verified server scope reaches workspace selection; caller-supplied tenant fields have no
     authority. Unknown or cross-tenant project IDs fail before capability acquisition.
- **Verification command.** `pnpm verify`.
- **Dependencies.** T3a, T5.
- **Size.** L.
- **Owner tier.** `opus-manager`.

### T7. Finish Pi instruction, compaction, diff, and turn-event integration

- **Why.** A bare Agent with four tools does not load managed instructions or compact a long thread.
  The old buffered loop still provides a competing turn definition. The Pi path also has no diff
  tool, and goal criterion 4 and feature-map demo step 3 both require a diff.
- **Scope.** `src/facet/generation-0/{pi-agent-turn,facet-turn,facet-turn-request,request-handler,main-facet,turn,tools,tool-execution,session-transcript}.ts`,
  a small new facet-owned session module if needed, and `tools/vendor-pi.mts` plus its facade source
  when a vendored capability needs exporting. Own the corresponding facet and session tests and
  update only necessary Pi provenance and export checks. Read evidence E7 and Q3. T6a owns
  `src/workspace/host.ts` in this wave; audit the callers of the legacy workspace execution
  interface and commit the deletion list as a file for T9 rather than passing it as prose.
- **Acceptance criteria.**
  1. The selected project's cwd and saved Pi conversation start the turn. Load managed instructions
     through T3a's exported constant and applicable repository instructions through the execution
     adapter, using vendored Pi behavior. A test proves both affect the prompt. The other project's
     conversation never enters this prompt merely because files share a workspace.
  2. Use Pi's compaction behavior before the fixed route's context limit is exceeded. A
     deterministic small-budget test forces compaction, saves the resulting Pi context, and
     continues after facet replacement. Starting fresh removes that context and preserves files. Use
     the metadata from T4; do not write a second summarizer. Confirm what Pi does with the context
     window number before claiming this passes: `ROUTE_MODEL` declared `contextWindow: 0` before T4,
     and a zero window makes the compaction trigger meaningless (E7).
  3. Export any new Pi capability by editing the generator's facade source in `tools/vendor-pi.mts`
     and running `pnpm exec tsx tools/vendor-pi.mts --refresh-generated`. **Never hand-edit
     `vendor/**`.** `vendor/pi-v0.84.4/index.ts` is generated (`tools/vendor-pi.mts:198`),
     `checkVendorTree()` compares every managed file against its exact expected contents and
     SHA-256 sum, and `verify:vendor` is the second step of `pnpm verify`, so a hand edit cannot
     pass the gate. Compaction is not exported today: `index.ts` exports only the
     `CompactionSummaryMessage` type, while the implementation lives under
     `vendor/pi-v0.84.4/packages/agent/src/harness/compaction/`. A declaration-conformance check
     against `upstream-surface.ts` may reject an export that does not exist upstream; if it does,
     record why and choose a supported surface. **Do not attempt
     `pnpm exec tsx tools/vendor-pi.mts --update`**: it needs an upstream Pi checkout, clean, at tag
     `v0.84.4` / commit `b79e4cc834970cca69daebffab7df1da7d1e52c4`, defaulting to
     `/tmp/cf-stumble-pi-v0.84.4`, and `/tmp` is cleared between runs.
  4. The Pi path can produce a repository diff for the demo turn — either by keeping a diff tool on
     the Pi agent or by proving `bash` plus `git diff` returns the diff through a tool-result frame.
     The frame's byte budget is large enough to display a small real diff without truncating it to
     uselessness; the vendored Pi exports `truncateTail`, so state the budget and test a diff near
     it. Goal criterion 4, feature-map demo step 3, T10 criterion 2, and T11 criterion 1 all consume
     this.
  5. Emit typed plain frames for incremental text, tool start with arguments, tool results including
     bounded displayable content, and exactly one terminal outcome. Distinguish rejected admission,
     failed turn with retained conversation, and successful Pi completion. This facet terminal
     outcome is provisional until T9 saves it.
  6. Cancellation releases the RPC capability and stops further model and tool dispatch. Implement
     or explicitly reject any previously unsupported `ExecutionEnv` method required by instructions
     or compaction; tests must exercise it through the real adapter. Do not implement unused tools
     just to fill out the interface.
  7. Delete the hand-written buffered `runGeneration0Turn` path, its custom transcript, the
     duplicate tools, and the old production `/turn` handler at `request-handler.ts:78`. **The
     duplicate tools are read, write, edit, and bash only.** `git_diff` (`tools.ts:77,92,138`,
     `tool-execution.ts:141-151`) is not a duplicate — it is the only diff producer in the
     repository — and may not be deleted unless its replacement from criterion 4 lands in the same
     commit. Move `GENERATION_0_SYSTEM_PROMPT` and `MAX_MODEL_CALLS` out of `turn.ts` before
     deleting it, because `pi-agent-turn.ts:17` imports them. Keep cheap ordinary `GET /` for
     startup. Commit the audited deletion list for `WorkspaceHost.execute` and its old fixed-check
     adapter as a file for T9; preserve build and provision operations.
  8. Keep Pi's default tool scheduling, the fixed model route, and no model generation-control tool.
     The real Pi path is the sole production coding loop.
- **Verification command.** `pnpm verify`.
- **Dependencies.** T3a, T4.
- **Size.** L.
- **Owner tier.** `opus-manager`.

### T8. Bound the rebuildable R2 cache with one age rule

- **Why.** ADR-0034 permits eviction and the v0 feature map requires a simple size or age limit. The
  current cache has neither.
- **Scope.** `src/supervisor/artifacts/cache.ts` only if runtime support is necessary, R2 lifecycle
  configuration and procedure under `docs/agents/`, relevant cache tests, and a focused verification
  tool if required. Read ADR-0034. Prefer a bucket lifecycle rule scoped to `module-maps/` over an
  application cleanup scheduler.
- **Acceptance criteria.**
  1. Satisfy every item of the Paid-run preconditions in the dispatch contract before touching the
     bucket. An age rule on a real bucket is a deletion. Stop on the first paid failure and record
     it; missing paid authorization means BLOCKED, not passed — never fake or simulate a paid
     result.
  2. Enumerate the bucket's actual contents and record what prefixes exist **before** creating any
     rule. Scope the rule to `module-maps/`. If the bucket holds anything else, the rule stays
     prefix-scoped and the finding is recorded.
  3. Record and apply one simple age bound. Use seven days as a reversible initial value unless the
     measured build cost or owner cost preference justifies another value. Read current R2 lifecycle
     support rather than inventing Wrangler syntax.
  4. Missing or corrupt cache objects rebuild under the same commit key. Cache hits avoid building.
     Cache-write failure still permits a validated map to load. Failed rebuild does not change
     generation-control state.
  5. Expiry cannot delete project files, conversations, credentials, or unrelated bucket prefixes.
     Cache changes do not advance the generation epoch. No new artifact digest, retention database,
     background sweeper, or quota framework.
  6. Demonstrate the expiry and miss semantics with a disposable object and retain the configured
     rule. Do not wait seven days for the test; verify the rule and exercise deletion-triggered
     rebuild separately.
- **Verification command.** `pnpm verify`. Record the R2 rule inspection, the pre-rule bucket
  enumeration, and the eviction and rebuild probe.
- **Dependencies.** T1a.
- **Size.** S.
- **Owner tier.** `sonnet-implementer`. Paid.

## Wave 3

### T9. Own the saved streamed turn in the Supervisor

- **Why.** E6: the owner API serves only `/api/status`, three `/api/generations/*` paths,
  `/api/recovery/latest`, and `/fresh`. No route reaches `startProjectTurn`, `finishProjectTurn`,
  `abandonProjectTurn`, or `streamProjectTurn`, so the coding half of v0 is unreachable from a
  browser. `streamProjectTurn`'s own doc comment concedes it: "Joining them is the next unit's
  work". This task builds the turn route surface as well as the Supervisor-side join. The browser
  must not join leases, facet state, and completion evidence itself.
- **Scope.** `src/supervisor/projects/`, `src/supervisor/supervisor.ts`, `src/supervisor/relay/`,
  **`src/supervisor/eligibility.ts`**, thread integration in `src/supervisor/threads/`, the
  authenticated turn route under `src/routes/`, and `src/worker.ts`. Add storage, loaded-facet, and
  route tests. Read ADRs 0031, 0033, 0035, 0037, and 0038, evidence E6, and Q3. Consume T7's frames
  without adding Pi behavior to the Supervisor. Apply T7's committed deletion-list file rather than
  re-deriving it. The HTTP adapter skeleton may be written during wave 2 against frozen T5 and T7
  interfaces.
- **Acceptance criteria.**
  1. One authenticated project-turn entry validates the project and prompt, resolves the current
     thread, acquires its lease, snapshots the active generation and passing preparation check,
     ensures the workspace is usable, and starts that facet with its per-turn capability. Request
     JSON cannot supply a tenant, trusted history, model credential, or lease ownership.
  2. Stream validated, bounded frames while consuming the facet result on the server. Save Pi
     terminal messages with T5's lease and durable thread identity. Only after the save commits may
     the browser receive authoritative success and the relay attempt earn one completed-real-turn
     credit. A failed save never produces success, even when the facet emitted `completed`.
  3. Change `src/supervisor/eligibility.ts`. Line 140 currently reads
     `attempt.outcome === "body-completed" && attempt.responseStatus < 400`, so any completed body
     under 400 earns turn credit with no requirement that the thread was saved. Goal criterion 6
     forbids that. Credit requires Pi terminal success **and** a committed thread save. A test
     proves a `body-completed` attempt with status 200 and no committed save earns no credit.
  4. A failed turn's valid partial Pi state may be saved according to a documented policy without
     earning credit. Malformed, oversized, duplicate-terminal, or truncated streams cannot save
     arbitrary state or count success. An empty EOF and a successful `GET /` earn no real-turn
     credit.
  5. Adopt cancel-on-disconnect for v0 per Q3's default. On observed cancellation, stop upstream
     work and release only the owned lease. Keep valid partial Pi messages when the server can save
     them under the original lease, and mark the outcome cancelled. Define the save-versus-cancel
     race at the durable commit. Preserve a save already committed, but never fabricate completion
     for a disconnected unfinished turn.
  6. A bounded turn deadline handles absent disconnect signals, lost facets, and interrupted hosts.
     Use T1b's recorded cold-build and cold-start timings to choose the bound and state the number.
     Later admissions can recover an expired lease. Old finish and abandon callbacks cannot affect a
     new turn. Reconcile pending evidence on an existing request path if required. No alarm, no
     scheduler, no queue framework, no automatic retry, no background-turn feature.
  7. Mid-turn activation does not relabel that turn's evidence. New turns use the new active
     generation; the admitted turn follows a stated drain or cancel rule. Manual rollback remains
     independent of model work. A failed candidate never changes the serving facet.
  8. The HTTP adapter returns explicit conflict, unavailable, and validation responses without
     leaking exception details or credentials. Enforce same-origin mutation protections where cookie
     authentication requires them. Remove the old public split-turn choreography once tests and
     callers use this interface. Apply T7's committed deletion list for the unused
     `WorkspaceHost.execute` and fixed-check adapter, preserving build and provision operations.
  9. Update obsolete fixture-attribution and stream-completion limitation notes in ADR-0031 and
     current implementation-status docs. Preserve the decision itself and leave known-good
     thresholds and automated recovery out.
  10. Measure actual browser-disconnect propagation and the deadline behavior in the paid runtime.
      Satisfy the Paid-run preconditions before that probe. Stop on the first paid failure and
      record it; missing paid authorization means BLOCKED, not passed — never fake or simulate a
      paid result. The local cancellation tests are not this measurement.
- **Verification command.** `pnpm verify`. Record the paid disconnect and deadline probe separately,
  in addition to local cancellation tests.
- **Dependencies.** T2, T5, T6a, T7.
- **Size.** L.
- **Owner tier.** `opus-manager`. Paid for criterion 10 only.

## Wave 4

### T10. Put the connected project conversation on one page

- **Why.** The current status prototype contains neither a conversation nor a project sidebar. The
  useful workflow should be primary, with rollback still reachable. `test/routes/page.test.ts`
  checks markup, headers, and script syntax only, so no browser harness exists at all.
- **Scope.** `src/page/`, `src/routes/page.ts`, browser build tooling, `test/routes/page.test.ts`,
  and a new committed browser harness with its tests. Consume existing route contracts; do not
  modify backend orchestration in this task. Read ADRs 0037 and 0038 and Q4. The `control-ui` skill
  covers building a local browser/CDP harness. T11 owns everything else under `test/routes/`.
- **Acceptance criteria.**
  1. A collapsible left sidebar lists connected projects and their connection status. It supports
     T6a's connection flow without asking for a token in page fields. Selecting a project loads that
     project's current conversation and sets subsequent turns to it.
  2. Render text deltas, tool calls, bounded tool output, diff output from T7 criterion 4, and
     authoritative terminal status as they arrive. Render content as text or sanitized Markdown. Do
     not execute repository or model HTML. Large command output cannot make the page unresponsive.
  3. Expose fresh thread, busy and conflict, disconnected, failed-save, and no-active-generation
     states. Starting fresh requires an explicit user action and preserves files. A second browser
     sees the same saved thread after reload. Switching projects cannot append a late frame to the
     newly selected conversation.
  4. Show active label and observed epoch. Keep submit, checked activation, rollback, and the latest
     available recovery report on the same page. Use a compact generation drawer by default per Q4.
     Do not imply background repair or known-good status chosen by an unsettled threshold.
  5. Delete the free-text project-ID input and raw-JSON panels as the primary workflow. Maintain CSP
     nonces, same-origin requests, and no-store responses. Keep browser logic in checked TypeScript
     rather than expanding opaque script strings. Choose the smallest build change; no frontend
     framework is required.
  6. Commit a runnable browser harness. This is its own deliverable: a checked-in command that
     drives a real browser against a running application, with its invocation documented. The
     repository has no such harness today, so budget for building it. Existing script-syntax checks
     do not satisfy this criterion.
  7. Name the environment the harness runs against and record it. A deployed environment is required
     for any assertion about Access; local `wrangler dev` cannot prove Access. Satisfy the Paid-run
     preconditions before using a deployed environment. Stop on the first paid failure and record
     it; missing paid authorization means BLOCKED, not passed — never fake or simulate a paid
     result. Harness runs that do not touch Access may run locally, and the report says which
     assertions ran where.
  8. A real browser test selects a project, starts a streamed turn, sees a tool call before terminal
     completion, observes output, starts fresh, and uses generation controls. Test narrow and wide
     viewports and keyboard access.
- **Verification command.** `pnpm verify`. Record and run the browser harness command against a
  running application and retain its output.
- **Dependencies.** T2, T6a, T9.
- **Size.** L.
- **Owner tier.** `opus-manager`. Paid for criterion 7's deployed assertions only.

### T11. Test the complete workflow under failures and races, and fix what it finds

- **Why.** The existing suite has strong local protocol tests but no integrated proof that saved
  coding work survives replacement. This task is independent of the page author. By wave 4 every
  owning task is finished and its worker is gone, so a real finding needs an owner here rather than
  a report with nowhere to go.
- **Scope.** New integration tests under `test/supervisor/projects/`, `test/routes/` except
  `page.test.ts`, and disposable fixtures and tools. Read production code freely. **Fix authority:**
  this task may land a narrow production fix when a test it wrote fails, on three conditions — the
  fix is the smallest change that makes the named test pass, it ships with that test as a named
  regression test, and the report lists the fix, the file, and which owning task's acceptance
  criteria are re-run against the fixed tree. A fix that requires a design decision or crosses more
  than one seam is reported, not landed. Re-run the affected task's verification command after any
  fix and record the result.
- **Acceptance criteria.**
  1. Through the same turn interface the HTTP adapter calls, prove read, edit, check, and diff and a
     saved continuation after replacing the main facet. Use deterministic model output for local
     replay and real workerd RPC, not a fake turn coordinator.
  2. Cover two projects in one workspace with separate conversations, two clients contending for one
     project, expired-lease takeover, late finish and abandon, fresh-thread ABA against the durable
     thread identity, malformed and truncated frames, save failure, and cancellation before and
     after durable save. Assert both thread state and relay credit, not just response codes.
  3. Assert the eligibility rule from T9 criterion 3 directly: a `body-completed` attempt with
     status under 400 and no committed save earns no completed-real-turn credit.
  4. Exercise active-generation change during a running turn, passing candidate activation,
     deliberately broken candidate isolation, and rollback to a previously active ready label. Assert
     the edit and current thread survive all three generation cases.
  5. Exercise cold cache hit, corrupt-object rebuild, missing-object rebuild, and failed build while
     the active generation serves. Include same-commit concurrent build behavior from T3a. Do not
     claim fake map canonicalization proves real reproducibility; the reproducibility proof is
     T1b criterion 4.
  6. Confirm no credential-bearing bindings reach the facet, browser output, logs, or saved thread
     fixtures, using T6a's recognizable fake token. Confirm direct generation controls remain
     owner-only, that T3a's owner-only Access rejections hold, and that the model has no control
     connector.
  7. Keep existing loaded-stub disposal, framing, cancellation, and property tests. Delete
     superseded scaffold tests only with an explicit replacement mapping. No new test may pass
     solely by checking that source text contains a desired identifier.
- **Verification command.** `pnpm verify` in a fresh worktree at the exact candidate commit. Record
  the candidate SHA, the focused test commands, and the verification command of every task whose
  code this task fixed.
- **Dependencies.** T3a, T8, T9.
- **Size.** L. Six integration areas spanning threads, leases, generations, cache, credentials, and
  property tests, plus fix authority, is not M.
- **Owner tier.** `opus-manager`.

## Wave 5

### T6b. Complete the owner GitHub authorization and prove a private clone

- **Why.** Q2's flow needs a human at `github.com/login/device`. It is one owner step, and putting it
  on the unsupervised critical path blocks the whole night. T6a builds and tests the flow with a fake
  credential; this task runs it once for real.
- **Scope.** No source changes are expected. Run T6a's shipped flow in the paid environment against
  disposable repositories and record the outcome. A source change is permitted only when the live
  run disproves something T6a's fake-credential tests asserted, and then only in the narrowest way,
  with a regression test.
- **Acceptance criteria.**
  1. Satisfy every item of the Paid-run preconditions in the dispatch contract, including disposable
     GitHub repositories under a throwaway owner, before the first paid call. Stop on the first paid
     failure and record it; missing paid authorization means BLOCKED, not passed — never fake or
     simulate a paid result.
  2. The owner completes gh device authorization in the shared workspace. The application showed
     only the verification URL and code and the connection status, and no access token appeared in
     any browser response, log, tracked file, R2 map, or facet state.
  3. Prove a private-repository clone and one permitted git or gh operation on a disposable
     repository. At least two GitHub repositories are connected, and one Computer workspace contains
     both plus the separate harness repository (goal criterion 3).
  4. Credentials live in normal local gh configuration outside all repositories, and ordinary git
     credential use works from inside a repository directory.
  5. After a host or container restart, ordinary tools still authenticate, or the app reports the
     documented reconnect requirement. Record which of the two happened; both are acceptable
     outcomes and a silent connected status with unusable credentials is not.
- **Verification command.** `pnpm verify` for any source change. Record the live authorization and
  clone transcript with credentials redacted.
- **Dependencies.** T6a, T1b.
- **Size.** S.
- **Owner tier.** `owner`. Paid.

### T12a. Deploy the exact candidate and re-run the paid checks on it

- **Why.** Local workerd and a configured bucket cannot prove the release. Evidence gathered before
  the last source change is not evidence about the release.
- **Scope.** Deployment and probe tooling under `scripts/`, agent-authored deployment notes under
  `docs/agents/`, and runtime configuration only as required. Keep human `README.md` unchanged.
- **Acceptance criteria.**
  1. Satisfy every item of the Paid-run preconditions in the dispatch contract before the first paid
     call. `scripts/deploy/check-config.sh` runs and passes before any deploy; this is a hard
     precondition, not a criterion checked afterwards. Stop on the first paid failure and record it;
     missing paid authorization means BLOCKED, not passed — never fake or simulate a paid result.
  2. Provide one repeatable procedure covering the Worker, Supervisor and Workspace Host migrations,
     Container, R2 and its age rule, model binding, the Access GitHub identity policy restricted to
     the owner exactly as T3a recorded it, and separate repository authorization. Resolve secrets
     through the documented secure channel and print none. Use the current request bodies without
     request IDs.
  3. Deploy an exact committed candidate. Run the final `pnpm verify` after the last source change
     and record SHA, pins, commands, resource names, and redacted raw results. A later code change
     invalidates the relevant evidence and must be rechecked.
  4. Repeat the measured disconnect, deadline, same-workspace concurrency, and cold-cache rebuild
     checks on this exact release. Record elapsed times and failure codes. A summary written from
     memory is not evidence.
  5. Restart or evict the Supervisor, facet, Workspace Host, and container as supported, then prove
     active selection, the connected-project catalog, current threads, workspace files, and usable
     GitHub authentication persist or require the documented reconnect action. Confirm unauthorized
     and cross-tenant requests fail against the deployed Access policy.
  6. Run T1a's clean-build script from criterion 2(d) as a release checklist item and record its
     result. Its absence fails the checklist.
- **Verification command.** `pnpm verify`. Run the documented deployment and paid acceptance
  commands separately and retain their output.
- **Dependencies.** T2, T8, T10, T11.
- **Size.** L.
- **Owner tier.** `opus-manager`. Paid.

### T12b. Record the v0 demo, write the release notes, and stop

- **Why.** The paid demo is the product's done predicate. Goal criterion 10 needs a recording of the
  seven-step workflow, and criterion 1 needs release notes that identify the release.
- **Scope.** Agent-authored release notes under `docs/agents/`, disposable demo repositories, and
  browser evidence. Update `docs/agents/design/feature-map.md`,
  `docs/agents/design/computer-integration.md`, and stale implementation notes in
  `docs/agents/design/slices.md`. Keep human `README.md` unchanged.
- **Acceptance criteria.**
  1. Satisfy every item of the Paid-run preconditions in the dispatch contract. Stop on the first
     paid failure and record it; missing paid authorization means BLOCKED, not passed — never fake
     or simulate a paid result.
  2. Complete the seven-step demo in `docs/agents/design/feature-map.md` in a fresh browser. Make a
     small real repository edit, run its configured check, show the diff and command output, build
     and activate a second visibly different harness commit, continue the same conversation, reject
     a broken candidate while the active one serves, and roll back without losing files or thread
     state.
  3. Repeat from a second authenticated browser and show both reach the same Supervisor, connected
     projects, shared workspace, generation state, and saved threads.
  4. Produce the two-minute recording. Record only a disposable demo repository with no personal
     code, credentials, or identity details, per Q5.
  5. Write release notes identifying the SHA, the Computer source and image pair, the model route,
     and reproducible deployment commands, with links to every evidence artifact: the final
     `pnpm verify` output, the clean-build result, the paid probe outputs, and the recording.
  6. Reconcile stale completion claims without re-documenting settled ADRs. Distinguish implemented,
     local, and paid status, especially the old fixture, model, page, and SQLite artifact claims.
     Keep historical slices marked historical. Show recovery reports only if they exist; manual
     rollback is sufficient recovery.
  7. Publish the recording only to the owner's approved destination from Q5. If destination approval
     is pending, retain the file and mark publication blocked, explicitly. Do not call v0 released
     until every done criterion in `goal.md` passes.
- **Verification command.** `pnpm verify`. Run the browser demo commands separately and retain the
  recording, probe output, and notes.
- **Dependencies.** T6b, T12a.
- **Size.** M.
- **Owner tier.** `opus-manager` with owner actions for the browser demo and publication. Paid.

## Critical path and scope control

The main path is T1a -> T3a -> T6a/T7 -> T9 -> T10/T11 -> T12a -> T12b. T2, T4, and T5 run beside
T1a and depend on nothing. T1b runs beside wave 0 as soon as paid authorization exists and gates
only T3b, T6b, T7's compaction evidence, T9's disconnect probe, T10's deployed assertions, and T12.
T8 is a small cache rule, not a retention project.

T1b, T3b, T9, and T12a contain empirical gates. If a paid contract fails, record expected versus
observed behavior and the narrow proposed correction. Re-run that gate before dependent work
continues. Do not ask the owner to guess platform behavior. Q2 through Q6 are product preferences
with stated defaults; use the defaults for reversible work. Q7 is the paid authorization and its
preconditions, and no paid task starts without it.

The single largest unpriced product risk is whether `@cf/zai-org/glm-5.3-flash` through the Workers
AI binding can stream text and tool calls at all, and whether `low` reasoning effort with
`thinkingLevel: "off"` is good enough for the criterion-4 coding turn. T1b criterion 6 retires the
first half in five minutes of paid time and should run before T7 commits to a compaction design.

## Changes from roadmap-v0.md

Every edit below names the objection, defect-table row, collision row, coverage-map row, evidence
note, or decision that caused it.

### Task splits

| change | cause |
| --- | --- |
| T1 split into **T1a** (local build correctness, deps none, M) and **T1b** (paid capability/build/load gate, deps T1a, L). | B1, defect table T1 "scope conflation", D24 |
| T1a carries the B2 Gap 1 regression proof as criterion 2: `build:artifact` script, `buildCommand` equals that script name, a gate test that `buildCommand` names an existing script, and a real clean-build test with `HOME`/store isolated and `node_modules` unreachable. | B2 Gap 1, defect table T1 "unfalsifiable acceptance", D30, E1 |
| T3 split into **T3a** (deterministic layout, ex-T3.1-T3.3, T3.5, T3.6, L) and **T3b** (paid concurrency experiment, ex-T3.4, M). | B8, defect table T3 "size", brief |
| T6 split into **T6a** (storage, variable-arity catalog, ownership resolution, routes, provisioning wiring, testable with a fake credential, wave 2) and **T6b** (one owner-run device authorization plus private-repo clone proof, wave 5, tier `owner`). | B5, defect table T6 "requires a human mid-run" |
| T12 split into **T12a** (procedure, deploy, paid re-probes) and **T12b** (demo, recording, release notes). | defect table T12 "seven criteria = a release programme in one id" |

### Dependency graph

| change | cause |
| --- | --- |
| T2 `Dependencies: T1` -> `none`, with the reason stated in the task. | B1, defect table T2 "false dependency on T1", D28 |
| T4 `Dependencies: T1` -> `none`; T4.1's paid clause moved into T1b criterion 6. | B1, defect table T4 "paid clause blocks an otherwise-free task", D32 |
| T5 `Dependencies: T1` -> `none`, with the reason stated in the task. | B1, review section 9, D28 |
| T8 `Dependencies: T1` -> `T1a`. | B1 |
| T3a `Dependencies: T1` -> `T1a`; T3b -> `T3a, T1b`. | B1 |
| T6a -> `T3a, T5`; T6b -> `T6a, T1b`; T7 -> `T3a, T4`; T9 -> `T2, T5, T6a, T7`; T10 -> `T2, T6a, T9`; T11 -> `T3a, T8, T9`; T12a -> `T2, T8, T10, T11`; T12b -> `T6b, T12a`. | B1, B5 |
| Waves rebuilt: wave 0 is T1a, T2, T4, T5 with T1b beside them; wave 1 is T3a and T3b; wave 5 gains T6b. | B1, B5, review section 4 reordering note |
| Added a scheduling note allowing T9's HTTP adapter skeleton to be written in wave 2 against frozen T5/T7 interfaces. | defect table T9 "wall-clock bottleneck" |

### Coverage gaps against `goal.md`

| change | cause |
| --- | --- |
| T3a criterion 2 added: owner-only Access policy plus local rejection tests for unauthenticated, wrong-identity, and caller-supplied-tenant requests, and a recorded policy configuration for T12a. `src/access/index.ts` assigned to T3a only; T6a consumes it. | coverage map criterion 2, defect table T3 "duplicated ownership of the Access verified-scope widening" |
| T7 criterion 4 added: the Pi path can produce a repository diff, with a stated frame byte budget tested near a small real diff. T7.7 reworded so the duplicate tools are read/write/edit/bash only and `git_diff` may not be deleted without its replacement in the same commit. | B3, coverage map criterion 4, D31 |
| T1a criterion 4 marked a pre-check; the two-clean-build proof moved to T1b criterion 4 and says **Computer**. | B2 Gap 2, coverage map criterion 7 |
| `src/supervisor/eligibility.ts` added to T9's scope with criterion 3 naming line 140's `body-completed` + status < 400 rule and requiring a committed save for credit. T11 criterion 3 asserts it independently. | coverage map criterion 6 note, wave-1 integration notes |

### Decisions taken out of workers' hands

| change | cause |
| --- | --- |
| T2 criterion 4 now states: an already-ready candidate returns current status and is not implicitly re-prepared; re-preparation is an explicit separate command. | defect table T2 "acceptance 4 is an open design decision handed to sonnet", D34 |
| T5 criterion 3 now states: use a durable thread identity, not a monotonic concurrency version. | defect table T5 "two designs", D34 |

### Cut-line guards

| change | cause |
| --- | --- |
| T3b criterion 4 added: no alarm, no scheduler, no queue framework. | coverage map cut-line check, wave-1 integration notes |
| T9 criterion 6 keeps the same guard and adds it to the deadline bound. | coverage map cut-line check |

### Collisions and file ownership

| change | cause |
| --- | --- |
| Added a "File ownership and merge order" table to the dispatch contract. | collision table, section 4 |
| `src/supervisor/supervisor.ts` serialized T5 -> T3a -> T2's `GenerationRequest` type edge; T2's scope now names that type edge explicitly. | B6, collision row wave 1, defect table T2 "hidden file dependency" |
| `src/facet/generation-0/capabilities.ts` assigned to T4; `WorkspaceCapability` frozen until T7 deletes it. | B6, collision row wave 1 |
| T3a's "related tests" replaced with an enumerated test list that excludes T4's files. | B6, defect table T3 "related tests unbounded" |
| T2's page work restricted to deletion, stated in both the scope and the ownership table. | collision row wave 1->4, defect table T2 "edits page files that T10 rewrites" |
| Managed-instructions path becomes one exported constant owned by T3a, consumed by T6a and T7. | collision row wave 2 |
| T7 must commit its `WorkspaceHost.execute` deletion list as a file; T9 applies the file. | collision row wave 2, defect table T9 "inherits a cross-task deletion list" |
| `src/routes/index.ts` named as the sequenced hub file. | collision row wave 3->4 |

### Paid and account-touching tasks

| change | cause |
| --- | --- |
| Added a named "Paid-run preconditions" block to the dispatch contract: named non-production account or run prefix, spend cap, disposable GitHub repositories with no push to `sakompella/cf-stumble`, R2 deletions prefix-scoped to `module-maps/`, deploy guard, publication blocked on Q5. | B8, D35 |
| T1b, T3b, T6b, T8, T9, T10, T12a, and T12b each carry the preconditions reference plus "stop on the first paid failure and record it" and "missing paid authorization means BLOCKED, not passed — never fake or simulate a paid result". | B8, D27, D35 |
| T8 criterion 2 added: enumerate the bucket's contents and record its prefixes before creating any lifecycle rule. | B8 item 4, defect table T8 |
| T1a criterion 8 added: this task spends nothing, and a criterion needing paid access is recorded as blocked. | D24, D27 |
| "Record the disproof rather than adding a fake or a second cache identity" kept verbatim in T1b and copied to T3b and T4. | review section 6 |

### Sizing, tiers, and scope corrections

| change | cause |
| --- | --- |
| T11 gains fix authority under three conditions (smallest change, named regression test, listed re-run of the owning task's criteria), resizes M -> L, and moves to `opus-manager`. | B7, defect table T11 |
| T4 retitled "Add a streaming interface across route, facet, and RPC" and its Why rewritten from E5/E7: there is no incremental interface to buffer, and the non-incremental surface is two hops. Scope now requires reading `streamSimple`, `createAssistantMessageEventStream`, and `createGatewayBindingFetch` before writing an adapter. | defect table T4 "understated starting point" and "ignores existing vendored assets", E5, E7, D33 |
| T3a criterion 3 requires one owning module for the repository-relative root, replacing the two `PROJECT_ROOT` definitions. | defect table T3 `PROJECT_ROOT`, E3 |
| T3a criterion 6 no longer tells the worker to avoid restoring `toolExecution: "sequential"`; it states that `toolExecution` appears nowhere in `src` or the vendored facade, so no one hunts for it. | review section 7 item 3 |
| T6a criterion 1 states that `ProjectCatalog` is a fixed-arity tuple **type** with 17 references across 5 files and names `resolveProject` as the choke point, and states the ordering hazard that connecting a third repository before T3a lands creates a third container. | defect table T6 "catalog arity is a type change" and "ordering hazard with T3", E4 |
| T6a criterion 3 added: a documented `GH_TOKEN`-from-secret fallback for automated tests, so T9, T10, and T11 are not blocked on a human. | B5 |
| T7 criterion 3 added: export through `tools/vendor-pi.mts` and `--refresh-generated`, never hand-edit `vendor/**`, expect the declaration-conformance check, and do not attempt `--update`. `tools/vendor-pi.mts` added to scope. Named that only `CompactionSummaryMessage` is exported today. | B4, defect table T7 "edits a generated vendored file" and "compaction export does not exist yet" |
| T7 criterion 7 states that `GENERATION_0_SYSTEM_PROMPT` and `MAX_MODEL_CALLS` move out of `turn.ts` before it is deleted, because `pi-agent-turn.ts:17` imports them. | defect table T7 "deletion order" |
| T7 criterion 2 states that `contextWindow: 0` may make Pi's compaction trigger meaningless and must be confirmed. | E7 caveat |
| T9's Why rewritten from E6: no route reaches any of the four turn methods, so T9 builds the turn route surface, not only the Supervisor-side join. | E6 |
| T10 criterion 6 added: commit a runnable browser harness as its own deliverable, since the repository has none. T10 criterion 7 added: name the environment, and state that local `wrangler dev` cannot prove Access. | defect table T10 |
| T1a criterion 5 names the container preconditions but folds in E8: the pinned pair already records Node 22.23.2, pnpm 11.24.0, Git, FUSE, and working network installs, so T1b confirms rather than re-buys them, and the genuinely open items are lockfile/pnpm compatibility, native install scripts, cold-store install time and disk, and `git` in the build container. | B2 Gap 3, E8, D23 |
| T1a criterion 6 and T3a criterion 5 split the `rm -rf ${directory}` same-commit race: T1a writes the install location and the race into a committed handoff file, T3a fixes it deterministically, T3b answers only the paid overlap question. | B2 Gap 4, defect table T1 "isolate race left implicit" |
| T1b criterion 5 states that E8's already-proved container behavior is not re-bought. | E8, D23 |
| Owner tier `owner` introduced for T6b and named in the dispatch contract. | B5 |

### Unchanged on purpose

T2 stays a pure deletion under human-approved ADR-0030. T3a still implements human-approved ADR-0038
and ADR-0039. T5 still precedes T9. Platform behavior, timing, and container concurrency stay
experiments rather than owner questions. T10 and T11's `test/routes/` partition is kept. The refusal
of automatic repair, known-good promotion, provider pickers, and background turns is kept. T12b's
publication stays blocked on Q5. No acceptance criterion was weakened and no scope was added beyond
the cut line in `goal.md`.
