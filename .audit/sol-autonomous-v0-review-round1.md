# Autonomous v0 run review, round 1

## Verdict

**Reject.** The run is not safe to resume as written.

The code has useful pieces. The fixed Workers AI choice, low reasoning setting, host-owned model binding, R2 cache class, Access JWT verification, Pi vendoring, and session lease are real. The checklist overstates what those pieces prove. It also misses two security boundaries, one concurrency failure, and the requested Codex compatibility experiment.

The first action is not more feature work. Reconcile the run against commit `4f76bd4`, correct the paid-probe record, and close the owner-only Access gap. Then continue in the smaller order in this review.

## Review snapshot

I reviewed tracked commit `4f76bd4cf5333b35830368b102ff9c668b605a92`. A clean detached worktree passed `pnpm verify` with 43 test files and 267 tests. The shared working directory gained untracked `src/workspace/` files from another worker during this review, so I did not treat those partial files as repository state.

The review covered `.audit/autonomous-v0-run.md`, the three files under `.audit/research/`, the paid-probe artifacts, the current source and tests, the required domain documents, and every current ADR.

## What the current code does

The root Worker verifies an Access JWT, derives a Supervisor Durable Object name from the verified `sub` and the Access audience, and routes `/api/` requests to a partial owner API. Other requests reach the active facet after the Worker removes Access credentials. The Supervisor stores generation and session state in SQLite, reads module maps from R2, loads a facet under the harness commit, and gives the facet only the host `MODEL` service binding.

Production still starts from `fixtureMainHarnessCommit`. The R2 code can store and load a supplied module map, but no code checks out a labeled harness commit or rebuilds an R2 miss through Computer. Pi and Computer are not in the serving turn. The owner API exposes status, session read, and session turn routes. It has no generation submission, activation, rollback, recovery-report route, or page.

## Must-fix findings

### 1. Reconcile the run and the architecture records before another implementation unit

The run is not an executable description of HEAD.

- `.audit/autonomous-v0-run.md:22-30` records historical counts and commits, not the current baseline.
- `.audit/autonomous-v0-run.md:37` says to add owner-only HTTP routes. `src/routes/owner-api.ts:82-126` already has status, session read, and session turn routes. The generation controls and page remain missing.
- `.audit/autonomous-v0-run.md:25` still says the probe was never executed, while line 28 records a later run.
- The run does not link the much more detailed `.audit/autonomous-v0-plan.md`. A future worker cannot tell which file supplies acceptance criteria.
- `docs/agents/design/feature-map.md:7` says four owner decisions remain and describes an old Q2. `.audit/design-questions.md:16-65` now has six open questions, and its Q2 asks a different question.
- `docs/agents/design/feature-map.md:65-84`, `docs/agents/design/slices.md:3-7`, and ADR-0034 line 13 describe older implementation state.
- `docs/agents/design/overview.md:55` and `docs/agents/design/computer-integration.md:25-29` still call the artifact format and storage open. ADR-0028 and human-approved ADR-0034 settled those choices.
- `.audit/research/workers-ai-glm-5.3-flash.md:76-93` and lines 108-117 describe the repository before the model route landed. The note needs a source commit or a historical-state marker.

**Required fix.** Replace the run with one current checklist or make it name one authoritative detailed plan. Pin its starting commit. For each open unit, list the input state, files in scope, direct check, paid or external action, stop condition, and next dependency. Update stale tracked architecture statements in one small documentation change. Do not redesign the settled ADRs.

### 2. Downgrade the completed paid probe to a binding smoke test

The completed probe does not prove the application route.

- `scripts/probe/run.sh:157-171` calls `env.AI.run` directly. It does not call the host `ModelRoute` through a loaded facet.
- The probe sets `model_ok` when the result is any object. It never checks the sentinel text, returned model, finish reason, tool-call shape, HTTP status, or elapsed time.
- `scripts/probe/run.sh:126-155` compares only part of the R2 object.
- `.audit/paid-runtime-evidence.md:13-20` therefore proves that R2 and the AI binding answered. It does not prove response normalization, a Pi tool loop, Computer, Worker Loader, or cold startup.
- `RuntimeProbeEvidence` at `.audit/autonomous-v0-run.md:11-14` promises model metadata and a Computer result that the saved JSON does not contain.

