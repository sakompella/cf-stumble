# Version 0 feature map

Version 0 has one job: deploy a coding agent that can move to another harness generation without abandoning its project or the conversation in progress.

Older plans tried to prove much more. That is why the useful path is still unfinished. The smaller demo below is enough to prove the boundary that matters. `overview.md` and the human-approved ADRs remain the architecture authority. This file sets the version 0 cut line. `slices.md` keeps the earlier implementation sequence and local evidence; it is not the release plan.

The scope here is provisional in one specific way. Five owner decisions in `.audit/design-questions.md` are still open, and two of them move the cut line. If the answer to Q2 is that versioned configuration counts as changing a generation, P1 and P2 both shrink. Until Q4 settles the model and payment path, P0 probes a route nobody has chosen yet.

## What version 0 is

cf-stumble is a personal coding agent on Cloudflare. It starts with one tenant, who may use several browsers or machines. The owner gives the agent a task in one configured project repository. The active main facet uses a durable Computer workspace to read and edit files, run a project command, then report the result.

The owner may submit a harness commit as a generation candidate. The Supervisor builds and checks that commit while the active generation continues to run. Once the check passes, the owner may activate it and may later return to a generation that ran before. The project workspace and saved conversations survive either move.

Harness code is replaceable. Project files and conversation state are not. Version 0 proves that boundary. It does not claim the agent can decide how to improve itself safely.

## The demo

The finished project should make sense in a two-minute recording:

1. Open the Access-protected page and see the active generation.
2. Ask the agent to make one small change in the configured project.
3. It reads the project, edits a file, runs the configured check, then returns the diff and command output.
4. Submit a second harness commit. The Supervisor builds it, cold-starts a candidate main facet, and runs `GET /`.
5. Activate the passing candidate, then continue the same conversation in the same workspace.
6. Submit a deliberately broken candidate. Its startup check fails while the active generation keeps serving.
7. Roll back to the earlier generation. The conversation and project edit are still present.

If a feature neither makes that recording work nor makes it safe to run, it is outside version 0.

## Fixed limits

- Version 0 launches with one tenant. Any number of authenticated clients may reach it, and it may keep several saved sessions.
- That tenant has one configured project repository and a separate harness repository. Later tenants may share that harness repository or own one; version 0 does not choose between those models.
- Each tenant has one Computer workspace. Harness code builds elsewhere, so the two Git histories stay separate.
- Cloudflare Access supplies identity. The Worker derives the tenant from the verified token, and no request can choose it. cf-stumble has no account, invitation, or provisioning service.
- Conversations are opaque session documents keyed by `sessionId`, stored outside every generation. Generation code owns their schema.
- The main harness runs the vendored Pi core and one fixed model route. That route's credential stays outside the mutable facet.
- The agent has file access, a shell, and `git diff`. There is no domain tool catalogue.
- The browser waits for a complete HTTP response. The facet may read a provider stream internally, but it saves the session before replying and allows one turn at a time per session.
- A labeled harness commit identifies executable code. R2 contains rebuildable module maps and nothing else.
- Only an authenticated tenant owner may submit, activate, or roll back a generation. The model has no generation-control tool.
- Recovery is manual rollback plus the reports current code records.
- The Worker serves one plain page.
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

Every client for one identity reaches one Supervisor and one workspace host. A request names a `sessionId` within that tenant. Two sessions can run at once. One session accepts only one active turn, and session writes carry revisions, so two clients cannot silently overwrite each other.

An invited user added later takes the same route and receives separate durable state on first use: a Supervisor, workspace host, generation history, and session collection. There is no tenant database. R2 may cache module maps across tenants because a map is addressed by harness commit and contains no credentials, conversations, or project files.

The Access policy still admits only the owner's identity. Identity routing is in place now so admitting a second person later does not require a change to the Supervisor or main harness.

## Where the repository stands

The project is lopsided. The Supervisor has deliberate generation, relay, eligibility, and recovery code. The code it supervises is still a test fixture. That imbalance is why the project feels late: `pnpm verify` has 33 passing test files and 168 passing tests for the half a user cannot yet use.

| Capability                                               | What exists now                                | What version 0 needs                                                  |
| -------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| Generation labels, status, epoch, and activation history | Implemented and tested locally                 | Keep it. Do not redesign it.                                          |
| Journaled candidate, activation, and rollback requests   | Implemented and tested locally                 | Put them behind an authenticated tenant route.                        |
| Bounded startup check                                    | Implemented and tested locally                 | Run it against real candidate module maps.                            |
| Active-generation facet serving                          | Works locally with `src/facet/fixture.ts`      | Load a real Pi-based main facet.                                      |
| Relay attempts and eligibility                           | Implemented and tested locally                 | Freeze the policy. Credit only complete buffered turns.               |
| Recovery episode bookkeeping                             | Implemented and tested locally                 | Show the latest report if useful. Do not add automatic repair.        |
| R2 binding                                               | Configured and smoke-tested locally            | Add the cache and the Computer rebuild path.                          |
| Pi 0.84.4 fork                                           | Vendored and checked                           | Run it in the main facet.                                             |
| Computer source and image pair                           | Pinned and tested separately on a paid account | Add the workspace host and the runtime adapter to this repository.    |
| Coding-agent loop                                        | Missing                                        | Complete one real edit-and-test turn.                                 |
| Saved conversations                                      | Missing                                        | Store session documents outside generation state.                     |
| Model access                                             | Missing                                        | Add one fixed route whose credential stays outside the mutable facet. |
| Tenant page and HTTP routes                              | Missing                                        | Add identity routing, chat, status, candidate check, and rollback.    |
| Paid deployment                                          | Missing                                        | Run the complete demo in the paid runtime.                            |

