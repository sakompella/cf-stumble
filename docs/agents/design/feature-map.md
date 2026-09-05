# Version 0 feature map

Version 0 has one job: deploy a coding agent that can move to another harness generation without
abandoning its project or current thread.

Older plans tried to prove much more. That is why the useful path is still unfinished. The smaller demo below is enough to prove the boundary that matters. `overview.md` and the human-approved ADRs remain the architecture authority. This file sets the version 0 cut line. `slices.md` keeps the earlier implementation sequence and local evidence; it is not the release plan.

Some owner decisions in `.audit/design-questions.md` remain open. If the answer to Q2 is that
versioned configuration counts as changing a generation, P1 and P2 both shrink. The owner chose
Workers AI for the first model route and prefers OpenAI. Codex and Pi support ChatGPT sign-in for
local CLI harnesses through a localhost callback. The available prior art does not establish that
their hard-coded client supports an arbitrary HTTPS callback for a Worker, so version 0 does not
depend on that unconfirmed integration. The research records are
`.audit/research/openai-chatgpt-login-workers-ai.md` and
`.audit/research/codex-oauth-web-prior-art.md`.

## What version 0 is

cf-stumble is a personal coding agent on Cloudflare. It starts with one tenant, who may use several
browsers or machines. The user connects GitHub repositories as projects and selects one from a
collapsible left sidebar. The active main facet uses that project's directory in the shared durable
Computer workspace and its Pi thread to complete the work.

The owner may submit a harness commit as a generation candidate. The Supervisor builds and checks
that commit while the active generation continues to run. Once the check passes, the owner may
activate it and may later return to a generation that ran before. The shared workspace and current
project threads survive either move.

Harness code is replaceable. Project files and conversation state are not. Version 0 proves that boundary. It does not claim the agent can decide how to improve itself safely.

## The demo

The finished project should make sense in a two-minute recording:

1. Open the Access-protected page and see the active generation.
2. Select a GitHub project and ask the agent to make one small change.
3. It streams its response while it reads the project, edits a file, runs the configured check, then
   shows the diff and command output.
4. Submit a second harness commit. The Supervisor builds it, cold-starts a candidate main facet, and runs `GET /`.
5. Activate the passing candidate, then continue the same conversation in the same workspace.
6. Submit a deliberately broken candidate. Its startup check fails while the active generation keeps serving.
7. Roll back to the earlier generation. The conversation and project edit are still present.

If a feature neither makes that recording work nor makes it safe to run, it is outside version 0.

## Fixed limits

- Version 0 launches with one tenant. The user signs in with GitHub through Cloudflare Access and
  may use several browsers or machines.
- The tenant may connect several GitHub project repositories and has a separate harness repository.
  Later tenants may share that harness repository or own one; version 0 does not choose between
  those models.
- Each project has one current Pi thread. One Computer workspace contains the harness and project
  repositories in separate directories, so they retain separate Git histories without separate
  container lifecycles.
- Starting a fresh thread replaces the project's conversation and compacted context but preserves
  its files. Thread state stays outside every generation, and Pi defines its message types.
- The main harness runs the vendored Pi core and one fixed model route. That route's credential stays outside the mutable facet.
- The agent has a shell, unrestricted outbound internet access, and normal development tools,
  including `git` and `gh`. GitHub credentials live in local tool configuration outside the project
  repository.
- The browser receives Pi text, tool calls, and tool results as a turn runs. Only terminal success
  after saved thread state completes a real turn.
- A labeled harness commit identifies executable code. R2 contains rebuildable module maps and nothing else.
- Only an authenticated tenant owner may submit, activate, or roll back a generation. The model has no generation-control tool.
- Recovery is manual rollback plus the reports current code records.
- The Worker serves one application page with a collapsible left project sidebar, streaming
  conversation, and generation controls.
- The paid Cloudflare account covers Dynamic Worker facets and Computer.
- `pnpm verify` stays the local gate. Paid-runtime checks remain separate because workerd cannot prove these integrations.

## Tenant and client routing

The Worker verifies the Cloudflare Access token. It derives a tenant key from the stable user claim and the Access application ID, hashes that value, and uses the hash as the Durable Object name. The request never provides the authoritative tenant key.

```text
verified Access identity
    -> tenant key
       -> SUPERVISOR.getByName(tenant key)
       -> WORKSPACE_HOST.getByName(tenant key)
```

Every client for one identity reaches one Supervisor. A request selects a project owned by that
tenant, and the server derives that project's directory in the tenant's shared workspace; a request
cannot choose another tenant's workspace. Each project accepts one active turn because it has one
current Pi thread. The shared workspace may serialize operations that use its single container.

An invited user added later takes the same route and receives separate durable state on first use: a
Supervisor, project collection, Workspace Hosts, generation history, and threads. R2 may cache
module maps across tenants because a map is addressed by harness commit and contains no credentials,
conversations, or project files.

