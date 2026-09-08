# Roadmap to cf-stumble v0

## Dispatch contract

Start from `d6ff2380487a60f410c568272635d99f30560d14` plus the completed dependency commits. This is an implementation plan, not evidence that v0 works. The oracle changed no tracked files. Baseline `pnpm verify` passed 642 tests; the separate clean-archive module build failed on missing Pi `dist/index.js`.

Read `AGENTS.md` and follow `docs/agents/domain.md` before each task. Read the ADRs named by the task. Use the repository's TypeScript, Cloudflare, and testing skills for code changes. Preserve human-written `README.md`. Do not create or edit tracker issues without explicit developer approval.

Each task is independently dispatchable with this file, its listed source paths, and its dependency commits. Give each writer a separate worktree. A worker returns its commit, changed paths, acceptance evidence, and any remaining blocker. Run `pnpm verify` in that worktree before handing off. An opus-manager may divide its task into smaller verified commits, but owns the integrated result. S is a small bounded change, M is a specified vertical slice, and L has several seams or an empirical design choice.

Waves describe safe parallel work. Finish and integrate a wave before starting the next. Dependencies are the minimum semantic prerequisites, not permission to write concurrently into a shared worktree. Within a wave, the listed scopes do not overlap except the explicitly partitioned T3/T5 Supervisor edits. The manager merges those method-level changes and runs the gate again. T3 owns construction and workspace wiring; T5 owns only thread RPC wrappers.

Existing approved choices are fixed. One tenant, one shared Computer workspace, separate project threads, Pi, one Workers AI route, commit-keyed loading, direct generation commands, owner-only generation controls, and manual rollback. No new automatic recovery, provider picker, subscription login, public signup, event store, or repository security sandbox.

## Waves

| Wave | Parallel tasks | Outcome |
| --- | --- | --- |
| 0 | T1 | A clean labeled commit builds and loads through the real paid capability path. Stop on a failed platform assumption. |
| 1 | T2, T3, T4, T5 | Direct controls, shared machine semantics, model events, and safe thread leases. |
| 2 | T6, T7, T8 | Connected repositories, a Pi conversation that uses instructions and compaction, and bounded R2 retention. |
| 3 | T9 | One authenticated, server-owned, saved streamed turn. |
| 4 | T10, T11 | The user page and independent fault/race acceptance tests. |
| 5 | T12 | Paid demo, deployment evidence, and release. |

## Wave 0

### T1. Prove the clean commit build and paid execution seams

- **Why.** Warm local builds hide missing Pi build prerequisites. Existing paid evidence proves R2 and Workers AI, not Computer-to-facet execution. Later work must use observed contracts.
- **Scope.** `src/harness-build.ts`, `src/supervisor/artifacts/{builder,build-workspace,build-plan}.ts`, `src/workspace/harness-build.ts`, `tools/build-generation-0.mts`, `package.json`, `vendor/pi-v0.84.4/package.json`, `scripts/probe/`, focused tests in `test/supervisor/artifacts/` and `test/workspace/harness-build.test.ts`. Read `src/workspace/host.ts`, `src/facet/index.ts`, and ADRs 0026 through 0029 and 0034. Update evidence in `docs/agents/design/computer-integration.md` without rewriting the layout decision.
- **Acceptance criteria.**
  1. Reproduce the oracle's clean-archive failure. Make the build operation explicitly obtain the named commit, use the lockfile, build Pi, then produce the module map from a clean checkout. It must not borrow parent `node_modules`, generated Pi output, or the owner's uncommitted source. Propagate failures from archive extraction as well as compilation.
  2. A new commit submitted after the harness checkout was provisioned is fetched or found locally. A commit absent from the configured repository returns a bounded, actionable failure. An interrupted provision must not erase an existing editable harness checkout.
  3. Two independent clean builds of one commit produce byte-identical canonical maps. Retain commands and outputs. The existing fake-module ordering test is not this check.
  4. In an approved disposable paid environment, a loaded facet receives the model capability and a per-turn Computer RPC capability, reads and writes a durable file, runs a container command, and reaches an arbitrary ordinary internet destination. No capability is serialized into a cached project-specific Loader environment.
  5. Computer builds the map, the commit-named Loader accepts it, and a cold candidate passes bounded `GET /`. Restart or evict the host and facet and show the durable file again. Record cold/warm timings, image/source pins, input commit, and raw redacted failures.
  6. Check for a supported Computer source/image pair. Retain the current paired pins unless the replacement passes the same checks. A mismatch or unreproducible map stops this gate; record the disproof rather than adding a fake or a second cache identity. Paid authorization or account access missing means blocked, not passed.