This is not a reason to turn the probe into the old all-in-one P0. The owner approved a minimal probe. Keep it minimal and state its limit honestly.

**Required fix.** Rename the result as an R2 and Workers AI binding smoke test. Mark the application-model gate open. After the model adapter is corrected, prepare one harmless, one-call paid check through the actual host route. It must record the exact fixed model, `reasoning_effort: "low"`, status, duration, response shape, and an exact harmless sentinel. It must not record credentials, user prompts, project files, or hidden reasoning. Obtain a new explicit paid-call approval before running it.

### 3. Treat the prior paid cleanup as incomplete

The cleanup evidence proves the wrong storage location.

`scripts/probe/run.sh:219` and line 235 omit `--remote`. Both cleanup logs say `Resource location: local`. The deployed Worker wrote the probe object to remote R2. `.audit/paid-runtime-evidence.md:22-26` therefore cannot claim that the remote object is absent.

The cleanup also suppresses Worker deletion errors and prints only `delete requested`. A shell `EXIT` trap cannot support the word "always" because `SIGKILL`, a dead host, or a lost credential can prevent it from running.

**Required fix.** Stop new paid probes until an owner-approved cleanup command checks the exact remote key `probe/probe-1788408728/module-map.json`, deletes only that key if present, and verifies remote absence with `--remote`. Verify the exact Worker name separately. Record the commands, exit codes, account identifier, and result without credentials.

Then change the lever as follows:

- Require the exact approved run class. Do not accept the presence of Cloudflare credentials as approval.
- Use a cryptographically random run ID. Epoch seconds can collide.
- Enforce one invocation or make repeated invocation return the recorded result without another paid call.
- Put cleanup in a rerunnable subcommand that reads the manifest. Keep the trap as a convenience.
- Use `--remote` for every paid-account R2 operation.
- Check Worker deletion rather than logging a request.
- Delete only manifest-listed keys, workspace identifiers, Durable Object state, and container application IDs.
- Run workspace and Durable Object cleanup before deleting the Worker when cleanup needs a Worker endpoint.

The approval recorded at `.audit/autonomous-v0-run.md:24` covered the narrow R2 and AI run. It does not authorize later Computer starts, disposable deployments, or production writes.

### 4. Enforce the owner in Worker code and prove the real Access deployment

The current code authenticates an Access user. It does not enforce the configured owner.

`scripts/deploy/check-config.sh:35-40` requires `CF_ACCESS_OWNER_SUB`, and `scripts/deploy/README.md:17` says that the Worker reads it. `src/access/index.ts:29-33` does not declare that value. `authenticateAccessRequest()` accepts every correctly signed `sub` at `src/access/index.ts:179-218`. If the Access policy broadens by mistake, another accepted identity gets a different Supervisor instead of a rejection.

The configured application is also an assertion in `.audit/autonomous-v0-run.md:23`. The audit files contain no redacted policy export, DNS or Worker route proof, different-identity denial, or owner success at `stumble.akompella.dev`. `wrangler.jsonc` has no custom route or `workers_dev` decision. The configuration guard is not a deploy wrapper, and nothing forces a deploy command to run it.

The earlier attack review asked for a Cloudflare Access team-domain host check. `issuerForTeamDomain()` at `src/access/keys.ts:78-93` only requires an HTTPS hostname containing a dot.

**Required fix.** Add `CF_ACCESS_OWNER_SUB` to the runtime environment and compare it with the verified claim before deriving any Durable Object name. Add valid-owner and valid-non-owner signed tests. Tighten the team-domain parser to the intended Cloudflare Access host form, unless the owner records a different supported issuer.

Create one deploy command that validates and supplies the same values it deploys. Its preflight must prove the following facts:

- `stumble.akompella.dev` routes to the intended Worker.
- The Access application has one exact-owner Allow policy and no `Everyone` or `Bypass` policy.
- An unauthenticated browser is sent through Access.
- The owner reaches the page.
- A different identity is denied.
- The `workers.dev` route is disabled or still fails the application JWT and owner checks.
- Access assertion headers and the `CF_Authorization` cookie never reach a mutable facet.

Changing DNS, Access policy, routes, or Worker secrets is an external write. List each action and require owner approval before it runs.

