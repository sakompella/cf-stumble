# src/workspace reader summary (reader-3)

HEAD: d6ff2380487a60f410c568272635d99f30560d14. Read-only inspection of AGENTS.md,
docs/agents/domain.md, docs/agents/CONTEXT.md, docs/agents/design/overview.md,
docs/agents/design/feature-map.md, docs/agents/design/computer-integration.md,
docs/agents/adr/README.md, ADR-0030/0038/0039, and every file under src/workspace/.

## Module map

- `src/workspace/decisions.ts` -- pure parse/plan for the generic `execute()` surface: five
  request kinds (`read-file`, `write-file`, `list-files`, `run-command`, `git-diff`), path
  containment via `resolvePath`, command lookup against a fixed `commands` map.
- `src/workspace/executor.ts` -- thin effect shells (`executeWorkspaceRequest`,
  `executeHarnessBuildRequest`, `executeProjectProvisionRequest`) over `WorkspaceOperations`
  (`lstat`/`readFile`/`writeFile`/`listFiles`/`runCommand`); symlink-checks every path segment
  before touching it; catches Computer errors into `workspace-unavailable`.
- `src/workspace/harness-build.ts`, `src/workspace/project-provision.ts` -- parse/plan for the
  build and provisioning RPC surfaces, delegating fixed configuration from root-level
  `src/harness-build.ts` and `src/project-provision.ts` (platform-free plain-value modules).
- `src/workspace/host.ts` -- `WorkspaceHost extends DurableObject`, one per tenant/project (see
  friction below). Exposes `execute`, `build`, `provision` (parsed `unknown` RPC input) and
  `project()`, returning a `ProjectRpcTarget` capability. Wraps `@cloudflare/computer` `Workspace`
  + `CloudflareContainerBackend`.
- `src/workspace/project/*` -- the narrow six-method `ProjectRpcTarget` (`lstat`, `readFile`,
  `writeFile`, `listFiles`, `startExec`, `kill`) confined to a fixed `/project` root
  (`resolve.ts`), with symlink-safe path resolution, streaming exec via `ReadableStream<Uint8Array>`
  NDJSON framing (`exec-operation.ts`, `protocol.ts`), and a Computer adapter (`computer-adapter.ts`).
- `src/workspace/provisioning.ts` -- `provisionProjectWorkspace`: resolves a workspace name,
  re-runs clone+instructions steps idempotently, returns a `better-result` `Result`.
- `src/workspace/untrusted.ts` -- branded-object boundary helper used everywhere an RPC payload is
  `unknown`.

## Dependencies

Consumes: `@cloudflare/computer` (`Workspace`, `WorkspaceContainerAPI`,
`CloudflareContainerBackend`), `cloudflare:workers` (`DurableObject`, `RpcTarget`), `better-result`,
plus root-level plain modules (`harness-build.ts`, `project-provision.ts`, `project-catalog.ts`,
`workspace-names.ts`, `harness-commit.ts`, `shell-quote.ts`, `invariant.ts`).

Consumed by: `src/facet/generation-0/*` (execution-env*, project-capability.ts, main-facet.ts,
tool-execution.ts) via `ProjectRpcTargetContract` or `WorkspaceRequest`/`WorkspaceResult`;
`src/supervisor/projects/project-turn.ts` (`namespace.getByName(name).project()`);
`src/supervisor/artifacts/build-workspace.ts` (`WorkspaceHostModuleMapBuilder` drives `build()`);
`src/worker.ts` re-exports `WorkspaceHost` as a Durable Object binding.

## Concrete friction found in code

