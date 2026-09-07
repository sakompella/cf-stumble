# Implementation plan: the main harness

Execute this with no prior session context. It replaces `src/facet/fixture.ts` with a real
Pi-derived coding agent that the owner can use repeatedly, without weakening the Supervisor's
authority over generations.

Read first, in this order: `docs/agents/domain.md`, `docs/agents/design/overview.md`,
`docs/agents/CONTEXT.md`, `docs/agents/adr/README.md` and every ADR it lists, then
`docs/agents/design/computer-integration.md`. This plan uses the glossary's terms exactly.

Baseline: `main` at `fde5948`, `pnpm verify` green.

## 1. What is being built

One durable Computer workspace holding one repository, one Pi `Agent` loop running inside the
generation facet, sessions that outlive any generation, a small web UI the harness itself can
edit, and a relay that can finally tell a completed turn from a truncated one.

The Supervisor is not restructured. It gains R2 materialization, an accurate completion rule, and
an owner-approval fact. Everything else under `src/supervisor/` is finished and stays as it is.

## 2. Verified facts this plan rests on

Re-verify any of these before depending on it. Each was checked directly, not recalled.

**Pi 0.84.4**, tag `v0.84.4`, commit `b79e4cc834970cca69daebffab7df1da7d1e52c4`, MIT, cloned at
`/tmp/cf-stumble-pi-v0.84.4`.

- `packages/agent/src` imports `node:` in exactly two files, `harness/env/nodejs.ts` and
  `harness/session/testing/conformance.ts`. The loop, tools and types are runtime-neutral.
- `packages/agent/src/harness/types.ts` defines `ExecutionEnv extends FileSystem, Shell`. Every
  method returns a `Result` and is documented as never throwing. Implementations must preserve it.
- `packages/agent/src/agent.ts` exports the stateful `Agent`: `subscribe`, `prompt`, `abort`,
  mutable `state.messages`, caller-supplied `streamFn`.
- `packages/agent/src/harness/agent-harness.ts` is a scaffold. `prompt`, restore, abort, queues,
  navigation, compaction and watch all reject with `HarnessNotImplemented`. Do not build on it.
- `packages/ai/src/api/cloudflare-gateway-binding.ts` exports `createGatewayBindingFetch`, routing
  AI Gateway calls through `env.AI.gateway(id).run(...)`, pre-authenticated in-account.

**Computer**, pinned by ADR-0026 to source `12336475c9fd03f5280a4537a707797fc0131fbd` and image
`ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:4f07bb11b5c9235ecd7ba7a4d9a4bbad52e8fd4366d76ee3dbfa1099c9295c6f`,
cloned at `/tmp/computer-src`.

- **There is no install path.** npm `latest` for `@cloudflare/computer` is `0.2.1` and its version
  list ends there. Its internals `@cloudflare/dofs` and `@cloudflare/computer-rpc` are `private`
  and 404 on the registry. The pinned `0.3.0` pair exists only as source. Section 4.2 handles this.
- The container backend needs `ctx.container`; `container-host.ts:133` throws without it, and
  `examples/container/wrangler.jsonc` declares `containers[].class_name` against a top-level
  exported Durable Object class. **A Dynamic Worker facet cannot host the container**, so the
  workspace lives in a statically deployed Durable Object.
- `proxy.ts` states that props travel through structured clone, that `DurableObjectNamespace`
  references are not clonable, and that only loopback bindings from `ctx.exports.<ClassName>(...)`
  on a top-level-exported `WorkerEntrypoint` pass the runtime's check. This is the supported route
  into a facet; a raw stub in loader `env` is not.
- `backends/worker-shell/adapter.ts:216`: "The store doesn't have a native rename today." **No
  atomic rename.** Session durability must not depend on one.

**This repo.** `src/supervisor/relay/index.ts`'s `bodyOutcome` credits `body-completed` whenever
no `content-length` was declared, so every streamed turn is credited even when a crash truncated
it. ADR-0031 makes relay facts decide known-good, so this defect corrupts recovery's inputs.
`src/supervisor/artifacts/index.ts` still retains module maps in SQLite, contradicting ADR-0034.

## 3. Runtime placement

**The Pi `Agent` and the provider stream run in the main facet. Only filesystem and shell work
happens in Computer. The workspace and session documents live in a static `WorkspaceHost` Durable
Object that is not a generation.**

ADR-0024 requires it: a generation must be able to replace the model loop, prompts, tools and
policies. Running the loop in a container would put executable harness behavior outside the
labeled module map and reduce the startup check to proving a proxy booted.

