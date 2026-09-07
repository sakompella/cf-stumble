# Architecture critique for cf-stumble v0

## Verdict

The owner cannot yet complete the v0 coding workflow. Most of its parts exist. The missing depth is in the modules that must keep those parts consistent during a turn, a cold build, or a workspace restart. Another recovery abstraction will not close that gap.

Keep the Supervisor's authority over generation state. Keep Pi as the mutable agent core. Finish the ordinary coding path before expanding either. The highest-leverage change is a server-owned project-turn module that admits work, drives the facet, saves the thread, and records completion behind one interface.

This review examined `d6ff2380487a60f410c568272635d99f30560d14`. The working tree started clean. `pnpm verify` passed with 93 test files and 642 tests. Raw output is in `/tmp/cf-stumble-v0/verify-baseline.log`. This is local evidence, not paid-runtime acceptance. No tracked files were changed for this review.

## The architecture that exists

```text
Browser
  -> src/worker.ts
     -> Access verification and owner-derived Supervisor name
     -> owner page and generation/thread HTTP routes
     -> Supervisor.fetch for other paths

Supervisor
  -> generation tables, epoch and activation history
  -> R2 module-map resolver -> Computer build on cache miss
  -> Worker Loader keyed by labeled harness commit -> main facet
  -> generic fetch relay and its durable attempts
  -> project thread store and separate lease methods
  -> separate streamProjectTurn RPC -> project RpcTarget -> Pi Agent

WorkspaceHost
  -> Computer filesystem and container
  -> build / provision / legacy execute / project RpcTarget interfaces
```

The browser routes do not call the project-turn RPC. The project-turn RPC does not use the thread lease or relay writer. Its workspace capability is correctly passed per turn instead of cached in the Loader environment. The normal `fetch` route still reaches a separate buffered, hand-written loop at `/turn`.

Two real seams earn their keep. The model adapter hides Workers AI and keeps its binding outside the mutable facet. The execution adapter hides Computer behind Pi's filesystem and shell interface. A fake adapter and the loaded workerd adapter exercise these seams. Keep their lifetime and framing tests. Small adapter implementations are not automatically shallow modules.

## Findings ranked by leverage

### 1. A project turn has several owners and no complete interface

**Strong. Release blocker. Tasks T5 and T9.**

`src/supervisor/supervisor.ts` exposes `startProjectTurn`, `streamProjectTurn`, `finishProjectTurn`, and `abandonProjectTurn` separately. Its comment explicitly leaves the caller to join them. `src/supervisor/projects/project-turn.ts` only resolves a project, mounts a generation, obtains a capability, and returns frames. `src/routes/owner-api.ts` has no chat route.

That interface makes callers responsible for ordering, durable state, cancellation, and failure recovery. The individual modules have useful internal depth, but the overall turn has poor locality. A future browser implementation could show success before the thread saves, leave a lease held after cancellation, or attribute a terminal event to a generation selected after the turn began.

There is also an unsafe alternate lease interface. `src/supervisor/threads/store.ts` has lease-id-aware finish and abandon operations, but `src/supervisor/threads/project-threads.ts` calls their unkeyed counterparts. After lease expiry, a new turn can use the same thread revision. An old completion with that revision can then pass the unkeyed finish checks. Fresh-thread deletion can recreate revision zero, too. The existing lease ID solves this; the caller-facing path discards it. This is a source-derived failure trace, not a newly executed race test.

`src/supervisor/relay/index.ts` records a clean body EOF as `body-completed`. `src/supervisor/eligibility.ts` can credit a sub-400 completion. Neither establishes Pi terminal success plus saved thread state. The RPC stream currently bypasses this relay entirely. A cheap `GET /` must not become evidence of a completed coding turn.

Deepen the project-turn module. Keep lease IDs, the active-generation snapshot, parsing of terminal frames, and persistence ordering inside its implementation. The HTTP adapter should select an authenticated project and request work, not coordinate commits. Browser success must follow a successful durable save. Use the existing lease-aware methods exclusively and make late completions harmless.

