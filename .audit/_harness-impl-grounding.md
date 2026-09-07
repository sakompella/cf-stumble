# Grounding: Pi-derived main harness and mutable web UI

Shared context for every arena candidate. Everything below was verified this session unless it is
marked unproven. Treat unproven items as open, not as background truth.

## The product

cf-stumble is a single-owner coding agent on Cloudflare that can safely upgrade itself. A
**generation** is one labeled harness Git commit. The immutable Supervisor Durable Object loads a
generation's module map into a Dynamic Worker facet through the Worker Loader, checks it starts,
activates it, records evidence about it, and can roll back to a known-good generation.

The Supervisor half is built and tested. The harness half is a fixture. `src/facet/fixture.ts` is
all that a generation currently is, so the product cannot yet do coding work.

The goal of this plan: a minimal but genuinely usable coding agent, hosted in the facet, that a
single owner uses repeatedly for real work, without losing the generation and recovery model.

## What exists in this repo

Read these before planning. Do not skim the ADRs.

- `docs/agents/domain.md` gives the required reading order.
- `docs/agents/design/overview.md`, `docs/agents/CONTEXT.md`, `docs/agents/design/slices.md`,
  `docs/agents/design/computer-integration.md`.
- `docs/agents/adr/README.md` and every human-approved ADR. The load-bearing ones:
  - ADR-0002: a generation is a labeled harness commit; a failed check is an event on that commit.
  - ADR-0003: the Supervisor's SQLite controls activation.
  - ADR-0024: the facet owns the evolvable harness. Mutable harness code lives in the generation.
  - ADR-0027: the labeled commit is the Worker Loader identity. No separate artifact digest or
    mount key.
  - ADR-0028: harness artifacts are module maps.
  - ADR-0029: the startup check is an ordinary request.
  - ADR-0030, ADR-0033: generation requests are journaled and epoch-bound.
  - ADR-0031: relay facts decide known-good.
  - ADR-0032: recovery bounds an episode, it does not perform the repair.
  - ADR-0034: rebuildable module maps are cached in R2, not retained in Supervisor SQLite.
  - ADR-0035: `better-result` only inside process boundaries.
- Source: `src/worker.ts`, `src/supervisor/supervisor.ts`, `src/supervisor/artifacts/index.ts`,
  `src/supervisor/relay/index.ts`, `src/supervisor/startup-check/index.ts`,
  `src/supervisor/generations/`, `src/supervisor/recovery/`, `src/facet/`.
- `wrangler.jsonc` currently binds `SUPERVISOR` (DO, SQLite), `LOADER` (worker_loaders) and
  `MODULE_MAPS` (R2 bucket `cf-stumble-module-maps`). No AI binding, no container yet.
- `package.json`: pnpm, `pnpm verify` = `tsc --noEmit` then `oxfmt --check` then
  `oxlint --type-aware --max-warnings=0` then `vitest run`. Currently green, 30 files / 158 tests.