`WorkspaceHost` owns Computer and an opaque compare-and-swap document table. It holds no prompt,
no model choice, no tool policy, no session schema. The generation parses the document value and
owns every migration of it. The CAS revision is what stops an old facet and a new facet from both
overwriting a transcript, and it sidesteps the missing atomic rename entirely.

One instance, `owner-v1`, with one checkout at `/workspace/repo` and sessions under
`/workspace/.cf-stumble/sessions`. V1 does not switch repositories mid-session.

## 4. Vendoring

### 4.1 Pi

Vendor `packages/{agent,ai,telemetry}` from the pinned tag, plus the root MIT `LICENSE`. Do not
vendor `coding-agent`, `tui`, `protocol`, `client`, `server`, examples or upstream tests.

The closure roots at `api/openai-completions.ts`, not `anthropic-messages.ts`. Workers AI exposes an
OpenAI-compatible endpoint with a free daily allocation, so probes cost nothing and a paid provider
swaps in later without re-vendoring. Its npm dependencies are exactly `openai`, `typebox`, `diff`
and `partial-json`; `ignore` and `yaml` are not in the closure. Measured at 98 KB gzipped with zero
static `node:` imports, per `.audit/_slice2-bundle-probe.md`.

`vendor/pi-v0.84.4/UPSTREAM.json` records repository, tag, commit, copied paths and the command
that produced the copy. `SHA256SUMS` covers every file. `tools/vendor-pi.mts --check` rehashes the
tree, rejects any added, removed or edited file, confirms the licence, and checks runtime imports
against an allowlist. Update mode copies only from a clean checkout at the recorded commit. Never
hand-edit the tree; a workerd incompatibility becomes a small named wrapper outside `vendor/`.

### 4.2 Computer

Vendor the built dist. There is no published package (§2), so `tools/vendor-computer.mts` clones
`cloudflare/computer` at the pinned commit and runs its `rolldown` build, which inlines `dofs` and
`computer-rpc` and leaves only `acorn`, `capnweb` and `just-bash` as real dependencies.
`vendor/computer/COMPUTER_PIN` records the source commit and the ADR-0026 image digest.

Committing build output is the honest trade here. A clone-at-install would put the network on the
install path and make generation builds non-reproducible.

### 4.3 Keeping `pnpm verify` green

`tsc` typechecks every file reachable by import, so excluding a directory from `include` does not
work. Make each vendored tree a real pnpm workspace package that emits `dist/*.js` and
`dist/*.d.ts`. `skipLibCheck` is already on, so emitted declarations are not rechecked, and
harness code imports `@cf-stumble/pi` rather than reaching into vendored sources.

- `oxlint.config.ts`: add `vendor/**` to `ignorePatterns`.
- `oxfmt` reads `.gitignore` and `.prettierignore`, and `vendor/` must be committed, so add a
  `.prettierignore` containing `vendor/`.
- Exactly one `index.ts` in each vendored tree, at its root. `test/docs/module-seams.test.ts`
  enforces seams per directory containing an `index.ts`; deeper ones would make Pi's own internal
  imports read as seam violations.
- `generation/tsconfig.json` holds hand-written harness code to the repo's strict settings.
- `test/vendor/pins.test.ts` asserts the Pi commit, the Computer commit and the image digest match
  ADR-0026, and that `pi-ai`/`pi-telemetry` are pinned exactly. The Pi subset and its driver must
  move together or not at all.

`pnpm verify` becomes: `verify:vendor` (hash and pin checks), `typecheck`, `typecheck:generation`,
`build:generation:check`, `format:check`, `lint`, `test`. Keep that order. `build:generation:check`
bundles to a temporary directory, rejects `node:` imports in the output, parses the module map and
reports byte counts, without writing tracked build output.

**Stop condition.** If the vendoring slice cannot get `pnpm verify` green within a focused day,
narrow the vendored surface rather than adding carve-outs file by file. A vendored dependency that
needs a growing pile of exceptions has become a half-fork.

## 5. Directory shape

```text
generation/                 mutable; one generation; built into the module map
  src/main-facet.ts         MainFacet Durable Object, router, SSE turn endpoint
  src/turn/                 runner, event-to-frame projection, single-flight registry
  src/session/              StoredSession schema, parser, CAS repository
  src/workspace/            ComputerExecutionEnv over the host port
  src/tools.ts              Pi tool binding, gated by TurnMode
  src/model.ts              one fixed model and its StreamFn
  src/ui/                   index.html, app.ts, styles.css
  scripts/build-module-map.mts
src/
  worker.ts                 owner auth, control and status routes, relay forwarding
  workspace-host/           WorkspaceHost DO, ctx.exports proxy, document table
  egress/                   AIGatewayOutbound WorkerEntrypoint
  facet/                    module-map parsing and loader construction
  supervisor/               existing; artifacts/ and relay/ change
vendor/{pi-v0.84.4,computer}/
tools/{vendor-pi.mts,vendor-computer.mts}
```

