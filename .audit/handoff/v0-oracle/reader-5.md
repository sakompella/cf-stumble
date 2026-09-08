# cf-stumble v0 architecture read (reader-5)

HEAD examined: d6ff2380487a60f410c568272635d99f30560d14
("docs(design): align version zero architecture", 2026-09-05 01:36:29 -0700). Working tree clean.
Read-only; no repo files modified, nothing installed, nothing run beyond `git`, `find`, file reads.

Doc order followed: AGENTS.md -> docs/agents/domain.md -> design/overview.md -> CONTEXT.md ->
adr/README.md -> ADR-0030/0038/0039 -> design/feature-map.md -> design/computer-integration.md ->
design/slices.md (skimmed).

## Module inventory (src/: 119 .ts files; test/: 113 .ts files)
- `src/worker.ts`: default `fetch`. Calls `authenticateAccessRequest` (`src/access/index.ts`),
  serves owner page via `ownerPageResponse` (`src/routes/page.ts`), routes `/api/*` via
  `routeOwnerApiRequest` (`src/routes/owner-api.ts`), else relays to
  `env.SUPERVISOR.getByName(access.supervisorName)` after `withoutAccessCredentials(request)`.
- `src/access/index.ts`: `deriveSupervisorName` (line ~216) derives the tenant Supervisor name
  from verified Access identity, matching feature-map.md's tenant-routing description. No literal
  `"facet-spike"` Supervisor name remains in `src/` (only in `test/facet/facet-spike.test.ts` as a
  workspace-name argument) — that feature-map.md cleanup item appears done.
- `src/supervisor/supervisor.ts` + `src/supervisor/{generations,control,relay,recovery,threads,
  artifacts,startup-check,projects}/`: generation state, control (candidate/activate/rollback),
  relay-attempt/eligibility, recovery episode bookkeeping, thread store, artifact
  resolver/builder/cache, startup-check — the "deliberate generation, relay, eligibility, and
  recovery code" feature-map.md calls already implemented and locally tested.
- `src/facet/generation-0/`: `main-facet.ts` (`MainFacet extends DurableObject`, `fetch` ->
  `handleGeneration0Request`, `startTurn(projectTarget, request)` -> `startFacetTurn`),
  `pi-agent-turn.ts` (`runPiAgentTurn` wires `@cf-stumble/pi`'s `Agent` with
  `createReadTool/createWriteTool/createEditTool/createBashTool`, `MAX_MODEL_CALLS`,
  `GENERATION_0_SYSTEM_PROMPT` from `turn.ts`), `workers-ai-adapter.ts` (Pi<->ModelRoute adapter:
  `piContextToRouteRequest`, `routeResponseToPiAssistant`), `execution-env*.ts` (RPC-framed
  filesystem/exec bridge to Computer-backed project workspace).
- `src/model-route.ts`: `ModelRoute extends WorkerEntrypoint`, hard-codes
  `MODEL = "@cf/zai-org/glm-5.3-flash"`, `REASONING_EFFORT = "low"`, rejects bodies setting
  `model|reasoning_effort|credentials|endpoint|provider`, validates a closed message union, calls
  `env.AI.run(...)`. Only consumer of the `AI` binding in `wrangler.jsonc`.
- `src/workspace/`, `src/workspace/project/`: Computer-backed WorkspaceHost DO,
  `computer-adapter.ts`, `provisioning.ts`, `harness-build.ts`, RPC protocol (`protocol.ts`).
- `src/workspace-names.ts`: `deriveProjectWorkspaceName` hashes
  `identity + audience + project.id` (SHA-256) into a per-project workspace name
  (`access:<hash>`), separate from `HARNESS_BUILD_WORKSPACE_NAME`.

## Concrete friction / spec-vs-code mismatches (evidence, not speculation)

