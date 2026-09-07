# T3a — Make one tenant workspace hold every repository

- **Task**: T3a (wave 1) of `.audit/v0/roadmap-v0.approved.md`.
- **Worktree / branch**: `/tmp/cf-stumble-wt/T3a`, `work/T3a`, based on `d1f2412`.
- **Commit**: `a1bcb7e3077d50067cab83ce6b89e9ed2e56d7df` —
  `refactor(workspace): hold every repository in one tenant workspace`.
- **Gate**: `pnpm verify` passes at that commit: **101 test files, 681 tests** (main: 96 / 658).
  The tracked pre-commit hook ran the same gate, so the commit is green by construction.
- **Clean-build probe**: `scripts/probe/clean-build.sh` at `a1bcb7e` produced two identical module
  maps. Module map sha256 (both builds):
  `d88c820412f2597bdc4fb6a64c786679e2f7192e6f44c862b2cb06c805617995` (905943 bytes, 13 s each).
- **Paid spend**: none. No deploy, no Computer workspace, no Cloudflare API call.

## The layout, in one place

`src/workspace-layout.ts` is the single owner of the workspace layout and of the
repository-relative root:

| Path | Holds |
| --- | --- |
| `/workspace` | The root. Every addressed path lives beneath it. |
| `/workspace/AGENTS.md` | The managed instructions, above every repository. |
| `/workspace/harness` | The owner's editable harness checkout. |
| `/workspace/projects/<project id>` | One connected project's clone. |
| `/workspace/.builds/<commit>` | Build scratch for one labeled commit. Holds no repository. |

## Acceptance criteria

### 1. One server-derived tenant key selects one Workspace Host — HOLDS

The tenant key is the Supervisor's own name. `src/worker.ts` turns a verified Access token into
that name (`deriveSupervisorName(identity, audience)`) and addresses the Durable Object by it, so
`src/supervisor/supervisor.ts` reads it back as `ctx.id.name` and derives one workspace name from
it with `tenantWorkspaceName` (`src/workspace-names.ts`). That one name is used twice in the
constructor region: `HarnessArtifacts.forWorkspace(...)` for builds and `streamProjectTurn(...)`
for project turns.

Deriving the workspace name from the Supervisor's name, rather than hashing identity and audience a
second time, is deliberate: E3's fault was two independent derivations of one idea, and a second
SHA-256 of the same pair would be a second one. `ctx.id.toString()` is the fallback when a Durable
Object id carries no name; both branches are server-derived and tenant-unique.

Removed: `HARNESS_BUILD_WORKSPACE_NAME` (the tenant-blind global build container) and
`deriveProjectWorkspaceName` / `resolveProjectWorkspaceName` (the project-id hashing). Nothing in
`src/` names a workspace from a request field; `ProjectTurnRequest` now carries only `projectId`
and `request`.

Evidence:
- `test/workspace-names.test.ts` — one tenant selects one workspace for builds and every project;
  two identities differ; one identity in two audiences differs; the name carries no project id; an
  empty tenant key throws.
- `test/supervisor/artifacts/build-workspace.test.ts` — "a build runs in the tenant's own
  workspace, not a global build container".
- `test/supervisor/projects/project-turn.test.ts` — two projects of one tenant request exactly one
  workspace name; a second tenant's workspace holds none of the first tenant's files.
- `test/supervisor/projects/supervisor-project-turn.test.ts` — a type assertion that
  `ProjectTurnRequest` is exactly `{ projectId: unknown; request: unknown }`, so no tenant field
  exists for a browser to fill.

### 2. The verified scope admits exactly one owner — HOLDS, with a correction to the premise

**Correction.** The roadmap says "Goal criterion 2 also has no owner-only Access policy anywhere in
the codebase today". That was already false at the base commit. `src/access/index.ts` reads
`CF_ACCESS_OWNER_SUB`, refuses any other verified identity with `not-owner`, and fails closed on a
missing or blank owner subject; `test/access-owner.test.ts` proved it. Those checks landed in
`2f3a7f7` and `2c5f73c`, before this task started. T3a did not add owner-only enforcement; it
widened the scope, closed the caller-supplied-tenant hole, and recorded the deployment
configuration.

What this task added:
- `AccessRequestResult.ok` now carries `scope: { identity, audience }`, the pair the Supervisor
  name was derived from. T6a consumes this instead of deriving a tenant of its own.
