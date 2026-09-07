# Autonomous v0 plan review

## Verdict

The plan is not ready to execute. It keeps the right product cut in several places, but the paid probe does not test the architecture that later phases need. Several runtime links required by the demo are missing.

## Must-fix 1. Remove the two explicit scope expansions

P1 derives Durable Object names from user identity and tests two identities. That is multi-tenant routing for a release whose Access policy admits one owner. D1 also adds a Codex OAuth route and leaves a Codex inference probe open. Neither change helps the version 0 recording.

**Change required.** Delete `src/access/tenant-key.ts`, its two-identity tests, all of D1, and every D1 graph and cleanup reference. After Access verification, route all accepted requests to one server-owned Supervisor name and one server-owned workspace name. Keep Workers AI as the only model path.

## Must-fix 2. Make Access verification cryptographic

P1 says to decode the JWT, then check `iss` and `aud`. Decoding does not authenticate the token. A forged token could select the owner's Durable Objects and invoke generation controls.

**Change required.** State that the Worker verifies the signature against the Access application's JWKS. It must also enforce the configured issuer, application audience, owner subject, expiry, not-before time, and an allowed signing algorithm before it trusts any claim. Put the public issuer and audience in deployed Worker configuration, not only local `.env`, and disable the `workers.dev` route. Add signed fixtures for a valid owner token, a wrong subject, a wrong key, a wrong issuer, a wrong audience, an expired token, and a not-yet-valid token. The Worker must never log the assertion. Use 401 consistently for a missing or invalid assertion.

## Must-fix 3. P0 must probe the actual capability chain

P0 omits Computer and lets the probe call `env.AI.run` directly. It therefore cannot prove the chain required by `feature-map.md` P0. It also misses the outbound-denial check. A direct AI binding in mutable facet code would cross the intended model security boundary.

**Change required.** Make P0 deploy the pinned Computer source and image pair. The immutable host must own the AI and Computer bindings. The loaded facet must receive only a fixed model capability and a capability for the one disposable workspace. Set `globalOutbound` to `null` and assert that an unrelated outbound request fails. In the same run, Computer must build a realistically sized Pi module map from a commit, R2 must cache it, Worker Loader must load it under that commit, the facet must call the fixed model capability, and a file must survive the chosen restart test. Stop before P1 if any link fails. P4 must thread the same scoped workspace capability through `MainFacetCapabilities`, `loadMainFacet`, `HarnessArtifacts.mount`, and the startup check. Do not give the facet a raw namespace or the session store.

## Must-fix 4. The fixed model route cannot drive Pi tools

`src/model-route.ts` accepts one prompt string and sends no conversation or tool definitions. P3 does not change that route. Pi cannot produce or continue a read, edit, shell, and final-answer loop through this contract, so P4 cannot produce the coding turn.

**Change required.** Settle a fixed Workers AI to Pi adapter in P0, then implement it in P3. The facet may send the Pi context and tool definitions, but it may not select a model, provider, URL, credential, or reasoning level. The immutable route must build the fixed Workers AI request and convert its response and tool calls into Pi events. Add a deterministic fake test for model call, tool call, tool result, second model call, and final text. Delete the local AI-binding test because `pnpm verify` must not make a paid, nondeterministic request. P0 must make the real model emit at least one tool call. A plain text `ai_ok` response is not enough.

## Must-fix 5. Connect saved sessions to facet turns

P2 exposes the existing session store, while P3 sends only `{ prompt, sessionId }` to the facet. No step supplies the stored conversation to the facet or saves the returned document. The same-conversation claims in P5 and P7 are therefore unsupported.

**Change required.** Define one turn operation that accepts `expectedRevision`, takes the Supervisor session lease, sends `{ prompt, document }` to the active facet, receives `{ document, text, commands }`, commits the new document, and only then replies. Release the lease without advancing the revision on mount, model, tool, or facet failure. Test a first turn, a generation activation, and a second turn whose input contains the first turn's saved document. Also test that a failed turn releases the lease.