1. **ADR-0030 not implemented.** ADR-0030 (Human-approved) requires removing `requestId`,
   command fingerprints, and `generation_control_journal`, and says so itself: "The implementation
   still has `requestId`, command fingerprints, and `generation_control_journal`. It must remove
   them from the page, routes, RPC types, Supervisor, and tests." Verified directly:
   `src/supervisor/control/request.ts` types `GenerationRequest.requestId: string`;
   `src/supervisor/control/journal.ts` still exists in full (`JournalRow`,
   `resultFromJournalRow`); `src/routes/generations.ts` requires and validates `requestId` on
   every control/submission body (`isRequestId`, `MAX_REQUEST_ID_LENGTH=200`,
   `REQUEST_ID_PATTERN`) and documents replay-by-request-ID as current behavior in its own
   docstrings; `scripts/deploy/README.md`'s two `curl` examples still send
   `"requestId": "generation-0-$CF_STUMBLE_HARNESS_COMMIT"` / `"activate-generation-0"` and state
   "Both request IDs are journaled." Not re-run: `test/routes/generation-{control,candidates,
   requests,submission}.test.ts` and `test/supervisor/control/*` likely still assert this
   pre-ADR-0030 behavior; contents not opened here.

2. **ADR-0038 (one shared workspace) not implemented.** `computer-integration.md` states: "The
   current implementation still derives a separate Computer workspace name for each project and a
   separate name for harness builds. It must be simplified to use the shared workspace." Verified
   directly: `src/workspace-names.ts` `deriveProjectWorkspaceName` returns a distinct hashed name
   per `(identity, audience, project.id)`, and `HARNESS_BUILD_WORKSPACE_NAME` is a separate
   constant — two workspace identities where ADR-0038 requires one.

3. **ADR-0039 (development-machine workspace) only partially code-evidenced.** The one concrete,
   test-checked artifact: `src/project-provision.ts` exports `MANAGED_AGENT_INSTRUCTIONS`, and
   `test/docs/managed-instructions.test.ts` checks (whitespace-normalized) that it still contains
   the exact `git`/`gh` instruction quoted in ADR-0039. Unrestricted egress, `gh`/GitHub-credential
   wiring, and container lifecycle are evidenced only by a paid-account probe recorded in
   `computer-integration.md` (2026-08-29), not by code in this repo; `wrangler.jsonc` declares
   `containers`/`WORKSPACE_HOST` but a local read cannot confirm live container behavior.

4. **`feature-map.md`'s status table understates HEAD's own code.** The doc (committed one minute
   after the last code commit touching this area) marks "Coding-agent loop: Missing" and "Model
   access: Missing," but `git log` on `src/facet/generation-0/pi-agent-turn.ts` shows real commits
   through `61ac8b2 2026-09-05 01:35:22`, and `src/model-route.ts` /
   `workers-ai-adapter.ts` are complete, not stubs. This does not prove P1's end-to-end "one real
   edit-and-test turn" acceptance criteria are met (no thread-lease-driven browser stream was
   traced, nothing was executed); it only shows the "Missing" label undercounts `src/`. Tests exist
   (`test/facet/generation-0/pi-agent-turn.test.ts`, `tools.test.ts`, `facet-turn*.test.ts`) but
   were not run.

5. **AGENTS.md's `pnpm verify` description omits real steps.** AGENTS.md: verify "runs typecheck,
   format check, lint and the full test suite in that order." Actual `package.json` script:
   `build:pi && verify:vendor && verify:project-protocol && typecheck && format:check && lint &&
   build:module-map && build:loaded-execution-env-fixture && test` — five steps AGENTS.md omits
   (`build:pi`, `verify:vendor`, `verify:project-protocol`, `build:module-map`,
   `build:loaded-execution-env-fixture`); the four named steps' relative order is correct.

6. **No `eslint.config.js` exists.** Linting is `oxlint --type-aware --max-warnings=0`, configured
   by `oxlint.config.ts` (loads local plugin `./tools/oxlint/anti-slop/index.ts`). Its rule
   comments list per-rule violation counts "on adoption" (e.g. `no-unknown-parameters`: 58,
   `no-runtime-typeof`: 40) as ratchet markers, not proof of current-zero state; not recounted here.

7. **No `.github` directory** (`find . -maxdepth 2 -iname .github` empty) — no GitHub Actions CI.
   Only enforcement is tracked `.githooks/pre-commit`, which runs `pnpm verify` against the working
   tree (not the index), is bypassable with `git commit --no-verify`, and by its own comment does
   not run under `jj commit` at all — this repo has both `.git` and `.jj` directories, so that
   bypass path is live.