- **Verification command.** `pnpm verify`. Also run the task's repeatable clean-build and paid probe commands and record their exact invocation. They are mandatory additional evidence, not part of the local gate.
- **Dependencies.** None.
- **Size.** L.
- **Owner tier.** `opus-manager`.

## Wave 1

### T2. Remove generation request journaling end to end

- **Why.** ADR-0030 already approves this subtraction. It reduces every control caller's interface before the conversation UI grows.
- **Scope.** `src/supervisor/control/`, `src/routes/generations.ts`, `src/page/script-generations.ts`, `src/page/markup.ts`, `src/page/element-ids.ts`, generation route/control tests, `scripts/deploy/README.md`. Read ADRs 0030 and 0033. Preserve recovery operation keys and turn lease IDs.
- **Acceptance criteria.**
  1. Production request bodies and RPC types contain principal plus command, without generation `requestId`, fingerprinting, or replay fields. Delete `src/supervisor/control/journal.ts` and journal creation/writes. A fresh-schema test proves the table is absent. Handle any retained local journal table by an explicit documented cleanup, not a new compatibility journal.
  2. Candidate resubmission returns the existing label. Activation of the active label with the current epoch is a no-op. Activation and rollback with stale epochs reject. Rollback still requires a ready label that ran before.
  3. Generation rows, active selection, and preparation checks advance the epoch under existing rules. Relay observations and recovery records do not. Failed candidates leave active traffic unchanged.
  4. Duplicate candidate requests do not replay an old response. Do not silently rerun preparation on an already ready candidate as a substitute for journaling. If preparation is pending or failed, return its current status or perform an explicit preparation action with tested behavior. Preserve the direct-command semantics without inventing automatic retries.
  5. After uncertain transport failure, the page reads current status before another activation/rollback. Remove request-ID controls and all obsolete tests and deployment examples. Tests exercise repeated delivery with current state, not exact replay.
- **Verification command.** `pnpm verify`.
- **Dependencies.** T1.
- **Size.** M.
- **Owner tier.** `sonnet-implementer`.

### T3. Make one tenant workspace hold every repository

- **Why.** Renaming Workspace Hosts alone would put all clones at `/project`. Identity, directories, file access, and shared-container operations must change together.
- **Scope.** `src/workspace-names.ts`, trusted tenant-context wiring in `src/access/index.ts` and `src/worker.ts`, `src/project-provision.ts`, `src/workspace/{host,provisioning,project-provision}.ts`, `src/workspace/project/`, `src/facet/generation-0/execution-env*`, `src/supervisor/projects/`, `src/supervisor/artifacts/build-workspace.ts`, workspace construction in `src/supervisor/supervisor.ts`, related tests, and `tools/verify-project-protocol.mts` if the protocol changes. Read ADRs 0038 and 0039. T5 alone owns Supervisor thread RPC wrappers in this wave.
- **Acceptance criteria.**
  1. One server-derived tenant key selects the same Workspace Host for harness builds and all that tenant's projects. Two verified identities select different hosts. Remove the global build-host name and project ID from host hashing. A browser never supplies the authoritative tenant key, identity, or audience.
  2. Give harness and projects separate stable directories and Git histories inside that host. Project selection sets initial cwd only. Pi's filesystem and shell adapters agree on addresses and can intentionally inspect a sibling repository or managed instructions. They cannot select another tenant's host. Keep malformed-input, byte-size, and symlink-cycle checks; remove the rejected project-as-security-barrier assumptions.
  3. Provisioning reuses a matching clone without resetting dirty files or unpushed commits. A remote mismatch or a populated non-repository directory fails without deleting it. Interrupted staging is recoverable. Restarting one project does not reclone or overwrite another.
  4. Build scratch directories never replace the editable harness checkout. Concurrent builds of the same commit cannot delete each other's files. Probe two project commands and a candidate build on the one container. Record whether Computer permits overlap; enforce a bounded conflict or a narrow serialization policy for operations that actually share mutable state. Never silently overlap unsupported execution or queue without a bound.
  5. Keep one active-turn lease per project and Pi's default tool scheduling. Do not solve workspace contention by restoring `toolExecution: "sequential"` globally. Re-run capability, exec cancellation/disposal, path mapping, and loaded workerd tests against the shared layout.
  6. Provide one server-resolved project-location result for the later connection and turn tasks. The current static catalog may remain only until T6 replaces it. Update `computer-integration.md`'s implementation status after the shared path passes.
