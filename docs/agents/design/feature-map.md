# Version 0 feature map

Finish one thing: a deployed coding agent that can change its own harness generation without losing the project or conversation it was working on.

That is smaller than the project described in the older planning notes. It is also enough. `overview.md` and the human-approved ADRs still control the architecture. This file controls version 0 scope. `slices.md` records earlier implementation work and local evidence, but it is no longer the release plan.

## What version 0 is

cf-stumble is a personal coding agent on Cloudflare. Version 0 starts with one tenant, but that tenant may use several browsers or machines. The owner gives it a task for one configured project repository. The active main facet uses a durable Computer workspace to read files, edit them, run a project command, and report what happened.

The owner can submit a harness commit as a generation candidate. The Supervisor builds and checks that commit without touching the active generation. If the check passes, the owner can activate it. The owner can also return to an earlier active generation. The project workspace and saved conversations survive either change.

The point is simple: harness code is replaceable, while project files and conversation state are not. Version 0 demonstrates that boundary. It does not pretend the agent already knows how to improve itself safely.

## The demo

The finished project should fit in a two-minute recording.

1. Open the Access-protected page. It shows the active generation.
2. Ask the agent to make one small change in the configured project.
3. The agent reads the project, edits a file, runs the configured check, and returns the diff and command output.
4. Submit a second harness commit. The Supervisor builds it, starts a cold candidate main facet, and runs `GET /`.
5. Activate the passing candidate and continue the same conversation in the same workspace.
6. Submit a deliberately broken candidate. Its startup check fails, and the active generation keeps serving.
7. Roll back to the earlier generation. The conversation and project edit are still there.

If a feature does not help this demo work or make it safe to run, it is not version 0 work.

## Fixed limits

- Version 0 deploys one tenant but allows several clients and saved sessions for that tenant.
- The version 0 tenant has one configured project repository and a separate harness repository. Later tenants may share that harness or own one. Version 0 does not decide.
- Cloudflare Access supplies identity. cf-stumble has no account, invitation, or provisioning service.
- The main harness uses the vendored Pi core and one fixed model route.
- The browser waits for a complete HTTP response. The facet may read a provider stream internally, but it saves the session before replying.
- Only an authenticated tenant owner can submit, activate, or roll back generations. The model gets no generation-control tool.
- The paid Cloudflare account is available for Dynamic Worker facets and Computer.
- `pnpm verify` remains the local gate. Paid-runtime checks stay separate because workerd cannot prove these integrations.

## Tenant and client routing

The Worker verifies the Cloudflare Access token and derives a tenant key from the stable user claim and Access application ID. It hashes that value before using it as a Durable Object name. The request never supplies the authoritative tenant key.

```text
verified Access identity
    -> tenant key
       -> SUPERVISOR.getByName(tenant key)
       -> WORKSPACE_HOST.getByName(tenant key)
```

Every client for the same identity reaches the same Supervisor and workspace host. Requests name a `sessionId` within that tenant. Different sessions may run at the same time, but one session accepts only one active turn. Session writes use revisions so two clients cannot overwrite each other silently.

A later invited user follows the same route and receives a separate Supervisor, workspace host, generation history, and session collection on first use. This needs no tenant database. R2 may cache module maps across tenants because the maps are addressed by harness commit and contain no credentials, conversations, or project files.

Version 0 still allows only the owner's identity through the Access policy. The tenant routing exists now so adding another invited identity does not require changing the Supervisor or main harness.

## Where the repository stands

There is a strange imbalance in the current code. The Supervisor has careful generation, relay, eligibility, and recovery logic, but the thing it supervises is still a test fixture. That is why the project feels late despite having 168 passing tests.

| Capability                                               | What exists now                                | What version 0 needs                                                  |
| -------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| Generation labels, status, epoch, and activation history | Implemented and tested locally                 | Keep it. Do not redesign it.                                          |
| Journaled candidate, activation, and rollback requests   | Implemented and tested locally                 | Put them behind an authenticated tenant route.                        |
| Bounded startup check                                    | Implemented and tested locally                 | Run it against real candidate module maps.                            |
| Active-generation facet serving                          | Works locally with `src/facet/fixture.ts`      | Load a real Pi-based main facet.                                      |
| Relay attempts and eligibility                           | Implemented and tested locally                 | Freeze the policy. Credit only complete buffered turns.               |
| Recovery episode bookkeeping                             | Implemented and tested locally                 | Show the latest report if useful. Do not add automatic repair.        |
| R2 binding                                               | Configured and smoke-tested locally            | Add the cache and Computer rebuild path.                              |
| Pi 0.84.4 fork                                           | Vendored and checked                           | Run it in the main facet.                                             |
| Computer source and image pair                           | Pinned and tested separately on a paid account | Add the workspace host and runtime adapter to this repository.        |
| Coding-agent loop                                        | Missing                                        | Complete one real edit-and-test turn.                                 |
| Saved conversations                                      | Missing                                        | Store session documents outside generation state.                     |
| Model access                                             | Missing                                        | Add one fixed route whose credential stays outside the mutable facet. |
| Tenant page and HTTP routes                              | Missing                                        | Add identity routing, chat, status, candidate check, and rollback.    |
| Paid deployment                                          | Missing                                        | Run the complete demo in the paid runtime.                            |