**Deletion test.** Delete the public split-turn choreography and its unkeyed completion paths once callers migrate. Complexity should concentrate in one turn module, not move into the page. Keep thread decisions and storage as internal seams. Preserve ordinary `fetch` for startup checking without treating it as real-turn evidence.

### 2. Workspace identity and filesystem addressing still encode the rejected layout

**Strong. Release blocker. Task T3.**

`src/workspace-names.ts` hashes identity, audience, and project ID into different Workspace Host names. Harness builds use the global `HARNESS_BUILD_WORKSPACE_NAME`. `src/supervisor/artifacts/build-workspace.ts` and `src/supervisor/projects/project-turn.ts` consume these different naming rules. This is the deferred ADR-0038 change, not a reason to reopen it.

Changing only the name would be wrong. `src/project-provision.ts` clones every project at `/project`; `src/workspace/host.ts` returns a target without selecting a repository directory. `src/workspace/project/resolve.ts` and `src/facet/generation-0/execution-env-paths.ts` each impose a fixed `/project` namespace. Multiple repositories would collide, and Pi's read/edit tools would still reject paths outside the selected project even though shell commands have ordinary machine access.

Make workspace identity tenant-owned and repository location project-owned. One Workspace Host should hold the harness checkout and project directories. The selected project supplies Pi's initial cwd. The filesystem adapter must describe the shared workspace consistently with the shell adapter. Keep validation and byte limits at the RPC seam, but delete claims that a repository directory is a security barrier within this owner's machine.

The current layout also hides concurrency problems. `src/harness-build.ts` deletes and recreates a commit-specific build directory. Two same-commit builds can destroy each other's output. Provisioning uses shell PID locks with an acknowledged initialization race. Pi now uses its default tool scheduling. A single container does not prove commands serialize, and a project lease does not protect another project's commands or a harness build. Separate disposable build directories from editable checkouts and measure which container operations can overlap. Serialize only the mutations that actually share state.

**Deletion test.** Remove project-specific host hashing, the global build host name, and duplicate project-root translation policy. Keep the Computer execution adapter and RPC resource-lifetime implementation. They hide real runtime variation and produce leverage for every Pi tool.

### 3. A commit is the executable identity, but the build path does not yet establish it

**Strong. Release blocker. Task T1, then T3 and T12 rechecks.**

The R2 resolver is implemented. `src/supervisor/artifacts/resolver.ts` rebuilds missing or corrupt objects, validates output, and allows cache-write failure without rejecting a valid build. `src/supervisor/artifacts/index.ts` mounts the active generation through that resolver. Supervisor SQLite no longer needs a module-source replacement project.

The unfinished part is the build adapter. `src/harness-build.ts` archives a commit and immediately runs `pnpm run build:module-map`. It neither installs locked dependencies nor builds the vendored Pi package. `vendor/pi-v0.84.4/package.json` exports generated `dist/index.js`. The local `pnpm verify` prepares Pi before building the map, so a warm checkout masks this gap. Provisioning also checks an existing origin without fetching newly submitted commits.

A clean archive probe reproduced a build failure outside the repository. `pnpm --dir /tmp/cf-stumble-v0/clean-harness-archive run build:module-map` exited 1 because `@cf-stumble/pi/dist/index.js` did not exist. The local pnpm automatically installed dependencies before running the command, but it did not build Pi. See `/tmp/cf-stumble-v0/clean-build-baseline.log`. This proves the missing Pi prerequisite locally; it does not establish what a paid Computer image contains.

`test/supervisor/artifacts/module-map-build.test.ts` calls a fake that returns prepared maps in different module orders. Its two-build test proves canonicalization, not two real reproducible builds of the same commit. Keep that unit test, but stop using it as reproducibility evidence.

Deepen the commit-build module so callers name a commit and receive a validated map or a bounded failure. The implementation must obtain the object, create a disposable checkout, install from the lockfile, build Pi, and build the map without depending on the owner's warm tree. The same commit must produce identical canonical output in two clean paid builds. If it does not, ADR-0034's assumption is actively disproved and must be reconsidered. Do not hide that result behind another artifact identity.