8. **Split test runtime despite unified tsconfig.** `tsconfig.json` states there is deliberately
   one program now ("Nothing imports node: any more"), but `vitest.config.ts` still runs a second
   `"node"` project (`pool: "forks"`) for `**/*.props.test.ts` (Hegel property tests, since "Hegel
   loads a native generator through Koffi, which workerd cannot run"); each such test is required
   to have a workerd sibling enforced by `test/docs/props-siblings.test.ts`.

9. **`wrangler.test.jsonc` intentionally omits the `AI` binding** present in `wrangler.jsonc`,
   with an inline rationale that declaring Workers AI opens a remote connection per Workers test,
   so one network failure could fail unrelated tests; `test/docs/test-config.test.ts` is asserted
   (not run here) to prove this is the only difference. Both configs share
   `compatibility_flags: ["enable_ctx_exports", "nodejs_compat"]`, with a comment that
   `nodejs_compat` exists only because `@cloudflare/computer` imports `node:crypto`/`node:events`,
   and that Vitest resolves those itself so the suite can pass while `wrangler dev` fails to boot
   without the flag — a documented local/paid divergence risk.

## Missing v0 behavior (feature-map.md table, cross-checked against source where time allowed)
- Tenant page/HTTP routes: table says "Missing," but `src/routes/{page,owner-api,generations,
  recovery,json}.ts` exist with tests in `test/routes/*`; only live paid deployment and
  two-client-same-tenant behavior are unverified.
- Paid deployment: confirmed missing. `scripts/deploy/check-config.sh` only validates env-var
  presence/shape, performs no network or Wrangler calls itself.
- R2 cache + Computer rebuild path (P2): `src/supervisor/artifacts/{cache,builder,resolver,
  build-plan,build-workspace,module-map}.ts` exist; table says "Configured and smoke-tested
  locally," rebuild path still needed — which half is complete was not independently verified.
- Browser-streamed project threads: `src/supervisor/threads/*` exists (store, decisions, messages,
  thread); `src/facet/generation-0/route-stream.ts`/`session-transcript.ts` exist as candidate
  pieces but end-to-end thread-lease-to-browser wiring was not traced here.

## Deferred-by-decision, correctly out of scope (not gaps)
feature-map.md "Deliberately postponed": automatic known-good threshold/fallback activation,
self-repair/self-submission, reconnect/resume/steering/background turns beyond required disconnect
handling, combined project+harness views, multi-tenant signup/roles/teams, provider
selection/subscription login, better cache policy/alarms/thread migration. "Ideas not part of this
release": patch.md profiles, code-server, OS Gadget/Blueprint compat, issue triage/CI webhooks,
custom Git object storage, skills/MCP/marketplace, admin console/metrics/canaries/attestations/GC,
DO-backed Trustix log, R2 Nix cache, rate limiter, sharded KV. None appeared implemented; treat
absence as intended, not a gap.

## Tests / evidence gaps (no test command was run in this investigation)
- All "test coverage exists" claims above rest on file presence/naming (`find test -name
  '*.ts'`), not on `pnpm test`/`pnpm verify` output. This report does not confirm any test passes.
- `.audit/` has ~55 files (e.g. `design-questions.md`, `paid-runtime-evidence.md`,
  `overnight-vertical-path.md`, `sol-autonomous-v0-*-checklist.md`) referenced by feature-map.md
  as open owner questions/evidence notes; contents not read under the timebox.
- Whether `test/supervisor/control/*` and `test/routes/generation-*.test.ts` assert pre-ADR-0030
  journal/request-ID behavior was inferred from source, not from opening the test files.
- `docs/agents/_original-vision-audit.md` and `docs/agents/_cloudflare-viability.md` are marked
  historical/platform evidence, not current decisions (per `domain.md`); not read here.

## Skill checks applied
- `wrangler.jsonc`: SQLite DO migrations (`new_sqlite_classes` v1/v2), `worker_loaders` (`LOADER`),
  `containers`, `ai`/`r2_buckets` bindings match ADR-0027/ADR-0034 as configuration only; runtime
  behavior not independently verified (feature-map.md itself notes "workerd cannot prove these
  integrations").
- `tsconfig.base.json`'s `strict`/`noUncheckedIndexedAccess`/`exactOptionalPropertyTypes`/
  `verbatimModuleSyntax` and `oxlint.config.ts`'s `typescript/no-explicit-any: error` /
  `typescript/consistent-type-imports: error` match TypeScript-best-practices strict-config
  guidance.