- `authenticateAccessRequest` refuses any request carrying a `tenant`, `identity`, `audience`,
  `workspace`, or `supervisor` query parameter, or the matching `x-cf-stumble-*` header, with the
  new reason `caller-supplied-tenant`. The check runs first, before the token is parsed, so no
  identity, Supervisor name, workspace name, or capability exists at that moment. `src/worker.ts`
  answers it `400`; every other refusal keeps its existing `401` / `500`.

Evidence — `test/access/tenant-selection.test.ts` drives the real `worker.fetch` and spies on
`env.SUPERVISOR.getByName`, which is the first call that names anything:
- an unauthenticated request: `401`, `getByName` never called;
- a valid token for another identity: `401`, `getByName` never called;
- the owner's own valid token plus a caller-supplied tenant field (five query forms and one
  header): `400`, `getByName` never called;
- the admitted result carries the configured audience, never a request field.

**Access application and policy T12a must deploy** (recorded in `scripts/deploy/README.md`):
one self-hosted Access application covering the deployed hostname and every path under it,
including `/api/`; one Allow policy with a single include rule naming the owner's identity through
the configured identity provider; the application audience tag supplied as `CF_ACCESS_AUD` and the
owner's stable `sub` as `CF_ACCESS_OWNER_SUB`; no bypass rule, no service-token rule, no second
policy. The Worker verifies the token and the `sub` itself, so it fails closed even if the
application were configured more loosely.

### 3. One owning module for the root; directories, not boundaries — HOLDS

`src/workspace/project/resolve.ts` and `src/facet/generation-0/execution-env-paths.ts` no longer
declare `PROJECT_ROOT`. Both import `WORKSPACE_ROOT` from `src/workspace-layout.ts`, so the
addressed-path translation and the path-escape guard move together or not at all.

The root is the whole workspace, so Pi's filesystem and shell adapters can address a sibling
repository or the managed instructions, and project selection only sets the initial working
directory. That directory is server-derived: `streamProjectTurn` resolves the project id against the
catalog and passes `projectDirectory(project.id)` as a third argument of `startTurn`, beside the
untrusted request rather than inside it (`src/facet/index.ts`, `main-facet.ts`, `facet-turn.ts`).

Kept: malformed-input parsing (`parseAddressedPath`, `parseStartExecInput`), `MAX_FILE_BYTES` and
the exec byte caps, and the symlink-cycle cap — their tests are unchanged apart from the root
string. Removed: the rejected project-as-security-barrier assumption. The old test "a turn for one
project cannot read the file another project's turn wrote" asserted the opposite of ADR-0038 and is
replaced by "a turn may read a sibling repository, because the workspace is one machine".

Evidence:
- `test/workspace/layout.test.ts` — the four directories are distinct and none contains another;
  the build configuration and project provisioning read this layout; what the facet guard admits the
  target can address; a sibling and `../../AGENTS.md` resolve, and `../../../etc/passwd`,
  `/etc/passwd`, and `/workspace/../secrets` do not.
- `test/supervisor/projects/project-turn.test.ts` — across three isolates, a turn writes into the
  selected project's directory, another project's turn writes into its own, a turn reads a sibling
  repository, and a read outside the root fails.
- `test/workspace/project/target-*.test.ts`, `test/facet/generation-0/execution-env-*.test.ts` —
  the existing guard, byte-size and symlink suites, re-run against `/workspace`.

### 4. Provisioning reuses a clone and deletes nothing it did not create — HOLDS

`src/project-provision.ts` now derives one project's directories from its id
(`projectProvisionConfiguration`) and plans a clone that:
- leaves an existing matching clone untouched (no fetch, reset, or checkout), and fails on a remote
  mismatch;
- refuses a populated directory that is not a Git repository, printing which path it refused,
  instead of removing it — the previous plan ran `rm -rf "$repository"` there;
- removes the project root only with `rmdir`, which succeeds only when the directory is empty;
- clones into a fixed staging directory and moves it into place, so an interrupted run leaves the
  previous state and the next run clears the staging directory.

Evidence: `test/workspace/project-provision-plan.test.ts` (the reconciliation text, the refusal
line, and the absence of `rm -rf "$repository"`; each project gets its own directory and one
project's clone names no other repository), `test/workspace/project-provisioning.test.ts` (an
interrupted run and its resumption ask for byte-identical plans; a repeat holds no memory).

### 5. Build scratch never replaces a checkout; same-commit builds cannot collide — HOLDS

