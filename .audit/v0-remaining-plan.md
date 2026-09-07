# cf-stumble v0 remaining work plan

Live execution checklist for the rest of v0. Supersedes the sequencing in `.audit/v0-completion.md`,
which stays as the argument record, run log, and owner-decision register.

For the owner, this ends with a browser driving a real Pi coding turn against a real Computer
workspace, two isolated projects, and a working generation rollback. For the next engineer, it
replaces a buffered hand-written model loop and session-shaped routes with Pi's own agent loop and
project-shaped routes, and it makes commit materialization real rather than fixture-backed.

The rule this plan enforces: no phase is done until its named evidence exists and the orchestrator
has seen it directly, not as a subagent's summary.

Revision 2, 2026-09-03. Sol rejected revision 1 as an execution sequence and this rewrite applies
all five findings. The changes that matter: the old phases B and D formed a dependency cycle and
are now unpicked; commit materialization moved from late to early because nothing real can be built
without it; the paid-approval gate now blocks one phase instead of five; every phase that hid two
or three deliverables is split; and the done predicate moved out of this repository because an
agent that can edit the evidence cannot be policed by it.

## Ground truth, verified at `959e0ac`

Three scoped explorer subagents mapped the tree and Sol spot-checked the load-bearing claims. All
four held. Corrections from Sol are folded in.

- The workspace has never been wired into a turn. `WORKSPACE` is optional at
  `src/facet/generation-0/capabilities.ts:26-37` and `ArtifactStore.mount()` passes only
  `{ MODEL: modelRoute }` at `src/supervisor/artifacts/index.ts:100`. Orchestrator-verified.
- `mount()` installs capabilities into cached loader environment (`src/facet/index.ts:39-45`) and
  returns only a `Fetcher`. The settled argument forbids binding the project capability there,
  because the loader entry is cached per harness commit and would leak whichever project warmed the
  cache. Orchestrator-verified.
- No project concept exists. Routes are session-shaped at `src/routes/owner-api.ts:130-157`.
  `PROJECT_WORKSPACE_NAME` at `src/workspace-names.ts:6` is an unused string.
- Egress is `none` at `src/workspace/host.ts:40-44`.
- Nothing in the turn path streams. Buffering at `src/model-route.ts:57-68`,
  `src/facet/generation-0/turn.ts:170-196`, `src/supervisor/sessions/turn-operation.ts:115-158`,
  and `src/routes/owner-api.ts:99-114`.
- Page tests parse the client script with `new Function` at `test/routes/page.test.ts:156-176`
  rather than executing it.
- Commit materialization is seam-tested only. `HARNESS_BUILD_CONFIGURATION` declares
  `harnessGitDir: "/harness/.git"` at `src/harness-build.ts:20-23` and nothing provisions that
  repository. Submission invokes the cache-miss builder at `src/routes/generations.ts:153-176`, so
  this breaks the first real candidate.
- Correction from Sol: recovery performing no rollback is intentional under ADR-0032, not a defect.
  Manual rollback already exists at `src/supervisor/control/index.ts:136-167`. Revision 1 was wrong
  to imply otherwise.
- `scripts/probe/run.sh` is unsafe to run: timestamp ids at `:54-66`, no cross-process lock, worker
  deletion neither manifest-driven nor verified at `:214-241`, no `--remote`.

## The Codex provider is rate-limited

A phase E implementer on `openai-codex/gpt-5.6-terra` died mid-run with "The usage limit has been
reached" after about two and a half minutes, having committed nothing. `main` was untouched and no
branch was created, so nothing was corrupted, but the work was lost. Re-dispatched on
`anthropic/claude-opus-5`, which is the right tier for a change this size under the repo's model
guidance.

Two lessons. Dispatch away from Codex until the limit resets. And require several small commits in
every implementer brief, so a provider cutoff loses one commit rather than an entire phase; the dead
agent was building toward a single commit and had nothing to show.

## Agents cannot read this file

`.audit/` is gitignored, so it does not exist in the isolated worktrees implementer agents run in.
Every brief that says "read `.audit/v0-remaining-plan.md`" silently fails that instruction; the
phase C agent reported this directly. Briefs have worked anyway because the phase requirements are
inlined into each one. Keep inlining them, and stop pointing agents at a file they cannot see.

## A recurring trap when verifying agent branches

Four times now an agent branch has shown a diff against `main` that appears to delete large amounts
of landed work, once 2,925 lines including all of phase A and the project catalog. Every time it was
the same artifact: the agent forked before those merges, so `git diff main..branch` reports newer
files as deletions. Always run `git merge-base main <branch>` first, and after merging confirm the
supposedly-deleted files still exist on disk. A real deletion and this artifact look identical in a
diffstat, and the summary an agent writes will not mention either.

## Constraint audit, orchestrator-verified 2026-09-03 at `959e0ac`

Standing constraints the program must not break. Each checked against the file. Re-check all before
the rehearsal.

- `instance_type` is `basic` in both configs, `wrangler.jsonc:37` and `wrangler.test.jsonc:41`.
- The workspace check is `./test.sh` at `src/workspace/host.ts:19`.
- The wrangler configs differ only by name and the AI binding, enforced by a whole-file normalized
  comparison at `test/docs/test-config.test.ts:41-49`. This test is strong; do not weaken it.
- Non-`/api/` requests reach the Supervisor only through `withoutAccessCredentials(request)` at
  `src/worker.ts:31`, now guarded by `test/access-routing.test.ts`. The guard asserts on the request
  the Supervisor actually receives, checks the assertion header and the `CF_Authorization` cookie
  are gone, checks no header value anywhere contains the token, and checks unrelated cookies and
  headers survive so it cannot pass by deleting everything.
- Gap worth noting: `withoutAccessCredentials` at `src/access/credentials.ts:61-76` strips a header
  and a cookie, never a query parameter, and the guard preserves the full URL including its query.
  A credential arriving in a query string would pass through to generated code. Access does not
  normally do this, so it is recorded rather than fixed.
- No secrets in tracked files. `.audit/` is gitignored. `.env` holds `CF_ACCESS_AUD`,
  `CF_ACCESS_TEAM_DOMAIN`, `CF_STUMBLE_HOSTNAME`, `GITHUB_APP_ID`, `GITHUB_CLIENT_ID`, and no value
  from it has entered this plan, the run log, or any agent brief.

## Program checklist