The module map is one generated module, `main-facet.js`, which ADR-0028 allows. `entryModule` is
that name and the loader identity is the labeled commit SHA and nothing else. Compatibility date,
the egress Fetcher and `globalOutbound` are immutable loader configuration, not a mount key.

Move the fixture to `test/fixtures/`. Production materializes Generation 0 from its labeled commit
like any other generation; there must not be a second production path.

## 6. Seams

```ts
type SessionId = string & { readonly __brand: "SessionId" };
type TurnId = string & { readonly __brand: "TurnId" };

type TurnMode = "inspect" | "modify-harness";

type TurnRequestV1 = {
  readonly version: 1;
  readonly turnId: string;
  readonly mode: TurnMode;
  readonly expectedRevision: number;
  readonly prompt: string;
};

type TurnStreamEventV1 =
  | { readonly version: 1; readonly kind: "assistant-text"; readonly turnId: string; readonly delta: string }
  | { readonly version: 1; readonly kind: "tool-started"; readonly turnId: string; readonly toolCallId: string; readonly toolName: string }
  | { readonly version: 1; readonly kind: "tool-finished"; readonly turnId: string; readonly toolCallId: string; readonly isError: boolean; readonly text: string }
  | { readonly version: 1; readonly kind: "session-saved"; readonly turnId: string; readonly revision: number }
  | { readonly version: 1; readonly kind: "turn-terminal"; readonly turnId: string; readonly outcome: "completed" | "failed" | "aborted"; readonly revision: number };
```

One event per NDJSON line, 256 KiB per line, `content-type: application/x-ndjson`, and the
response declares `x-cf-stumble-completion: turn-v1` with `x-cf-stumble-turn-id`. The final
non-empty line must be exactly one `turn-terminal` for the matching turn.

`TurnMode` is a capability decision, not a prompt instruction. `inspect` exposes `read` only;
`modify-harness` exposes `read`, `edit`, `write`, `bash`. You cannot make a shell command
read-only by inspecting its text, so "change the harness only on explicit request" has to be
enforced by which tools exist in the turn.

The facet's only capability binding:

```ts
type MainFacetEnv = { readonly HOST: MainHarnessHostBinding };

type MainHarnessHostBinding = {
  workspace(): Promise<WorkspaceStub>;
  readDocument(key: string): Promise<DocumentReadResult>;
  compareAndSwapDocument(input: DocumentWrite): Promise<DocumentWriteResult>;
  listDocuments(prefix: string): Promise<readonly DocumentHead[]>;
  controlGeneration(input: { readonly requestId: string; readonly command: GenerationCommand }): Promise<GenerationControlResult>;
};

type DocumentWrite = {
  readonly key: string;
  readonly expectedRevision: number | undefined;
  readonly value: string;
};

type DocumentWriteResult =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly problem: { readonly code: "revision-conflict"; readonly actualRevision: number | undefined } };
```

`MainHarnessHostProxy` is a top-level `WorkerEntrypoint` reached through
`ctx.exports.MainHarnessHostProxy({ props: ... })`, per `proxy.ts`. Its props are plain strings
and numbers: Supervisor id, WorkspaceHost id, generation label. It resolves namespaces at call
time. `controlGeneration` supplies `{ kind: "harness", generationLabel }` itself, so mutable code
cannot claim another generation, and the Supervisor's existing active-generation check revokes the
capability after replacement.

Model egress never enters the generation. `AIGatewayOutbound` is a top-level `WorkerEntrypoint`
that accepts only the configured gateway prefix and calls `createGatewayBindingFetch` on its own
`AI` binding. The Worker Loader passes it as `globalOutbound`. The facet gets no AI binding, no
account id, no provider key. All four arena candidates reached this design independently.

The session document is owned by the generation and treated as untrusted input on read:

```ts
type StoredSessionV1 = {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messages: readonly AgentMessage[];
  readonly turns: readonly StoredTurnV1[];
};
```

The parser checks the version, identifier grammar, message discriminants, unique turn ids, and the
invariant that only the last turn may be running. If the last stored message is an assistant tool
call with no matching result, restore appends one error result per missing call with code
`interrupted-before-result`. It never re-runs the tool.