### 5. Correct and bound the native Workers AI contract

The fixed selection is sound. The provider adapter is not.

The research says that GLM's native synchronous response is OpenAI-shaped with `choices[].message` at `.audit/research/workers-ai-glm-5.3-flash.md:31-33`. `ProviderResult` at `src/model-route.ts:62-65` expects top-level `response` and `tool_calls`. `normalizeResponse()` reads those fields at lines 217-228. A documented native result can become an empty Pi assistant message.

The fake tests use the same unproved top-level shape, and the paid probe accepted any object. `validateRequest()` at lines 192-203 validates messages but never validates `tools`. Its 1 MiB check counts JavaScript characters after serialization, not request bytes. The route also lacks a provider-response validator and a fixed output bound.

**Required fix.** Put the provider-specific request and response types entirely inside the immutable `ModelRoute`. Validate the documented native response before translating it. Reject malformed choices, content, tool names, IDs, arguments, and finish reasons. Validate every tool definition before the AI binding sees it. Measure UTF-8 bytes. Set conservative request, response, tool-count, output-token, model-call, and loop limits.

Add local native-response fixtures for plain text, a tool call, malformed output, provider failure, and output truncation. Then use the single paid sentinel gate from finding 2. Do not spend a second paid call on an intentionally invalid model.

### 6. Implement a real Pi stream adapter, not only message conversion

`src/facet/generation-0/workers-ai-adapter.ts` converts Pi-like message records to route records and one route result back to a Pi-like assistant record. No `src/` code imports `Agent` from `@cf-stumble/pi`. Pi's `StreamFn` contract in `vendor/pi-v0.84.4/packages/agent/src/types.ts:18-32` requires an `AssistantMessageEventStream`, including a final error or aborted message for failures.

The adapter also repeats selected Pi types instead of proving conformance to the vendored types. Its tests manually stage responses. They do not run the Pi agent loop.

**Required fix.** Build the smallest real Generation 0 facet around the vendored `Agent` and actual Pi types. Its stream adapter must call the immutable route and emit the event sequence Pi expects. A deterministic local test must cover model call, tool call, Computer tool result, second model call, final text, provider error, abort, and session serialization. The mutable facet must never select the provider, model, reasoning setting, endpoint, or credential.

The paid gate is one harmless coding turn after Computer exists. It must show the exact model route and low reasoning setting in host evidence, not in caller-controlled fields.

### 7. Define the Computer boundary before giving Pi a shell

The tarball is vendored, but the Computer path does not exist at the reviewed commit. There is no `WorkspaceHost`, Computer binding, container configuration, project adapter, or build adapter. The run compresses this work into lines 31 and 34 without a security or evidence boundary.

Use the exact approved source commit and image digest from ADR-0026. Record the `basic` instance choice already established by the paid Computer notes. The workspace host must derive its name from the same verified owner context as the Supervisor. The facet may receive only operations scoped to the configured project workspace. It must not receive a raw namespace, build workspace, R2 binding, Access state, or container administration capability.

A more serious issue is hidden by `globalOutbound: null`. That setting blocks ambient facet `fetch()`. A model-controlled shell can still run `curl`, a package manager, or another network client inside Computer. The existing Computer evidence even proves package installation over the network. The plan says nothing about this egress path.

**Required fix.** Before production, choose and test one explicit model-shell network rule. The smallest safe v0 is to pre-seed the demo repository and deny network during model-controlled commands. If the pinned Computer path cannot enforce that, record the limitation and require owner confirmation before every network-capable turn. Do not claim that `globalOutbound: null` blocks Computer egress.

Bound working directory, command duration, output bytes, file size, and total tool calls. Do not put deployment credentials or harness-build credentials in the project workspace. Convert Computer failures into typed tool errors.

Use one targeted paid Computer check after local host tests. It must show a harmless read, write, command, controlled redeploy with deployment IDs, persisted file, and cleanup. That paid action needs its own approval and manifest.

### 8. Serialize project mutations across sessions and reconcile timed-out work

The session lease protects one session document. It does not protect the shared project workspace.

`docs/agents/design/feature-map.md:33-40` gives one tenant one Computer workspace and allows several sessions. Lines 59-61 say that two sessions can run at once. Two session leases can therefore edit the same Git working tree concurrently.