- [ ] Durable checklist path. `.audit/v0-remaining-plan.md`.
- [ ] Durable objective. Ship cf-stumble v0: a browser behind Cloudflare Access drives login
      gating, a streamed Pi turn against a real Computer workspace, two isolated projects, a
      passing candidate generation, activation, a broken candidate, rollback, and survival of
      thread and project files.
- [ ] Done predicate. `pnpm verify && cf-stumble-v0-e2e --url "$URL" --expected-sha "$(git rev-parse HEAD)"`, where the runner lives outside this repository and exits nonzero itself.
- [ ] Named loop. `v0-remaining-audit`.
- [ ] Predicate. `pnpm verify && cf-stumble-v0-e2e --url "$URL" --expected-sha "$(git rev-parse HEAD)"`.
- [ ] Cadence. Reconsider at every phase boundary and whenever an approval gate is answered.
- [ ] Arm it. `skills/poteto-mode/scripts/loop/loop --repo . arm v0-remaining-audit --objective "Ship cf-stumble v0 per .audit/v0-remaining-plan.md" --predicate "pnpm verify" --interval 3600`.
      skip: a host persistent goal already drives this program and its objective and done predicate
      match this checklist. Two drivers would give two sources of truth. The command stays so the
      plan survives without the host.
- [ ] Manual tick. `skills/poteto-mode/scripts/loop/loop --repo . tick v0-remaining-audit`.
      skip: same reason. The host goal's continuation prompt is the tick.
- [ ] Recovery. `skills/poteto-mode/scripts/loop/loop --repo . status v0-remaining-audit`, then
      `skills/poteto-mode/scripts/loop/loop --repo . cancel v0-remaining-audit`, then
      `skills/poteto-mode/scripts/loop/loop --repo . unlock` only when status confirms a dead local
      PID. skip while the host goal drives the program.
- [ ] Optional host adapter. The active pi-goal references this checklist by path and runs the same
      `pnpm verify` gate.
- [ ] GitHub predicate. `skills/poteto-mode/scripts/watch-pr/watch-pr predicate merge-ready --pr <number>`.
      skip: this program lands directly on `main` in a single-owner repository with no pull requests
      and no `.github/workflows`. Use this if v0 ever moves to a PR flow.
- [ ] GitHub evidence. skip: same reason. No PR URL, head SHA, or predicate verdict exists.

## Why the done predicate left this repository

Revision 1's predicate read a JSON file under `.audit/`, which is gitignored at `.gitignore:8` and
writable by the same agents the predicate is meant to police. Sol called it trivially forgeable and
he is right. The runner must be owner-controlled, live outside the writable tree, execute the seven
live scenarios itself, and exit nonzero on failure. A checked-in runner or a checked-in report
cannot police an agent that can edit both.

## Phase A. Byte-framed exec and the Worker-safe protocol boundary

- [ ] Depends on. None. In flight.
- [ ] Change. Worker-safe entry point for the project protocol importing nothing from
      `src/workspace/host.ts`, `computer-adapter.ts`, `@cloudflare/computer`, or `node:*`. Then
      `startExec` emits newline-delimited JSON byte frames, encoded inline before
      `controller.enqueue()` at `src/workspace/project/exec-operation.ts:256-279`, preserving
      `pull()`, `cancel()`, and `{ highWaterMark: 1 }`. Output bounded with Pi's own truncation
      helper. Kill best-effort and nonblocking on any undecodable stream. One shared encoded-frame
      byte limit, split producer-side.
- [ ] Evidence. esbuild metafile assertion excluding Computer and `node:*` from transitive inputs;
      existing lifecycle and race tests retained against byte frames; exact-limit, over-limit,
      fragmented and coalesced frame tests; kill and reader cancellation on every abnormal exit; a
      loaded-isolate test that pauses consumption and one that cancels remotely.
- [ ] Completion. `pnpm verify` green with `test/workspace/project/exec-lifecycle.test.ts:157-180`
      unmodified.

Phase A landed 2026-09-03 as `720fb27`, `pnpm verify` green at 80 files and 581 tests. Four
commits: the Worker-safe protocol split with an esbuild metafile assertion now wired into
`pnpm verify` as `verify:project-protocol`, NDJSON byte framing encoded inline, the facet
`ExecutionEnv` with a bounded frame reader and kill-on-malformed-stream, and a read-ahead
measurement.

Orchestrator-verified rather than accepted. The one-event backpressure test at
`test/workspace/project/exec-lifecycle.test.ts` was touched, which is what I told the agent to stop
for, so I read the whole diff: 22 lines, an import and a `withDecodedEvents` wrapper, every
assertion byte-identical including `expect(handle.readCalls).toBe(1)`. No `TransformStream` and no
`pipeThrough` anywhere; `pull()`, `cancel()` and `{ highWaterMark: 1 }` all survive. I proved the
metafile assertion by adding `import "../host.js"` to `src/workspace/project/protocol.ts` and
watching it exit 1, then confirming a clean tree exits 0.

Measured, not assumed: through a loaded workerd isolate with the consumer paused, two backend reads
occur, not one. The application queue holds one event and workerd's RPC transport adds one more. Our
bound is one event plus one transport read.

Output semantics resolved from the sources: `exec` retains a bounded tail per channel using Pi's own
`truncateTail` at Pi's defaults of 2,000 lines and 50 KiB, so callers still receive strings and no
invented marker corrupts output.

Review finding 1, that the advertised RPC surface could not cross an isolate, is closed.

## Phase B1. Build workspace provisioning, offline

- [ ] Depends on. None. Moved early because nothing real can be built without it, and submission
      already invokes the cache-miss builder at `src/routes/generations.ts:153-176`.
- [ ] Change. Provision the `/harness/.git` repository that `src/harness-build.ts:20-23` declares
      and `src/supervisor/artifacts/build-workspace.ts:103-120` assumes. Make provisioning
      idempotent so an interrupted setup reconciles to the same state. Build from a labeled
      checkout.
- [ ] Evidence. Unit-level tests against a fake workspace covering the missing-repository path, the
      already-provisioned path, and an interrupted-then-resumed run converging. These tests must not
      claim to prove materialization works; that is B2's job and the distinction must be stated in
      the test names.
- [ ] Completion. `pnpm verify` green.

## Phase B2. Prove materialization against a real container

- [ ] Depends on. Phases B1 and C, because provisioning clones over the network and egress is still
      `none`. Owner approval required for a container start. BLOCKED.
