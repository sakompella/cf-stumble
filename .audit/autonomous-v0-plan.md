# Autonomous v0 implementation plan

Revised 2026-09-03 (fourth pass). Supersedes `.audit/v0-implementation-plan.md`.

Current verified state before the product decisions below: commit `8c582ad`; 63 test files and 428
tests pass. Cloudflare Access exists for `stumble.akompella.dev`; GitHub becomes its version 0
identity provider. The current code still implements one fixed workspace, manually named sessions, a
buffered hand-written turn loop, and disabled Computer egress. Those are implementation gaps, not
the target design.

Demo repo: `https://github.com/earendil-works/pi`. Demo command: `./test.sh`. Both are ephemeral prompt inputs, not hardcoded.

## Owner-approved product decisions after the fourth pass

ADRs 0037 through 0039 and the current `docs/agents/design/feature-map.md` supersede every
conflicting statement later in this plan:

- Version 0 reuses the vendored Pi core and streams Pi text, tool calls, and tool results to the
  browser. The buffered hand-written turn loop is scaffolding.
- The user connects GitHub repositories as projects and selects them from a collapsible left
  sidebar. Each project has one current Pi thread and one isolated Computer workspace.
- Starting a fresh thread resets Pi conversation and compacted context but preserves project files.
- GitHub-backed Cloudflare Access authenticates the user. Connected project workspaces keep GitHub
  credentials in normal local `gh` configuration outside the repository.
- Computer project workspaces have unrestricted internet access and ordinary development tools,
  including `git` and `gh`. Egress restrictions, credential brokers, and workstation hardening are
  deferred.
- The runtime-managed Pi `AGENTS.md` tells Pi that `git`, `gh`, and internet access are available,
  that it should follow the user's request and repository conventions, and that it must never print
  or commit authentication tokens.

The implementation plan must replace session routes with project-thread routes, define terminal
stream completion and browser-disconnect behavior, derive one Workspace Host identity per project,
and replace the current no-egress Computer configuration. Do not execute a contradictory step from
the older phase text below.

## Constraints

1. `pnpm verify` stays green after every commit. No test makes a paid or nondeterministic request.
2. Tracked files change only with owner approval; see the approval policy below.
3. Run paid probes before writing code that assumes their result.
4. No credential exposure. Tokens, secrets, Access assertions, and OAuth state never appear in logs, URLs, browser JS, tracked files, or agent messages.

## Approval policy

Owner approval of this revised plan authorizes all local tracked code edits and local `pnpm verify` runs in P1 through P6. Those are autonomous.

The following require explicit owner confirmation at runtime:

- Any paid Cloudflare call, deployment, container start, or resource deletion (the probe gates in P0, P4, P4b, and P5).
- Final production deployment (P7).
- The recorded demo (P7).

## Phases

| Phase | Kind | Depends on | What it proves |
|-------|------|------------|----------------|
| P0 | Autonomous + owner gate | — | Paid runtime accepts the full capability chain |
| P1 | Autonomous | P0 | Access verification (cryptographic) routes to the owner's Supervisor |
| P3 | Autonomous | P0 | Generation 0 main facet runs a Pi tool-calling turn (deterministic fake) |
| P4 | Autonomous + owner gate | P3 | Computer workspace host; scoped capability through facet |
| P4b | Autonomous + owner gate | P4 | Commit-to-module-map build, R2 cache, and load cycle |
| P2 | Autonomous | P1, P4b | HTTP routes; submission calls the resolver that now exists |
| P5 | Autonomous + owner gate | P2, P3, P4, P4b | Six-step backend rehearsal on the paid account |
| P6 | Autonomous | P5 | Single tenant page (renders diff and exit code) |
| P7 | Owner gate | P6 | Deploy, timed recording, stop |

Codex/ChatGPT login is deferred research, not a phase. Workers AI is the only v0 model route. If the owner later wants to probe the Codex redirect URI, the existing Access verification and owner-only policy make it safe to add a minimal one-off route. That work is outside this plan.

---

## Repository identity

Two repositories matter. Their commits are never interchangeable.

| Repository | Purpose | Example resolved SHA |
|------------|---------|---------------------|
| `sakompella/cf-stumble` | Harness source. A labeled commit becomes a generation. Worker Loader uses the cf-stumble commit as its identity key. | The current HEAD or a tagged commit in this repo |
| `cloudflare/computer` | Vendored dependency. Pinned at source commit `12336475c9fd03f5280a4537a707797fc0131fbd`. | `12336475c9fd03f5280a4537a707797fc0131fbd` |

The Computer source SHA is a dependency pin, not a harness commit. The checkout-and-build path (P4b) checks out a cf-stumble harness commit. Worker Loader loads the built module map under that cf-stumble commit's SHA. No code path uses the Computer source SHA as a Worker Loader identity or generation label.

