# src/facet reader notes (HEAD d6ff2380487a60f410c568272635d99f30560d14)

## Reading order followed
`AGENTS.md` -> `docs/agents/domain.md` -> `docs/agents/design/overview.md` -> `docs/agents/CONTEXT.md`
-> `docs/agents/adr/README.md` (+ ADR-0024,0026-0030,0034,0038,0039) -> `docs/agents/design/feature-map.md`
-> every file under `src/facet/` and `src/facet/generation-0/`.

## Module map (`src/facet/`)

- `src/facet/index.ts` — host-side loader boundary. Exports `MainFacetTarget` (the fixed RPC
  contract every generation must satisfy: `fetch`, `startTurn(projectTarget, request)`),
  `MainFacetCapabilities` (`{ MODEL: Fetcher<ModelRoute> }`), and `loadMainFacet(loader, input,
  capabilities)`, which parses a `MainHarnessArtifact` and calls `loader.get(harnessCommit, () => ({
  mainModule, modules, env: capabilities, globalOutbound: null }))` (ADR-0027 identity, ADR-0028
  module-map shape).
- `src/facet/artifact.ts` — `MainHarnessArtifact.parse` validates an untrusted `MainHarnessArtifactInput`
  (from R2/Computer, ADR-0034) into a non-empty module map with one located entry module and no
  duplicate names; returns a `Result` (`better-result`, ADR-0035) with problem codes
  `invalid-harness-commit | invalid-artifact | empty-module-map | entry-module-not-found |
  duplicate-module-name`.
- `src/facet/fixture.ts` — hand-written `MainFacet` module map + invented commit for tests only;
  `test/facet/fixture-reach.test.ts` enforces `src/` never imports it (real deploys submit an actual
  commit, per feature-map.md P0/P1).

## Module map (`src/facet/generation-0/`) — Generation 0's own implementation

Two parallel turn implementations exist side by side, wired very unevenly:

1. **Buffered `/turn` path (scaffolding, effectively dead in production).**
   `request-handler.ts` (`handleGeneration0Request`, `parseTurnRequest`) → `turn.ts`
   (`runGeneration0Turn`, `MAX_MODEL_CALLS=8`) → `tools.ts` (`GENERATION_0_TOOLS`, `planToolCall`,
   `applyUniqueEdit`) → `tool-execution.ts` (`executeToolPlan` against a `WorkspaceCapability` from
   `capabilities.ts`, itself `src/workspace/index.ts`'s `WorkspaceRequest/WorkspaceResult`) →
   `session-transcript.ts` (a private, versioned `cf-stumble-generation-0` JSON document) →
   `workers-ai-adapter.ts` (Pi-shape ⇄ `ModelRouteRequest/Response` from `src/model-route.ts`).
   `main-facet.ts`'s `fetch()` calls `handleGeneration0Request(request, this.env)` with **no**
   workspace argument, and no `src/` caller ever supplies one (confirmed by grep: `runGeneration0Turn`
   has exactly one call site, in `request-handler.ts`, always `workspace === undefined`). Per the
   `turn.ts` docstring, every file/command tool on this path therefore always reports
   `"workspace error: workspace-unavailable"` in production; it only exercises real files under a
   direct unit test that hands it a workspace by hand.

2. **Streamed `startTurn` path (the one actually wired to the Supervisor).**
   `main-facet.ts`'s `startTurn(projectTarget, request)` → `facet-turn.ts` (`startFacetTurn`,
   `FacetTurnFrame` NDJSON stream: `text | tool-result | completed | failed | rejected`) →
   `project-capability.ts` (`leaseProjectCapability` dup()s the received RPC stub because Workers RPC
   disposes a parameter stub when the call returns, but the turn outlives that call) →
   `pi-agent-turn.ts` (`runPiAgentTurn`, real vendored `Agent` from `@cf-stumble/pi`, binds only four
   Pi tools: `createReadTool/createWriteTool/createEditTool/createBashTool`) → `execution-env.ts`
   (`createFacetExecutionEnv`, implements Pi's `ExecutionEnv` over the six-method
   `ProjectRpcTargetContract` from `src/workspace/project/protocol.ts`) → `execution-env-paths.ts`,
   `execution-env-filesystem.ts`, `execution-env-exec.ts`, `execution-env-rpc.ts`,
   `execution-env-frame-reader.ts` (path confinement to `/project`, RPC envelope/error parsing, NDJSON
   exec-stream decoding) → `route-stream.ts` (`createRouteStreamFn`, `ROUTE_MODEL` — a zero-cost
   descriptor stub, since the real model/credential stay behind `MODEL_ROUTE`) →
   `workers-ai-adapter.ts` (shared with path 1). This is confirmed reachable from the Supervisor:
   `src/supervisor/projects/project-turn.ts` calls `mounted.value.fetcher.startTurn(capability,
   input.request)`.