`ComputerExecutionEnv implements ExecutionEnv` exactly. Every path resolves under `/workspace/repo`
with lexical escapes rejected before the call. `renameFile` returns `FileError("not_supported")`
because pinned Computer has none. Every Computer rejection is caught and returned as a `Result`;
the interface forbids rejecting.

## 7. A browser turn

1. The browser posts `TurnRequestV1`. `src/worker.ts` authenticates the owner and forwards to the
   Supervisor.
2. The Supervisor records a pending relay attempt with request kind `real-turn`. UI and session
   reads are `ordinary` and can never earn credit.
3. `HarnessArtifacts` reads `module-maps/<commit>` from R2. On a miss it asks Computer to
   `git archive` the labeled commit into an isolated build directory, runs the pinned build,
   validates the map, writes R2, and loads it under the same commit. It never checks the commit out
   over the owner's working tree, and never writes module bytes to SQLite.
4. The Worker Loader supplies `HOST` and `globalOutbound`. The Supervisor forwards the ordinary
   request to the facet.
5. `MainFacet` opens the session document, rejects a stale `expectedRevision`, and refuses a second
   live run for the same session with `409`. One turn per session at a time.
6. It builds `ComputerExecutionEnv`, selects tools by `TurnMode`, constructs `Agent` with the
   restored messages and `toolExecution: "sequential"`, subscribes, then calls `prompt`.
7. On every Pi `message_end` it commits the whole session document by CAS *before* emitting the
   corresponding frame. A crash can lose a partial assistant message; it cannot lose an
   acknowledged message or a workspace edit.
8. When `prompt` settles and all writes have landed, it emits `turn-terminal` and closes.
9. The Supervisor relays bytes unchanged while a bounded parser watches line boundaries. EOF after
   a matching completed terminal is `body-completed`. EOF without it, invalid JSON, a mismatched
   turn id, an oversized line or a stream error is `body-failed`. Client cancellation is
   `relay-cancelled` and stays neutral.

## 8. Known-good

Record an ADR amending ADR-0031's eligibility policy before implementing this. Known-good needs
three facts in one evidence era: the latest preparation check passed, at least one `real-turn`
relay ended with a matching completed terminal, and the owner approved that exact generation,
activation id and preparation-check id. Store approval as an append-only fact, never a mutable
flag. The model has no generation-control tool in V1; after an explicit `modify-harness` turn
commits source, the owner submits and approves through immutable routes.

## 9. Slices

Each ends in a runnable check. Do not start one before the previous check passes.

**1. Prove the paid path.** No product code. A throwaway gateway plus a tiny facet: load it through
the Worker Loader with the gateway as `globalOutbound`, reach `WorkspaceHost` through the
`ctx.exports` proxy, run a container command on the pinned Computer pair, stream a synthetic model
response, and confirm an unapproved outbound URL is rejected. Save latency and raw failures.
*Stop* if the proxy cannot cross loader cloning, if the pinned pair cannot persist a file and run
`pnpm`, or if egress is not actually constrained. Do not fake this locally.

**2. Vendor Pi and Computer.** Both trees, the manifests, the hash and pin checks, the workspace
packages emitting `dist`, the gate changes in §4.3, and a bundle that loads through
`loadMainFacet` and answers `GET /`. *Check:* `pnpm verify` green, module-map size recorded.
*Stop* per §4.3's day box, or if the bundle needs Node shims.

**3. R2 materialization.** Replace SQLite retention with the R2 cache and the Computer builder.
Startup checking and serving both resolve through it. *Check:* tests for hit, miss then write,
corrupt object, build failure leaving the old generation serving, loader reuse for the same SHA,
and a schema test proving no module-source table remains. *Stop* if a rebuild of one commit yields
a different map; that disproves ADR-0034's determinism assumption and needs a decision, not a
workaround.

**4. Workspace, sessions, tools.** `WorkspaceHost`, the document table, `ComputerExecutionEnv`, the
session parser and CAS repository, `TurnMode` tool gating, the single-flight registry. *Check:*
CAS conflict and restart tests; a read/edit/write/bash sequence over a fake port; `inspect` exposes
no write-capable tool; the parser rejects every illegal turn-state combination.

**5. Completion before credit.** Request kinds on relay attempts, the bounded NDJSON observer, the
terminal rule, owner approval facts, the amended eligibility. *Check:* property tests splitting
every protocol example at every byte boundary, plus truncation after headers, a marker split across
chunks, a spoofed marker inside assistant text, cancellation, a failed terminal, and static traffic.
*Stop* known-good promotion until this is green.

