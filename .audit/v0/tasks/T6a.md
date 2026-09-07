# T6a — Connect GitHub repositories with a testable credential

- **Task:** T6a (wave 2, `opus-manager`), from `.audit/v0/roadmap-v0.approved.md`.
- **Worktree / branch:** `/tmp/cf-stumble-wt/T6a`, branch `work/T6a`, based on `638890e`.
- **Commit:** `af9a562ab1874396de0ce3b4c0ea57776ef154ae`
  — `feat(projects): connect GitHub repositories with a testable credential`.
- **Gate:** `pnpm verify` passes. 111 test files, 797 tests (base was 103 files, 698 tests).
- **Reproducibility:** `scripts/probe/clean-build.sh` at this commit produced two identical module
  maps, sha256 `8e821d8635751e9bb75db7042aa4925f97b77225378f2d3338134724191327ec`, the same sha as
  main. 913332 bytes, 13 seconds per build.
- **Paid spend:** none. No `wrangler deploy`, no Computer workspace, no Cloudflare API call, no use
  of the owner's GitHub account. Every GitHub call in the tests goes to a scripted provider.

## Changed paths

New source:

- `src/github/redaction.ts`, `src/github/device-flow.ts`, `src/github/credential-commands.ts`,
  `src/github/index.ts`
- `src/supervisor/projects/connected-projects.ts`,
  `src/supervisor/projects/github-connection-store.ts`,
  `src/supervisor/projects/github-connection.ts`,
  `src/supervisor/projects/project-connections.ts`
- `src/workspace/github-credential.ts`, `src/workspace/credential-access.ts`
- `src/routes/projects.ts`
- `docs/agents/design/github-connection.md`

Changed source:

- `src/project-catalog.ts` (variable-length catalog, canonical URL, derived identity; the two
  `example.invalid` entries and `PROJECT_CATALOG`/`PROJECT_CATALOG_CONFIGURATION` are deleted)
- `src/supervisor/supervisor.ts`, `src/supervisor/projects/index.ts`,
  `src/supervisor/projects/project-turn.ts`, `src/supervisor/threads/project-threads.ts`,
  `src/supervisor/env.d.ts`
- `src/workspace/host.ts`, `src/workspace/index.ts`, `src/workspace/project-provision.ts`,
  `src/workspace/provisioning.ts`
- `src/routes/owner-api.ts`, `src/routes/index.ts`, `src/routes/json.ts`, `src/worker.ts`
- `docs/agents/domain.md`

New tests: `test/github/redaction.test.ts`, `test/github/device-flow.test.ts`,
`test/github/credential-surfaces.test.ts`, `test/workspace/github-credential.test.ts`,
`test/routes/projects.test.ts`, `test/supervisor/projects/connected-projects.test.ts`,
`test/supervisor/projects/project-connections.test.ts`,
`test/supervisor/projects/github-authorization.test.ts`,
`test/supervisor/projects/fake-tenant-workspace.ts`, `test/project-fixtures.ts`.

Changed tests: `test/project-catalog.test.ts`, `test/workspace-names.test.ts`,
`test/workspace/{layout,project-provision-plan,project-provision-surface,project-provisioning,workspace-host}.test.ts`,
`test/supervisor/helpers.ts`, `test/supervisor/threads/{threads,fresh-thread,turn-lease,decisions}.test.ts`,
`test/supervisor/projects/{project-turn,project-turn-helpers,supervisor-project-turn}.*`,
`test/routes/{helpers,owner-api,generation-candidates,generation-control,generation-requests,generation-submission,recovery-report}.*`.
The catalog no longer ships projects, so tests that needed projects now use `test/project-fixtures.ts`
or connect them, and the id strings moved from `project-one` to `sample-project-one`.

## Acceptance criteria

### 1. Variable-length catalog, stored per tenant, stable identity, converging duplicates