- [ ] Change. None to production behavior.
- [ ] Evidence. An integration test traversing `WorkspaceHostModuleMapBuilder`, an R2 cache miss, a
      real checkout, a real build, and Loader startup. Two builds of one fresh commit producing
      byte-identical canonical output. Replace the fake-workspace test at
      `test/supervisor/artifacts/module-map-build.test.ts:111-126`, which supplies both of its own
      outputs through `FakeBuildWorkspace({ outputs: [...] })` and therefore proves nothing about
      determinism. Two local temp-repository builds do not count; they miss the production path.
- [ ] Completion. A candidate submitted from a real commit reaches Loader startup.

Phase B1 landed 2026-09-03 as `1cbc793`, `pnpm verify` green at 524 tests. It adds a `provision`
build step before isolate, checkout and build, which clones the harness repository when absent or
incomplete, holds a recoverable directory lock so a concurrent attempt waits rather than corrupts,
and refuses when the existing remote does not match instead of silently converging. That refusal is
the right call and matches the brief.

Two things the orchestrator found after merging, neither caught by the agent's fake-workspace tests.

First, this cannot work until phase C. The provision step clones over the network and the build
workspace still runs `egress: { mode: "none" }` at `src/workspace/host.ts:43`. Phase C is therefore
a hard prerequisite of B2, not an independent nicety. The code is correct and inert until then.

Second, `shellQuote` was wrong. It emitted `'a'\\''b'` for `a'b`, one backslash too many, which no
shell can parse. Every current caller passes a constant with no quote so nothing was broken today,
but a helper whose only job is safe quoting must be correct before a caller passes a project name
or a branch through it. Fixed and covered in `f2fe291`, verified by reintroducing the extra
backslash and watching the new test fail.

Open question for the owner: the provision step clones a hardcoded
`https://github.com/sakompella/cf-stumble.git` over HTTPS with no credential, so that repository has
to be publicly cloneable. Confirm that is intended, and confirm the harness should build itself from
its own public repository rather than from a configured source.

## Phase C. Egress direct

- [ ] Depends on. None. Extracted from the old phase B so it stops riding along with unrelated work.
- [ ] Change. `egress: { mode: "none" }` becomes `direct` at `src/workspace/host.ts:40-44`.
- [ ] Evidence. A test asserting the configured mode, plus a note in the run log of what outbound
      access this now permits.
- [ ] Completion. `pnpm verify` green.

Phase C landed 2026-09-03 as `f2918ae`, `pnpm verify` green at 583 tests. Rather than flipping a
literal inside the constructor, it extracted `workspaceContainerBackendConfiguration(workspaceId)`
returning the `egress` and `workspace` options, giving a real seam a test asserts against without
starting a container. Orchestrator-verified: the relay fix survived the merge, checked directly
rather than assumed, because this branch also forked before it.

What this opens: both project containers and the harness-build container can now reach arbitrary
internet hosts. ADR-0039 already permits unrestricted project-workspace internet access and
documents the credential risk, so nothing contradicts the change. But ADR-0039 covers the project
workspace only, and the harness-build workspace is a separate instance now receiving the same
access with no ADR discussing it. That is a new owner gate below.

## Phase D. Pi Agent core against synthetic events

- [ ] Depends on. Phase A. Explicitly not gated by the paid probe.
- [ ] Change. Stand up Pi's `Agent` with the four stock tools wrapped in `ExecutionToolContext`,
      state handoff, `toolExecution: "sequential"`, and the eight-model-call bound. Drive it with an
      injected `StreamFn` (`vendor/pi-v0.84.4/packages/agent/src/agent.ts:98-103,216-238`) fed by
      synthetic Pi events, which `createAssistantMessageEventStream` already supports deterministically
      (`test/vendor/pi.test.ts:104-135`). Do not invent provider wire fixtures; synthetic Pi events
      test Pi integration, and phase P's captures test the provider decoder.
- [ ] Evidence. Ordered side effects proving sequential execution, not just the property value.
      Call-limit exhaustion proven to receive no success credit. All ten reachable `ExecutionEnv`
      methods exercised. No operation method throws or rejects.
- [ ] Completion. `pnpm verify` green.

Phase D landed 2026-09-03 as `92a09c0`, `pnpm verify` green at 588 tests, in two commits adding
`runPiAgentTurn`, typed state handoff, stock tools bound through `ExecutionToolContext`, sequential
execution, and the eight-call bound, all driven by synthetic Pi events with no provider involved.

Both evidence requirements Sol insisted on were met properly rather than nominally. Sequential
execution is proven by an ordered log reading `write:start`, `write:end`, `edit:start`, which
concurrency cannot produce, not by asserting a config string equals `"sequential"`. Call-limit
exhaustion returns `{ ok: false, problem: { code: "model-call-limit" } }` with the synthetic
`StreamFn` invoked exactly eight times, so it receives no success credit.

Correction to a settled fact. `.audit/v0-completion.md` records under "Settled by the argument" that
ten `ExecutionEnv` methods are reachable by Pi's four stock tools, listing `canonicalPath` among
them. That is wrong: the unmodified stock tools reach nine. `canonicalPath` has no stock call site.
Every plan since has been sized against the incorrect ten.

The agent closed the gap by configuring `createBashTool` with a `prepare` hook calling
`env.canonicalPath(execution.cwd)` before every command. That is a documented Pi option rather than
a modification of Pi, so the technique is sound, but `ProjectRpcTarget.startExec` already resolves
`cwd` through symlinks server-side, proven at `test/workspace/project/target-symlinks.test.ts:57`
where `/dir-link` reaches the backend as `/project/dir2`. So the hook adds a redundant round trip to
every command purely to make a documented count true, and it does `throw cwd.error`, throwing a
non-`Error` inside a hook. Orchestrator decision: remove the hook and record nine, folded into the
phase E brief because it touches the same directory. An honest nine beats an engineered ten.

Deletion list for phase Q, from the agent: `callModel`, `modelProblem`, `completed`, `runToolCalls`,
`advanceTurn`, `runGeneration0Turn`, then the session transcript functions, manual tool planning and
execution, the Workers AI adapter conversions, and `MODEL_CALL_LIMIT_NOTE`.
`GENERATION_0_SYSTEM_PROMPT` and `MAX_MODEL_CALLS` stay live through the new seam and should move out
of `turn.ts` first.

## Phase E. Dynamic Worker turn RPC through a loaded isolate

- [ ] Depends on. Phases A and D.
- [ ] Change. Expose a facet turn RPC that accepts a request-scoped `RpcTarget`, replacing the
      `Fetcher`-only mount contract at `src/facet/index.ts:39-45`. Byte streaming, workspace stub
      duplication, and cancellation.