- **Verification command.** `pnpm verify`. Repeat T1's paid capability/file-survival probe with this layout and record the concurrency probe command.
- **Dependencies.** T1.
- **Size.** L.
- **Owner tier.** `opus-manager`.

### T4. Carry real model events through the fixed Workers AI route

- **Why.** The current `StreamFn` adapter produces one buffered terminal message. Pi cannot stream text as the provider produces it or use honest context limits from zero metadata.
- **Scope.** `src/model-route.ts`, `src/facet/generation-0/{capabilities,route-stream,workers-ai-adapter}.ts`, `test/model-route.test.ts`, and focused adapter tests. Read the pinned Pi event types and current provider documentation. T7 owns `facet-turn.ts` and the Agent assembly.
- **Acceptance criteria.**
  1. Preserve one immutable model selection and credential holder. Prove that the selected route supports the required text/tool stream in the paid runtime. If not, record a concrete provider limitation and resolve it before this task passes. Do not substitute synthetic token chunks or add a provider picker.
  2. The adapter delivers actual incremental text, tool-call assembly, terminal status, and model errors through Pi's event types. Test split UTF-8, split tool arguments, a truncated provider stream, provider error, and cancellation. Cancellation prevents further model calls and releases the reader; document whether it can stop an already-issued inference.
  3. Parse untrusted model request/tool definitions and provider outputs at this seam. No arbitrary endpoint, model, provider credential, or generation-control capability can pass through it. Bound input and event bytes using bytes rather than JavaScript string length.
  4. Expose fixed non-secret context/output limits needed by Pi. Carry real usage if provided; otherwise represent unavailability and use a documented conservative estimate. Do not claim zero usage is a measurement. Existing text/tool history remains readable.
  5. Keep transport envelopes plain across Workers RPC. Tests use the real loaded seam as well as a deterministic provider adapter.
- **Verification command.** `pnpm verify`. Record the paid model-event probe separately.
- **Dependencies.** T1.
- **Size.** L.
- **Owner tier.** `opus-manager`.

### T5. Make thread completion require the lease that admitted it

- **Why.** Thread revision alone cannot distinguish an expired turn from its replacement. The store already creates a lease ID, but public completion methods discard it.
- **Scope.** `src/supervisor/threads/`, only the thread RPC wrappers in `src/supervisor/supervisor.ts`, and `test/supervisor/threads/`. Read ADRs 0035, 0036, and 0038. T3 owns Supervisor construction and workspace wiring.
- **Acceptance criteria.**
  1. Every finish or abandon operation requires the lease ID that admitted that turn. Migrate the current RPC wrappers and tests and remove optional/unkeyed completion paths in the same task. Keep lease IDs server-owned; do not make the browser the save coordinator.
  2. A late finish or abandon from turn A cannot alter turn B after expiry/takeover at the same revision. Test both operations, not only successful finish.
  3. Fresh thread invalidates old leases even when revision zero recurs. A delayed start against a replaced thread must not be accepted solely because its old numeric revision matches. Use a durable thread identity or monotonic concurrency version and test the reset race through storage.
  4. Starting fresh clears Pi messages and compacted context without touching workspace files. It cannot let the old lease save into the replacement. The later turn coordinator receives enough identity to cancel or fence its old work.
  5. Reads, admission, and writes use the existing synchronous transactions and plain serialized Pi messages. Keep one active turn per project. An expired lease permits a new admission without needing an alarm.