Holds. `ProjectCatalog` is `readonly Project[]` and `resolveProject` still resolves every consumer's
id, with `EMPTY_PROJECT_CATALOG` as the default instead of two placeholders. The tenant's list lives
in the Supervisor's `connected_projects` table (`connected-projects.ts`).

- Empty, one, two, three projects: `test/project-catalog.test.ts` ("resolves every project of a
  catalog holding %i of them") and `test/supervisor/projects/connected-projects.test.ts` ("holds %i
  connected repositories and resolves every one", "a tenant that has connected nothing has an empty
  catalog").
- Identity independent of order and display name: `projectIdForRepository` derives the id from the
  canonical URL; "identity survives the order of connection and the name a project is shown under",
  "gives one repository the same identity whatever its position or display name".
- Duplicate connection converges: "connecting the same repository again converges on the project
  already there" (same id, `alreadyConnected: true`, list length stays 1). A different repository
  that reduces to an existing id is refused with `project-id-conflict`.
- `example.invalid` entries and the exact-two restriction are deleted; `git grep example.invalid src`
  finds nothing.
- No third container: "a third repository joins the same one workspace, not a workspace of its own"
  asserts every provision and credential call reached one workspace name, `tenantWorkspaceName(...)`.

### 2. Separate GitHub authorization, owner-bound, no token in the browser

Holds for everything that can be proved without the owner's GitHub account.

- Device flow: `src/github/device-flow.ts` (device-code and redemption calls, reply mapping) with
  `test/github/device-flow.test.ts`.
- The app shows only the verification URL and user code:
  `GitHubConnectionStatus` has no token field, and
  `test/supervisor/projects/github-authorization.test.ts` asserts the status carries neither the
  token nor the device code.
- Access sign-in alone grants nothing: a tenant with no authorization reports `disconnected`, and
  the credential the workspace uses comes only from an install.
- Bound to the initiating owner: the pending row stores the verified identity and audience from
  T3a's `AccessRequestResult.scope`; a redemption by another verified owner is refused with
  `not-the-initiating-owner` and installs nothing.
- Replay: the device code is deleted when redeemed, denied, or expired; the second completion
  answers `no-pending-authorization`.
- Cross-origin mutation: every state-changing project route refuses a foreign `Origin` with 403
  before the Supervisor is called (`test/routes/projects.test.ts`).
- The live authorization stays T6b. Every test here uses the fake token
  `ghp_cfstumbleFAKEtokenFAKEtoken0123456789`.

### 3. Documented `GH_TOKEN` credential source for automated runs

Holds. `GH_TOKEN` is a Worker secret read by the Supervisor
(`src/supervisor/env.d.ts`, `supervisor.ts`), installed through the same workspace path as a
device-flow token, and recorded with the source `configured-token` so a status never presents it as
an owner authorization. Documented in `docs/agents/design/github-connection.md` ("The `GH_TOKEN`
fallback"). Evidence: "connects a repository once the workspace credential works, and provisions
it" and "asks for a reconnection after a restart left the workspace without a credential", which
also shows the fallback repairing a workspace with no person present. T9, T10, and T11 can set the
secret and connect repositories unattended.

### 4. Verify access first, install into local `gh` configuration, keep credentials off every surface

Holds, except the live private-repository clone, which is T6b.

- Verification before use: `ProjectConnections.connect` runs `git ls-remote` through the workspace
  before storing or cloning. "keeps a repository the workspace cannot read out of the catalog"
  proves a denied repository is not stored and nothing is cloned.
- Ordinary local credentials: the install runs `gh auth login --with-token` and
  `gh auth setup-git --hostname github.com`, so `git` and `gh` use the normal configuration
  (`test/workspace/github-credential.test.ts`).
- Outside all repositories: the token is staged at `/tmp/cf-stumble-gh-token`, asserted to be
  outside `WORKSPACE_ROOT` and `PROJECTS_DIRECTORY`, and the file is overwritten after the install.
- Not in URLs or command lines: the install command text contains no token; the tests assert that.
- Redaction with a recognizable fake token across the named surfaces:
  `test/github/credential-surfaces.test.ts` drives a whole authorization and then checks tracked
  files and agent documents (no credential-shaped string anywhere in `src/**` or `docs/agents/**`),
  application logs (no module on the credential path calls `console`), browser responses (every
  value the routes return), saved state (every row of every table in the tenant's SQLite, which is
  where threads and connection records live), and command lines. R2 maps hold module source built
  from `src/`, so the tracked-file check covers them; the clean-build sha above is unchanged from
  main. `test/github/redaction.test.ts` covers each GitHub token prefix and URL credentials.

### 5. `git` and `gh` availability, restart behaviour, no false connected status

Partly holds; one part is blocked on a paid probe.

- No installation step is added. E8 records Git present on the pinned pair, and ADR-0039 expects
  the image to carry the tools. If `gh` is missing, the commands report `tooling-missing` and
  cf-stumble neither installs a package nor reports a connection
  ("shows a workspace image without gh instead of installing one").
- After a restart: "asks for a reconnection after a restart left the workspace without a
  credential" — the status becomes `reconnect-required` with reason `credential-missing`, and the
  documented fallback reinstalls without a person.
- Never silently connected: a credential the API rejects gives `reconnect-required`
  (`credential-rejected`), an unreachable workspace gives `reconnect-required`
  (`workspace-unavailable`), and both clear the recorded connection.
- **Blocked: awaiting owner approval for a paid probe.** Whether `gh` exists on the pinned image is
  unverified, because checking it starts a Computer workspace.

### 6. Idempotent provisioning on connection and use, catalog resolution in both paths

Holds locally.

- On connection: `connect` provisions after verifying access; a failing clone removes a newly
  recorded project ("takes a project back out when its clone fails").
- On use and after recreation: `Supervisor.streamProjectTurn` provisions the selected project after
  mounting the generation and before obtaining the capability
  (`ProjectTurnInput.provision`); "provisions again every time a project is used" shows the second
  clone request. Provisioning holds no memory of a previous run, which is what repairs a recreated
  host (`test/workspace/project-provisioning.test.ts`, unchanged behaviour).
- Dirty files preserved: the clone step reconciles rather than resets; unchanged from T3a and still
  covered by `test/workspace/project-provision-plan.test.ts`.
- Both paths resolve through the stored catalog: `ProjectThreads` takes a catalog source read at
  each call, and `streamProjectTurn` receives `this.connections.catalog()`. The Supervisor line
  `new ProjectThreads(ctx.storage)` that T3a and T5 left for this task now supplies the real
  catalog.
- No static fallback: the source catalog is deleted, so a caller that forgets to pass one resolves
  nothing.

### 7. Routes the page needs, verified scope reaching workspace selection

Holds.

- New: `GET /api/projects` (list plus connection status), `POST /api/projects/connect`,
  `GET /api/github/connection`, `POST /api/github/authorization`,
  `POST /api/github/authorization/complete`.
- Existing read and fresh-thread routes (`GET /api/projects/:id/thread`,
  `POST /api/projects/:id/thread/fresh`) now resolve against the stored catalog.
- The verified scope travels from `authenticateAccessRequest` through `routeOwnerApiRequest` to the
  Supervisor as an argument. "starts an authorization for the verified owner, not for one the body
  names" asserts the scope passed is the boundary's, with a body that tries to name another
  identity.
- Caller-supplied tenant fields have no authority: the boundary already refuses them with 400
  (`test/access/tenant-selection.test.ts`, unchanged), and the connect body accepts exactly
  `repositoryUrl` and `displayName`, so a body with `tenant` or `token` is refused with 400.
- Unknown or cross-tenant ids fail before capability acquisition: `resolveProject` runs first in
  `streamProjectTurn` (before mount, provisioning, and `project()`), and a project connected by one
  tenant is unknown to another ("one tenant's project is unknown to another tenant").

## What I deliberately did not do

- No live device authorization and no private-repository clone. That is T6b, and it needs the
  owner at `github.com/login/device`.
- No paid probe of any kind: no deploy, no Computer workspace, no billing API call.
- No edit to `src/access/index.ts`. T3a owns it; this task consumes `AccessRequestResult.scope` and
  adds no tenant authority. The owner-only policy already existed and was left alone.
- No page or UI work. T10 owns `src/page/**`.
- No change to `wrangler.jsonc` or `wrangler.test.jsonc`. Deployment configuration is T12a's;
  `GITHUB_OAUTH_CLIENT_ID` and `GH_TOKEN` are documented in
  `docs/agents/design/github-connection.md` instead, beside the existing undeclared `CF_ACCESS_*`
  values.
- No disconnect route. Removing a project is not in the criteria; the store has `disconnect`
  because the connect path uses it to undo a failed clone.
- No new ADR. ADR-0038 and ADR-0039 already decide the shared workspace and the separate GitHub
  authorization, and nothing here contradicts them.
- No retry loop or polling schedule for the device flow. One completion request redeems once; the
  page decides when to ask again, and the status carries GitHub's `intervalSeconds`.

## Design decisions a reviewer should check

1. **The Workspace Host can no longer resolve a project id against the catalog.** The catalog is
   Supervisor storage, and the host is a different Durable Object. The provision request therefore
   carries the resolved `repositoryUrl` as well as the id, and the host proves the pair is coherent:
   it re-derives the id from the URL and refuses a mismatch. Command text still cannot travel.
   `test/workspace/project-provisioning.test.ts` was updated to state this honestly.
2. **A project is stored only when its clone succeeds.** A failed clone removes a newly recorded
   project, so a listed project has files. A repeat connection of an already-connected project does
   not remove it.
3. **The Supervisor keeps no token.** Storage holds a login name, the credential source, and a
   time. The cost is that a recreated container needs a reconnection, which criterion 5 allows and
   the `GH_TOKEN` path automates.
4. **`src/supervisor/supervisor.ts` carries an `oxlint-disable max-lines`.** One Durable Object
   class is one RPC surface; splitting the file would hide entry points from the binding. Every
   method delegates. `src/workspace/project/exec-operation.ts` has the same disable.

## Remaining blockers

1. **`gh` on the pinned Computer image is unverified.** Blocked: awaiting owner approval for a paid
   probe. If it is missing, the connection status reports `tooling-missing` and no repository can be
   connected; ADR-0039 would then need an install step. Nothing in this task guesses.
2. **`GITHUB_OAUTH_CLIENT_ID` does not exist yet.** Creating the GitHub OAuth app is an owner step
   (T6b). Without it, starting an authorization answers `not-configured`; the `GH_TOKEN` path still
   works.
3. **The device-flow HTTP calls have never met the real provider.** The reply mapping is tested
   against a scripted provider only. T6b is the first real exchange.
4. **Provisioning and `gh` are still text, not behaviour.** No test in this repository can run a
   shell, so what is proved is which requests are accepted and what commands are built.

## Things I noticed and did not fix

- `src/page/markup.ts` line 30 sets the project-id input's default value to `project-one`, which now
  names no connected project. T2 and T10 own the page files; T10 should read the project list from
  `GET /api/projects`.
- `test/supervisor/threads/*` reach the Supervisor's storage to connect their projects through
  `connectSampleProjects` in `test/supervisor/helpers.ts`. That is a test seam over production
  storage, not a production path; a real connection cannot run here because the local runtime has no
  container.
- `ROUTE_MODEL` still declares `contextWindow: 0` (E7), and `WorkspaceCapability` still exists in
  `src/facet/generation-0/capabilities.ts` awaiting T7. Both are outside this task.