- [ ] Evidence. A loaded-isolate test passing a live capability as an RPC argument. Cancellation
      proven to dispose the duplicated stub on success, error, and cancel.
- [ ] Completion. `pnpm verify` green.

Landed 2026-09-03 as `b1ebb0d`, `pnpm verify` green at 86 files and 609 tests, in six commits.
`MainFacet.startTurn(projectTarget, request)` takes the capability as an RPC argument, and
`src/facet/generation-0/project-capability.ts` duplicates the received stub under a one-shot lease
because Workers RPC disposes a parameter stub when the call returns while the turn outlives that
call. `src/facet/generation-0/route-stream.ts` drives Pi's `Agent` from the host `ModelCapability`
and declares zero cost and zero context window rather than inventing values Generation 0 cannot
know. Disposal is three separate tests, one per ending, plus a fourth proving a rejected request
releases nothing it never duplicated. `test/facet/loader-environment.test.ts` proves the loader
refuses to carry a capability in a facet environment at all.

Orchestrator-verified. Deleting `duplicate[Symbol.dispose]()` failed all three disposal tests
independently plus two lease tests; deleting the `signal?.aborted` guard failed the cancel test.
All five pre-existing `pi-agent-turn.test.ts` tests survive verbatim, the 70 deleted lines being the
extraction of `test/facet/generation-0/scripted-model.ts`. The implementer mutation-tested its own
loaded-isolate disposal assertion, found it passed with the release removed because the runtime
reclaims at context teardown, and relabelled it rather than letting it pose as a path guard.

## Phase F. Project catalog and configuration

- [ ] Depends on. None.
- [ ] Change. Two immutable projects defined in configuration, with server-resolved project ids and
      workspace names derived from verified tenant plus project id, replacing the unused
      `PROJECT_WORKSPACE_NAME`.
- [ ] Evidence. A test proving two projects resolve to different workspace names, and that a name
      cannot be influenced by client input.
- [ ] Completion. `pnpm verify` green.

Landed 2026-09-03 as `948d631`, `pnpm verify` green at 521 tests. `src/project-catalog.ts` holds
exactly two frozen projects with branded `ProjectId` and `PublicRepositoryUrl` types parsed at
configuration load, and the module throws at import if the catalog is invalid, so an invalid catalog
cannot reach runtime. `src/workspace-names.ts` derives `access:<sha256>` from identity, audience and
the resolved catalog project. Orchestrator-verified security property: `deriveProjectWorkspaceName`
takes a `Project`, never a raw string, and `resolveProject` returns `invalid-project-id` or
`unknown-project-id` without producing a name, so no client-supplied value can reach a workspace
name. Repository URLs are `example.invalid` placeholders until the owner names the real ones.

## Phase G. Idempotent project repository provisioning

- [ ] Depends on. Phases B1, C, F. Sol flagged that revision 1 never said how the two public
      repositories get cloned or reconciled after an interrupted setup.
- [ ] NOT blocked on the owner naming the repositories. Review 2026-09-03 confirmed a public clone
      needs no credential: ADR-0039 puts the GitHub credential in *connecting* a project and pushes
      delivery into phase T, and no file in `src/` reads `GITHUB_APP_ID` or `GITHUB_CLIENT_ID`.
      Substituting a real URL for an `example.invalid` placeholder is a configuration edit.
- [ ] Two things G must add that the line below hides. The project surface physically cannot clone
      today: `CONFIGURATION` at `src/workspace/host.ts:17-21` is `commands: { check: "./test.sh" }`
      and `planWorkspaceRequest` at `src/workspace/decisions.ts:126-133` refuses any `run-command`
      whose name is not a key of `configuration.commands`. And the repository URL must be resolved
      server-side from `PROJECT_CATALOG` by project id, never passed in the request, since a
      caller-supplied URL would reach a shell string behind nothing but `shellQuote`
      (`src/harness-build.ts:59-61`). The workspace name is an opaque `access:<sha256>`
      (`src/workspace-names.ts:12-22`) and cannot be inverted, so the id has to travel and be
      validated.
- [ ] Evidence limit, stated up front. The Workers vitest pool has no `node:child_process` and the
      only Node project in `vitest.config.ts:21-29` matches `test/**/*.props.test.ts`, so no test
      here can run a shell. G's test can prove emitted shell text and reconciliation order and
      nothing more, exactly like B1's at `test/supervisor/artifacts/build-workspace.test.ts:114-118`.
      That shape already missed two real faults in this repo: the `shellQuote` bug fixed in
      `f2feb91`, and the whole provision step being inert under `egress: none`. G's brief must say
      so rather than let the test pose as proof the clone works.
- [ ] Fold into the container-start gate. `max_instances: 1` at `wrangler.jsonc:36` and
      `wrangler.test.jsonc:40` means two project workspaces and a build workspace cannot coexist,
      and nothing in the tree proves `git` exists in the pinned Computer image.
- [ ] Change. Clone each configured public repository into its project workspace, reconcile on
      restart, and add the managed `AGENTS.md`.
- [ ] Evidence. An interrupted-then-resumed provisioning test converging to the same state.
- [ ] Completion. `pnpm verify` green.

Landed 2026-09-03 as `df96edb`, `pnpm verify` green at 93 files and 643 tests, in three commits plus
a harness auto-commit. `src/workspace/project-provision.ts` plans the clone and the managed
`AGENTS.md`, `provisioning.ts` drives the steps, and the workspace host gained a provisioning
surface **alongside** `commands: { check: "./test.sh" }` rather than editing it, so the required
check command is untouched. `src/shell-quote.ts` now owns POSIX quoting, reusing the helper fixed in
`f2feb91` rather than hand-rolling escaping.

Orchestrator-verified. The request carries a project id and a step name only: `runStep` calls
`host.provision({ kind: "provision-project", projectId, step })` and the URL is resolved server-side
by `resolveProject(field(value, "projectId"), catalog)`. Adding a `repositoryUrl` to that request
failed five tests including the one named for the property, "carries a project id and a step name,
never a repository URL or command text". `./test.sh` confirmed unchanged at `host.ts:31`; the two
wrangler files still differ only by the AI binding and the generated-view header.