## Must-fix 6. Add the missing commit-to-module-map implementation

P5 submits a second harness commit and expects the Supervisor to build and cold-start it. No phase implements the ADR-0034 cache-miss path. P3 builds only Generation 0 from the local tree, and P4 builds only the project workspace adapter. Production still seeds and serves `fixtureMainHarnessCommit` when no generation is active. The plan also does not say how the repository obtains unreleased Computer `0.3.0` source at the approved commit.

**Change required.** Add a phase before P5 that checks out the exact labeled harness commit in a build workspace separate from the project workspace, runs one fixed build command, validates and canonicalizes the module map, caches it in R2, and loads it under the commit ID. Test a cache miss, a cache hit, a corrupt object rebuild, two equal builds, and a failed build that leaves the active generation serving. Replace the production fixture seed with the real Generation 0 commit. The deploy setup must materialize, check, and activate Generation 0 before the demo. No production file may import `src/facet/fixture.ts`. Name the reproducible dependency method for Computer source commit `12336475c9fd03f5280a4537a707797fc0131fbd`, and verify that source SHA together with the full approved image digest. P4 must name the `WorkspaceHost` export, Durable Object migration, and `containers` configuration. Make P5 depend on this phase.

## Must-fix 7. Make paid cleanup complete and safe

`wrangler delete` does not describe cleanup for R2 objects, Computer files, or Durable Object state. P4 has paid verification without a cleanup script. A failed command can also skip the final lines of the P0 or P5 scripts. The cleanup register treats deletion of the P7 production Worker as routine even though it can destroy the only deployed conversation and workspace path.

**Change required.** Give every disposable paid run a unique Worker name, resource prefix, and manifest. Use a `finally` or shell `trap` handler plus a rerunnable cleanup command. It must delete the Worker, every recorded R2 key, disposable Computer workspace data, and disposable Durable Object data after success or failure. Run cleanup before deleting the Worker when the Worker must expose the deletion operation. Record every cleanup result and fail the probe if cleanup is incomplete. Keep the P7 deployment after the recording. Put any production teardown in a separate owner-approved procedure that first exports the data and states what deletion cannot restore.

## Must-fix 8. Turn the demo claims into observable checks

The plan does not bound the recording to two minutes. P5 includes repository cloning in the demo run, and P7 mixes the recording with a second client, runtime eviction, and `pnpm verify`. The plan also asks for eviction without naming a way to force and observe it. A returned diff and command output do not prove that `./test.sh` passed or that conversation and file state survived.

**Change required.** Call P5 a six-step backend rehearsal. The page does not exist until P6. Move clone, dependency setup, Access login, and candidate preparation into a setup step outside the timed P7 recording. Define one timed seven-action page run with a total duration of at most 120 seconds. Require structured evidence for the expected diff, the exact `./test.sh` command, exit code zero, the session revision and saved first-turn document after activation and rollback, the project file hash after both changes, and the unchanged active generation after the broken candidate. Replace "evict" with a reproducible restart, such as a controlled redeploy between write and read, and record deployment IDs on both sides. Run the second-client check and `pnpm verify` outside the recording.

## Must-fix 9. Resolve the approval contradiction

The constraints forbid tracked edits without owner approval, but P1 through P6 are marked autonomous and have no approval gate. An implementation agent cannot know whether plan approval authorizes those files.

**Change required.** State that owner approval of the revised plan authorizes the listed tracked work in P1 through P6, while deploys and destructive cleanup keep their explicit gates. Otherwise add an owner gate before each tracked phase.

## Accepted 1. Keep the small interaction model

The cheap deterministic `GET /`, buffered turns, one plain page, one project, and manual rollback all serve the recording. Do not add streaming, reconnect, a project picker, or automatic recovery.

## Accepted 2. Keep generation authority in the Supervisor

The plan keeps activation and rollback behind the Supervisor and gives the model no generation-control tool. That preserves the main security boundary.

## Accepted 3. Keep the fixed provider choice

The main path has one Workers AI model and no generic provider selector, Preview flow, or CI project. Keep it that way after deleting D1.


