
# cf-stumble v0 Implementation Plan

## Current state

- 35 test files, 188 tests pass (`pnpm verify`).
- Supervisor: generation labels, epoch, activation, journaled control, relay attempts, eligibility, recovery episodes, sessions, startup check — all implemented and locally tested.
- Artifacts: SQLite-backed `harness_artifact_modules` table in `src/supervisor/artifacts/index.ts`. R2 binding configured in `wrangler.jsonc` (`MODULE_MAPS`) and smoke-tested (`test/supervisor/artifacts/r2-binding.test.ts`).
- Facet: `src/facet/fixture.ts` provides a test fixture facet. `loadMainFacet` in `src/facet/index.ts` loads module maps through the Worker Loader. Active generation serving works through fixture (`test/facet/facet-spike.test.ts`, `test/supervisor/active-serving.test.ts`).
- Pi v0.84.4 vendored at `vendor/pi-v0.84.4/`. Exports `Agent`, `createReadTool`, `createWriteTool`, `createEditTool`, `createBashTool`, `streamSimple`, `createGatewayBindingFetch`. Pi's harness types expose `FileSystem`, `Shell`, `ExecutionEnv`.
- Sessions: `SessionStore` in `src/supervisor/sessions/` with revision-checked turns, conflict detection, lease-based deadlines. Sessions are opaque documents outside generation state.
- Worker entry `src/worker.ts`: hardcoded `getByName("facet-spike")`, no routing.
- No model route, no Workers AI binding, no Access verification, no tenant routing, no HTTP routes, no page, no Computer workspace host, no R2 cache logic.
- Owner decisions: Workers AI model `@cf/zai-org/glm-5.3-flash` with low reasoning, owner-only Codex/ChatGPT OAuth sign-in (deferred to after Workers AI works).

## Key files to know

| Area | Path |
|---|---|
| Worker entry | `src/worker.ts` |
| Supervisor DO | `src/supervisor/supervisor.ts` |
| Env types | `src/supervisor/env.d.ts` |
| Facet loader | `src/facet/index.ts` |
| Artifact store (SQLite, to be replaced) | `src/supervisor/artifacts/index.ts` |
| Fixture facet | `src/facet/fixture.ts` |
| Generation control | `src/supervisor/control/index.ts`, `request.ts` |
| Sessions | `src/supervisor/sessions/index.ts` |
| Relay | `src/supervisor/relay/index.ts` |
| Startup check | `src/supervisor/startup-check/index.ts` |
| Eligibility | `src/supervisor/eligibility.ts` |
| Recovery | `src/supervisor/recovery/index.ts` |
| Pi vendor | `vendor/pi-v0.84.4/dist/index.js` |
| Pi types | `vendor/pi-v0.84.4/dist/upstream-surface.d.ts` |
| Wrangler config | `wrangler.jsonc` |
| Test helpers | `test/supervisor/helpers.ts` |
| ADR index | `docs/agents/adr/README.md` |

## Chunks (dependency-ordered)

### Chunk 1: R2 module-map cache (replaces SQLite artifact store)

**Depends on:** nothing (current tests stay green throughout)
**Can parallel with:** Chunk 2, Chunk 3

ADR-0034 requires module maps cached in R2, not retained in Supervisor SQLite. The `harness_artifact_modules` table must go.

**Files to create/modify:**
- `src/supervisor/artifacts/r2-cache.ts` — new. R2 get/put keyed by harness commit. Validate on read (parse through `MainHarnessArtifact.parse`). Reject corrupt objects and return cache-miss.
- `src/supervisor/artifacts/index.ts` — replace SQLite `retain`/`get` with R2 read. Keep `mount` but resolve artifacts from R2 instead of SQLite. Remove `harness_artifact_modules` table creation and all SQL in this file.
- `src/supervisor/supervisor.ts` — pass `env.MODULE_MAPS` (R2 bucket) to `HarnessArtifacts` constructor.
- `src/supervisor/env.d.ts` — already declares `MODULE_MAPS: R2Bucket`.
- `src/supervisor/startup-check/index.ts` — the startup-check writes a verified artifact; update to write through R2 instead of SQLite retain.