**The evidence limit is named in the test files themselves, not just here.** Both
`project-provision-plan.test.ts` and `project-provisioning.test.ts` state that the Workers pool has
no `node:child_process` so no test can run a shell, and `project-provisioning.test.ts` goes further
by citing the precedent: this exact test shape passed while `shellQuote` emitted quoting no shell
could parse. A later reader cannot mistake these for proof that the clone works.

## Phase H. Wire the project capability into a turn

Dependency corrected 2026-09-03 after an adversarial review, and the phase's real content is larger
than the line below says. **H does not depend on G.** Its isolation evidence is that project one
cannot read project two's files, which a write into each empty workspace satisfies; a populated
workspace is not needed. Since K and L sit behind H and I rather than behind G, correcting this
unblocks the whole H, K, L, M, N, O chain without any owner answer.

The review also found work in H that the plan never assigned to anyone, and the orchestrator
confirmed each finding directly:

- `ProjectRpcTarget` (`src/workspace/project/target.ts:52`) is constructed at twelve sites and every
  one is under `test/`. Nothing in `src/` ever produces one.
- `WorkspaceHost` (`src/workspace/host.ts`) exposes `execute` at line 62 and `build` at line 77, and
  nothing that returns a project capability.
- The Supervisor's binding is `WORKSPACE_HOST: BuildWorkspaceNamespace` at
  `src/supervisor/supervisor.ts:56`, so it can reach the build surface only.

So H's real deliverable is the `WorkspaceHost` to `ProjectRpcTarget` to Supervisor plumbing, plus
dropping the now-dead optional `WORKSPACE` capability at
`src/facet/generation-0/capabilities.ts:34`. Without it `MainFacet.startTurn` stays a well-tested
orphan that nothing calls.

- [ ] Depends on. Phases E, F. This is the phase revision 1 had cycling with D.
- [ ] Change. Pass the project capability as a request-scoped RPC argument on every turn. Never
      loader environment.
- [ ] Evidence. A test proving the capability is unreachable through loader environment. A real
      Computer isolation test proving project one cannot read project two's files, not merely that
      their names differ.
- [ ] Completion. `pnpm verify` green and a turn reaching a real workspace.

Landed 2026-09-03 as `aebbe06`, `pnpm verify` green at 89 files and 622 tests, in five commits plus a
merge. `WorkspaceHost` now hands out a `ProjectRpcTarget`, the Supervisor reaches the project
surface through a new `src/supervisor/projects/` module, and the dead `WORKSPACE` capability slot is
gone. `MainFacet.startTurn` is no longer an orphan.

Orchestrator-verified. Making both projects hash to one workspace name failed exactly one test,
`project-turn.test.ts > "a turn for one project cannot read the file another project's turn wrote"`,
so the isolation evidence asserts real file access rather than differing names. `main` is a true
ancestor of the branch and a grep for `SessionStore`, `supervisor/sessions` and `runSessionTurn`
across `src` and `test` returns nothing, so the merge did not resurrect the old storage to pass.

The implementer refused a lint suppression when `oxlint` reported `max-dependencies` on
`supervisor.ts` (12 against a limit of 10) and instead gave the new work its own `bindings.ts` and
`projects/index.ts` seam. The file now sits at 288 lines and 10 dependencies with the thread surface
also in it, so both caps hold honestly.

**A name collision a mechanical merge would have gotten wrong.** Phase I's thread rewrite already
owned `startProjectTurn`, where it means the lease. Phase H's independent work used the same name
for streaming the turn. Git could not see the clash because the two edits were in different hunks.
The implementer renamed its own to `streamProjectTurn` rather than letting one name mean two things
inside the Supervisor's own modules.

**Deliberately not wired, and the reason is a real design question.** `streamProjectTurn` touches no
thread. The halves do line up, since `PiAgentTurnState.messages` is the same `AgentMessage[]` that
`finishProjectTurn` parses and the terminal frame carries it. Joining them requires deciding who
observes the terminal frame when the browser is draining the stream, which is the open disconnect
question in `overview.md` and the crediting rule in ADR-0037. That belongs to phases K and L; half
wiring it here would have silently baked in an answer.

**A stale justification the implementer retracted rather than let stand.** Commit `84b486a`
originally justified keeping the buffered tool path with "sessions still posts `/turn`", and phase I
deleted that poster. The conclusion survives for two different reasons it then checked: `POST /turn`
is still reachable on the facet through the Supervisor's relay, so it is a live route rather than
dead code, and `turn.ts` still owns `GENERATION_0_SYSTEM_PROMPT` and `MAX_MODEL_CALLS`, which the
streamed path imports. Retiring it is still phase Q's job.

## Phase I. Per-project thread storage

- [ ] Depends on. Phases D, F.
- [ ] Change. Replace session-keyed storage at `src/supervisor/sessions/index.ts:29-50` with
      per-project storage of Pi `AgentMessage` entries, including the four harness variants
      `bashExecution`, `custom`, `branchSummary`, and `compactionSummary`.
- [ ] Evidence. Round-trip for every message variant. A fresh-thread test proving both that
      workspace files survive and that the old conversation is actually gone, since a reset that
      never touches the workspace passes a files-survive assertion trivially.
- [ ] Completion. `pnpm verify` green.

Landed 2026-09-03 as `4700318`, `pnpm verify` green at 87 files and 615 tests, in four commits.
`src/supervisor/threads/` replaces `src/supervisor/sessions/`: a `project_threads` table keyed by a
resolved `Project`, a per-role field schema in `message-fields.ts`, and encode/decode in
`messages.ts`. The turn lease survives as `startProjectTurn` / `finishProjectTurn` /
`abandonProjectTurn` with optimistic concurrency intact.

Orchestrator-verified. Deleting the `DELETE FROM project_threads` line at `store.ts:59` failed the
graded test plus two others, and the two workspace assertions still passed, which is exactly the
asymmetry the brief demanded. The variant enumeration is structurally guarded: `StoredFields<R>` is
a mapped type with `-?` over the role's keys, so both a dropped field and a new union variant fail
`tsc` rather than silently skipping.

**A platform constraint the plan did not know about, confirmed by the orchestrator directly.**
Workers RPC will not carry a Pi `AgentMessage` across a Durable Object boundary *at the type level*:
`Rpc.Serializable` rejects any type containing `unknown`, and Pi declares `CustomMessage.details`
and an assistant diagnostic's `details` as `unknown`. A `T extends Rpc.Serializable<T>` probe
compiled against the real façade shows `user` and `toolResult` pass while `assistant` and `custom`
fail. The bytes clone fine at runtime; only the type check fails, and the failure is silent, because
a method returning a union quietly loses its success arm at the call site. So the RPC surface hands
the conversation across as stored JSON text plus a `messageCount`, with `parseThreadMessages`
exported for callers. Recorded in ADR-0035.