The baseline for this map is 33 passing test files and 168 passing tests under `pnpm verify`.

## P0: prove the Cloudflare path

Do this before more UI or policy work. A tiny temporary facet is enough.

Build a statically deployed workspace host around the pinned Computer pair. Select both the workspace host and Supervisor from a test tenant key. Give a Dynamic Worker facet a narrow way to use that workspace and one model route. Then have Computer check out a harness commit, build its Worker module map, and load that map under the commit ID.

P0 is done when all of these work on the paid account:

- The facet reads a durable file, writes another, and runs one container command.
- The file remains after the host and facet restart or are evicted.
- A model probe returns through the same route the main harness will use.
- A request to any other outbound destination fails.
- Computer builds a module map that the Worker Loader accepts.
- A cold facet made from that map passes the existing `GET /` startup check.
- The probe notes include timings and raw failures, not a summary written from memory.

Stop if the facet cannot receive the Computer or model capability, if Computer cannot build the map, or if the map does not load. Those failures change the design. A local fake would only postpone finding that out.

## P1: complete one coding turn

Use one project and one model. Clients may create several sessions, but each session runs one request at a time.

Build the real Generation 0 main facet from the vendored Pi core. Store opaque session documents outside generation state, keyed by `sessionId`. Add a Computer execution adapter for file reads, edits, writes, shell commands, and `git diff`. `POST /sessions/:sessionId/turn` runs the agent and saves that session before returning one buffered response. `GET /` stays cheap and deterministic because the Supervisor uses it for startup checks.

P1 is done when:

- The owner can ask for a small change in the configured repository.
- The agent finds the relevant file, edits it, runs the configured check, and returns the diff and command output.
- The project edit and saved sessions survive facet replacement and workspace-host eviction.
- Two clients can use separate sessions without sharing conversation state.
- A second active turn for the same session fails with a conflict.
- A stale session revision fails instead of overwriting newer work.
- A Computer failure appears as a tool error instead of crashing the facet.
- A successful response records one completed relay attempt. Cancellation and failure earn no credit.

No browser streaming, shared live-session synchronization, steering, compaction, project picker, or model abstraction belongs here. A buffered turn may feel plain, but it removes a large disconnect and resume problem that has nothing to do with the demo.

## P2: build a generation from its commit

The current SQLite artifact store is temporary. ADR-0034 says the harness commit is authoritative and R2 only caches build output.

On a cache miss, Computer checks out the labeled harness commit in an isolated build directory and produces a module map. The Supervisor validates the map, writes it to R2, and loads it under that same commit ID. Startup checking and normal serving use this one resolver. The Supervisor no longer stores completed module source in SQLite.

P2 is done when:

- The first request for a commit builds, validates, caches, and loads its module map.
- A later cold request reads the map from R2 without rebuilding it.
- A corrupt R2 object is rejected and rebuilt.
- A failed rebuild leaves the active generation serving.
- Two builds of the same commit produce the same canonical module map.
- A schema test proves that `harness_artifact_modules` and any replacement module-source table are gone from Supervisor SQLite.

If two builds differ, stop. That disproves ADR-0034's current reproducibility assumption and needs a decision. Do not hide it with a second cache key.

Version 0 only needs a simple R2 size or age limit. Miss coalescing, background cleanup, and a general retention system can wait.

## P3: add the tenant page

Expose the behavior that already exists. Do not build an admin product around it.

Cloudflare Access protects all tenant routes. The Worker verifies the identity, derives the tenant key, and routes chat and control requests to that tenant's Supervisor. Small JSON endpoints return status, sessions, generation history, candidate check results, activation and rollback results, and the latest recovery report. A no-framework page uses those endpoints for chat and generation controls.

P3 is done when:

- Unauthenticated requests cannot reach chat or control endpoints.
- A request cannot select another tenant by sending a tenant ID.
- Two clients authenticated as the owner reach the same generation state and workspace.
- Test identities with different stable claims resolve to different Supervisor and workspace-host names.
- The page shows the active generation and the epoch used for activation or rollback.
- Repeating the same request ID returns the journaled result.
- Reusing that ID for another command fails.
- A failed candidate leaves the active generation unchanged.
- A passing candidate activates only through an epoch-checked owner request.
- Rollback accepts only a ready generation that ran before.
- The owner can inspect the latest recovery report without implying that repair runs in the background.