The Access policy still admits only the owner's identity. Identity routing is in place now so admitting a second person later does not require a change to the Supervisor or main harness.

## Where the repository stands

The project is lopsided. The Supervisor has deliberate generation, relay, eligibility, and recovery
code. The code it supervises is still incomplete. Most of the passing tests exercise control
machinery rather than the coding path a user needs.

| Capability                                               | What exists now                                   | What version 0 needs                                                  |
| -------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| Generation labels, status, epoch, and activation history | Implemented and tested locally                    | Keep it. Do not redesign it.                                          |
| Candidate, activation, and rollback requests             | A journaled implementation is authenticated       | Remove request IDs and the request journal; keep epoch checks.        |
| Bounded startup check                                    | Implemented and tested locally                    | Run it against real candidate module maps.                            |
| Active-generation facet serving                          | Works locally with `src/facet/fixture.ts`         | Load a real Pi-based main facet.                                      |
| Relay attempts and eligibility                           | Implemented and tested locally                    | Credit only terminal streamed turns whose thread state was saved.     |
| Recovery episode bookkeeping                             | Implemented and tested locally                    | Show the latest report if useful. Do not add automatic repair.        |
| R2 binding                                               | Configured and smoke-tested locally               | Add the cache and the Computer rebuild path.                          |
| Pi 0.84.4 fork                                           | Vendored and checked                              | Run it in the main facet.                                             |
| Computer source and image pair                           | Pinned and tested separately on a paid account    | Add the workspace host and the runtime adapter to this repository.    |
| Coding-agent loop                                        | Missing                                           | Complete one real edit-and-test turn.                                 |
| Project threads                                          | One thread per catalog project, keyed server-side | Drive a turn through the thread lease and stream it to the browser.   |
| Model access                                             | Missing                                           | Add one fixed route whose credential stays outside the mutable facet. |
| Tenant page and HTTP routes                              | Missing                                           | Add identity routing, chat, status, candidate check, and rollback.    |
| Paid deployment                                          | Missing                                           | Run the complete demo in the paid runtime.                            |

## P0: prove the paid Cloudflare path

Do this before more UI or policy work. A tiny temporary facet is enough. The point is to learn whether the paid runtime will actually permit the contracts the rest of the plan assumes, rather than writing another local approximation.

Build a statically deployed workspace host around the pinned Computer pair. Select the workspace host and the Supervisor from a test tenant key. Give a Dynamic Worker facet a narrow way to use that workspace and one model route. Have Computer check out a harness commit, build its Worker module map, and load that map under the commit ID.

The paid-account probe must show all of the following:

- The facet reads a durable file, writes another, and runs one container command.
- The file survives a restart or eviction of the host and the facet.
- A model probe returns through the route the main harness will use.
- The shared workspace reaches arbitrary internet destinations through ordinary development tools.
- Computer builds a module map the Worker Loader accepts.
- A cold facet from that map passes the existing `GET /` startup check.
- Probe notes preserve timings and raw failures, rather than a summary written from memory.

Stop if the facet cannot receive the Computer or model capability, Computer cannot build the map, or the map fails to load. Any one of those results changes the design. A local fake would merely hide the problem again.

## P1: make one coding turn real

Build the real Generation 0 main facet on the vendored Pi core. Keep each project's current Pi
thread outside generation state. Add a Computer adapter that gives Pi ordinary project file and
shell operations. The turn route streams Pi events to the browser, saves terminal thread state, and
keeps `GET /` cheap and deterministic because the Supervisor uses it for startup checks.

This phase is complete when the working path has these properties:

- The owner can request a small change in the configured repository.
- The agent finds the relevant file, edits it, runs the configured check, and returns the diff and command output.
- The project edit and current thread survive facet replacement and Workspace Host eviction.
- Two projects keep separate thread and workspace state.
- A second active turn for one project fails with a conflict.
- Starting a fresh thread clears conversation and compacted context but preserves project files.
- A Computer failure becomes a tool error rather than crashing the facet.
- A successful response records one completed relay attempt. Cancellation and failure earn no credit.

Pi owns streaming, tool execution, thread state, and compaction. Live collaboration, steering,
background execution, and a model abstraction stay out. The implementation must state and test what
happens when the browser disconnects from a running stream.

## P2: build each generation from its commit

The SQLite artifact store is temporary. ADR-0034 makes the harness commit authoritative. R2 is only a cache for build output.

On a cache miss, Computer checks out the labeled harness commit in an isolated build directory and produces a module map. The Supervisor validates it, writes it to R2, and loads it under that commit ID. Startup checking and normal serving use that one resolver. The Supervisor no longer stores completed module source in SQLite.

The cache is acceptable only when:

- The first request for a commit builds, validates, caches, and loads its module map.
- A later cold request reads the module map from R2 without rebuilding it.
- The Supervisor rejects and rebuilds a corrupt R2 object.
- A failed rebuild leaves the active generation serving.
- Two builds of one commit produce the same canonical module map.
- A schema test proves `harness_artifact_modules`, and any table that replaced it, are gone from Supervisor SQLite.