`executeSessionTurn()` releases the session lease immediately after a timeout or facet failure at `src/supervisor/sessions/turn-operation.ts:42-46`. Aborting the facet fetch does not prove that a Computer command stopped. A late command can change files after another turn starts. The session lease ID prevents a late session save, but it cannot undo or order workspace writes.

The word "transaction" at `.audit/autonomous-v0-run.md:32` also covers only the session record. File and command effects are not atomic. A failed turn can leave a dirty workspace even when the session revision does not advance.

**Required fix.** For v0, allow many saved sessions but only one project-mutating turn per owner workspace. Make the `WorkspaceHost` own the lease and durable operation ID. On timeout, report `timed-out-unknown` until the host proves the command stopped. Do not release the workspace to another turn or retry the command while the result is unknown. After any failed or cancelled turn, inspect and return the dirty diff before another write.

Model these outcomes explicitly. A turn can finish cleanly, fail without changes, fail with a dirty workspace, or remain unresolved. Add crash and retry tests. A worktree-per-session design can restore concurrency later. It does not belong in v0.

### 9. Finish the turn contract and its evidence path

The current session response has `text`, `commands`, and `sessionRevision` at `src/supervisor/sessions/session.ts:40-44`. It has no diff. `executeSessionTurn()` returns the facet's values unchanged at `src/supervisor/sessions/turn-operation.ts:60-65`. The required demo cannot prove what changed.

The owner API calls `runSessionTurn()` as a Supervisor RPC. That path does not use `FacetRelay`, so successful owner API turns do not create the completed relay attempts required by `docs/agents/design/feature-map.md:110-120` and ADR-0031.

`parseFacetTurnResult()` validates types but places no byte limits on the saved document, response text, command, stdout, or stderr. A facet can fill Durable Object storage or return an impractical response.

**Required fix.** Return a bounded `git diff` record for the configured project and a bounded command record. Validate all facet output before saving it. Prove that a failed or stale turn cannot commit a session document. Prove that activation and rollback preserve both the saved session and project files.

Either record a terminal relay attempt for the owner API turn with the real active generation attribution, or remove that eligibility claim from version 0. Do not keep a metric that silently misses every real turn.

Keep session documents opaque. For the demo, require both candidate generations to read the same recorded document version. Do not build a general session-migration framework.

### 10. Make commit materialization the only production path

The current R2 code is a cache for artifacts supplied by a caller, not a cache backed by the harness commit.

`HarnessArtifacts.retain()` at `src/supervisor/artifacts/index.ts:54-80` accepts module source in its input. `mount()` returns an error on an R2 miss at lines 82-110. No builder checks out the labeled commit. `Supervisor` seeds `fixtureMainHarnessCommit` at `src/supervisor/supervisor.ts:70-78`, and `HarnessArtifacts.mount()` writes the fixture when no generation is active at `src/supervisor/artifacts/index.ts:88-101`.

The single box at `.audit/autonomous-v0-run.md:36` omits the security and failure rules that make ADR-0034 true.

**Required fix.** The public submission request may contain a request ID and a 40-hex harness commit. It may not contain module source, a repository URL, a build command, or an R2 key. The immutable host selects the configured harness repository and fixed build command.

On a miss, a separate Computer build workspace must check out the exact commit, build, canonicalize, validate, and return a bounded module map. It receives no project workspace, model binding, Access credential, or Supervisor store. Build the same commit twice and compare canonical bytes. Stop if they differ.

Then prove these cases:

- A miss builds, caches, loads, and passes the bounded cold `GET /` check.
- A hit loads without a build.
- Invalid or oversized R2 data cannot execute and causes a rebuild.
- A syntactically valid object under the wrong commit cannot execute.
- A failed build leaves the active generation serving.
- A submitted commit becomes ready only after the startup check.
- Generation 0 is materialized, checked, and activated through this path.
- Production code no longer imports or seeds the fixture.
- Supervisor SQLite contains no module source.

State the R2 trust rule. If the immutable host is the only writer and account-level R2 access is trusted, say so and test that no facet receives the binding. Otherwise add an integrity tag without making it a second Loader identity. Add a maximum object size and a simple manual or age-based limit. Do not build background garbage collection or miss coalescing for v0.