- `tsconfig.base.json` is strict with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noUnusedLocals`. `tsconfig.json` includes
  `src`, `test`, `*.config.ts` and types against `@cloudflare/workers-types` only.
- `oxlint.config.ts` runs an `anti-slop` plugin with rules like `no-unknown-type-aliases`,
  `no-runtime-typeof`, `no-object-parameters`, `require-safety-comment-for-type-assertion`.
- `test/docs/module-seams.test.ts` and `test/docs/adr-index.test.ts` enforce doc/code invariants.
- `.githooks/pre-commit` runs `pnpm verify`.

Known conflict already in the tree: artifacts are still retained in Supervisor SQLite in
`src/supervisor/artifacts/index.ts`, which contradicts human-approved ADR-0034.

## Known relay defect

`src/supervisor/relay/index.ts` decides completion with:

```ts
function bodyOutcome(expectedBytes: number | undefined, bodyBytes: number) {
  return expectedBytes === undefined || expectedBytes === bodyBytes ? "body-completed" : "body-failed";
}
```

An SSE turn has no `content-length`, so any stream that merely closes is credited as completed,
including one truncated by a facet crash. ADR-0031 makes relay facts decide known-good, so this
defect corrupts the evidence that recovery depends on.

## Upstream Pi

Latest release is **0.84.4**, npm package `@earendil-works/pi-coding-agent`, tag `v0.84.4`, commit
`b79e4cc834970cca69daebffab7df1da7d1e52c4`, MIT. A read-only clone at that tag is at
`/tmp/cf-stumble-pi-v0.84.4`. Read it directly; do not guess API shapes.

Verified this session:

- `packages/agent` (`@earendil-works/pi-agent-core`) has `node:` imports in exactly two files:
  `src/harness/env/nodejs.ts` and `src/harness/session/testing/conformance.ts`. The agent loop,
  tools and session code are runtime-neutral. Runtime deps are `pi-ai`, `pi-telemetry`, `diff`,
  `ignore`, `typebox`, `yaml`.
- `packages/agent/src/harness/types.ts` defines `ExecutionEnv extends FileSystem, Shell`. Every
  method is async, returns `Result`, and is documented as never throwing. That is the seam a
  Computer-backed filesystem and shell would implement.
- `packages/agent/src/agent.ts` exports a stateful `Agent` over `runAgentLoop`, with a
  caller-supplied `streamFn`, tools, steering and follow-up queues, and an event listener set.
- `packages/agent/src/harness/agent-harness.ts` is a scaffold in 0.84.4. `prompt`, `abort`,
  `watch`, compaction, navigation, queues and restore reject with `HarnessNotImplemented`. It
  cannot power V1.
- `packages/ai/src/api/cloudflare-gateway-binding.ts` exports `createGatewayBindingFetch`, which
  translates AI Gateway HTTPS requests into `env.AI.gateway(id).run(...)` binding calls,
  pre-authenticated in-account, rejecting anything outside the configured gateway prefix. Nothing
  else in `packages/ai/src` imports it; it is opt-in per client.
- `packages/coding-agent` is Node-centric: its tools import `node:path`, `node:fs`,
  `child_process`, and `@earendil-works/pi-tui` even when no terminal UI is used. `core/tools/`
  read/bash/edit/write are 258-544 lines each and carry terminal rendering.
- Pi also ships experimental `packages/protocol`, `packages/client`, `packages/server` for
  transport-neutral sessions over framed CBOR. Explicitly unstable, no compatibility guarantee.

Unproven: whether Pi's agent core bundles for workerd, module-map size under the Loader limit,
whether an AI binding can be granted to a Dynamic Worker, per-tool Computer latency, facet CPU and
duration limits across a multi-tool turn, and long-lived duplex RPC into a container.

## Computer

Cloudflare Computer is the intended work environment (ADR-0026, `docs/agents/design/computer-
integration.md`). It gives a durable workspace with files and shell. `.audit/computer-
materialization.md` records the measured behavior available so far, including cold-call latency
around 2.6-2.9s. Nothing about Computer has been proven on a paid deployment from this repo.

## Direction already settled with the owner

- One model provider, one repository, one Computer workspace. Coding work first.
- Vendor Pi's source at a pin. Do not depend on an opaque npm upgrade.
- No terminal UI.
- A very small web UI. The owner wants the harness to be able to edit that UI's source directly,
  not through a plugin or extension interface.
- Defer: multi-user, provider abstraction, autonomous repair, broad UI, generalized infrastructure.
- Known-good status stays explicit: startup success, one completed real turn, owner approval.

Open and yours to decide with reasons: runtime placement, exactly what is vendored and where, how
the mutable UI is isolated from the recovery controls, session storage, and slice order.

## Acceptance test the product must eventually pass

1. Fix and commit a real failing test in a real repository.
2. Exit and resume the same session without losing transcript or workspace.
3. Modify the harness repo only on explicit request.
4. Reject a broken candidate while the old generation keeps serving.
5. Activate a valid candidate, complete a real turn, approve it as known good.
6. Force a harness failure; fallback preserves project and session state and records a recovery
   report.