Manual rollback is version 0 recovery. The existing recovery code may record and explain failure, but no model diagnoses, repairs, submits, or activates code.

## P4: deploy, record, stop

Write one repeatable deployment procedure for the Worker, Durable Objects, R2 bucket, Computer host, model binding or secret, and Access policy. Keep one small demo repository and one broken harness candidate ready for the recording.

Run the full demo from a fresh browser session, then open the same tenant from a second client and continue through another session. Restart or evict the runtime objects, then confirm that the active generation, saved conversations, and project files remain. Run `pnpm verify` after the last code change and keep the paid probe output with the release notes.

When that passes, version 0 is done. Publish the recording and stop adding features.

## Build order

```text
paid Computer, facet, and model probe
                 |
                 v
      workspace host and model route
                 |
                 v
         real Generation 0 facet
                 |
                 v
       one saved coding turn
                 |
                 v
    R2 build cache keyed by commit
                 |
                 v
        Access-protected tenant page
                 |
                 v
 candidate failure, activation, rollback
                 |
                 v
          paid demo and release
```

After P0 fixes the module-map and capability contracts, the R2 cache and Pi adapter can proceed separately. Wait to build the page until the turn and control responses settle. Otherwise every backend type change becomes frontend rework.

## Decisions for version 0

| Question                         | Answer                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Who uses it?                     | One tenant at launch, from any number of authenticated clients.                                             |
| How is a tenant selected?        | The Worker derives it from the verified Access identity. Requests cannot choose it.                         |
| Where does work live?            | One Computer workspace per tenant. The harness builds elsewhere, so the Git histories stay separate.        |
| Where do conversations live?     | Opaque session documents keyed by `sessionId`, outside every generation. Generation code owns their schema. |
| How does a turn return?          | Buffered HTTP, one turn at a time.                                                                          |
| Which tools exist?               | File access, shell, and Git diff. No domain tool catalogue.                                                 |
| Which model does it use?         | One fixed route controlled outside the mutable facet.                                                       |
| What identifies executable code? | The labeled harness commit. R2 contains rebuildable module maps only.                                       |
| Who changes generations?         | The owner submits, activates, and rolls back.                                                               |
| What is recovery?                | Manual rollback, plus the reports the current code already records.                                         |
| What is the UI?                  | One plain page served by the Worker.                                                                        |

## Deliberately postponed

- Choosing a known-good threshold or activating a fallback automatically.
- Letting the agent repair itself, submit generations, or approve changes through replay tests.
- Token streaming, reconnect, resume, steering, and background turns.
- More projects, combined project and harness views, or a workspace picker.
- Public signup, teams, roles, invitations, tenant administration, or a custom account system.
- Provider selection and subscription login.
- Better cache policy, alarms, and session migrations.

## Ideas that are not part of this release

The historical conversation covered many good side projects. They are still side projects.

- `patch.md` profiles
- code-server
- Cloudflare OS Gadget or Blueprint compatibility
- GitHub App installation, issue triage, CI webhooks, and pull requests
- custom Git object storage, Artifacts compatibility, and a Git protocol server
- skills, MCP, plugin, and tool marketplaces
- a metrics dashboard, full admin console, canaries, quarantine, attestations, and garbage collection
- the DO-backed Trustix log, R2 Nix cache, rate limiter, sharded KV store, and other distributed-systems demos

Do not leave these as unchecked boxes in the version 0 plan. An idea outside the release is not unfinished release work.

## Cleanup tied to the work

Do each cleanup when its replacement works. A cleanup phase at the start would delay the same user path again.

- Move the production fixture out of application construction after real Generation 0 materialization works. Keep fixture artifacts in test code.
- Delete the Supervisor SQLite module-source table only after both the R2 hit path and Computer rebuild path pass their checks.
- Replace the Supervisor name `facet-spike` with the tenant key derived from the verified Access identity.
- Leave recovery and eligibility policy alone unless the demo exposes a defect.
- Keep HTTP types concrete. Tenant routing does not require a general account, provisioning, or authorization framework.

## Rules while finishing

1. Work on one numbered part at a time and end it with the checks listed above.
2. Run each paid probe before writing the code that assumes its result.
3. When Cloudflare behaves differently from the design, record the observed and expected behavior, then stop and decide. Do not add a fake or another architecture on speculation.
4. Do not expand recovery, eligibility, or generation policy while the main facet is still a fixture.
5. Use a fixed value when version 0 has one project, model, or page. Tenant identity and session IDs are the two deliberate routing dimensions.
6. Once the demo passes, release it. Put later ideas in a later plan.