`capabilities.ts` defines `Generation0Capabilities = { MODEL: ModelCapability }` and separately
`WorkspaceCapability` (used only by the dead path 1); `plain-values.ts` (`isString/isBoolean/
isPlainObject`) is the shared untrusted-value guard used across parsing boundaries.

## Dependencies

- `@cf-stumble/pi` (vendored fork): `Agent`, `createReadTool/createWriteTool/createEditTool/
  createBashTool`, `ExecutionEnv`, `FileError`, `ExecutionError`, `StreamFn`,
  `createAssistantMessageEventStream`, `truncateTail`.
- `better-result`: only in `src/facet/index.ts` and `artifact.ts` (host boundary), consistent with
  ADR-0035 ("better-result only inside process boundaries" — RPC/loader edges keep plain
  `ProjectResult`/`WorkspaceResult`/`TurnOutcome` shapes instead).
- `src/model-route.ts` (`MODEL`, closed `RouteMessage` union, `ModelRouteRequest/Response`), and
  `src/workspace/project/protocol.ts` (`ProjectRpcTargetContract`, `MAX_EXEC_TIMEOUT_MS`,
  `MAX_EXEC_FRAME_BYTES`).
- `src/harness-commit.ts` (`parseHarnessCommit`) underlies `MainHarnessArtifact`.

## Concrete friction

- Two turn implementations solve the same problem with incompatible transports (buffered JSON
  document vs. streamed NDJSON + Pi `AgentState`), duplicated tool catalogues, and duplicated
  Pi-adapter code (`workers-ai-adapter.ts` serves both). Only the streamed one is reachable from the
  Supervisor; the buffered one (`turn.ts`, `tools.ts`, `tool-execution.ts`, `session-transcript.ts`)
  is unreachable dead weight in the shipped facet, kept alive by unit tests only.
- `createFacetExecutionEnv` (`execution-env.ts`) leaves 7 of Pi's `ExecutionEnv` methods as
  `unsupportedError`: `joinPath`, `readTextLines`, `renameFile`, `listDir`, `createDir`, `remove`,
  `createTempDir` (only `createTempFile` is implemented, via a create-exclusive retry loop). Notably
  `listDir` is unsupported even though `ProjectRpcTargetContract.listFiles` exists on the protocol —
  the adapter never calls it. Today this is masked because `pi-agent-turn.ts` binds only
  read/write/edit/bash tools, so nothing invokes `listDir`; it becomes a gap the moment Pi gains or
  the facet binds a directory-listing tool.
- `execViaProjectTarget` (`execution-env-exec.ts`) rejects any `ShellExecOptions.env` override or
  `inheritEnv: false` outright, narrower than a generic Pi shell.
- `route-stream.ts`'s `createRouteStreamFn` always answers with one terminal event per model call
  (non-streaming route), so no token-by-token delta reaches the browser, whatever ADR-0037 wants.

## Missing v0 behavior (present in feature-map.md, absent in this code)

- No `src/` code path drives a `Generation0Capabilities.MODEL` value from an actual Workers AI
  binding; `route-stream.ts`'s `ROUTE_MODEL` is a placeholder descriptor, and feature-map.md still
  lists "Model access" as **Missing**.
- No committed, buildable Generation 0 artifact exists yet — `fixture.ts` is explicitly test-only,
  and feature-map.md's P0/P1 (real Computer-built module map, real Generation 0 facet load) are open.
- `session-transcript.ts`'s document format and `pi-agent-turn.ts`'s `PiAgentTurnState` are two
  separate, incompatible thread-state shapes; nothing in `src/facet` reconciles which one the
  Supervisor's actual thread store (ADR-0038 "accumulated context") is meant to persist.

## Distinguishing code from deferred ADR-0030 / 0038 / 0039

- **ADR-0030** (apply generation requests directly, no request journal) is a Supervisor/generation-
  control decision; nothing in `src/facet` implements or violates it — out of this module's scope.
- **ADR-0038** ("the hand-written bounded turn loop is scaffolding, not the version 0 harness")
  directly names what this reading found: the buffered `turn.ts` loop **is** that scaffolding,
  superseded in the wiring by the streamed `pi-agent-turn.ts` path, but not yet deleted.
- **ADR-0039** (treat the shared workspace as a dev machine: unrestricted internet, `git`/`gh`,
  multi-repo reach, no egress allowlist) describes a materially wider environment than
  `execution-env.ts` implements today: the facet execution env is scoped to one
  `ProjectRpcTargetContract` rooted at a fixed `/project`, paths lexically confined
  (`resolveAbsolute` in `execution-env-paths.ts` rejects any escape), env overrides refused, and
  only four file/exec operations exposed. That wider breadth, if it exists, lives in the
  Computer/Workspace layer this code calls through, not in the facet's own adapter.