- Scratch is `/workspace/.builds/<commit>`, a subtree holding no repository, so the isolate step's
  `rm -rf` can only remove a previous extraction of the same commit. `planHarnessBuild` also
  asserts that the harness checkout is not inside the directory a build deletes.
- The harness provision step no longer replaces `/workspace/harness`. It clones with a working tree
  (it was `--no-checkout`), refuses a populated non-repository, and uses `rmdir` for an empty root.
- Same-commit concurrency is answered in two places rather than with a scheduler. Builds now run in
  the tenant's own container, which removes the cross-tenant collision the global build workspace
  created; and `WorkspaceHostModuleMapBuilder` admits one build per commit at a time, so a second
  request for a commit already building joins it and receives its result. The entry is dropped when
  the build settles, so this bounds a conflict and does not cache a finished build.

I kept the commit-keyed directory rather than a per-build one because both sides plan the same
steps from the commit alone: `CommitBuildWorkspace` matches a step by its source and cwd, so a
random directory name would have to travel in the request for the two plans to agree.

Evidence: `test/workspace/harness-build-isolation.test.ts` (scratch contains no repository; the
isolate step's exact command; the provision step never runs `rm -rf "$repository"`),
`test/supervisor/artifacts/build-concurrency.test.ts` (two concurrent builds of one commit run four
build steps in total, not eight, and both callers get the same module map; a later build runs
again).

### 6. One active-turn lease per project, Pi's default tool scheduling — HOLDS, nothing added

No serialization was added. `test/supervisor/threads/turn-lease.test.ts` and the other thread suites
are unchanged and pass. The shared layout did not need a new lock: the operations that share mutable
state are the harness build scratch (bounded above) and each project's own clone during
provisioning (which already holds a lock in the shell). `toolExecution` appears nowhere in `src` or
the vendored Pi facade, and I did not look for it.

### 7. Re-ran the capability, cancellation, path-mapping and loaded suites — HOLDS

Against the shared layout, all passing: `test/workspace/project/target-{validation,content,writes,symlinks}.test.ts`,
`test/workspace/project/exec-{lifecycle,frame,pending-handle}.test.ts`,
`test/workspace/project/rpc-boundary.test.ts`, `test/facet/generation-0/execution-env-*.test.ts`
(including `execution-env-loaded.test.ts` in a real Worker Loader isolate),
`test/facet/generation-0/facet-turn-{loaded,disposal}.test.ts`, `test/facet/loader-environment.test.ts`,
and `test/supervisor/projects/project-turn.test.ts` (three isolates end to end).

## Changed paths

New:
- `src/workspace-layout.ts`
- `test/access/tenant-selection.test.ts`
- `test/supervisor/artifacts/build-concurrency.test.ts`
- `test/workspace-names.test.ts`
- `test/workspace/harness-build-isolation.test.ts`
- `test/workspace/layout.test.ts`

Modified source and docs:
- `src/access/index.ts`
- `src/facet/generation-0/execution-env-paths.ts`
- `src/facet/generation-0/execution-env.ts`
- `src/facet/generation-0/facet-turn.ts`
- `src/facet/generation-0/main-facet.ts`
- `src/facet/index.ts`
- `src/harness-build.ts`
- `src/project-provision.ts`
- `src/supervisor/artifacts/build-workspace.ts`
- `src/supervisor/artifacts/builder.ts`
- `src/supervisor/artifacts/index.ts`
- `src/supervisor/projects/index.ts`
- `src/supervisor/projects/project-turn.ts`
- `src/supervisor/projects/project-workspace.ts`
- `src/supervisor/supervisor.ts`
- `src/worker.ts`
- `src/workspace-names.ts`
- `src/workspace/executor.ts`
- `src/workspace/host.ts`
- `src/workspace/project-provision.ts`
- `src/workspace/project/index.ts`
- `src/workspace/project/resolve.ts`
- `src/workspace/provisioning.ts`
- `docs/agents/design/computer-integration.md`
- `scripts/deploy/README.md`

Modified tests (the enumerated list; nothing under the files T4 owns):
- `test/access-cookie.test.ts`
- `test/facet/generation-0/execution-env-byte-framing.test.ts`
- `test/facet/generation-0/execution-env-filesystem.test.ts`
- `test/facet/generation-0/execution-env-loaded.test.ts`
- `test/facet/generation-0/execution-env-malformed.test.ts`
- `test/facet/generation-0/execution-env-target.ts`
- `test/facet/generation-0/execution-env-tools.test.ts`
- `test/facet/generation-0/facet-turn-disposal.test.ts`
- `test/facet/generation-0/facet-turn-helpers.ts`
- `test/facet/generation-0/facet-turn-loaded.test.ts`
- `test/facet/generation-0/facet-turn.test.ts`
- `test/facet/generation-0/loaded-execution-env-entry.ts`
- `test/facet/generation-0/loaded-facet-turn-entry.ts`
- `test/facet/generation-0/pi-agent-turn.test.ts`
- `test/facet/loader-environment.test.ts`
- `test/project-catalog.test.ts`
- `test/supervisor/artifacts/build-workspace.test.ts`
- `test/supervisor/artifacts/module-map-build.test.ts`
- `test/supervisor/projects/project-turn-helpers.ts`
- `test/supervisor/projects/project-turn.test.ts`
- `test/supervisor/projects/supervisor-project-turn.test.ts`
- `test/supervisor/threads/fresh-thread.test.ts`
- `test/workspace/harness-build.test.ts`
- `test/workspace/project-provision-plan.test.ts`
- `test/workspace/project-provision-surface.test.ts`
- `test/workspace/project-provisioning.test.ts`
- `test/workspace/project/fakes.ts`
- `test/workspace/project/rpc-boundary.test.ts`
- `test/workspace/project/target-content.test.ts`
- `test/workspace/project/target-symlinks.test.ts`
- `test/workspace/project/target-writes.test.ts`
- `test/workspace/workspace-host.test.ts`

`test/facet/generation-0/facet-turn*.ts` are in that list. They had to change: `startFacetTurn`
gained the server-supplied working directory, and their fake workspaces addressed `/project`. I did
not touch `test/facet/generation-0/route-stream*`, `test/facet/generation-0/workers-ai-adapter*`,
`test/model-route.test.ts`, or `src/facet/generation-0/capabilities.ts`.

## The catalog-less `new ProjectThreads(ctx.storage)`

**Left as a written interface for T6a**, not wired. A real catalog needs stored connected projects,
which is T6a's work; passing the placeholder catalog explicitly would change nothing. The seam is
recorded in the constructor: `new ProjectThreads(ctx.storage, catalog)`. `streamProjectTurn` takes
the same optional `catalog` argument for the same reason, so T6a can supply one catalog to both.

## What I deliberately did not do

- No alarm, scheduler, queue, or retry. The build conflict rule is a map of in-flight builds keyed
  by commit; it defers nothing.
- No paid action: no `wrangler deploy`, no workspace creation, no Cloudflare API call. T3b's
  shared-container concurrency experiment stays blocked on owner approval.
- Did not delete the legacy `WorkspaceHost.execute` surface or `WorkspaceCapability`. They are
  frozen until T7 removes the buffered path. `execute` now roots at `/workspace`, which is the
  honest translation of "the root the clone lands in" once there is no single project root.
- Did not change ADR-0038 or ADR-0039. The code now matches them; no ADR needed editing.
- Did not touch `tools/verify-project-protocol.mts`: the six-method protocol is unchanged.
- Did not rename or re-scope anything in `src/supervisor/supervisor.ts` outside the constructor
  region and the `streamProjectTurn` wiring.

## Noticed, out of scope, not fixed

- `src/facet/generation-0/tools.ts` and `turn.ts` still say "project workspace" in the stock tool
  descriptions and the legacy system prompt. That is the hand-written bounded turn loop that the Pi
  turn superseded; T7 owns those files.
- `WorkspaceHost.execute`'s one command is `check: "./test.sh"`, now run at the workspace root where
  no `test.sh` exists. The surface is already unreachable from any route; T7/T9 delete it.
- `provisionProjectWorkspace` is still unreachable from `src/` (E9's finding). It now takes a
  workspace name and a project id, ready for T6a to call.
- `src/supervisor/supervisor.ts` sits exactly at the 300-line lint limit again, and
  `import/max-dependencies` is at 10 of 10. I moved the builder construction into
  `HarnessArtifacts.forWorkspace` and reached `tenantWorkspaceName` through
  `src/supervisor/projects/index.ts` to stay inside both. The next task to add a line there will
  have to split the file.

## Blockers

None for this task. Everything claimed above is proved by a local command at `a1bcb7e`.

Still blocked elsewhere, unchanged by this task: T3b's shared-container concurrency probe needs
**owner approval for a paid probe**, and goal criterion 7's "two clean Computer builds" needs the
same. The local `scripts/probe/clean-build.sh` result above is a pre-check, not that criterion.