## P0: prove the paid Cloudflare path

Do this before more UI or policy work. A tiny temporary facet is enough. The point is to learn whether the paid runtime will actually permit the contracts the rest of the plan assumes, rather than writing another local approximation.

Build a statically deployed workspace host around the pinned Computer pair. Select the workspace host and the Supervisor from a test tenant key. Give a Dynamic Worker facet a narrow way to use that workspace and one model route. Have Computer check out a harness commit, build its Worker module map, and load that map under the commit ID.

The paid-account probe must show all of the following:

- The facet reads a durable file, writes another, and runs one container command.
- The file survives a restart or eviction of the host and the facet.
- A model probe returns through the route the main harness will use.
- A request to every other outbound destination fails.
- Computer builds a module map the Worker Loader accepts.
- A cold facet from that map passes the existing `GET /` startup check.
- Probe notes preserve timings and raw failures, rather than a summary written from memory.

Stop if the facet cannot receive the Computer or model capability, Computer cannot build the map, or the map fails to load. Any one of those results changes the design. A local fake would merely hide the problem again.

## P1: make one coding turn real

One project and one model are enough. Clients may open several sessions, but each session runs one request at a time.

Build the real Generation 0 main facet on the vendored Pi core. Keep opaque session documents outside generation state, keyed by `sessionId`. Add a Computer execution adapter for file reads, edits, writes, shell commands, and `git diff`. `POST /sessions/:sessionId/turn` runs the agent, saves the session, then returns one buffered response. Keep `GET /` cheap and deterministic because the Supervisor uses it for startup checks.

This phase is complete when the working path has these properties:

- The owner can request a small change in the configured repository.
- The agent finds the relevant file, edits it, runs the configured check, and returns the diff and command output.
- The project edit and saved sessions survive facet replacement and workspace-host eviction.
- Two clients can use separate sessions without sharing conversation state.
- A second active turn for one session fails with a conflict.
- A stale session revision fails rather than overwriting newer work.
- A Computer failure becomes a tool error rather than crashing the facet.
- A successful response records one completed relay attempt. Cancellation and failure earn no credit.

Browser streaming, live shared sessions, steering, compaction, a project picker, and a model abstraction stay out. A buffered turn is easy to demonstrate and avoids a disconnect-and-resume problem unrelated to this proof.

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

Cloudflare Access protects every tenant route. The Worker verifies identity, derives the tenant key, and sends chat and control requests to that tenant's Supervisor. Small JSON endpoints return status, sessions, generation history, candidate check results, activation and rollback results, and the latest recovery report. A no-framework page uses those endpoints for chat and generation controls.

The page and routes are ready when:

- An unauthenticated request cannot reach a chat or control endpoint.
- A request cannot choose another tenant by sending a tenant ID.
- Two clients authenticated as the owner reach the same generation state and workspace.
- Test identities with different stable claims resolve to different Supervisor and workspace-host names.
- The page shows the active generation and the epoch used for activation or rollback.
- Repeating one request ID returns the journaled result.
- Reusing that ID for a different command fails.
- A failed candidate does not change the active generation.
- A passing candidate activates only through an epoch-checked owner request.
- Rollback accepts only a ready generation that ran before.
- The owner can read the latest recovery report without suggesting repair runs in the background.

Manual rollback is version 0 recovery. Existing recovery code may record and explain a failure, but no model diagnoses, repairs, submits, or activates code.

## P4: deploy, record, then stop

Write one repeatable deployment procedure for the Worker, Durable Objects, R2 bucket, Computer host, model binding or secret, and Access policy. Keep one small demo repository and one broken harness candidate ready for the recording.

Run the complete demo in a fresh browser session. Then open the same tenant from a second client and continue through another session. Restart or evict runtime objects and confirm the active generation, saved conversations, and project files remain. After the last code change, run `pnpm verify` and retain paid probe output with the release notes.

Version 0 is done when that passes. Publish the recording. Stop adding features.

## Build order

P0 comes first and alone because it settles the module-map and capability contracts that P1 and P2 would otherwise guess at. After P0, the Generation 0 facet with its saved coding turn and the R2 build cache can proceed separately. P3 waits for both. Building the page earlier would make every backend type change into frontend rework. P4 is last, and it ends the project.

## Deliberately postponed

These belong to cf-stumble, but not to this release:

- Choosing a known-good threshold or activating a fallback automatically.
- Letting the agent repair itself, submit generations, or approve changes through replay tests.
- Token streaming, reconnect, resume, steering, and background turns.
- More projects, combined project and harness views, or a workspace picker.
- Public signup, teams, roles, invitations, tenant administration, or a custom account system.
- Provider selection and subscription login.
- Better cache policy, alarms, and session migrations.

## Ideas that are not part of this release

The historical conversation produced many good side projects. They are side projects, not deferred release work. Keep them out of this plan rather than carrying them as unchecked boxes.

- `patch.md` profiles
- code-server
- Cloudflare OS Gadget or Blueprint compatibility
- GitHub App installation, issue triage, CI webhooks, and pull requests
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
5. Use a fixed value where version 0 has one project, one model, or one page. Tenant identity and `sessionId` are the only routing dimensions worth adding.
6. Release the demo once it passes. Put later ideas in a later plan.