The retained paid probe in `scripts/probe/evidence/result-1788408728.json` proves R2 and Workers AI only. `.audit/paid-runtime-evidence.md` explicitly excludes Computer, the Pi coding turn, candidate build/load, and production Access. This is why the roadmap begins with a paid integration gate rather than more UI.

**Deletion test.** Replace command-step knowledge duplicated across callers with one owned build operation. Retain commit identity, the artifact smart constructor, and the cache/build seam. Do not replace R2 or add an artifact digest.

### 4. Using Pi's Agent is not yet using Pi's full conversation behavior

**Strong. Release blocker. Tasks T4 and T7.**

`src/facet/generation-0/pi-agent-turn.ts` runs the real vendored `Agent` with read, write, edit, and bash tools. Keep it. `src/facet/generation-0/turn.ts` still contains a second hand-written bounded loop used by the HTTP handler. These are two definitions of what a turn means, with different transcript formats and tool capabilities.

Streaming is incomplete at two seams. `src/model-route.ts` returns one buffered assistant result. `src/facet/generation-0/route-stream.ts` wraps it in one terminal Pi event. `src/facet/generation-0/facet-turn.ts` forwards only `message_end`, with whole text messages and tool-result metadata. It publishes neither tool-start events nor tool output content. Returning a `ReadableStream` does not satisfy ADR-0037 by itself.

Instruction and compaction behavior are also missing from the application path. `src/project-provision.ts` writes managed instructions to `/AGENTS.md`, outside the file adapter's `/project` namespace. `runPiAgentTurn` constructs a bare Agent with a fixed prompt and does not load that file or repository instructions. The app accepts Pi compaction-summary message shapes, but no app code invokes compaction. `ROUTE_MODEL` declares zero context and usage metadata, which cannot support an honest context-budget policy.

Keep the fixed model route and expose only the metadata and event behavior Pi needs, never credentials. Adapt real provider deltas and tool lifecycle events. Use vendored Pi instruction/context/compaction behavior through a small supported export if needed. Persist its conversation representation outside generations. Do not write another compactor or invent token usage.

**Deletion test.** Once the real streamed path covers the behavior, delete the buffered loop, its private transcript/tool machinery, and production `/turn` forwarding. Move the shared prompt and bounds out before deleting their current owner. Keep the Pi execution adapter and its loaded-RPC tests.

### 5. GitHub project connection has no owning module

**Strong. Release blocker. Task T6.**

`src/project-catalog.ts` hard-codes exactly two placeholder repositories at `example.invalid`. It models a fixture cardinality as `readonly [Project, Project]`. `src/routes/owner-api.ts` neither lists projects nor connects one. `src/workspace/provisioning.ts` is exported but no application caller uses it. A project ID text box in `src/page/markup.ts` is not repository onboarding.

Access authentication already exists and must stay separate. `src/access/index.ts` verifies the owner and derives a Supervisor name. It does not grant GitHub repository permission, and it currently returns too little verified scope for the separate workspace-naming input. Resolve that mismatch on the trusted server path. Never repair it by accepting identity or audience from a browser body.

Give the connected-project module locality over repository identity, connection status, and idempotent provisioning. Its interface should hide GitHub authorization and local credential installation from routes and mutable facet state. The workspace keeps `gh` credentials outside repositories as ADR-0039 requires. Git and gh continue to call GitHub directly. No per-operation Supervisor proxy, mandatory pull-request workflow, or project security sandbox is needed.

The authorization UX is a human preference question recorded in `questions.md`. Provider behavior, token persistence across a container restart, and whether gh is installed are empirical checks for the implementation task.

**Deletion test.** Delete the two-item fixture catalog from production and the public-only naming assumption. Keep project-ID parsing and server-side ownership resolution. Those checks become more valuable once the list is durable.

### 6. Direct generation commands are an approved deletion, not a new design project

**Strong. High leverage, bounded work. Task T2.**