**6. Model, UI, and the loop closed.** The fixed model through the gateway entrypoint, the small UI
under `generation/src/ui/`, and the owner control routes. *Check:* `pnpm verify`, then the
acceptance run below.

## 10. Acceptance

Seed `/workspace/repo` with a real failing test. Then, in one paid run: fix and commit it through a
`modify-harness` turn; reload and continue the same session with the transcript and workspace
intact; run an `inspect` turn and confirm its tool list holds only `read`; submit a broken
candidate and watch it fail its startup check while the old generation keeps serving; submit the
valid commit, let Computer build it into R2, activate it under an epoch-checked owner request,
complete one terminal turn, approve it, and confirm eligibility; then force the active facet to
fail before headers and confirm the Supervisor records a recovery report, routes to the approved
prior generation, and the same session and workspace still read.

The local half of this runs without a model key or a container: a scripted `StreamFn` driving
`read`, `edit` and `bash` through the full worker, Supervisor, relay and facet path, asserting one
credited `real-turn` attempt and a transcript that survives eviction.

## 11. Scope

**In.** `generation/**`, `vendor/**`, `tools/vendor-*.mts`, `src/workspace-host/**`, `src/egress/**`,
`src/worker.ts`, `src/facet/index.ts`, `src/supervisor/artifacts/**`, `src/supervisor/relay/**`,
`src/supervisor/eligibility.ts`, `wrangler.jsonc`, the build and lint configuration, tests, and the
eligibility ADR.

**Out.** `README.md`. `src/supervisor/recovery/**`, `generations/**` and `control/**` unless
acceptance exposes a defect in their existing contracts. Multiple projects or workspaces, provider
abstraction, model discovery, extensions, skills, MCP, images, session branches, compaction,
steering queues, in-flight turn resumption, autonomous repair, and any tool that lets the model
submit or activate its own generation.

## 12. Risks

- **Bundle and runtime limits.** Stop on an unresolved `node:` import, a loader rejection, or a
  three-tool turn exceeding facet CPU or duration. Narrow the import graph first; moving the loop
  changes the startup and generation model and needs a replacement ADR.
- **Computer drift.** The source and image pins move together or not at all. Never combine npm
  `0.2.1` with the `0.3.0` image.
- **Session conflict.** A CAS conflict during one live turn is a concurrency defect, not something
  to retry around. Abort the turn and inspect routing and facet shutdown.
- **Build reproducibility.** If one commit rebuilds to a different map, keep both and stop; this
  contradicts ADR-0034 rather than merely inconveniencing the cache.
- **Authentication.** The mutable UI exposes generation actions. Put the route behind Cloudflare
  Access, disable `workers.dev`, and compare the authenticated identity against the owner. A header
  check on an open route is not authentication.
- **The facet is not a security boundary against code it runs.** It gets no Supervisor authority and
  no general egress, only the typed host port and one model route.

## 13. A second environment breaks two assumptions

Today there is one environment. `wrangler.jsonc` declares no vars, secrets or environments, and
`src/worker.ts:7` routes everything to a single `env.SUPERVISOR.getByName("facet-spike")`. The
moment a staging, preview or per-branch environment exists, two invariants break, and both break
quietly.

**The R2 cache key has no environment component.** `module-maps/<harnessCommit>` is keyed by the
commit alone. Two environments sharing the `MODULE_MAPS` bucket means either can write the bytes
that the other loads for that commit. If their build inputs differ at all, production can serve a
map built from a different tree while still believing the commit is the authority, which is exactly
what ADR-0027 and ADR-0034 promise it is not. ADR-0034's determinism assumption is stated per
commit; it silently becomes an assumption across environments too. **A non-production environment
must get its own bucket, never an imported production binding.**

**The Computer workspace is a singleton holding real work.** `owner-v1` contains the owner's
repository and sessions. A second environment that imports that binding runs `bash` and `edit`
against live work. **Every non-production environment points at its own workspace instance.**

Relay evidence is the mild case. Preview traffic reaching a shared Supervisor would append relay
attempts to the same ledger, but the request-kind split in slice 5 keeps ordinary traffic from
crediting anything, and known-good additionally requires explicit owner approval, so contamination
is bounded rather than dangerous. Separate Durable Object namespaces per environment remove it
entirely.

Two things a disposable environment would genuinely enable, both unsafe today: running acceptance
step 6, which forces a live harness failure to watch recovery fall back, and testing bootstrap from
empty state, which otherwise means wiping production SQLite and R2. Neither is a reason to depend on
an unreleased platform feature, but both are reasons to keep the binding overrides above explicit
rather than inherited.