**Scope note, and the one thing to watch.** The old document-based turn driver went with the
sessions module: `turn-operation.ts`, `runSessionTurn`, `POST /api/sessions/:id/turn`, and the
page's chat send. That driver exchanged an opaque document with the facet's HTTP `POST /turn` over a
schema that is not Pi messages, so once storage holds `AgentMessage[]` it had nothing coherent to
write, and it could not be upgraded in this unit because `runPiAgentTurn` needs an `ExecutionEnv`
built from a request-scoped project capability. **The app therefore has no chat send until phase L
lands the SSE transport.** This is not a Definition-of-Done regression: scenario 2 requires a first
delta to arrive before provider completion, which the deleted buffering driver could never have
satisfied. It is a real temporary gap, and phase L is now the phase that restores user-visible
chat rather than merely improving it.

## Phase J. Compaction

- [ ] Depends on. Phase I.
- [ ] Change. Selective export with a threshold via `transformContext`.
- [ ] Evidence. A threshold-crossing test proving compacted context is dropped and a summary
      replaces it.
- [ ] Completion. `pnpm verify` green.

## Phase K. Turn coordinator and lease

- [ ] Depends on. Phases H, I.
- [ ] Change. Per-project turn lease. Expiry marks the operation unresolved and never admits a
      second workspace-mutating turn until the prior execution is killed or reconciled.
- [ ] Evidence. A test refusing a second concurrent turn. A test proving expiry marks unresolved
      rather than silently freeing the lease.
- [ ] Completion. `pnpm verify` green.

## Phase L. SSE transport and cancellation

- [ ] Depends on. Phase K.
- [ ] Change. Direct cancellable SSE `POST`. Disconnect cancels the Pi `Agent`, kills and reconciles
      Computer executions, and persists messages.
- [ ] Evidence. A disconnect test proving the command is killed and the operation marked.
- [ ] Completion. `pnpm verify` green.

## Phase M. Relay accounting

- [ ] Depends on. Phase L.
- [ ] Change. Credit only after terminal success plus durable save. Fix the bug at
      `src/supervisor/relay/index.ts:142-149` where a streamed body without `content-length` can
      falsely count as complete.
- [ ] Evidence. A regression test for the `content-length` bug. A test proving no credit on
      cancellation.
- [ ] Completion. `pnpm verify` green.

The `content-length` half of this phase landed early as `dc60198`, `pnpm verify` green at 582 tests,
because it depended on nothing. `bodyOutcome` now requires both a clean stream termination, observed
through `reader.closed`, and a matching byte count when `content-length` is declared. Previously a
missing `content-length` alone scored `body-completed`, so a truncated SSE stream would have been
credited as finished work once phase L lands. The agent showed the assertion flipping from
`body-completed` to `body-failed` before and after, and confirmed `attempt.ts` and `attempts.ts`
needed no change. What remains in this phase is crediting only after terminal success plus durable
save, which still depends on K and L.

## Phase N. Project routes

- [ ] Depends on. Phase L. The credential-strip guard now exists at `test/access-routing.test.ts`,
      so this dependency is satisfied.
- [ ] Change. Replace session routes at `src/routes/owner-api.ts:130-157` with project routes.
- [ ] Evidence. The guard test still passing, proving non-`/api/` requests remain stripped after the
      handler is restructured.
- [ ] Completion. `pnpm verify` green.

## Phase O. Project UI

- [ ] Depends on. Phase N.
- [ ] Change. Sidebar, incremental streamed rendering, fresh thread control, generation controls.
      Update `src/page/element-ids.ts:20-25`, `markup.ts:25-51`, `script-turn.ts:85-125`.
- [ ] Evidence. The client script executed in a real browser against a real server, replacing the
      `new Function` parse at `test/routes/page.test.ts:156-176`. Mocked HTTP does not count.
- [ ] Completion. `pnpm verify` green plus a browser run.

## Phase P. Capture the provider stream

- [ ] Depends on. Owner approval for exactly two paid inference calls. BLOCKED.
- [ ] Change. None to production behavior. Capture one text stream and one fragmented tool-call
      stream from `@cf/zai-org/glm-5.3-flash`.
- [ ] Evidence. Raw bytes stored under `.audit/evidence/`.
- [ ] Completion. Two captures exist and no invented fixture is in the tree.

## Phase Q. Provider decoder and old-loop deletion

- [ ] Depends on. Phases D, P. This is now the only phase the paid gate blocks.
- [ ] Change. Stream the Workers AI response, replacing one-shot `ModelInference.run()` at
      `src/model-route.ts:57-68`. Adapt provider events into Pi's stream. Delete `advanceTurn`,
      `runToolCalls`, `callModel`, `completed`, `runGeneration0Turn`, the bespoke
      `workers-ai-adapter.ts` conversion, the `session-transcript.ts` schema, `invokeFacetTurn` and
      `parseFacetTurnResult`. Bound response bytes, calls, tools, and wall time.
- [ ] Evidence. Replay of the captured bytes at arbitrary chunk boundaries. First-delta liveness
      before provider completion. Rejection of unknown shapes, malformed SSE, EOF without the
      terminal marker, invalid arguments, and unrequested tools.
- [ ] Completion. `pnpm verify` green and no buffered drain left in the turn path.

## Phase R. Early real-turn checkpoint

- [ ] Depends on. Phases B2, H, Q. Owner approval required. BLOCKED.
- [ ] Change. None. One disposable workspace, one streamed Pi turn that reads, edits, runs
      `./test.sh`, and returns text.
- [ ] Evidence. A transcript captured through the browser and SSE path, not an internal call, with
      the workspace file state before and after.
- [ ] Completion. Behavior matches the local contract, or the program stops and reports the
      difference.

## Phase S. Remaining eight ExecutionEnv methods

- [ ] Depends on. Phase R. SCOPE QUESTION: Sol notes these eight are unreachable by the four stock
      tools and appear nowhere in the Definition of Done, so this should not gate release unless the
      owner expands v0.
- [ ] Change. Implement the eight methods currently resolving `FileError("not_supported")`.
      `cleanup()` stays a resolving no-op.
- [ ] Evidence. Per-method tests including error paths.
- [ ] Completion. `pnpm verify` green.

## Phase T. GitHub delivery broker