- **Verification command.** `pnpm verify`.
- **Dependencies.** T1.
- **Size.** M.
- **Owner tier.** `sonnet-implementer`.

## Wave 2

### T6. Connect GitHub repositories and provision the shared machine

- **Why.** The fixed two-item placeholder catalog cannot power the demo. Access identity is not repository authorization.
- **Scope.** `src/project-catalog.ts`, new connected-project storage beside `src/supervisor/projects/`, catalog resolution in `src/supervisor/threads/project-threads.ts`, `src/access/index.ts`, `src/worker.ts`, project-list/connect routes under `src/routes/`, and credential/provision wiring in `src/workspace/host.ts` and `src/workspace/provisioning.ts`. Add focused route, ownership, storage, and provisioning tests. T7 owns facet/session code; T8 owns R2 cache policy.
- **Acceptance criteria.**
  1. Store a tenant-owned list of connected GitHub repositories. Empty, one, two, and three projects all work. Stable project identity is independent of list order and display name. Duplicate connection converges on the same project. Delete `example.invalid` production entries and the exact-two tuple restriction.
  2. Add a separate GitHub repository authorization flow. Default to an owner-initiated gh device authorization in the workspace, subject to current GitHub support and Q2. The app must show only a verification URL/code and safe connection status, not an access token. Access sign-in alone grants no repository access.
  3. Verify repository access before making a project usable. Install credentials in normal local gh configuration outside all repositories and establish ordinary git credential use. Keep credentials out of tracked files, URLs, browser responses, logs, R2 maps, and facet state. Test redaction with a recognizable fake token. Prove private-repository clone and a permitted git/gh operation on a disposable repository.
  4. Make git and gh available only if the pinned image lacks them. After host/container restart, ordinary tools can still authenticate or the app reports a reconnect requirement. Never silently return a connected status with unusable credentials.
  5. Invoke idempotent provisioning on connection/use and after host recreation. Preserve dirty files and separate project threads. Resolve projects through the stored tenant catalog in both the thread and workspace paths. The host must not fall back to the old static catalog.
  6. Add list, connect/status, and read/fresh-thread routes needed by the page. Verified server scope reaches workspace selection; caller-supplied tenant fields have no authority. Unknown or cross-tenant project IDs fail before capability acquisition. Bind authorization completion to the initiating owner and reject replay/cross-origin mutation as appropriate to the chosen flow.
- **Verification command.** `pnpm verify`. Record the real credential/repository probe without secrets. Production credential authorization is an owner action; missing authorization blocks that acceptance item.
- **Dependencies.** T3, T5.
- **Size.** L.
- **Owner tier.** `opus-manager`.

### T7. Finish Pi instruction, compaction, and turn-event integration

- **Why.** A bare Agent with four tools does not load managed instructions or compact a long thread. The old buffered loop still provides a competing turn definition.
- **Scope.** `src/facet/generation-0/{pi-agent-turn,facet-turn,facet-turn-request,request-handler,main-facet,turn,tools,tool-execution,session-transcript}.ts`, a small new facet-owned session module if needed, and `vendor/pi-v0.84.4/index.ts` plus its managed export tooling if a vendored capability needs exporting. Audit remaining callers of the legacy workspace execution interface and report the deletion list to T9. Own corresponding facet/session tests and update only necessary Pi provenance/export checks. T6 owns Workspace Host edits in this wave.
- **Acceptance criteria.**
  1. The selected project's cwd and saved Pi conversation start the turn. Load managed instructions and applicable repository instructions through the execution adapter using vendored Pi behavior. A test proves both affect the prompt. The other project's conversation never enters this prompt merely because files share a workspace.
  2. Use Pi's compaction behavior before the fixed route's context limit is exceeded. A deterministic small-budget test forces compaction, saves the resulting Pi context, and continues after facet replacement. Starting fresh removes that context and preserves files. Use the metadata from T4; do not write a second summarizer.
  3. Emit typed plain frames for incremental text, tool start with arguments, tool results including bounded displayable content, and exactly one terminal outcome. Distinguish rejected admission, failed turn with retained conversation, and successful Pi completion. This facet terminal outcome is provisional until T9 saves it.
  4. Cancellation releases the RPC capability and stops further model/tool dispatch. Implement or explicitly reject any previously unsupported `ExecutionEnv` method required by instructions or compaction; tests must exercise it through the real adapter. Do not implement unused tools just to fill out the interface.
  5. Delete the hand-written buffered `runGeneration0Turn` path, its custom transcript, duplicate tools, and the old production `/turn` handler after moving still-used prompt/bound constants. Keep cheap ordinary `GET /` for startup. List `WorkspaceHost.execute` and its old fixed-check adapter for deletion in T9 if the caller audit confirms they now have no production use. T6 owns that host file in this wave; preserve build/provision operations.
  6. Keep Pi's default tool scheduling, the fixed model route, and no model generation-control tool. The real Pi path is the sole production coding loop.
