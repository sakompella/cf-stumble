# cf-stumble reader-4: src/routes and src/page architecture read

HEAD examined: d6ff2380487a60f410c568272635d99f30560d14
("docs(design): align version zero architecture", 2026-09-05). Working tree clean.
Read-only investigation. No files modified, no installs run, no tests executed.

## Reading order followed
AGENTS.md -> docs/agents/domain.md -> design/overview.md -> CONTEXT.md -> adr/README.md ->
ADR-0030, ADR-0038, ADR-0039 (full text) -> design/feature-map.md -> `find src -type f` ->
src/routes/*.ts -> src/page/*.ts (+ src/worker.ts, src/project-catalog.ts, src/access/verification.ts,
src/facet/generation-0/request-handler.ts, src/facet/generation-0/route-stream.ts for call-site context).
Did not read src/supervisor/**, src/workspace/**, or facet turn/tool internals beyond what routes
directly call; those are out of scope for this pass.

## Module interfaces read

### src/routes (826 total lines across files read)
- `src/worker.ts` (`fetch`): Access-authenticates every request via `authenticateAccessRequest`,
  then serves the owner page for a browser `GET /` (`ownerPageResponse`), else routes `/api/*` to
  `routeOwnerApiRequest`, else relays everything else via `supervisor.fetch(withoutAccessCredentials(request))`.
  Non-`/api/` non-page paths (including a machine `GET /`) go straight to the Supervisor's relay
  path per ADR-0029 (verified: `test/routes/page.test.ts` "a machine request for GET / still
  reaches the Supervisor relay" gets a typed 503 `no-active-generation`).
- `src/routes/page.ts`: `isOwnerPageRequest` (GET, path `/`, `Accept: text/html` present) and
  `ownerPageResponse(request, nonce?)`. Sets CSP `default-src 'none'; connect-src 'self';
  style-src/script-src 'nonce-...'`, `cache-control: no-store`, `x-content-type-options: nosniff`.
- `src/routes/json.ts`: shared HTTP-boundary helpers — `ApiErrorCode` union
  (`invalid-submission-request`/`invalid-activation-request`/`invalid-rollback-request`/`not-found`/
  `internal-error`), `jsonError`, `isRecord`, `hasExactKeys`, `isCount`, `readJson`.
- `src/routes/owner-api.ts` (`routeOwnerApiRequest`): the entire owner API surface is
  `GET /api/status`, `GET /api/recovery/latest`, `POST /api/generations/submit`,
  `POST /api/generations/activate`, `POST /api/generations/rollback`,
  `GET /api/projects/:id/thread`, `POST /api/projects/:id/thread/fresh`. `OwnerApiSupervisor`
  composes `GenerationControlSupervisor`, `GenerationSubmissionSupervisor`, `RecoveryReportSupervisor`
  plus `getActiveGeneration`/`getProjectThread`/`startFreshProjectThread`.
- `src/routes/generations.ts`: `handleGenerationControl` (activate/rollback, requires
  `{requestId, observedEpoch, label}`), `handleGenerationSubmission` (requires
  `{requestId, harnessCommit}`, then calls `prepareGeneration(label)` for the startup check).
  Comments explicitly cite ADR-0030 while implementing `requestId` and journal semantics (see gap below).
- `src/routes/recovery.ts`: `recoveryReportSummary`/`latestRecoveryReportSummary` project a
  `RecoveryEpisode` to a client-safe `RecoveryReportSummary` (no error text, only
  `awaitingExternalReport: "repair"|"startup-check"|null` per ADR-0032).

### src/page (826 total lines across files read, string-templated inline HTML/CSS/JS, no bundler/build step)
- `src/page/index.ts` (`ownerPageHtml(nonce)`): assembles one HTML document from
  `OWNER_PAGE_BODY` + `OWNER_PAGE_STYLES` + `OWNER_PAGE_SCRIPT`, no external asset, single inline
  `<script>`/`<style>` tied to the route's nonce.
- `src/page/element-ids.ts`: `OWNER_PAGE_IDS` is the single source of every stable DOM id; markup,
  script, and tests all reference it, so ids cannot drift.
- `src/page/markup.ts`: six `<section>`s — Active generation (read-only status), Project thread
  (one text `<input>` for project id, Load/Start-fresh buttons, revision/turnActive/messageCount
  fields only), Submit a generation candidate, Activate a generation, Roll back to an earlier
  generation, Latest recovery report.
- `src/page/script.ts`/`script-helpers.ts`/`script-status.ts`/`script-thread.ts`/
  `script-generations.ts`: one IIFE assembled from string fragments (no framework). `call(method,
  path, body)` is the sole fetch wrapper (`credentials: "same-origin"`, relative paths only).
  `renderStatus`/`renderRecovery`/`renderThread` write `textContent` from JSON fields into the
  ids above. `newRequestId()` generates a client UUID (or a `Date.now()+random` fallback) sent as
  `requestId` on submit/activate/rollback.

## Concrete friction / drift from approved decisions

1. **ADR-0030 says remove `requestId` and the control-request journal; the code still has both.**
   ADR-0030 text (`docs/agents/adr/0030-apply-generation-requests-directly.md`) states verbatim:
   "The implementation still has `requestId`, command fingerprints, and
   `generation_control_journal`. It must remove them from the page, routes, RPC types, Supervisor,
   and tests before the code matches this decision." Confirmed still present at HEAD:
   `src/routes/generations.ts` defines `GenerationControlBody`/`GenerationSubmissionBody` requiring
   `requestId`, a `REQUEST_ID_PATTERN`, `isRequestId`; `src/supervisor/control/journal.ts` exists
   (91 lines); `grep -rl requestId src` hits `src/page/script-generations.ts`,
   `src/page/markup.ts` (ids `submitRequestId`/`activateRequestId`/`rollbackRequestId`),
   `src/routes/generations.ts`, `src/supervisor/control/{request,index}.ts`. This is a **known,
   documented, unfinished cleanup**, not new drift — the ADR itself flags it as outstanding.

2. **No chat/turn route exists on the owner API.** `routeOwnerApiRequest`'s path list above is
   exhaustive; there is no `/api/projects/:id/turn` or similar. The only turn endpoint that exists
   at all is the facet-local `POST /turn` in
   `src/facet/generation-0/request-handler.ts` (`handleGeneration0Request`), which nothing in
   `src/routes` or `src/worker.ts` calls or proxies to per-project. Matches feature-map.md's table
   row "Tenant page and HTTP routes | Missing | Add identity routing, chat, status, candidate
   check, and rollback" — chat is the piece not built.

3. **The facet's own turn endpoint is a single buffered JSON response, not a stream.**
   `handleTurn` in `request-handler.ts` calls `runGeneration0Turn` once and returns one
   `Response.json(outcome.result)`; `createRouteStreamFn` in `route-stream.ts` explicitly notes
   "The route answers one buffered assistant message per call, so each stream this returns carries
   exactly one terminal event; nothing here fakes token-by-token deltas the route never
   produced." ADR-0037 (human-approved) requires the browser to see "text, tool calls, tool
   results, and terminal turn state as they arrive instead of waiting for one buffered response."
   No streaming transport (SSE/WebSocket/chunked) exists in `src/routes` or `src/page`; the page's
   only fetch helper (`call` in `script-helpers.ts`) does one `await response.json()`, not a
   readable-stream reader. This is a real gap against an approved ADR, not a deferred one.

4. **The page has no chat UI, no message log, no diff/tool-output display, and no project
   sidebar.** `OWNER_PAGE_IDS`/`markup.ts` contain no element for rendering conversation messages,
   tool calls, or a diff; the "Project thread" section only shows `revision`/`turnActive`/
   `messageCount` counters (`script-thread.ts` `renderThread`) — never message content. Project
   selection is one free-text `<input id="project-id-input">`, not a "collapsible left sidebar"
   despite CONTEXT.md/overview.md/feature-map.md all describing that as a fixed version-0
   requirement ("The Worker serves one application page with a collapsible left project sidebar,
   streaming conversation, and generation controls" — feature-map.md "Fixed limits"). No route in
   `src/routes/owner-api.ts` lists projects at all.

5. **Project catalog is a hardcoded fixture of two placeholder projects, not GitHub-connected
   repositories.** `src/project-catalog.ts` `PROJECT_CATALOG_CONFIGURATION` is a fixed 2-tuple
   (`project-one`, `project-two`) with `repositoryUrl: "https://example.invalid/..."`. There is no
   "connect a GitHub project" flow or API route anywhere in `src/routes`. This matches
   feature-map.md calling coding-agent loop / project connection out of scope for what exists, but
   is worth flagging as a hard blocker for the "two-minute demo" script in feature-map.md step 2
   ("Select a GitHub project").

6. **Access/tenant-routing cleanup item already appears done, contrary to feature-map's phrasing.**
   feature-map.md "Cleanup tied to the work" lists "Replace the Supervisor name `facet-spike` with
   the tenant key derived from the verified Access identity" as still-to-do. At HEAD,
   `src/worker.ts:26` already calls `env.SUPERVISOR.getByName(access.supervisorName)`, and
   `src/access/verification.ts` exports `deriveSupervisorName`. `facet-spike` only appears in test
   fixture names (`test/facet/facet-spike.test.ts`), not in production code paths. Feature-map.md
   may be stale on this specific line item; did not verify the full derivation logic in depth.

## Implemented vs. deferred ADR-0030/0038/0039 (explicit distinction)

- **ADR-0030 (apply generation requests directly, no journal)**: **not yet implemented** — see
  friction item 1. The ADR text itself documents this as pending cleanup, approved but not yet
  applied to the code the routes call.
- **ADR-0038 (one thread per project, one shared workspace)**: the *shape* is implemented in
  `src/routes/owner-api.ts` (`getProjectThread`/`startFreshProjectThread` take one `projectId` and
  return one thread), consistent with "each project has one current Pi thread." Whether the
  Supervisor-side workspace sharing (one Computer workspace for all repos) is implemented was
  **not verified** in this pass — that lives in `src/workspace/**` and `src/supervisor/projects/**`,
  outside the routes/page scope read.
  request-handler.ts and route-stream.ts implement only one model route, consistent with the ADR's
  narrow scope, but this ADR does not itself claim a UI; no page evidence contradicts it.

## Tests / evidence gaps

- `test/routes/page.test.ts` (read in full) is thorough on transport-security properties
  (Access gating, CSP, no-store, id presence, "only same-origin JSON endpoints") but only checks
  that the inline script *parses* (`new Function(script)` must not throw) — it never executes
  `renderStatus`/`renderThread`/`renderRecovery` against a fake DOM, so no test proves those
  render functions correctly reflect a given JSON payload into the ids they claim to update. No
  `test/page/` directory exists; the only page-level test is `test/routes/page.test.ts`.
- No test exercises the facet's `/turn` endpoint via the owner-facing routes, because no owner
  route calls it. `test/facet/generation-0/request-handler.test.ts` exists (per the vitest
  results.json seen in node_modules) but that is facet-local, not routes/page.
- Did not run `pnpm verify` or any test command in this pass — no claim is made about current
  pass/fail status of any suite. A stale `node_modules/.vite/vitest/*/results.json` file was seen
  containing prior run output; it was not treated as current evidence and its timestamp/HEAD
  correspondence was not checked.
- No browser/DOM test framework (e.g., `@testing-library`, jsdom-driven click simulation) was
  found referenced in the page test; this is consistent with feature-map.md's "paid-runtime checks
  remain separate" but is a real coverage gap for the page's actual interactive behavior.

## Scope not covered (explicitly out of bounds for this pass)
`src/supervisor/**` internals (generations, control, recovery, relay, threads, artifacts),
`src/workspace/**`, `src/facet/generation-0/**` internals beyond the two files cited above,
`src/access/keys.ts`/`credentials.ts` in depth, and all ADRs other than 0030/0038/0039 plus the
README index. No speculation is offered about their internal correctness.