- [ ] Depends on. Phase G. Owner decision on ADR-0039 required. SCOPE QUESTION: also absent from the
      Definition of Done.
- [ ] Change. Push through a Worker-side broker using `GitPushOptions.onAuth`, which runs in the
      Worker isolate. `GITHUB_APP_ID` and `GITHUB_CLIENT_ID` are now in `.env`, so an App
      installation token is the likely source. Exact-URL auth, generated branch, matching pull
      request, no arbitrary remote, ref or base, no force, no delete, idempotent retry.
- [ ] Evidence. A non-matching URL receives no credential. Force and delete rejected. Idempotent
      retry proven.
- [ ] Completion. `pnpm verify` green and no credential reachable from workspace shell code.

## Phase U. Repair the paid cleanup lever

- [ ] Depends on. None. Owner approval required. BLOCKED.
- [ ] Change. Repair `scripts/probe/run.sh`: random run ids replacing timestamps at `:54-66`,
      cross-process one-run enforcement, manifest-only deletion including workers at `:214-241`, an
      explicit `--remote` flag, verified deletion. Then remove
      `probe/probe-1788408728/module-map.json` and prove absence.
- [ ] Evidence. A dry-run transcript, the deletion manifest, proof of absence.
- [ ] Completion. The stale artifact is gone and the script refuses to run twice.

## Phase V. Release driver

- [ ] Depends on. Phases M, O, R.
- [ ] Change. A release driver where every external action is single-use.
- [ ] Evidence. A dry run showing each action guarded.
- [ ] Completion. `pnpm verify` green.

## Phase W. Rehearsal

- [ ] Depends on. Phase V. Owner approval required. BLOCKED.
- [ ] Change. None. One disposable full rehearsal of all seven scenarios.
- [ ] Evidence. The external runner's nonzero-or-zero exit, plus its report.
- [ ] Completion. Seven of seven pass.

## Phase X. Deploy and record

- [ ] Depends on. Phase W. Owner approval required. BLOCKED.
- [ ] Change. None.
- [ ] Evidence. The recording and the runner verdict against the deployed instance.
- [ ] Completion. The done predicate passes.

## The seven scenarios

Revision 1 counted these instead of naming them, which Sol correctly rejected. Each must assert
concrete values, not that a page rendered.

1. **Login gating.** An unauthenticated request is refused and derives no Durable Object name. A
   valid non-owner is refused. The owner is admitted. Assert status codes and that no Supervisor
   name was derived for the refused cases.
2. **Streamed edit and check.** A turn reads a file, edits it, runs `./test.sh`, and returns text.
   Assert the exact command, its exit code, the file hash before and after, and that the first
   delta arrived before provider completion.
3. **Two-project isolation.** A turn in project one cannot read project two's files. Assert on real
   Computer file access, not on differing workspace names.
4. **Fresh thread.** Starting a fresh thread clears the conversation and preserves workspace files.
   Assert both: old messages absent, file hashes unchanged.
5. **Passing candidate and activation.** A candidate built from a real commit passes its startup
   check and activates. Assert the active generation label and the deployment id changed.
6. **Broken candidate.** A failing candidate does not become active. Assert the serving generation
   label is unchanged.
7. **Rollback after restart.** Rollback restores the prior generation and survives a controlled
   restart. Assert the active label, the thread contents, and project file hashes.

## The external runner, specified

Row 3 of the completion audit is the largest uncovered requirement and nothing in the codebase
moves it. This section specifies the runner so phases V, W and X have a concrete target, and so any
impossibility surfaces now rather than at rehearsal. Writing this is plan work; building it is
phase V.

Contract.

```sh
cf-stumble-v0-e2e --url <origin> --expected-sha <sha> [--scenario <n>] [--report <path>]
```

It exits `0` only when all seven scenarios pass, nonzero otherwise, and the exit code is the
verdict. A report file is a convenience for humans, never the predicate. It lives outside this
repository because `.audit/` is gitignored and writable by the agents it polices.

How it authenticates. It reuses `tools/access-session.mts`, which mints a disposable Access session
by generating one throwaway signing key, recording the public JWK for `CF_ACCESS_PUBLIC_KEYS`, and
minting one token the Worker then verifies through its ordinary path. That adds no bypass, since
signature, issuer, audience, expiry and identity checks all still run. The runner must never print
the token, and must assert it is absent from anything the browser can read.

How it checks `--expected-sha`. The running instance must report the commit it was built from, and
the runner refuses to score a mismatch. Without this, a green run proves nothing about the tree in
front of you. If no surface exposes the built commit today, adding one is part of phase V.

Per-scenario assertions, beyond the prose in the previous section.

1. Login gating: three requests, unauthenticated, valid non-owner, owner. Assert 401, 401, 200, and
   assert no Durable Object name was derived for the two refusals.
2. Streamed edit and check: assert the exact command string, its exit code, the file hash before and
   after, and a first-delta timestamp strictly earlier than the provider-completion timestamp.
3. Two-project isolation: a turn in project one attempts to read a known path in project two and is
   refused by real Computer file access. Differing workspace names do not satisfy this.
4. Fresh thread: assert prior message ids absent from the new thread, and assert project file hashes
   unchanged across the reset.
5. Passing candidate and activation: assert the active generation label changed and the activation
   id changed. `GenerationStore.active()` at `src/supervisor/generations/index.ts:158-166` exposes
   `generation`, `epoch`, and `activationId`, all locally. There is no Cloudflare deployment id
   involved; a harness generation activation is the deployment in this architecture.
6. Broken candidate: submit a candidate that fails its startup check and assert the active label is
   byte-identical to the pre-submission value.
7. Rollback after restart: roll back, restart the instance, then assert the active label, the full
   thread contents, and every project file hash.

Resolved 2026-09-03, and worth recording because it was my error. I imported Sol's phrase
"deployment ID" into scenario 5 without checking it against the Definition of Done, then raised it
to the owner as a risk that a local rehearsal might never reach seven of seven. The Definition of
Done in `.audit/v0-completion.md` says "a locally running instance" and lists "a passing candidate
generation, activation", with no Cloudflare deployment id anywhere. The activation id at
`src/supervisor/generations/index.ts:166` is the identity, it is local, and the rehearsal can reach
seven of seven without a deploy. The owner question is withdrawn.

## Open owner gates