The reproducibility check can break the plan. Different outputs for the same commit disprove the assumption behind ADR-0034. Stop and decide if that happens. Do not conceal it with a second cache key.

Version 0 needs a simple R2 size or age limit. Miss coalescing, background cleanup, and a real retention system can wait.

## P3: put the tenant controls on one page

Expose the behavior that exists. Do not turn this into an admin product.

Cloudflare Access uses GitHub as the identity provider and protects every tenant route. The Worker
derives the tenant key from the verified Access identity and sends project, chat, and control
requests to that tenant's Supervisor. The application page lists connected projects in a
collapsible left sidebar, streams the selected project's current Pi thread, and exposes generation
controls.

The page and routes are ready when:

- An unauthenticated request cannot reach a project, chat, or control endpoint.
- A request cannot choose another tenant by sending a tenant ID.
- Two clients authenticated as the owner reach the same projects, generation state, workspaces, and
  current threads.
- Test identities with different stable claims resolve to different Supervisor and workspace-host names.
- The page shows the active generation and the epoch used for activation or rollback.
- Repeating candidate submission returns the generation already assigned to that harness commit.
- Activation of the generation that is already active is a no-op.
- Activation and rollback reject a stale generation-control epoch.
- A failed candidate does not change the active generation.
- A passing candidate activates only through an epoch-checked owner request.
- Rollback accepts only a ready generation that ran before.
- The owner can read the latest recovery report without suggesting repair runs in the background.

Manual rollback is version 0 recovery. Existing recovery code may record and explain a failure, but no model diagnoses, repairs, submits, or activates code.

## P4: deploy, record, then stop

Write one repeatable deployment procedure for the Worker, Durable Objects, R2 bucket, Computer host, model binding or secret, and Access policy. Keep one small demo repository and one broken harness candidate ready for the recording.

Run the complete demo in a fresh browser session. Then open the same tenant from a second client and
continue the selected project's thread. Restart or evict runtime objects and confirm the active
generation, project threads, and project files remain. After the last code change, run `pnpm verify`
and retain paid probe output with the release notes.

Version 0 is done when that passes. Publish the recording. Stop adding features.

## Build order

P0 comes first and alone because it settles the module-map and capability contracts that P1 and P2 would otherwise guess at. After P0, the Generation 0 facet with its saved coding turn and the R2 build cache can proceed separately. P3 waits for both. Building the page earlier would make every backend type change into frontend rework. P4 is last, and it ends the project.

## Deliberately postponed

These belong to cf-stumble, but not to this release:

- Choosing a known-good threshold or activating a fallback automatically.
- Letting the agent repair itself, submit generations, or approve changes through replay tests.
- Reconnect, resume, steering, and background turns beyond the disconnect behavior required for a
  correct streamed turn.
- Combined project and harness views.
- Public signup, teams, roles, invitations, tenant administration, or a custom account system.
- Provider selection and subscription login.
- Better cache policy, alarms, and thread migrations.

## Ideas that are not part of this release

The historical conversation produced many good side projects. They are side projects, not deferred release work. Keep them out of this plan rather than carrying them as unchecked boxes.

- `patch.md` profiles
- code-server
- Cloudflare OS Gadget or Blueprint compatibility
- Issue triage, CI webhooks, and a product-level pull-request workflow
- custom Git object storage, Artifacts compatibility, and a Git protocol server
- skills, MCP, plugin, and tool marketplaces
- a metrics dashboard, full admin console, canaries, quarantine, attestations, and garbage collection
- the DO-backed Trustix log, R2 Nix cache, rate limiter, sharded KV store, and other distributed-systems demos

## Cleanup tied to the work

Do cleanup as its replacement begins to work. Starting with cleanup would postpone the user path another time.

- Move the production fixture out of application construction once real Generation 0 materialization works. Keep fixture artifacts in test code.
- Delete the Supervisor SQLite module-source table only after both the R2 hit path and Computer rebuild path pass their checks.
- Replace the Supervisor name `facet-spike` with the tenant key derived from the verified Access identity.
- Do not change recovery or eligibility policy unless the demo exposes a defect.
- Keep HTTP types concrete. Tenant routing does not need a general account, provisioning, or authorization framework.

## Rules while finishing

1. Work on one numbered part at a time and end it with the listed checks.
2. Run every paid probe before writing code that assumes its result.
3. When Cloudflare differs from the design, record the observed and expected behavior, then stop and decide. Do not add a fake or a second architecture from speculation.
4. Do not expand recovery, eligibility, or generation policy while the main facet remains a fixture.
5. Use Pi's existing thread, streaming, tool, and compaction logic. Add project identity as the only
   new user-selected routing dimension; keep one model and one application page.
6. Release the demo once it passes. Put later ideas in a later plan.