`src/supervisor/control/index.ts`, `src/supervisor/control/journal.ts`, `src/supervisor/control/request.ts`, `src/routes/generations.ts`, and `src/page/script-generations.ts` retain request IDs, command fingerprints, and exact-response replay. `scripts/deploy/README.md` teaches the old behavior. ADR-0030 expressly says to remove it.

Delete the journal across the vertical slice. Preserve the SQLite transaction, epoch checks, stable commit labels, active-target no-op, and rollback admission checks. After a lost response, the page reads current state. Candidate resubmission must return the existing label. Ensure the route does not accidentally keep replay semantics through a new cache or re-run a diagnostic preparation check without making that choice explicit.

**Deletion test.** Here complexity should vanish. Do not replace the journal with a generic command bus, event store, or deduplication framework. Leave recovery operation keys and turn lease IDs alone; they solve different problems.

### 7. Bounds belong beside the work they constrain

**Worth doing narrowly. Tasks T3, T8, T9, and T11.**

`src/supervisor/artifacts/cache.ts` has no age or size retention rule. `src/supervisor/relay/attempts.ts` can sweep unresolved attempts, but no production path calls the sweep. `src/facet/generation-0/facet-turn.ts` eagerly enqueues events without an explicit output budget. The fixed five-minute thread lease does not cancel an already-running tool or stop a late save through an unkeyed method.

These are concrete growth and interruption risks for one owner, not an argument for sharding or a scheduler. Give the turn module a tested deadline and bounded frame handling. Give the cache one simple age rule. Reconcile abandoned work on an existing request path if necessary. Measure cold build and model times before choosing release timeouts. Avoid adding alarms or automatic recovery merely to make a counter tidy.

**Deletion test.** Keep framing and cancellation logic where the real Computer and workerd adapters require it. Delete duplicate timing or output policies when moving callers behind the owned turn interface. Defer a general retention system and eligibility-query optimization until measured use needs them.

## Higher-level code structure

The directory count is not the primary problem. `src/workspace/project/` and `src/facet/generation-0/execution-env*` contain genuine protocol parsing, byte framing, errors, and stub disposal. Flattening them would move complexity into callers and fail the deletion test. Keep those internal seams.

The strongest subtraction is the second turn implementation. The next candidate is the legacy `WorkspaceHost.execute` path and its named-check configuration in `src/workspace/decisions.ts`. It is useful to old scaffolding, while the real Pi bash tool uses arbitrary commands through `ProjectRpcTarget`. Remove that production interface after checking its non-test callers. Do not combine that cleanup with a wholesale rewrite of build/provision adapters.

`src/page/` is an adequate status prototype. Its JavaScript lives inside TypeScript strings, so TypeScript does not check browser logic. `test/routes/page.test.ts` checks markup, headers, and script syntax, not user interaction. As streaming is added, use checked browser code and real browser tests. This does not require a frontend framework or a browser IDE.

The docs spend agent effort on work already completed. `docs/agents/design/feature-map.md` still calls the model route, page, and cache missing. `docs/agents/design/slices.md` still describes SQLite artifacts and unauthenticated control. ADR-0031's historical fixture-attribution limitation is no longer true of `HarnessArtifacts.mount`. Correct those status statements when the matching task lands. Do not rewrite approved decisions or duplicate them in another architecture document.

## Keep and defer

Keep generation labels, narrow epochs, activation history, ordinary bounded `GET /`, role-specific facet names, commit-keyed loading, R2 as a rebuildable cache, Access verification, plain RPC values, Pi, and the existing Computer pins until a paired replacement passes the workflow.

Keep recovery reports readable. Do not implement an immutable recovery model loop, automatic repair, known-good thresholds, background turns, a capability connector for generation control, or public signup for v0. No current human-approved ADR needs reopening on the evidence observed here. ADR-0034 has a falsifiable build assumption; T1 must test it.

## Review choices

Guard the Context Window drove five subsystem readers and targeted root reads rather than a full source dump. Subtract Before You Add drove journal removal and retirement of the second turn loop rather than new abstractions. Sequence Work into Verifiable Units drove the paid gate and independently checked task waves. The roadmap uses the interface as the test surface and preserves useful adapters instead of treating every small file as a defect.