## Re-review of the 2026-09-03 revision

### Verdict

Reject. The revision satisfies the single-owner scope decision, removes D1 as a phase, adds cryptographic JWT checks, adds the paid capability probe, defines session turn orchestration, adds P4b, separates paid AI from `pnpm verify`, bounds the recording, and resolves plan approval. Six material defects remain.

### Must-fix A. Keep the provider request in the immutable route

P3 puts `workers-ai-adapter.ts` inside the mutable facet and says that adapter builds the Workers AI request. It never changes `src/model-route.ts`, whose current `run({ prompt })` contract has no history or tools. This either cannot drive Pi or lets mutable code own provider policy.

**Change required.** Define the plain, structured-cloneable request and response on `src/model-route.ts`. The immutable `ModelRoute` must add the fixed model ID and reasoning effort, call `env.AI`, and normalize tool calls. The facet adapter may only translate between Pi events and that fixed route contract. P0 and P3 must test this exact contract and prove that caller input cannot override the model, effort, URL, or credentials.

### Must-fix B. Connect candidate submission to materialization and startup checking

P2 exposes submit, activate, and rollback. P4b implements a cache-miss builder but names no operation that calls it. P5 assumes that submit builds the commit, mounts a cold candidate, runs `GET /`, and records the preparation result. Current submit only labels a commit. P2 also incorrectly gives `observedEpoch` to submission, while the current request type and ADR-0030 require it only for activation and rollback.

**Change required.** State that `POST /api/generations/submit` labels the commit, invokes the P4b resolver, runs the bounded startup check, records the result, and returns that result while the active generation continues serving. Alternatively add one explicit check endpoint and include it in P5 and P7. Keep `observedEpoch` only on activation and rollback. Add an HTTP integration test for passing and broken commits, including unchanged active generation on build or startup failure.

### Must-fix C. Deploy the Access configuration

P1 adds the Access variables only to `src/supervisor/env.d.ts`. A type declaration does not put them in a deployed Worker. The plan still says the actual values exist only in ignored `.env`, so production can reject every request after deployment.

**Change required.** Add `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN` to deployed Wrangler vars. Add `CF_ACCESS_OWNER_SUB` there or through an explicit deploy-time secret command. The deploy scripts must fail before deployment when any value is absent. Keep the values out of browser code and logs.

### Must-fix D. Make the Computer dependency reproducible

P4 says to check out and build Computer locally, but it does not say which package artifact enters `package.json` or the lockfile. The approved `0.3.0` package is not on npm. A clean checkout still cannot import it. P0 step 2 also uses truncated source and image values, which are not valid pins.

**Change required.** Use the already established canonical artifact. Build `npm pack --workspace @cloudflare/computer` at commit `12336475c9fd03f5280a4537a707797fc0131fbd`, vendor or otherwise lock that exact tarball, and name its `package.json` and lockfile entry. Add a repeatable fetch, build, and checksum command. Replace both truncated P0 pins with the full source commit and full image digest.

### Must-fix E. Finish paid cleanup and remove the untestable eviction claim

P0 and P5 omit disposable Durable Object state and container applications from cleanup. P4 and P4b promise paid probes but define no unique Worker, manifest, cleanup command, or cleanup acceptance. P5 uses the shared prefix `rehearsal-`, so one cleanup can delete another run's keys. P4 still accepts an unspecified workspace-host eviction even though the revision uses controlled redeploy elsewhere.

**Change required.** Give P0, P4, P4b, and P5 a run-specific prefix and manifest. Each cleanup must remove exact R2 keys, workspace data, Durable Object data, the Worker, and any container application left in `wrangler containers list`. Make cleanup rerunnable and assert the account returns to its recorded baseline. Replace P4 eviction with the same controlled redeploy test used in P0 and P7, with deployment IDs before and after.

### Must-fix F. Align the turn response with the recording