- **Verification command.** `pnpm verify`.
- **Dependencies.** T3, T4.
- **Size.** L.
- **Owner tier.** `opus-manager`.

### T8. Bound the rebuildable R2 cache with one age rule

- **Why.** ADR-0034 permits eviction and the v0 feature map requires a simple size or age limit. The current cache has neither.
- **Scope.** `src/supervisor/artifacts/cache.ts` only if runtime support is necessary, R2 lifecycle configuration/procedure under `docs/agents/`, relevant cache tests, and a focused verification tool if required. Read ADR-0034. Prefer a bucket lifecycle rule scoped to `module-maps/` over an application cleanup scheduler.
- **Acceptance criteria.**
  1. Record and apply one simple age bound. Use seven days as a reversible initial value unless the measured build cost or owner cost preference justifies another value. Read current R2 lifecycle support rather than inventing Wrangler syntax.
  2. Missing or corrupt cache objects rebuild under the same commit key. Cache hits avoid building. Cache-write failure still permits a validated map to load. Failed rebuild does not change generation-control state.
  3. Expiry cannot delete project files, conversations, credentials, or unrelated bucket prefixes. Cache changes do not advance the generation epoch. No new artifact digest, retention database, background sweeper, or quota framework.
  4. Demonstrate the expiry/miss semantics with a disposable object and retain the configured rule. Do not wait seven days for the test; verify the rule and exercise deletion-triggered rebuild separately.
- **Verification command.** `pnpm verify`. Record the R2 rule inspection and eviction/rebuild probe.
- **Dependencies.** T1.
- **Size.** S.
- **Owner tier.** `sonnet-implementer`.

## Wave 3

### T9. Own the saved streamed turn in the Supervisor

- **Why.** This is the highest-leverage deepening. The browser must not join leases, facet state, and completion evidence itself.
- **Scope.** `src/supervisor/projects/`, `src/supervisor/supervisor.ts`, `src/supervisor/relay/`, thread integration in `src/supervisor/threads/`, the authenticated turn route under `src/routes/`, and `src/worker.ts`. Add storage, loaded-facet, and route tests. Read ADRs 0031, 0033, 0035, 0037, and 0038. Consume T7 frames without adding Pi behavior to the Supervisor.
- **Acceptance criteria.**
  1. One authenticated project-turn entry validates the project and prompt, resolves the current thread, acquires its lease, snapshots the active generation and passing preparation check, ensures the workspace is usable, and starts that facet with its per-turn capability. Request JSON cannot supply a tenant, trusted history, model credential, or lease ownership.
  2. Stream validated, bounded frames while consuming the facet result on the server. Save Pi terminal messages with T5's lease and thread identity. Only after the save commits may the browser receive authoritative success and the relay attempt earn one completed-real-turn credit. A failed save never produces success, even when the facet emitted `completed`.
  3. A failed turn's valid partial Pi state may be saved according to a documented policy without earning credit. Malformed, oversized, duplicate-terminal, or truncated streams cannot save arbitrary state or count success. An empty EOF and a successful `GET /` earn no real-turn credit.
  4. Adopt cancel-on-disconnect for v0 unless Q3 changes it. On observed cancellation, stop upstream work and release only the owned lease. Define the save-vs-cancel race at the durable commit. Preserve a save already committed, but never fabricate completion for a disconnected unfinished turn. Measure actual browser-disconnect propagation in the paid runtime.
  5. A bounded turn deadline handles absent disconnect signals, lost facets, and interrupted hosts. Later admissions can recover an expired lease. Old finish/abandon callbacks cannot affect a new turn. Reconcile pending evidence on an existing request path if required; no alarm, automatic retry, or background-turn feature is needed.
  6. Mid-turn activation does not relabel that turn's evidence. New turns use the new active generation; the admitted turn follows a stated drain/cancel rule. Manual rollback remains independent of model work. A failed candidate never changes the serving facet.
  7. The HTTP adapter returns explicit conflict, unavailable, and validation responses without leaking exception details or credentials. Enforce same-origin mutation protections where cookie authentication requires them. Remove the old public split-turn choreography once tests and callers use this interface. Apply T7's verified deletion list for the unused `WorkspaceHost.execute` and fixed-check adapter, preserving build/provision operations.
  8. Update obsolete fixture-attribution and stream-completion limitation notes in ADR-0031 and current implementation-status docs. Preserve the decision itself and leave known-good thresholds and automated recovery out.