---

## The model route contract

The immutable `src/model-route.ts` owns the model ID, reasoning effort, endpoint, and credentials. No mutable facet code can override those values.

The current `ModelRoute.run({ prompt })` contract is too narrow for Pi tool-calling turns. P3 widens it to a validated closed message union:

```ts
// Closed message union — the only message shapes the route accepts.
type SystemMessage   = Readonly<{ role: "system";    content: string }>;
type UserMessage     = Readonly<{ role: "user";      content: string }>;
type AssistantMessage = Readonly<{
  role: "assistant";
  content: string | null;
  tool_calls?: ReadonlyArray<Readonly<{
    id: string;
    function: Readonly<{ name: string; arguments: string }>;
  }>>;
}>;
type ToolResultMessage = Readonly<{
  role: "tool";
  tool_call_id: string;
  content: string;
}>;

type RouteMessage = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

// Request (facet → immutable route). Carries conversation and tool definitions only.
type ModelRouteRequest = Readonly<{
  messages: ReadonlyArray<RouteMessage>;
  tools?: ReadonlyArray<Readonly<{
    type: "function";
    function: Readonly<{ name: string; description: string; parameters: object }>;
  }>>;
}>;

// Response (immutable route → facet).
type ModelRouteResponse =
  | Readonly<{ ok: true; message: AssistantMessage }>
  | Readonly<{ ok: false; error: Readonly<{ code: "model-unavailable" }> }>;
```

The `ModelRoute` service binding validates the request against this union, adds the fixed model ID (`@cf/zai-org/glm-5.3-flash`) and reasoning effort (`low`), calls `env.AI`, and normalizes the response into an `AssistantMessage`. The facet-side adapter in `src/facet/generation-0/workers-ai-adapter.ts` only translates between Pi events and this contract. It cannot select a model, provider, URL, credential, or reasoning level.

P0 and P3 both test this exact contract. P3 builds the second model request (after a tool result) through the public `ModelRouteRequest` containing an `AssistantMessage` with `tool_calls` followed by a `ToolResultMessage` with the matching `tool_call_id`, and verifies the route processes it correctly.

---

## Deploy-time configuration

Access configuration values come from deployed Worker vars and secrets, never from tracked `wrangler.jsonc` or browser code.

| Value | Source at deploy time | How |
|-------|----------------------|-----|
| `CF_ACCESS_AUD` | Cloudflare Access application audience tag | `wrangler secret put CF_ACCESS_AUD` or `--var` in deploy command |
| `CF_ACCESS_TEAM_DOMAIN` | Cloudflare Access team domain (e.g. `akompella.cloudflareaccess.com`) | `wrangler secret put CF_ACCESS_TEAM_DOMAIN` or `--var` in deploy command |
| `CF_ACCESS_OWNER_SUB` | Owner's stable subject claim from Access identity provider | `wrangler secret put CF_ACCESS_OWNER_SUB` |

The deploy scripts in P0, P5, and P7 must fail before deployment when any of these values is absent. The Worker reads them from `env` at runtime and never logs them. The `.env` file stays untracked and is used only for local development reference.

---

## Computer dependency

Computer source commit `12336475c9fd03f5280a4537a707797fc0131fbd` is unreleased `@cloudflare/computer` 0.3.0 (npm `latest` is 0.2.1). The project obtains it as a vendored tarball built in a separate workspace:

1. Clone `cloudflare/computer` into a temporary build directory **outside** the cf-stumble tree.
2. Check out exactly `12336475c9fd03f5280a4537a707797fc0131fbd`.
3. Run `npm ci` to install dependencies.
4. Run the package build (the workspace build script that produces `dist/`).
5. Run `npm pack --workspace @cloudflare/computer` to produce the tarball.
6. Verify the packed tarball contains the expected exported `dist/` files (at minimum `dist/index.js` and `dist/index.d.ts`).
7. Copy the tarball to `vendor/cloudflare-computer-0.3.0.tgz` in the cf-stumble tree.
8. Add to `package.json`: `"@cloudflare/computer": "file:vendor/cloudflare-computer-0.3.0.tgz"`.
9. Lock in `pnpm-lock.yaml`.
10. Record the tarball SHA-256 checksum in `.audit/evidence/computer-tarball-checksum.txt`.
11. A reproducibility command re-derives the tarball in a fresh clone and compares checksums.

Full image digest: `ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11b5c9235ecd7ba7a4d9a4bbad52e8fd4366d76ee3dbfa1099c9295c6f`.

All plan references use the full source commit and full image digest. No truncated pins.

---

## Turn response contract

The turn operation returns structured evidence, not opaque text. The facet returns:

```ts
type TurnResult = {
  document: SessionDocument;    // opaque saved conversation
  text: string;                 // assistant's final text
  commands: ReadonlyArray<{
    command: string;            // e.g. "./test.sh"
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
};
```

After the facet returns, the immutable turn operation obtains `gitDiff` from the workspace and includes it in the response to the client:

```ts
type TurnResponse = {
  text: string;
  diff: string;                 // git diff output
  commands: ReadonlyArray<{ command: string; stdout: string; stderr: string; exitCode: number }>;
  sessionRevision: number;
};
```

P3 tests the schema with a deterministic fake. P5 asserts `diff` is present and `./test.sh` exit code is 0. P6 renders the diff and exit code on the page. P7 shows them in the recording.

---

## Paid probe security and cleanup protocol

Every deployed probe is protected. Since Access verification exists after P1, probes deployed after P1 use the same owner-only Access policy. P0 (deployed before P1 exists) uses a single-run secret: the deploy script generates a random bearer token, sets it as a Worker secret, and the probe rejects requests without that token. The token is never logged or saved to evidence files.

Cleanup follows a fixed order and tracks exact resources:

1. **Track run-owned resources.** Each probe records the exact R2 keys it writes and the exact container application IDs it creates (from `wrangler containers list` output after deploy). These go into a run manifest file (e.g. `.audit/probes/p0/manifest-<timestamp>.json`).
2. **Delete in order:** workspace and Durable Object data first (through the still-running Worker's exposed cleanup endpoint), then the Worker itself.
3. **Delete only tracked resources.** The cleanup script deletes only R2 keys listed in the manifest (using `wrangler r2 object delete <bucket> <key>` for each) and only container application IDs listed in the manifest. It never uses bulk listing as a deletion source.
4. **Rerunnable.** Running cleanup twice is safe; deleting an already-absent key succeeds silently.
5. **Verify.** After cleanup, confirm each manifest entry is gone. Save result to `.audit/evidence/<phase>/cleanup.log`. Fail the probe if any tracked resource remains.
6. **`trap`/`finally`.** Cleanup runs on success or failure.

---

## P0: paid probe — full capability chain

**Kind:** Autonomous code. Owner gate: owner approves deploy and cleanup.

Confirm the paid runtime accepts the full chain the demo needs.

### Probe security

P0 deploys before Access verification exists. The deploy script generates a random bearer token, sets it as a Worker secret (`PROBE_SECRET`), and the probe rejects any request whose `Authorization: Bearer <token>` header does not match. The token is not logged or saved.

### Steps

1. Create a self-contained probe in `.audit/probes/p0/`. Unique Worker name: `cf-stumble-probe-p0-<timestamp>`.
   - The probe has an immutable host DO that owns `env.AI` and `env.COMPUTER`. It creates a facet through Worker Loader, passing only a fixed model capability (`Fetcher<ModelRoute>`) and a scoped workspace capability. `globalOutbound` is `null`.
   - **Model route contract test:** The facet sends a `ModelRouteRequest` with messages (including the closed message union types) and a tool definition. The `ModelRoute` adds the fixed model and reasoning effort, calls `env.AI`. The probe asserts the response contains at least one `tool_call` in the `AssistantMessage`. The facet cannot override model, effort, URL, or credentials.
   - **Computer build:** Computer checks out a cf-stumble harness commit (a real commit from `sakompella/cf-stumble`, not the Computer source SHA), runs one fixed build command, produces a module map. R2 caches it under a run-specific key. Worker Loader loads it under that cf-stumble commit ID. The loaded facet responds to `GET /`.
   - **File persistence:** The facet writes a file through the workspace capability. The probe forces a controlled redeploy (recording deployment IDs before and after). The facet reads the file back.
   - **Outbound denial:** The facet attempts `fetch("https://example.com")` and the probe asserts it fails.
   - Returns JSON report: `model_tool_call_ok`, `computer_build_ok`, `r2_cache_ok`, `loader_ok`, `file_survives_redeploy`, `outbound_denied`, deployment IDs, and timings.
2. Write `wrangler.jsonc` in the probe directory. Full pins: Computer source `12336475c9fd03f5280a4537a707797fc0131fbd`, image `ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11b5c9235ecd7ba7a4d9a4bbad52e8fd4366d76ee3dbfa1099c9295c6f`. R2 bucket `cf-stumble-module-maps`, AI binding, DO, Worker Loader.
3. Deploy scripts must fail before deployment when `CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`, or `CF_ACCESS_OWNER_SUB` is absent.
4. The probe records exact R2 keys written and exact container application IDs created into a run manifest. Cleanup follows the protocol above: workspace/DO data first (via Worker cleanup endpoint), then Worker deletion, then verify each manifest entry is gone.

### Owner gate

Owner reviews the script and confirms deploy + cleanup.

### Acceptance

`.audit/evidence/p0/probe-result.json` has all fields `true` with timing and deployment IDs. `.audit/evidence/p0/cleanup.log` shows all manifest entries gone.

### Failure

If any link fails, record the error and stop. The design needs revision.

---

## P1: Access verification and owner routing

**Kind:** Autonomous.

The Worker verifies the Access JWT cryptographically and routes accepted requests to one server-owned Supervisor name and one server-owned workspace name.

### Steps

1. `src/access/verify.ts` — verify `Cf-Access-Jwt-Assertion`:
   - Fetch the JWKS from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`.
   - Verify the JWT signature against the JWKS. Enforce RS256.
   - Check `iss` matches `env.CF_ACCESS_TEAM_DOMAIN`, `aud` includes `env.CF_ACCESS_AUD`, `sub` matches `env.CF_ACCESS_OWNER_SUB`.
   - Enforce `exp` (expiry) and `nbf` (not-before).
   - Return the verified identity or a 401 rejection. Never log the assertion.
2. `src/access/tenant-key.ts` — derive DO names. SHA-256 hash of (verified identity claim + application AUD). Return the hex string. The Access policy admits only the owner, so only one key is ever produced in v0, but the derivation itself stays because the feature map requires it.
3. Update `src/worker.ts`:
   - Verify on every request. 401 for missing or invalid assertion.
   - Derive the tenant key from the verified identity.
   - `env.SUPERVISOR.getByName(tenantKey)` and `env.WORKSPACE_HOST.getByName(tenantKey)`.
   - Disable the `workers.dev` route in `wrangler.jsonc`.
4. Update `src/supervisor/env.d.ts` — declare `CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_OWNER_SUB` as env types. These are deployed as Worker vars/secrets (see deploy-time configuration section above), not committed to `wrangler.jsonc`.
5. Tests (deterministic, signed fixtures):
   - `test/access/verify.test.ts` — valid owner token → identity extracted. Wrong subject → 401. Wrong key → 401. Wrong issuer → 401. Wrong audience → 401. Expired token → 401. Not-yet-valid token → 401. Missing header → 401.
   - `test/access/tenant-key.test.ts` — same identity + AUD → same hash. Different identity → different hash.
   - `test/worker-routing.test.ts` — unauthenticated → 401. Valid owner → reaches Supervisor.
6. Existing 194 tests stay green.

### Acceptance

`pnpm verify` passes. No request reaches the Supervisor without a cryptographically verified token. The assertion is never logged. AUD, team domain, and owner subject come from env, not from the request or tracked config.

### Rollback

Revert commits. Existing tests bypass the Worker entry.

---

## P3: Generation 0 main facet with immutable-route adapter

**Kind:** Autonomous.

**Depends on:** P0 (confirms the model route contract works on paid runtime).

Build the real Generation 0 facet on vendored Pi. The facet-side adapter maps Pi events to/from the `ModelRoute` contract. The immutable `src/model-route.ts` owns model, effort, endpoint, and credentials. No new abstraction layer.

### Steps

1. Widen `src/model-route.ts`:
   - Replace `run({ prompt })` with `run(request: ModelRouteRequest): Promise<ModelRouteResponse>`.
   - Validate incoming messages against the closed `RouteMessage` union. Reject messages with unexpected roles.
   - `ModelRoute` adds the fixed model ID and reasoning effort, calls `env.AI`, normalizes tool calls into the `AssistantMessage` response.
   - The caller cannot override model, provider, URL, credential, or reasoning level. The request carries only `messages` and `tools`.
   - Keep the existing service-binding boundary (`WorkerEntrypoint`).
2. `src/facet/generation-0/workers-ai-adapter.ts` — facet-side adapter:
   - Translates between Pi events and `ModelRouteRequest`/`ModelRouteResponse`.
   - Calls `env.MODEL.run(request)` through the service binding.
   - Cannot select model, provider, URL, credential, or reasoning level.
3. `src/facet/generation-0/main-facet.ts` — `DurableObject` subclass `MainFacet`.
   - `GET /` returns a cheap deterministic response (ADR-0029).
   - `POST /turn` receives `{ prompt, document }`, runs a Pi `Agent` turn with the adapter, returns `{ document, text, commands }` where `commands` has `{ command, stdout, stderr, exitCode }` for each shell invocation.
   - Tools: `createReadTool`, `createWriteTool`, `createEditTool`, `createBashTool` from vendored Pi.
   - `FileSystem` and `Shell` initially stub to error (P4 fills them in).
   - Receives only a scoped model capability and a scoped workspace capability through `MainFacetCapabilities`, not raw bindings.
4. `src/facet/generation-0/build.mts` — esbuild script producing a `MainHarnessArtifactInput` (module map per ADR-0028).
5. Tests (**deterministic fake**, no paid/nondeterministic calls):
   - `test/model-route.test.ts` — update existing tests:
     - `ModelRouteRequest` with `SystemMessage`, `UserMessage`, and `tools` → response with `AssistantMessage` containing `tool_calls`.
     - **Second request through the public contract:** a `ModelRouteRequest` whose `messages` include the prior `AssistantMessage` (with `tool_calls`) followed by a `ToolResultMessage` (with matching `tool_call_id`) → response with a final `AssistantMessage`.
     - Request with an unexpected role → rejected.
     - Caller cannot override model or effort.
   - `test/facet/generation-0/adapter.test.ts` — deterministic fake: model call → tool call response → tool result sent → second model call → final text. Verify the adapter only translates and never overrides provider config.
   - `test/facet/generation-0/startup.test.ts` — load built module map through `loadMainFacet`, `GET /` returns 200.
   - `test/facet/generation-0/turn.test.ts` — deterministic fake: full turn with read → edit → bash → final answer. Response matches `TurnResult` schema with structured `commands`.
6. Fixture facet stays for existing Supervisor tests.

### Acceptance

`pnpm verify` passes. Module map loads. `GET /` passes startup check. Deterministic-fake turn produces expected tool-call loop, final text, and structured commands. Second model request built through the public contract with `AssistantMessage` + `ToolResultMessage`. No caller can override model or effort.

### Rollback

Revert commits.

---

## P4: Computer workspace host with scoped capability

**Kind:** Autonomous code. Owner gate for paid verification.

**Depends on:** P3.

Add `WorkspaceHost` DO using the pinned Computer pair. Thread the scoped workspace capability through `MainFacetCapabilities`, `loadMainFacet`, `HarnessArtifacts.mount`, and the startup check. The facet never receives a raw namespace or the session store.

### Steps

1. `src/workspace/host.ts` — `DurableObject` subclass `WorkspaceHost`.
   - Export name: `WorkspaceHost` in `wrangler.jsonc` under `durable_objects.bindings`.
   - Durable Object migration: add `WorkspaceHost` to `new_sqlite_classes` in a new migration tag.
   - Full Computer pins: source `12336475c9fd03f5280a4537a707797fc0131fbd`, image `ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11b5c9235ecd7ba7a4d9a4bbad52e8fd4366d76ee3dbfa1099c9295c6f`.
   - RPC: `readFile`, `writeFile`, `listFiles`, `exec`, `gitDiff`.
2. `src/workspace/computer-fs.ts` — Pi `FileSystem` backed by `WorkspaceHost` RPC.
3. `src/workspace/computer-shell.ts` — Pi `Shell` backed by `WorkspaceHost` RPC.
4. Update Generation 0 facet to accept a scoped workspace capability through `MainFacetCapabilities` and delegate `FileSystem`/`Shell` to it.
5. Update `wrangler.jsonc`:
   - Add `WorkspaceHost` DO binding.
   - Add `containers` configuration for Computer with the full image digest.
   - Add migration for `WorkspaceHost`.
6. Update `src/supervisor/env.d.ts` — add `WORKSPACE_HOST: DurableObjectNamespace<WorkspaceHost>`.
7. Update `src/worker.ts` — derive workspace host name from the same tenant key.
8. Thread the scoped workspace capability through `MainFacetCapabilities`, `loadMainFacet`, `HarnessArtifacts.mount`, and `checkGenerationStartup`. The facet receives workspace access only through this capability.
9. Computer dependency: use the vendored tarball (see Computer dependency section above).
10. Paid probe: unique Worker name `cf-stumble-probe-p4-<timestamp>`. Protected by owner-only Access (P1 is complete). Probe records exact R2 keys and container app IDs into a manifest.
    - Deploy, test read/write round-trip, exec, gitDiff.
    - **Controlled redeploy test:** write a file, redeploy (record deployment IDs before and after), read the file back.
    - Cleanup: workspace/DO data first via Worker endpoint, then Worker deletion. Delete only manifest-listed R2 keys (`wrangler r2 object delete`) and manifest-listed container app IDs. Verify each entry gone.
11. Tests (local, deterministic):
    - `test/workspace/host.test.ts` — read/write round-trip, exec returns output. If Computer unavailable locally: skip with reason, not in `pnpm verify`.
12. Existing tests stay green.

### Owner gate

Owner approves paid probe deploy and cleanup.

### Acceptance

`pnpm verify` passes locally. Paid probe: file survives controlled redeploy with recorded deployment IDs. Computer failure becomes a tool error, not a facet crash. Cleanup log shows all manifest entries gone.

### Rollback

Revert commits. Remove `WorkspaceHost` from `wrangler.jsonc`.

---

## P4b: commit-to-module-map build cycle

**Kind:** Autonomous code. Owner gate for paid verification.

**Depends on:** P4.

Implement the ADR-0034 cache-miss path. This phase must complete before P2 so the submit route can call the resolver.

### Steps

1. Implement the module-map resolver in the Supervisor or build coordinator:
   - On cache miss: check out the exact labeled cf-stumble harness commit (not the Computer source SHA) in a **build workspace** separate from the project workspace. Run one fixed build command (the same esbuild script from P3). Validate and canonicalize the module map. Cache in R2 under that cf-stumble commit ID. Load through Worker Loader under that same cf-stumble commit ID.
   - On cache hit: load from R2.
   - On corrupt R2 object: rebuild.
2. Replace the production fixture seed: the deploy setup materializes, checks, and activates Generation 0 from the real Generation 0 cf-stumble commit. No production file imports `src/facet/fixture.ts`. The fixture stays only in test files.
3. Paid probe: unique Worker name `cf-stumble-probe-p4b-<timestamp>`. Protected by owner-only Access. Probe records exact R2 keys and container app IDs into a manifest.
   - Deploy, submit a cf-stumble commit, verify build → cache → load → startup check.
   - Cleanup: workspace/DO data first via Worker endpoint, then Worker deletion. Delete only manifest-listed resources. Verify each entry gone.
4. Tests (local, deterministic):
   - Cache miss → build → validate → cache → load succeeds.
   - Cache hit → load from R2 without rebuild.
   - Corrupt R2 object → rebuild.
   - Two builds of the same cf-stumble commit produce the same canonical module map. If they differ, stop — ADR-0034's assumption is disproved.
   - Failed build leaves the active generation serving.
   - Schema test: no production `src/` file imports `src/facet/fixture.ts` (test files may).
5. Existing tests stay green.

### Owner gate

Owner approves paid probe deploy and cleanup.

### Acceptance

`pnpm verify` passes. Paid probe confirms the full build → cache → load → startup check cycle using a cf-stumble commit. Cleanup log shows all manifest entries gone.

### Failure

If two builds of the same commit produce different output, stop. ADR-0034 needs revision.

### Rollback

Revert commits. The fixture-based path still works for tests.

---

## P2: HTTP routes with submission-triggered materialization

**Kind:** Autonomous.

**Depends on:** P1 and P4b. The submit route calls the module-map resolver that P4b implements.

Wire JSON endpoints. Submission triggers materialization and startup checking. Only the endpoints that P5 and P7 actually exercise are built.

### Endpoints

| Method | Path | P5/P7 use |
|--------|------|-----------|
| `GET` | `/api/status` | P5 step a, P7 action 1 |
| `POST` | `/api/generations/submit` | P5 steps c/e, P7 actions 3/5 |
| `POST` | `/api/generations/activate` | P5 step d, P7 action 4 |
| `POST` | `/api/generations/rollback` | P5 step f, P7 action 6 |
| `GET` | `/api/sessions/:sessionId` | P7 action 7 |
| `POST` | `/api/sessions/:sessionId/turn` | P5 step b, P7 action 2 |
| `GET` | `/api/recovery/latest` | P6 page display |

No other endpoints are added.

### Steps

1. `src/routes/index.ts` — router by pathname and method.
2. `src/routes/status.ts` — `GET /api/status` → active generation, epoch.
3. `src/routes/generations.ts`:
   - `POST /api/generations/submit` — accepts `{ requestId, harnessCommit }`. Labels the commit (a cf-stumble commit, not the Computer source SHA), invokes the P4b module-map resolver (build on cache miss, load from R2 on hit), runs the bounded startup check (ADR-0029), records the preparation result, and returns it. The active generation continues serving throughout. No `observedEpoch` on submission (per ADR-0030).
   - `POST /api/generations/activate` — accepts `{ requestId, observedEpoch, label }`. Epoch-checked activation.
   - `POST /api/generations/rollback` — accepts `{ requestId, observedEpoch, label }`. Epoch-checked rollback.
4. `src/routes/sessions.ts`:
   - `GET /api/sessions/:sessionId` — returns the saved session document and revision.
   - `POST /api/sessions/:sessionId/turn` — the session-aware turn operation:
     a. Accepts `{ prompt, expectedRevision }`.
     b. Takes the Supervisor session lease for `sessionId`.
     c. Loads the saved session document (or empty for a new session).
     d. Sends `{ prompt, document }` to the active facet's `POST /turn`.
     e. Receives `{ document, text, commands }` from the facet.
     f. Obtains `gitDiff` from the workspace.
     g. Commits the new document with the next revision.
     h. Returns `{ text, diff, commands, sessionRevision }`.
     i. On mount, model, tool, or facet failure: releases the lease without advancing the revision.
5. `src/routes/recovery.ts` — `GET /api/recovery/latest`.
6. Update `src/worker.ts` to route after Access verification.
7. Tests:
   - Status returns generation and epoch.
   - **Submission tests:** submit with a passing cf-stumble commit → resolver builds, startup check succeeds, active generation unchanged. Submit with a broken commit → startup fails, active generation unchanged. Submit returns the preparation result.
   - Activate with epoch, rollback, idempotent replay, stale epoch rejection, reused request ID with different command fails. No `observedEpoch` on submit.
   - **Turn tests:** first turn on new session → saves document, returns `{ text, diff, commands, sessionRevision }`. A generation activation occurs. Second turn receives first turn's saved document as input. Failed turn releases lease without advancing revision. Stale `expectedRevision` → conflict.
   - **Response schema test:** turn response matches the `TurnResponse` type.
   - Recovery report.
8. Existing tests stay green.

### Acceptance

`pnpm verify` passes. Submission triggers the resolver + startup check. Every endpoint requires authentication. Conversation continuity across activation is tested. The submit route calls the resolver that P4b built.

### Rollback

Revert commits.

---

## P5: six-step backend rehearsal

**Kind:** Autonomous code. Owner gate: owner approves deploy and cleanup.

**Depends on:** P2, P3, P4, P4b.

Run the demo backend on the paid account with `curl`. The page does not exist yet.

### Probe security

Protected by owner-only Access (P1 is deployed).

### Steps

1. Prepare a deploy-rehearsal-cleanup script in `.audit/probes/p5/`. Unique Worker name: `cf-stumble-rehearsal-<timestamp>`.
2. Deploy scripts fail before deployment when `CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`, or `CF_ACCESS_OWNER_SUB` is absent.
3. Probe records exact R2 keys written and exact container app IDs created into a manifest.
4. **Setup** (outside timed run):
   - Deploy the Worker with all bindings.
   - Clone `https://github.com/earendil-works/pi` into the Computer workspace.
   - Install dependencies, confirm `./test.sh` runs clean.
   - Materialize, check, and activate Generation 0 from a real cf-stumble commit.
   - Prepare a second cf-stumble harness commit and a broken cf-stumble harness commit.
5. **Six-step rehearsal** (timed):
   a. `GET /api/status` → active generation visible. Record generation label and epoch.
   b. `POST /api/sessions/:id/turn` with a small edit task → response contains `diff` (non-empty string), `commands` array with an entry where `command` contains `./test.sh` and `exitCode` is `0`, and `sessionRevision`. Record session revision.
   c. Submit the second cf-stumble harness commit → response contains passing preparation result. Assert: active generation label unchanged.
   d. Activate the passing candidate with epoch check. `POST /api/sessions/:id/turn` with a follow-up → response contains first turn's context (session document carries history). Assert: session revision advanced. Record project file SHA-256 hash.
   e. Submit the broken cf-stumble commit → response contains failing preparation result. Assert: active generation label unchanged.
   f. Rollback to the earlier generation. `GET /api/sessions/:id` → session document still contains both turns. Compute project file SHA-256 hash and assert unchanged from step d.
6. **Structured evidence** in `.audit/evidence/p5/`:
   - `rehearsal.json`: each step's request, response status, timing, generation label, epoch, session revision, project file SHA-256 hash, command exit codes. No secrets or tokens.
   - `cleanup.log`: all manifest entries verified gone.
7. Cleanup: workspace/DO data first via Worker cleanup endpoint, then Worker deletion. Delete only manifest-listed R2 keys and container app IDs. Rerunnable. Verify each entry gone. Fail probe if any remains.

### Owner gate

Owner reviews the script, approves deploy + cleanup, confirms evidence.

### Acceptance

All six steps pass their assertions. `.audit/evidence/p5/rehearsal.json` is complete. Cleanup log shows all manifest entries gone.

### Failure

If conversation or project state does not survive a generation change, record the failure and stop.

---

## P6: tenant page

**Kind:** Autonomous.

**Depends on:** P5.

One no-framework HTML page. Renders the diff and `./test.sh` exit code from turn responses.

### Steps

1. `src/page/index.html` — plain HTML + inline JS:
   - Chat input/output. Displays `text` from turn response.
   - Renders `diff` in a preformatted block.
   - Renders each `commands` entry: command text, exit code, stdout/stderr.
   - Active generation display with epoch.
   - Candidate submission form (harness commit input).
   - Activate/rollback buttons with epoch.
   - Session selector.
   - Latest recovery report.
2. `src/routes/page.ts` — `GET /` with browser Accept → HTML. Without → startup check text.
3. Update `src/worker.ts`.
4. Tests:
   - `test/routes/page.test.ts` — browser Accept → HTML, machine → text.

### Acceptance

`pnpm verify` passes. Page shows generation, epoch, chat with diff and exit code, and controls.

### Rollback

Revert commits.

---

## P7: deploy, timed recording, stop

**Kind:** Owner gate.

**Depends on:** P6.

### Setup (outside the recording)

1. Deploy the Worker with production bindings. Deploy scripts fail when Access vars are absent. Owner approves.
2. Record deployment ID.
3. Clone demo repo into workspace, install dependencies, confirm `./test.sh` clean.
4. Materialize and activate Generation 0 from a real cf-stumble commit.
5. Prepare the second and broken cf-stumble harness commits.
6. Log in through Cloudflare Access in a fresh browser.

### Timed recording (≤ 120 seconds, seven actions)

1. Open the page → active generation and epoch visible.
2. Submit a task → agent edits, runs `./test.sh`, page shows diff and exit code 0.
3. Submit the second harness commit → page shows passing preparation result.
4. Activate the new generation → continue the same conversation (page shows prior context).
5. Submit the broken candidate → page shows failing preparation result, active generation unchanged.
6. Rollback → conversation and project edit survive (page shows prior turns and diff).
7. Show the persisted conversation and returned diff on the page (the existing session view and turn response — no project browser needed).

### After the recording

- Open the same tenant from a second client in a separate session. Confirm isolation.
- Force a controlled redeploy between a write and a read. Record deployment IDs on both sides. Confirm generation, conversations, and project files survive.
- Run `pnpm verify`.
- Save evidence in `.audit/evidence/p7/`.

### Acceptance

Screen recording ≤ 120 seconds shows all seven actions with visible diff and exit code. `.audit/evidence/p7/` has structured evidence. `pnpm verify` passes.

### Production teardown (separate procedure, not automatic)

If the owner later wants to decommission: export session documents and project files first, then `wrangler delete`. State what deletion cannot restore: Durable Object state (generation history, session documents, recovery reports), Computer workspace files, and any R2 objects not separately backed up.

---

## Codex login — deferred research note

The available prior art does not establish that the Codex client ID (`app_EMoamEEZ73f0CkXaXp7hrann`) accepts an HTTPS callback on a custom domain. The first-party source hard-codes `http://localhost:1455/auth/callback` and says the fallback port must stay in the Hydra redirect allow-list. Pi labels the flow Node-only.

Workers AI is the only v0 model route. This work is outside the plan.

---

## Dependency graph

```
P0 (paid probe — full chain)
├─► P1 (Access + owner routing)
├─► P3 (Gen-0 facet + immutable-route adapter)
│   └─► P4 (Computer workspace + scoped capability)
│       └─► P4b (commit-to-module-map cycle)
│
P1 + P4b ─► P2 (HTTP routes + turn + submission calls resolver)
P2 + P3 + P4 + P4b ─► P5 (six-step backend rehearsal)
P5 ─► P6 (tenant page with diff/exit-code rendering)
P6 ─► P7 (deploy + timed recording + stop)
```

P1 and P3 run in parallel after P0. P4 follows P3. P4b follows P4. P2 depends on P1 and P4b. Everything converges at P5.

## Cleanup register

Every disposable paid run has a unique Worker name, records exact R2 keys and container app IDs into a manifest, and deletes only those tracked resources.

| Phase | Unique name | Security | Cleanup order |
|-------|------------|----------|---------------|
| P0 | `cf-stumble-probe-p0-<ts>` | Single-run bearer secret | Workspace/DO → Worker → verify manifest |
| P4 | `cf-stumble-probe-p4-<ts>` | Owner-only Access | Workspace/DO → Worker → verify manifest |
| P4b | `cf-stumble-probe-p4b-<ts>` | Owner-only Access | Workspace/DO → Worker → verify manifest |
| P5 | `cf-stumble-rehearsal-<ts>` | Owner-only Access | Workspace/DO → Worker → verify manifest |
| P1, P3, P4b-local, P6 | (tracked source only) | — | `git revert` |
| P7 | Production (kept) | Owner-only Access | Separate teardown with data export |

## Not in v0

- Automatic fallback or known-good threshold.
- Agent self-repair, self-submission, automatic promotion.
- Token streaming, reconnect, resume, steering, background turns.
- Multiple projects, workspace picker, combined views.
- Public signup, teams, roles, invitations, administration.
- Provider selection beyond Workers AI.
- Cache policy, alarms, session migrations.
- Multi-tenant generalizations.
- Codex/ChatGPT login (deferred research).

## Rules while finishing

1. One phase at a time. End it with the listed checks.
2. Paid probes before assumptions.
3. When Cloudflare differs from the design, record observed vs expected and stop.
4. Do not expand recovery, eligibility, or generation policy while the main facet is a fixture.
5. Fixed values where v0 has one project, one model, one page.
6. Release the demo once it passes. Stop.
7. `pnpm verify` at every commit. No test makes a paid or nondeterministic request.