The build and cold-load paid check needs a separate approval. Record both the cf-stumble harness commit and the Computer dependency commit so they cannot be confused.

### 11. Split the partial owner API from the page work

The current line 37 hides at least two units.

First complete the authenticated backend. It needs generation list, candidate submission, preparation result, activation, rollback, latest recovery report, session read, session turn, and status. The Worker must create the control principal from the authenticated owner context. Request JSON must not choose the principal, tenant, repository, build command, or R2 key. State-changing routes need exact methods, JSON content type, body limits, an Origin or CSRF rule, request IDs, and epoch checks.

Then add one plain page. It needs conversation, active generation, candidate result, rollback, and the latest recovery report. Do not add a framework, live streaming, a project picker, a general admin console, or multi-tenant provisioning.

The backend must pass its real-artifact tests before page work starts. The page must pass a fresh Access-protected browser run before production approval.

### 12. Run the requested Codex compatibility experiment without turning it into authentication

The run contradicts itself. Line 38 marks the decision settled from research. Line 44 says the implementation is pending the compatibility experiment. The owner now requires a safe experiment.

The `CodexLoginExperiment` type at lines 13-14 is also a false binary. Missing public registration evidence does not prove `unsupported`. Reaching a login page does not prove that the token exchange or private Codex backend is supported.

**Required fix.** Keep this lane independent of version 0 and Workers AI. Record at least these results:

- `not-run`
- `redirect-rejected`
- `authorization-page-reached`
- `callback-reached-without-exchange`
- `supported-registration-documented`

The minimal experiment creates a fresh PKCE challenge and state, uses `https://stumble.akompella.dev` as the proposed callback origin, and opens the authorization request only in the owner's browser. It does not collect a ChatGPT cookie, submit credentials for the owner, exchange a code, persist a token, call `chatgpt.com/backend-api`, or expose a relay. If OpenAI rejects the redirect, record the redacted error. If OpenAI shows a login page, stop and record only `authorization-page-reached`. That result remains inconclusive.

Do not add a callback or token store unless OpenAI supplies a supported client registration or HTTPS redirect contract and the owner separately approves a credential-bearing experiment. Never reuse the public Codex client as proof of a supported web integration.

### 13. Make every external and destructive action explicit

The final sentence at `.audit/autonomous-v0-run.md:9` is too broad. Deployment and publication are different decisions. Disposable cleanup and secret changes also need clear bounds.

Add separate owner gates for these actions:

1. Repair the prior remote probe cleanup.
2. Run each new paid AI call.
3. Deploy or start each disposable Computer or Worker resource.
4. Delete each manifest-listed remote resource.
5. Change Access, DNS, routes, or Worker secrets.
6. Apply the first production Durable Object or container migration.
7. Deploy production.
8. Publish the recording.
9. Tear down production after an export that lists data that cannot be restored.

Each approval must name the account, Worker name, resource prefix, expected charge class, cleanup manifest, and whether the approval is single-use. A failed or expired approval stops the action. Production teardown must never share a cleanup command with disposable probes.

## Corrected execution order

| Order | Unit | Required evidence before the next unit |
| --- | --- | --- |
| 0 | Freeze the baseline and reconcile plans, docs, and checklist status | One starting commit, one authoritative checklist, clean `pnpm verify` |
| 1 | Repair remote probe cleanup and downgrade its claim | Exact remote key and Worker checked; cleanup result recorded |
| 2 | Finish owner-subject enforcement and deployment preflight | Signed owner and non-owner tests; redacted Access and hostname evidence |
| 3 | Correct the native GLM route and implement the real Pi stream adapter with fakes | Full local tool-loop test; fixed model and low effort cannot be overridden |
| 4 | Add the scoped Computer workspace host and tenant-wide workspace lease | Local harmless file, shell, timeout, dirty-state, and retry tests |
| 5 | Run one separately approved Computer capability check | Paid read, write, command, controlled redeploy, persistence, and cleanup evidence |
| 6 | Run one real Generation 0 Pi coding turn | Expected edit, bounded diff, exact check command, exit zero, saved session, and host model evidence |
| 7 | Add commit materialization and the R2-backed resolver | Two equal builds; miss, hit, corrupt, oversized, failure, and fixture-removal tests |
| 8 | Run the separately approved Computer build and cold-load check | Exact commits, cache path, Loader identity, cold `GET /`, timings, and cleanup evidence |
| 9 | Complete owner control routes | Authenticated integration tests with request IDs, epochs, and server-owned principal |
| 10 | Add the one plain page | Browser proof through Access against real local or disposable backend |
| 11 | Run the no-credential Codex redirect experiment | One typed result. Any non-rejection remains inconclusive |
| 12 | Run final local verification and a disposable backend rehearsal | Clean `pnpm verify`, exact demo assertions, no unresolved operations |
| 13 | Pause for production deployment approval | Owner sees resources, cost class, migrations, rollback, and teardown limits |
| 14 | Deploy and record. Pause again before publication | Two-minute demo, second-client check, controlled redeploy, durable state evidence |