- **Verification command.** `pnpm verify`. Record the paid disconnect/deadline probe in addition to local cancellation tests.
- **Dependencies.** T2, T5, T6, T7.
- **Size.** L.
- **Owner tier.** `opus-manager`.

## Wave 4

### T10. Put the connected project conversation on one page

- **Why.** The current status prototype contains neither a conversation nor a project sidebar. The useful workflow should be primary, with rollback still reachable.
- **Scope.** `src/page/`, `src/routes/page.ts`, browser build tooling if needed, `test/routes/page.test.ts`, and new page/browser tests. Consume existing route contracts; do not modify backend orchestration in this task. Read ADRs 0037 and 0038 and Q4 in `questions.md`.
- **Acceptance criteria.**
  1. A collapsible left sidebar lists connected projects and their connection status. It supports the T6 connection flow without asking for a token in page fields. Selecting a project loads that project's current conversation and sets subsequent turns to it.
  2. Render text deltas, tool calls, bounded tool output, diff output, and authoritative terminal status as they arrive. Render content as text or sanitized Markdown. Do not execute repository/model HTML. Large command output cannot make the page unresponsive.
  3. Expose fresh thread, busy/conflict, disconnected, failed-save, and no-active-generation states. Starting fresh requires an explicit user action and preserves files. A second browser sees the same saved thread after reload. Switching projects cannot append a late frame to the newly selected conversation.
  4. Show active label and observed epoch. Keep submit, checked activation, rollback, and latest available recovery report on the same page. Use a compact generation drawer by default. Do not imply background repair or known-good status chosen by an unsettled threshold.
  5. Delete the free-text project-ID input and raw-JSON panels as the primary workflow. Maintain CSP nonces, same-origin requests, and no-store responses. Keep browser logic in checked TypeScript rather than expanding opaque script strings. Choose the smallest build change; no frontend framework is required.
  6. A real browser test selects a project, starts a streamed turn, sees a tool call before terminal completion, observes output, starts fresh, and uses generation controls. Test narrow and wide viewports and keyboard access. Existing script-syntax checks alone do not pass this task.
- **Verification command.** `pnpm verify`. Record and run the browser harness command against a running application.
- **Dependencies.** T2, T6, T9.
- **Size.** L.
- **Owner tier.** `opus-manager`.

### T11. Test the complete workflow under failures and races

- **Why.** The existing suite has strong local protocol tests but no integrated proof that saved coding work survives replacement. This task is independent of the page author.
- **Scope.** New integration tests under `test/supervisor/projects/`, `test/routes/` except `page.test.ts`, and disposable fixtures/tools. Read production code but do not modify it in this task. Report defects to the owning task instead of silently fixing them during verification.
- **Acceptance criteria.**
  1. Through the same turn interface the HTTP adapter calls, prove read/edit/check/diff and a saved continuation after replacing the main facet. Use deterministic model output for local replay and real workerd RPC, not a fake turn coordinator.
  2. Cover two projects in one workspace with separate conversations, two clients contending for one project, expired-lease takeover, late finish and abandon, fresh-thread ABA, malformed/truncated frames, save failure, and cancellation before/after durable save. Assert both thread state and relay credit, not just response codes.
  3. Exercise active-generation change during a running turn, passing candidate activation, deliberately broken candidate isolation, and rollback to a previously active ready label. Assert the edit and current thread survive all three generation cases.
  4. Exercise cold cache hit, corrupt-object rebuild, missing-object rebuild, and failed build while the active generation serves. Include same-commit concurrent build behavior from T3. Do not claim fake map canonicalization proves real reproducibility.
  5. Confirm no credential-bearing bindings reach the facet, browser output, logs, or saved thread fixtures. Confirm direct generation controls remain owner-only and the model has no control connector.
  6. Keep existing loaded-stub disposal, framing, cancellation, and property tests. Delete superseded scaffold tests only with an explicit replacement mapping. No new test may pass solely by checking that source text contains a desired identifier.
