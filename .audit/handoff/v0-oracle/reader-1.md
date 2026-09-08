# cf-stumble src/supervisor architecture read — reader-1

HEAD examined: d6ff2380487a60f410c568272635d99f30560d14 (2026-09-05 01:36:29 -0700)
Scope: read-only. Docs read: AGENTS.md, docs/agents/domain.md, design/overview.md, CONTEXT.md,
adr/README.md, ADR-0030/0031/0033/0038/0039, design/feature-map.md. Implementation focus:
src/supervisor/** (36 files, 5074 lines), plus src/facet/generation-0/**, src/routes/owner-api.ts,
src/worker.ts to trace wiring. No installs, no tests run, no files modified.

## Module map (src/supervisor)

- `supervisor.ts` — `Supervisor extends DurableObject<SupervisorEnv>`. Composes `Generations`,
  `GenerationControl`, `HarnessArtifacts`, `RelayAttempts`, `Recovery`, `FacetRelay`,
  `ProjectThreads`. RPC surface: `checkGenerationStartup`, `prepareGeneration`,
  `getActiveGeneration`, `getGeneration(s)`, `controlGeneration`, `getPreparationCheckHistory`,
  `getRelayAttempts`, `sweepExpiredRelayAttempts`, `startRecovery`, `resumeRecovery`,
  `report/reconcileRecoveryOperation`, `get(Latest)RecoveryEpisode`, `getGenerationEligibility`,
  `getProjectThread`, `startFreshProjectThread`, `startProjectTurn`, `finishProjectTurn`,
  `abandonProjectTurn`, `streamProjectTurn`, `fetch()`. `fetch()` mounts the active generation via
  `mountServing`/`artifacts.mount`, forwards through `FacetRelay.forward`; a mount failure with
  `no-active-generation` returns 503 via `FacetRelay.recordMountFailure` without recording a relay
  attempt (ADR-0031).
- `generations/index.ts` — `Generations`: SQLite registry (`generations`, `generation_state`
  tables). Pure deciders in `generations/decisions.ts` (`decideActivation`,
  `decidePreparationCheck`), matching ADR-0036. Epoch bumps once per committed generation-row/
  active-label/preparation-check change, matching ADR-0033 exactly.
- `control/index.ts`+`control/request.ts`+`control/journal.ts` — `GenerationControl.execute`
  implements `submit-candidate`/`activate`/`rollback`, using `better-result`
  `Result<ControlOutcome, ControlProblemCode>` internally, converted to plain
  `GenerationControlResult` at the RPC boundary (ADR-0035).
- `eligibility.ts` — `generationEligibility`, `selectFallbackGeneration`,
  `DEFAULT_ELIGIBILITY_POLICY = { minimumCreditedTurns: 3, minimumObservationSpanMs: 60_000 }`
  (explicit placeholders per ADR-0031/overview.md).
- `relay/index.ts` (`FacetRelay`) + `relay/attempts.ts` — streams response bodies chunk-by-chunk,
  settles attempts `body-completed`/`body-failed` using `content-length` when present; matches
  ADR-0031's stated gap: a streamed response without `content-length` that closes early is recorded
  as `body-completed`.
- `recovery/index.ts` (`Recovery`) + `episode.ts`/`operations.ts`/`store.ts`/`persistence/*` —
  episode/report bookkeeping; per ADR-0032 records/bounds, does not repair.
- `artifacts/index.ts` (`HarnessArtifacts`) + `resolver.ts`/`builder.ts`/`cache.ts`/
  `module-map.ts`/`build-plan.ts`/`build-workspace.ts` — R2-cache-with-build-fallback for module
  maps (ADR-0034).
- `startup-check/*` — `checkGenerationStartup`/`prepareGenerationStartup`, bounded ordinary
  request (ADR-0029).
- `threads/store.ts` (`ThreadStore`) + `decisions.ts`/`thread.ts`/`project-threads.ts` — one row
  per project (`project_threads`: `project_id`, `messages`, `revision`, `turn_active`,
  `turn_deadline_at`, `turn_lease_id`). `startTurn`/`finishTurn`/`abandonTurn`/`startFreshThread`
  (deletes the row only; ADR-0038 compliant — files untouched).
- `projects/project-turn.ts` (`streamProjectTurn`) — resolves client project id against the
  catalog (`resolveProjectWorkspaceName`) before naming any workspace, mounts the active
  generation, calls `fetcher.startTurn(capability, request)` against a narrow `ProjectTurnFacet`
  (only `startTurn`, not full `MainFacetTarget`).

## Dependencies traced

- `src/worker.ts`: authenticates Access, serves owner page on `GET /`, routes `/api/*` to
  `routeOwnerApiRequest`, else calls `supervisor.fetch(...)` directly (relay path).
- `src/routes/owner-api.ts` (`routeOwnerApiRequest`) wires only: `GET /api/status`,
  `GET /api/recovery/latest`, `POST /api/generations/submit|activate|rollback`,
  `GET /api/projects/:id/thread`, `POST /api/projects/:id/thread/fresh`. **No chat/turn route
  exists**; nothing calls `Supervisor.streamProjectTurn`/`startProjectTurn`/`finishProjectTurn`.
- `src/facet/generation-0/*` — a real `MainFacet extends DurableObject<Generation0Capabilities>`
  exists (`main-facet.ts`, `fetch()`→`handleGeneration0Request`, `startTurn`→`startFacetTurn`),
  plus `pi-agent-turn.ts`, `execution-env*.ts`, `tools.ts`, `workers-ai-adapter.ts`. This
  contradicts the feature-map table's "Coding-agent loop: Missing" at the structural level (code
  exists), but it is reachable only through `streamProjectTurn`, itself uncalled by any route —
  treat as present-but-unverified-end-to-end, not confirmed working.
- `src/facet/fixture.ts` — 15 lines, exports only `fixtureMainHarnessCommit`/
  `fixtureMainHarnessArtifact`. Grep found no import outside its own file across `src/**`;
  feature-map's "production fixture in application construction" concern was not observed in
  current wiring (test-only usage not verified here).

## Concrete friction: ADR-0030 non-conformance (self-documented, verified in code)

ADR-0030 states: *"The implementation still has `requestId`, command fingerprints, and
`generation_control_journal`. It must remove them ... before the code matches this decision."*
Verified at HEAD:

- `control/request.ts`: `GenerationRequest` still carries `readonly requestId: string`.
- `control/index.ts` (`GenerationControl.execute`): computes `commandFingerprint(request.command)`,
  looks up `journalEntry(request.requestId)`, replays a fingerprint match, rejects with
  `"reused-request-id"` on mismatch.
- `control/journal.ts`: reconstructs `generation_control_journal` rows; the table is created in
  `control/index.ts`'s constructor (`CREATE TABLE IF NOT EXISTS generation_control_journal
  (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, ...)`).

Known, ADR-documented deferred cleanup — not hidden, but live at HEAD.

## Missing v0 behavior (vs. design/feature-map.md P1)

1. **No chat/turn HTTP route.** Matches feature-map's own "Project threads" row ("Drive a turn
   through the thread lease and stream it to the browser" = needed, not present).
2. **Thread lease and turn streaming are not joined anywhere in Supervisor code either.** The
   docstring on `Supervisor.streamProjectTurn` says so directly: *"a caller drives both halves —
   take the lease, stream the turn, then save the state.messages the terminal frame carries ...
   Joining them is the next unit's work."* `streamProjectTurn` takes no lease and never calls
   `finishProjectTurn`.
3. `Supervisor.modelRoute()` (`this.ctx.exports.ModelRoute({})`) exists as a type/method but P0
   ("prove the paid Cloudflare path") is explicitly unverified in feature-map; nothing read here
   proves it beyond local types.
4. Feature-map's status table (docs, not independently re-verified against a paid account here)
   still lists Missing: tenant page/HTTP routes, paid deployment; "Model access" and "Coding-agent
   loop" are structurally present but not confirmed wired/working end-to-end.

## Implemented vs. approved-but-deferred ADRs

- **ADR-0030** (apply requests directly, no journal): **not implemented** — `requestId`/
  fingerprint/journal are live code (see above), matching the ADR's own stated gap.
- **ADR-0038** (one thread/project, one shared workspace): **implemented** — `threads/store.ts`
  (one row per project id, `startFreshThread` deletes only the thread row) and
  `projects/project-turn.ts` (workspace name resolved from catalog + tenant identity). The gap is
  the missing *route* to drive it (a P1/P3 feature-map gap, not an ADR-0038 gap).
- **ADR-0039** (dev-machine workspace, unrestricted egress, `git`/`gh`, no proxy): no egress
  allowlist or GitHub-proxy code found in files read; consistent with the ADR, but
  `src/workspace/**` was not fully read — **unverified**, out of scope this pass.

## Tests / evidence gaps

- `test/supervisor/**` has 36 files covering control, generations, eligibility, relay, recovery,
  threads, artifacts, startup-check — matches feature-map's "most passing tests exercise control
  machinery, not the coding path." Did not run `pnpm verify` or any test; no pass/fail claimed.
- `test/supervisor/projects/project-turn.test.ts` and `supervisor-project-turn.test.ts` exist but
  contents were not read; whether they test the lease+stream join or only disjoint calls is
  unconfirmed.
- ADR-0031 states two gaps worth repeating verbatim, not inferred: "Nothing local proves a client
  disconnect reaches the Supervisor," and relay attempts are attributed to the active generation
  while `fetch()` was described as serving from "the one fixture artifact it mounts at
  construction" — current `supervisor.ts` constructor shows no fixture import, so this ADR text may
  predate current wiring; flag as a doc/code drift point for further check.
- ADR-0031: the relay-attempt sweep bound is "applied by an explicit sweep ... Nothing in
  production calls that sweep yet. Only tests do." Confirmed `sweepExpiredRelayAttempts` is a
  public RPC method on `Supervisor`; no caller found in `src/worker.ts` or `src/routes/**`.

## TypeScript style conformance (spot-check)

Files read conform to typescript-best-practices: discriminated unions with `kind` literals
throughout (`GenerationCommand`, `GenerationControlResult`, `ProjectTurnStart`, `BodyTermination`);
parsed/branded types via `parseGenerationLabel`/`parseHarnessCommit`; `unknown` at RPC boundaries
with explicit `oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: ...`
justifications; `better-result` confined to `control/index.ts` internals, converted to plain unions
at the RPC edge (ADR-0035). No bare `any` or unexplained `as` casts observed.

## Not read this pass (time-boxed)

`src/access/**`, `src/workspace/**` (beyond one protocol type), `src/routes/generations.ts`/
`recovery.ts`/`page.ts` bodies, `src/page/**`, `src/model-route.ts` body, `src/project-catalog.ts`,
`src/project-provision.ts`, full contents of the two project-turn test files,
`docs/agents/design/slices.md`, `docs/agents/design/computer-integration.md`, ADR-0002/0003/
0022-0029/0032/0034-0037 (index/title only).