P3 returns `{ document, text, commands }`, while P5 and P7 require a diff and exit code. The plan never defines `commands`, never adds a `diff` field, and never says who calls `gitDiff`. P7 also asks the page to show a project file, but P6 has no project-file view. The recording cannot prove these claims from the specified page.

**Change required.** Define the turn response with a structured `diff` and command records that include command text, stdout, stderr, and exit code. The immutable turn operation must obtain `gitDiff` after the facet finishes and return it with the saved session revision. Add response-schema tests and make P6 render the diff and `./test.sh` exit code. Change P7 action 7 to show the persisted conversation and returned diff on the existing page. Do not add a project browser.


## Final review of the third-pass plan

### Verdict

Reject. The six second-pass findings are addressed in intent, but the exact plan still has five material defects. No new product scope appears. Codex remains a deferred note only. The cleanup procedure introduces one unsafe deletion rule, described below.

### Must-fix 1. The model request cannot represent a tool loop

`ModelRouteRequest.messages` permits only `{ role, content: string }`. The second provider call in a Pi tool loop must carry the assistant message with its `tool_calls` and each tool result with its `tool_call_id`. The declared contract cannot represent either message, even though P3 claims a test will send the tool result.

**Change required.** Replace the message type with a closed union for the exact system, user, assistant, and tool messages used in v0. The assistant variant must carry `tool_calls`; the tool variant must carry `tool_call_id`. Validate the union in the immutable route. Make the P3 test build its second `ModelRouteRequest` through the public type so this failure cannot be hidden by a cast.

### Must-fix 2. P2 depends on code that P4b has not built

P2 depends only on P1, but its route invokes the P4b resolver and its acceptance says that submission builds and checks a candidate. P4b depends on P4 and is implemented later. P2 cannot reach its claimed verifiable state without a production fake or a missing method.

**Change required.** Implement the resolver in P4b before the route. Make P2 depend on both P1 and P4b, then connect the route and run the HTTP integration tests in P2. Remove the reverse P4b step that says the already-built P2 route calls it. Update the phase table and dependency graph.

### Must-fix 3. P0 names the Computer commit as a harness commit

P0 says that Computer checks out a harness commit at `12336475c9fd03f5280a4537a707797fc0131fbd`. That SHA belongs to `cloudflare/computer`, not the cf-stumble harness repository. The checkout or build will fail, and using it as the Loader identity would violate ADR-0027.

**Change required.** Use an explicit cf-stumble harness commit for the module-map build and Loader identity. Keep the Computer source SHA only as the dependency pin. Record both repository URLs and both resolved SHAs in the probe evidence.

### Must-fix 4. The Computer package recipe does not build the package

The dependency section runs `npm pack` directly after checkout. At the pinned commit, `packages/computer/dist` is not tracked and the package `prepare` script builds only the shell bundle. The tarball will not contain the `dist` entrypoints named by `exports`. P4b also permits a build-scoped directory inside the project workspace, which breaks the plan's required separation between project and harness Git histories.

**Change required.** Run `npm ci`, `npm run build --workspace @cloudflare/computer`, and only then `npm pack --workspace @cloudflare/computer`. Check that the tarball contains the exported `dist` files before recording its checksum. Require a separate Computer workspace or `WorkspaceHost` instance for harness builds. The mutable facet must never receive that build capability.

### Must-fix 5. Paid probes are not safely reachable or cleanable

P0 deploys before P1 and names no authentication for its paid endpoint. A public `workers.dev` caller could trigger paid model and container work. The cleanup baseline uses `wrangler r2 object list`, but the installed Wrangler has no such command. The rule to delete every container application absent from the baseline can delete an unrelated application created concurrently.

**Change required.** Protect P0 with a single-run secret or an owner-only Access route before the first paid call. Apply the same protection to every disposable paid endpoint. Track exact R2 keys and container application IDs in the run manifest. Delete only those IDs after checking the expected run-specific names. Replace the nonexistent R2 list command with the R2 API, an S3-compatible listing, or manifest-only deletion plus exact `get` checks. Name the workspace and Durable Object deletion operation and run it before deleting the Worker.