- **Verification command.** `pnpm verify` in a fresh worktree at the exact candidate commit. Record the candidate SHA and focused test commands.
- **Dependencies.** T3, T8, T9.
- **Size.** M.
- **Owner tier.** `sonnet-implementer`.

## Wave 5

### T12. Deploy the exact candidate, record the v0 demo, and stop

- **Why.** Local workerd and a configured bucket cannot prove the release. The paid demo is the product's done predicate.
- **Scope.** Deployment/probe tooling under `scripts/`, agent-authored deployment and release notes under `docs/agents/`, runtime configuration only as required, disposable demo repositories, and browser evidence. Update `docs/agents/design/feature-map.md`, `docs/agents/design/computer-integration.md`, and stale implementation notes in `docs/agents/design/slices.md`. Keep human `README.md` unchanged.
- **Acceptance criteria.**
  1. Provide one repeatable procedure covering the Worker, Supervisor and Workspace Host migrations, Container, R2 and its age rule, model binding, Access GitHub identity policy restricted to the owner, and separate repository authorization. The config guard actually runs before deployment. Resolve secrets through the documented secure channel and print none. Use the current request bodies without request IDs.
  2. Deploy an exact committed candidate in an approved paid environment. Run the final `pnpm verify` after the last source change and record SHA, pins, commands, resource names, and redacted raw results. A later code change invalidates the relevant evidence and must be rechecked.
  3. Complete the seven-step demo in `docs/agents/design/feature-map.md` in a fresh browser. Make a small real repository edit, run its configured check, show the diff/output, build and activate a second visibly different harness commit, continue the same conversation, reject a broken candidate while the active one serves, and roll back without losing files or thread state.
  4. Repeat from a second authenticated browser. Restart or evict the Supervisor, facet, Workspace Host, and container as supported, then prove active selection, connected-project catalog, current threads, workspace files, and usable GitHub authentication persist or require the documented reconnect action. Confirm unauthorized and cross-tenant requests fail.
  5. Repeat the measured disconnect, deadline, same-workspace concurrency, and cold-cache rebuild checks on this exact release. Record elapsed times and failure codes. A summary written from memory is not evidence.
  6. Reconcile stale completion claims without re-documenting settled ADRs. Distinguish implemented/local/paid status, especially the old fixture, model, page, and SQLite artifact claims. Keep historical slices marked historical. Show recovery reports only if they exist; manual rollback is sufficient recovery.
  7. Produce the two-minute recording and release notes with evidence links. Publish the recording only to the owner's approved destination from Q5. If destination approval is pending, retain the file and mark publication blocked. Do not call v0 released until the done criteria in `goal.md` pass.
- **Verification command.** `pnpm verify`. Run the documented deployment, paid acceptance, and browser commands separately and retain their output.
- **Dependencies.** T2, T8, T10, T11.
- **Size.** L.
- **Owner tier.** `opus-manager`.

## Critical path and scope control

The main path is T1 -> T3 -> T6/T7 -> T9 -> T10/T11 -> T12. T2 removes obsolete control complexity in parallel. T4 supplies real model events for T7. T5 fixes lease ownership before orchestration can depend on it. T8 is a small cache rule, not a retention project.

T1, T3, T4, and T9 contain empirical gates. If a paid contract fails, record expected versus observed behavior and the narrow proposed correction. Re-run that gate before dependent work continues. Do not ask the owner to guess platform behavior. Questions in `/tmp/cf-stumble-v0/questions.md` are product preferences only; use their stated defaults for reversible work.