1. **Two parallel project-execution surfaces coexist.** The old generic `execute()` surface
   (`decisions.ts`/`executor.ts`, one fixed check command from `host.ts`'s `CONFIGURATION`) is
   still used by `tool-execution.ts` (`workspace.execute(request)`), reached through
   `MainFacet.fetch` -> `request-handler.ts` -> `turn.ts` (`runGeneration0Turn`,
   `GENERATION_0_SYSTEM_PROMPT`, `MAX_MODEL_CALLS`). The newer narrow `ProjectRpcTarget` surface is
   reached through `MainFacet.startTurn` -> `facet-turn.ts` -> `pi-agent-turn.ts` and is what
   `execution-env*.ts` wires to real Pi tools. ADR-0038 names "the hand-written bounded turn loop"
   as scaffolding, not the version 0 harness -- matches `turn.ts` exactly, so the two surfaces read
   as superseded-but-undeleted code beside its replacement, not two intentional production paths.
2. **Per-project Computer workspace naming contradicts "one shared workspace."**
   `src/workspace-names.ts` derives a distinct `access:<sha256(identity, audience, projectId)>`
   name per project, and harness builds use a separate fixed `HARNESS_BUILD_WORKSPACE_NAME`
   (`buildRoot: "/harness-builds"`). ADR-0038/CONTEXT.md say one workspace holds every repository.
   `computer-integration.md` already names this gap explicitly ("must be simplified to use the
   shared workspace before version 0 is complete") -- acknowledged debt, not a hidden bug.
3. **`parseProjectProvisionRequest`'s optional `catalog` parameter is never supplied by its only
   caller.** `executor.ts`'s `executeProjectProvisionRequest` omits it, so behavior today depends
   entirely on `resolveProject`'s own default (`PROJECT_CATALOG`) lining up with what the caller
   expects -- an unused seam, not evidence of a working alternate catalog.
4. **Fixed two-project placeholder catalog.** `project-catalog.ts`'s
   `PROJECT_CATALOG_CONFIGURATION` hardcodes `project-one`/`project-two` with
   `example.invalid` URLs; no GitHub-connection flow or catalog storage exists under
   `src/workspace` or elsewhere found here.
5. **Fixture still in the production path.** `src/facet/fixture.ts` remains; feature-map.md notes
   "Active-generation facet serving: works locally with `src/facet/fixture.ts`" and lists moving it
   out of application construction as unfinished cleanup.

## Missing v0 behavior (feature-map.md, corroborated by absence in src/workspace)

- Real GitHub project connection, catalog persistence, tenant HTTP routes: **missing**.
- R2 build cache / Computer rebuild path for module maps (ADR-0034): not present in
  `src/workspace`; `harness-build.ts` plans a build but caching/eviction is Supervisor-side and
  still open.
- A single shared workspace per tenant (friction #2): not yet implemented.

## Explicitly deferred by ADR, not a code gap found here

- **ADR-0030**: the ADR text itself states the implementation still has `requestId`, command
  fingerprints, and `generation_control_journal` to remove "from the page, routes, RPC types,
  Supervisor, and tests" -- Supervisor-side, outside `src/workspace`, a named tracked cleanup.
- **ADR-0038**: the shared-workspace requirement is the ADR's decision; the per-project naming in
  `src/workspace-names.ts` is the known, tracked implementation lag documented in
  `computer-integration.md` (friction #2), not a silent contradiction.
- **ADR-0039**: "no egress allowlist, direct git/gh, credential outside repositories" looks
  implemented, not deferred: `workspaceContainerBackendConfiguration`'s `egress: { mode: "direct" }`
  and `project-provision.ts`'s `MANAGED_AGENT_INSTRUCTIONS` match the ADR's required instruction
  text.

## Test coverage observed

`test/workspace/` covers the host RPC surfaces (`workspace-host.test.ts`), provisioning
(`project-provisioning.test.ts`, `project-provision-surface.test.ts`,
`project-provision-plan.test.ts`), the harness build plan, and the `project/` RPC target in depth
(symlinks, writes, exec lifecycle, exec framing, RPC boundary rejection). Consistent with
feature-map.md's claim that "most of the passing tests exercise control machinery" rather than an
end-to-end coding turn.