- [ ] Confirm the harness-build workspace should have unrestricted outbound access. Phase C gave it
      the same `direct` egress as the project workspace, which is what makes `git clone` provisioning
      possible, but ADR-0039 only reasons about the project workspace. The build workspace
      materializes the code the Supervisor then runs, so its outbound access is arguably the more
      sensitive of the two.
- [ ] Approve a container start so materialization can be proven. NEW, and arguably more blocking
      than the paid calls. `CloudflareContainerBackend` and `WorkspaceContainerAPI` appear only in
      `src/workspace/host.ts` and no test has ever started one, so every build test today uses a
      fake workspace that supplies its own outputs. Sol placed materialization early because
      submitting any real candidate calls the cache-miss builder while `/harness/.git` does not
      exist. Phase B1 can be written offline; phase B2 cannot. Note a local container start under
      `wrangler dev` may cost nothing, but the standing constraint covers container starts
      regardless of cost, so this needs your word either way.
- [ ] Approve exactly two paid Workers AI inference calls. Blocks phase P, and P now blocks only Q
      and R rather than five phases. This is the change that makes the closed gate cheap.
- [ ] Decide the ADR-0039 amendment for brokered GitHub delivery and whether the new GitHub App is
      the credential source. Blocks phase T.
- [ ] Answer the scope question: are phases S and T in v0 at all? Neither appears in the Definition
      of Done. If they are out, the program shortens materially.
- [ ] Approve the disposable real-turn checkpoint. Blocks phase R.
- [ ] Approve the paid cleanup repair run. Blocks phase U.
- [ ] Approve the rehearsal and the deploy. Blocks phases W and X.
- [ ] Decide where the external e2e runner lives, since it must sit outside this writable
      repository to be worth anything. This is now the only unanswered question about the runner;
      the scenario 5 deployment-identity worry was my error and is withdrawn.
- [ ] Name the two public repositories the projects are seeded from. **Downgraded 2026-09-03: this
      gates the first real run, not any code.** A review confirmed a public clone needs no
      credential, and no file in `src/` reads `GITHUB_APP_ID` or `GITHUB_CLIENT_ID`; swapping an
      `example.invalid` placeholder for a real URL is a configuration edit. Since no test in this
      repo can run a shell anyway, phase G can be written and merged against the placeholders. They
      must still be public, secret-free, and free of privileged push workflows, per open decision 2
      in `.audit/v0-completion.md`.

## Completion audit, run 2026-09-03 at `aebbe06`

Status words: VERIFIED means the orchestrator inspected the artifact directly; HELD means a process
constraint has not been violated so far; OPEN means no evidence exists yet.

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Units 0 to 18 complete | OPEN | Landed: credential-strip guard (`0ab811a`), F (`948d631`), B1 (`1cbc793`), A (`720fb27`), relay fix (`dc60198`), C (`f2918ae`), D (`92a09c0`), E (`b1ebb0d`), I (`4700318`), H (`aebbe06`), G (`df96edb`). Phase K substantially done but held out of `main` over a lint cap; a finisher is on it. Still unstarted: J, L, M, N, O, Q, S, T, V. Of those only P, R, U, W and X are approval-gated, plus T pending a scope answer. |
| 2 | `pnpm verify` green at every commit | VERIFIED to date | Green at `df96edb`, 93 files, 643 tests, run by the orchestrator in the parent checkout after merging. Phase K was merged, failed the gate on `max-lines`, and `main` was reset to `aebbe06` rather than left red; it is not in `main` until it passes. Tracked pre-commit hook runs the same gate. |
| 3 | Seven browser scenarios pass | OPEN | No scenario has ever run. Largest uncovered requirement, and it has grown: phase I retired the old buffered chat send with the sessions module, so scenario 2 has no user-visible path at all until phase L lands SSE. Scenarios 3 and 4 now have unit-level analogues (`project-turn.test.ts` isolation, `fresh-thread.test.ts`), which is evidence for the code but not for the scenario. |
| 4 | No paid calls, deploys, container starts, or deletion without approval | HELD | None taken. `scripts/probe/run.sh` identified unsafe and not run. |
| 5 | No secrets anywhere | VERIFIED | `.audit/` gitignored; no `.env` value in any plan, log, or brief. |
| 6 | `instance_type` basic | VERIFIED | Re-checked at `b1ebb0d`: `wrangler.jsonc:37`, `wrangler.test.jsonc:41`. |
| 7 | Workspace check `./test.sh` | VERIFIED | Re-checked at `b1ebb0d`: `src/workspace/host.ts:20`. |
| 8 | Non-`/api/` stripped | VERIFIED with guard | `src/worker.ts:31` plus `test/access-routing.test.ts`, merged as `0ab811a`. Orchestrator broke the handler and watched the guard fail, then reverted. Phase N is no longer gated. |
| 9 | Wrangler configs identical except name and AI | VERIFIED | `test/docs/test-config.test.ts:41-49`, whole-file comparison. |
| 10 | Delegate to subagents in worktrees | HELD | Eleven implementer agents, each in its own worktree. Phases H and I overlapped on `supervisor.ts` and were reconciled by the later agent rather than mechanically, which caught a `startProjectTurn` name collision git could not see. |
| 11 | Adversarial cross-check before work starts | HELD | Sol changed the phase A brief in five ways and rejected plan revision 1, producing this rewrite. Sol is Codex-backed and hit its usage limit on 2026-09-03, so the phase G sequencing review ran on Opus instead, per the `AGENTS.md` allowance of either for plan reviews. That review found H's dependency on G was false and that `MainFacet.startTurn` had no production caller; the orchestrator confirmed all three of its load-bearing claims directly before acting. |
| 12 | Approval-gated items untouched | HELD | No code written for P, R, U, W, X, or unit 0. |
| 13 | Orchestrator verifies diffs and real `pnpm verify` | HELD | Every merged branch diff-read and re-verified in the parent checkout. Seven mutation tests run by the orchestrator: exec lifecycle, credential-strip guard, phase A metafile check, phase E disposal lease and abort guard, phase I fresh-thread delete, phase H workspace-name collapse. One implementer bug found and fixed directly (`shellQuote`, `f2feb91`). One surprising subagent claim independently reproduced rather than accepted: a `T extends Rpc.Serializable<T>` probe confirming Workers RPC rejects Pi's `assistant` and `custom` messages at the type level. |
| 14 | Decisions, evidence, questions recorded | HELD | `.audit/v0-completion.md` run log plus this file. |

## Close

- [ ] Every checklist item is checked or marked skipped with a reason.
- [ ] The done predicate passed and the evidence is linked above.