**Tests:**
- `test/supervisor/artifacts/r2-cache.test.ts` — new. Cache miss returns undefined. Put then get returns parsed artifact. Corrupt R2 object returns cache-miss. Two puts of same commit produce same canonical bytes.
- `test/supervisor/artifacts/r2-validation.test.ts` — new. Schema test: `harness_artifact_modules` table must not exist in Supervisor SQLite after construction.
- Update `test/supervisor/startup-check/startup-check.test.ts` — existing 12 tests must still pass with R2-backed artifacts.
- Update `test/supervisor/active-serving.test.ts` — existing 3 tests must pass.
- Update `test/facet/facet-spike.test.ts` — existing 2 tests must pass.

**Acceptance:** `pnpm verify` passes. A unit test proves the SQLite table is gone. R2 get after put returns the same artifact. Corrupt R2 triggers rebuild path (cache miss).

**Prerequisites:** none.

---

### Chunk 2: Workers AI model route

**Depends on:** nothing
**Can parallel with:** Chunk 1, Chunk 3

Add a fixed Workers AI route that Pi's `streamSimple` can use. The route credential stays outside the mutable facet. The model is `@cf/zai-org/glm-5.3-flash`.

**Files to create/modify:**
- `wrangler.jsonc` — add `ai: { binding: "AI" }` to provide the `env.AI` Workers AI binding.
- `src/supervisor/env.d.ts` — add `AI` binding type.
- `src/model-route/index.ts` — new. Export a `StreamFn` (matching Pi's `StreamFn` type) that uses `createGatewayBindingFetch` from the vendored Pi or directly calls `env.AI.run()`. Since Workers AI has an OpenAI-compatible endpoint, use `streamSimple` with the Workers AI base URL and the `@cf/zai-org/glm-5.3-flash` model. The binding avoids an API key.
- `src/model-route/workers-ai.ts` — new. Wraps the AI binding into a `FetchFunction` or uses `createGatewayBindingFetch`. Configures model name, low reasoning (thinking level "low" or equivalent parameter for this model).

**Tests:**
- `test/model-route/workers-ai.test.ts` — new. Unit test: the stream function produces a valid `AssistantMessageEventStream`. This needs the Workers AI binding in test, so use the `cloudflare:workers` env. If the binding is unavailable in local workerd, test the construction and parameter shape only; mark the live call as a paid-runtime check.
- Existing 188 tests must still pass.

**Acceptance:** `pnpm verify` passes. A test proves the `StreamFn` is constructible with the AI binding and correct model name. The model route does not import or depend on generation state.

**Prerequisites:** Cloudflare account with Workers AI enabled. The `@cf/zai-org/glm-5.3-flash` model must be available.

---

### Chunk 3: Access token verification and tenant routing

**Depends on:** nothing
**Can parallel with:** Chunk 1, Chunk 2

Replace the hardcoded `getByName("facet-spike")` in `src/worker.ts` with identity-derived tenant routing behind Cloudflare Access.

**Files to create/modify:**
- `src/access/verify.ts` — new. Verify the `Cf-Access-Jwt-Assertion` header. Decode the JWT, check `iss` and `aud` against the Access application config. Extract the stable user identity claim (e.g. `sub` or `email`). Return the verified identity or a rejection.
- `src/access/tenant-key.ts` — new. Derive a tenant key from the verified identity and the Access application ID. Hash it (SHA-256). Return the hash hex as the Supervisor/workspace DO name.
- `src/worker.ts` — verify the Access token on every request. Reject unauthenticated requests with 401. Derive the tenant key. Use `env.SUPERVISOR.getByName(tenantKey)` instead of `"facet-spike"`.
- `src/supervisor/env.d.ts` — add any needed Access config (audience, team domain) as env vars or secrets.
- `wrangler.jsonc` — add Access-related secrets/vars if needed.

**Tests:**
- `test/access/verify.test.ts` — new. Missing header → 401. Invalid JWT → 403. Valid JWT extracts identity.
- `test/access/tenant-key.test.ts` — new. Same identity + app ID → same hash. Different identity → different hash.
- `test/worker-routing.test.ts` — new or update existing. Unauthenticated request returns 401. Two different test identities resolve to different Supervisor names. Same identity always reaches same Supervisor.
- Existing 188 tests must still pass (they use `getByName` directly, bypassing the Worker entry).

**Acceptance:** `pnpm verify` passes. No request reaches the Supervisor without a verified Access token. The Worker never accepts a tenant key from the request body or URL.

**Prerequisites:** Cloudflare Access application configured. Access team domain and application audience tag known. Owner's identity provider set up.

---

### Chunk 4: HTTP routes (status, control, sessions, chat)

**Depends on:** Chunk 3 (tenant routing), Chunk 1 (R2 artifacts), Chunk 2 (model route)
**Cannot parallel with any dependency**

Wire the JSON API routes that feature-map.md P3 requires. These go through the Worker entry (after Access verification) and call Supervisor RPC methods.

**Files to create/modify:**
- `src/routes/index.ts` — new. Request router. Parse pathname and method. Dispatch to handler functions.
- `src/routes/status.ts` — new. `GET /api/status` → returns active generation, epoch, latest preparation check.
- `src/routes/generations.ts` — new. `GET /api/generations` → list. `POST /api/generations/submit` → submit-candidate. `POST /api/generations/activate` → activate. `POST /api/generations/rollback` → rollback. Each carries `requestId`, `observedEpoch`, `label` or `harnessCommit`. Principal is always `{ kind: "user" }`.
- `src/routes/sessions.ts` — new. `GET /api/sessions/:sessionId` → get session. `POST /api/sessions/:sessionId/turn` → start turn, run agent, finish turn, return response. This is the chat endpoint.
- `src/routes/recovery.ts` — new. `GET /api/recovery/latest` → latest recovery report.
- `src/worker.ts` — after Access verification and tenant key derivation, route the request through the router instead of forwarding to Supervisor `fetch` directly.

**Tests:**
- `test/routes/status.test.ts` — returns active generation and epoch.
- `test/routes/generations.test.ts` — submit candidate, activate with epoch, rollback, idempotent replay, stale epoch rejection, reused request ID rejection.
- `test/routes/sessions.test.ts` — start turn returns session, stale revision rejected, turn conflict returned.
- `test/routes/recovery.test.ts` — returns latest report.
- Existing tests continue to pass (they call Supervisor RPC directly).

**Acceptance:** `pnpm verify` passes. Every control endpoint requires authentication (from Chunk 3). Repeating a request ID returns the journaled result. A request cannot choose another tenant.

**Prerequisites:** Chunks 1, 2, 3 complete.

---

### Chunk 5: Generation 0 main facet (Pi agent turn)

**Depends on:** Chunk 2 (model route), Chunk 4 (HTTP routes for `POST /api/sessions/:sessionId/turn`)
**Cannot parallel with Chunk 4**

Build the real Generation 0 main facet on the vendored Pi core. This replaces the fixture facet for production use. The fixture stays for tests.

**Files to create/modify:**
- `src/facet/generation-0/main-facet.ts` — new. A `DurableObject` subclass `MainFacet`. On `GET /` returns a cheap deterministic response (startup check). On `POST /turn` (or via RPC from the Supervisor's session turn route): instantiate a Pi `Agent` with the Workers AI `StreamFn` from Chunk 2, provide `createReadTool`, `createWriteTool`, `createEditTool`, `createBashTool`. The `FileSystem` and `Shell` implementations delegate to the Computer workspace (Chunk 6) or to a stub for local testing. Run one agent turn, collect the buffered response, return it.
- `src/facet/generation-0/execution-env.ts` — new. Implement Pi's `ExecutionEnv` / `FileSystem` / `Shell` interfaces. For now, stub implementations that return errors. Computer integration (Chunk 6) fills these in.
- `src/facet/generation-0/build.mts` — new. esbuild script that bundles the Generation 0 facet source into a module map (`MainHarnessArtifactInput`). Entry module exports `MainFacet` as a `DurableObject`. Uses esbuild (already a devDependency).

**Tests:**
- `test/facet/generation-0/startup.test.ts` — new. Load the built module map through `loadMainFacet`. `GET /` returns 200 with a deterministic body.
- `test/facet/generation-0/turn.test.ts` — new. If Workers AI binding is available in test: run one agent turn with a simple prompt. Verify the response contains assistant text. If not available: test the agent construction and tool registration only.
- Existing fixture tests remain unchanged.

**Acceptance:** `pnpm verify` passes. The built module map loads through `loadMainFacet`. `GET /` passes the existing startup check logic. A turn with the Workers AI model returns a buffered response.

**Prerequisites:** Chunk 2 (model route). Workers AI binding available in test environment.

---

### Chunk 6: Computer workspace host

**Depends on:** Chunk 5 (Generation 0 facet needs `FileSystem`/`Shell` implementations)
**Can parallel with:** nothing at this stage

Add the Computer workspace host Durable Object. Implement the `FileSystem` and `Shell` interfaces from Pi against the Computer workspace.

**Files to create/modify:**
- `src/workspace/host.ts` — new. A `DurableObject` subclass `WorkspaceHost`. Uses the pinned Computer pair (source `12336475c9fd03f5280a4537a707797fc0131fbd`, image `ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11b5c9235...`). Provides RPC methods: `readFile`, `writeFile`, `listFiles`, `exec` (shell command), `gitDiff`.
- `src/workspace/computer-fs.ts` — new. Implement Pi's `FileSystem` interface by calling `WorkspaceHost` RPC.
- `src/workspace/computer-shell.ts` — new. Implement Pi's `Shell` interface by calling `WorkspaceHost` RPC.
- `src/facet/generation-0/execution-env.ts` — update stubs to delegate to the Computer-backed implementations.
- `wrangler.jsonc` — add `WorkspaceHost` DO binding, Computer binding/configuration.
- `src/supervisor/env.d.ts` — add `WORKSPACE_HOST: DurableObjectNamespace<WorkspaceHost>`.
- `src/worker.ts` — derive workspace host name from tenant key (same as Supervisor).

**Tests:**
- `test/workspace/host.test.ts` — new. Read/write file round-trip. Shell exec returns output. These need the Computer binding in test; if unavailable locally, mark as paid-runtime checks.
- `test/facet/generation-0/integration.test.ts` — new. Full turn: agent reads a file, edits it, runs a command, returns diff and output. Paid-runtime check.
- Existing tests unaffected.

**Acceptance:** `pnpm verify` passes (local tests). Paid-runtime probe: file survives workspace host eviction. Computer failure becomes a tool error, not a facet crash.

**Prerequisites:** Paid Cloudflare account. Computer image available. Chunk 5 complete.

---

### Chunk 7: Codex OAuth sign-in (owner-only)

**Depends on:** Chunk 3 (Access verification), Chunk 4 (HTTP routes)
**Can parallel with:** Chunks 5, 6

Implement the owner-only Codex/ChatGPT OAuth PKCE flow as described in `.audit/research/openai-chatgpt-login-workers-ai.md`. This is the preferred model route after Workers AI proves the path.

**Files to create/modify:**
- `src/auth/codex-oauth.ts` — new. PKCE authorization-code flow against `auth.openai.com`. Custom HTTPS callback at the Worker (e.g. `GET /auth/openai/callback`). Exchange code for access/refresh tokens. Store refresh token encrypted in Supervisor SQLite (not in browser, not in logs, not in cookies).
- `src/auth/token-store.ts` — new. Encrypted token storage in Durable Object storage. Atomic rotate/overwrite. Revocation/logout.
- `src/model-route/codex.ts` — new. `StreamFn` that calls the Codex Responses backend at `https://chatgpt.com/backend-api` with bearer token + account ID. Refresh before expiry.
- `src/routes/auth.ts` — new. `GET /auth/openai/start` → redirect to OpenAI authorize endpoint with PKCE. `GET /auth/openai/callback` → exchange code, store token. Both Access-protected.
- `src/worker.ts` — add auth routes before tenant routing.

**Tests:**
- `test/auth/codex-oauth.test.ts` — new. PKCE verifier generation. State parameter validation. Token storage round-trip (encrypted write, read, rotate).
- `test/auth/callback.test.ts` — new. Invalid state rejected. Missing code rejected. Successful exchange stores token.
- Existing tests unaffected.

**Acceptance:** `pnpm verify` passes. Owner can initiate the OAuth flow, complete the callback, and the token is stored encrypted. The Codex `StreamFn` is constructible. Live call is a paid/manual check.

**Prerequisites:** OpenAI Codex client ID. Qualifying ChatGPT subscription. Chunk 3 complete.

---

### Chunk 8: Tenant page

**Depends on:** Chunk 4 (HTTP routes), Chunk 5 (Generation 0 facet)
**Can parallel with:** Chunks 6, 7

One no-framework HTML page served by the Worker.

**Files to create/modify:**
- `src/page/index.html` — new. Plain HTML + inline JS. Chat input/output. Active generation display. Candidate submission form. Activate/rollback buttons with epoch. Latest recovery report. Session selector.
- `src/routes/page.ts` — new. `GET /` serves the HTML page (or `GET /app`). Differentiate from `GET /` startup check by Accept header or path.
- `src/worker.ts` — route page requests.

**Tests:**
- `test/routes/page.test.ts` — new. `GET /` with browser Accept header returns HTML. `GET /` without (startup check) returns plain text.
- Manual: open page in browser, verify chat works, generation controls visible.

**Acceptance:** `pnpm verify` passes. Page shows active generation and epoch. Chat sends a turn and displays the response.

**Prerequisites:** Chunks 4, 5 complete.

---

## Parallelism summary

```
Phase 1 (parallel):  Chunk 1 (R2)  |  Chunk 2 (Workers AI)  |  Chunk 3 (Access)
                          \               |                    /
Phase 2:                   \______________|___________________/
                                    Chunk 4 (HTTP routes)
                                          |
Phase 3 (parallel):       Chunk 5 (Gen-0 facet)   |   Chunk 7 (Codex OAuth)
                                |
Phase 4 (parallel):  Chunk 6 (Computer)  |  Chunk 8 (Tenant page)
```

Chunks 1, 2, 3 have zero inter-dependencies and can execute simultaneously.
Chunk 4 waits for all three.
Chunk 5 needs Chunks 2 and 4.  Chunk 7 needs Chunks 3 and 4 — these two can run in parallel.
Chunk 6 needs Chunk 5.  Chunk 8 needs Chunks 4 and 5.  Chunks 6 and 8 can run in parallel.
Chunk 7 can run in parallel with Chunks 5, 6, and 8 since it only needs Chunks 3 and 4.

## External prerequisites (all chunks)

| Prerequisite | Chunks |
|---|---|
| Paid Cloudflare account with Workers AI, R2, Durable Objects, Dynamic Workers | All |
| `@cf/zai-org/glm-5.3-flash` model available on Workers AI | 2, 5 |
| Cloudflare Access application configured with owner-only Allow policy | 3, 4, 7, 8 |
| Access audience tag and team domain | 3 |
| Computer source `12336475c9fd` + image pair available | 6 |
| OpenAI Codex client ID + qualifying ChatGPT subscription | 7 |
| Custom domain on Cloudflare zone (for Access self-hosted app) | 3 |

## Notes

- The fixture facet (`src/facet/fixture.ts`) stays for existing tests. Production path uses the Generation 0 module map.
- ADR-0035 (better-result inside process boundaries only): all new route handlers return plain JSON objects, not Result types.
- ADR-0036 (pure decisions, imperative shells): new route handlers follow this pattern — pure validation/decision functions, thin handler shells.
- ADR-0028 (module maps): Generation 0 build produces a `MainHarnessArtifactInput`.
- ADR-0029 (startup check): Generation 0 facet's `GET /` must return status < 400 with bounded body.
- The Supervisor name `"facet-spike"` is replaced by the tenant key hash in Chunk 3.
- `docs/agents/design/worker-previews.md` records the Worker Previews private beta; it stays test infrastructure and is not part of the production deployment path.