Do not start a unit when its direct evidence is missing. A local fake proves logic. It does not replace the paid gate for Computer, Worker Loader, R2, Access, or Workers AI.

## Scope to remove or keep out

The following work does not earn a place in version 0:

- A general model-provider abstraction.
- A Codex token store, refresh loop, private backend proxy, or ChatGPT cookie path.
- Multi-tenant accounts, invitations, provisioning, or per-user harness repositories.
- Concurrent edits to one project. Serialize v0 turns instead.
- Streaming, reconnect, background turns, or live shared sessions.
- Automatic recovery, automatic repair, or a known-good policy redesign.
- Worker Previews, CI preview automation, or a broad admin page.
- Background R2 garbage collection, a complete retention service, or miss coalescing.
- A paid invalid-model probe.
- Repeated full-chain probes after the same final rehearsal already proves the path.

Keep the identity-derived Supervisor name if it remains a small result of verified owner identity. Do not build a tenant framework around it.

## Evidence handling

`.audit/` and `scripts/probe/{manifests,evidence}/` are ignored. Their contents are mutable local notes, not commit-pinned release evidence. Before the done predicate relies on a paid result, record the candidate commit, deployment ID, command versions, UTC timestamps, redacted raw result, cleanup result, and SHA-256 of each evidence file in a durable release artifact. Keep credentials, Access assertions, OAuth state, authorization codes, prompts from real work, repository contents, and hidden reasoning out of it.

## Lead judgment

**Act on now.** Findings 1 through 5, 8, 10, 12, and 13 block safe continuation or invalidate current evidence.

**Act on before the real turn.** Findings 6, 7, and 9 define the smallest safe Computer and Pi path.

**Act on before the page.** Finding 11 prevents frontend work from hiding backend gaps.

**Dismissed.** Do not add an old-generation capability revocation system merely because a stopped facet may still hold a `MODEL` binding. The binding fixes the model and has no general credential. The Supervisor already controls which generation serves. Prove that inactive facets cannot serve traffic instead.

## Principles that changed this review

- **Foundational Thinking.** I modeled shared workspace mutation before accepting per-session concurrency. This changed the recommendation to one workspace lease across all v0 sessions.
- **Redesign From First Principles.** I treated owner-only authorization as a Worker boundary rule, not a deploy-script add-on. This changed the fix from another guard to an owner-subject check in the authentication result.
- **Boundary Discipline.** I checked Access, native AI responses, Computer RPC, R2, and facet output as separate boundaries. This exposed the dead owner setting, unvalidated tools, provider-response mismatch, and oversized-output risks.
- **Make Operations Idempotent.** I traced retries and crashes through paid cleanup and timed-out Computer work. This changed the fix to a manifest cleanup command and durable operation reconciliation.
- **Prove It Works.** I compared claims with the raw cleanup log and the real provider schema. This downgraded the paid result and made the remote cleanup a blocker.
- **Sequence Work into Verifiable Units.** I split Computer, Pi, materialization, controls, page, and production into units that end with direct checks.
- **Laziness Protocol.** I kept the paid probe small and cut OAuth token handling, concurrent worktrees, provider abstraction, and repeated full-chain probes.
- **Experience First.** I put one complete edit, check, diff, and continued conversation before page polish. That is the first result the owner can use and the next maintainer can verify.

## Review mechanics

The independent comment pass found no plan-relevant suppression or comment blocker. It proposed no deletions. I made no tracked-file edits. The detached verification worktree ran the repository's full gate. This review itself is the only requested output.
